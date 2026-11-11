import { Hono, type Context, type MiddlewareHandler } from "hono";
import { requireFreshAuth } from "../shared/auth-expiry";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { durableReadResult } from "./rpc-read";
import { completeReservedUpload } from "./upload-cleanup";
import { unwrapResult } from "../shared/result";
import { rateLimitRequest, httpRoute } from "./limits";
import { OcrImagesSchema, validateTranscriptionInput } from "../ai/transcribe";
import { revokeOAuthGrant } from "./mcp";
import { uploadBodyDigest, uploadDescriptorDigest } from "../vault/uploads";
import { renderPdf } from "../render/pdf";
import { PILOT_IDENTITY_PATHS, PILOT_MAX_CALLS, PILOT_MAX_MICROS } from "./pilot/ledger";
import { stagingPilotBudget } from "./pilot/access";
import { createArchive, MAX_ARCHIVE_BYTES, type ArchiveEntry } from "../render/archive";
import { archivePreflight, readArchiveSnapshot } from "./archive-snapshot";
import { guardedStream } from "./guarded-stream";
import { cachedExport, snapshotCacheKey } from "./vault-export-cache";
import { billingConfig } from "../shared/billing";
import { verifyStripe, parseStripeEvent, stripeClient } from "./billing";
import {
  createShareToken,
  readShareToken,
  createShareSession,
  shareLink,
  SHARE_COOKIE,
  shareCookieName,
} from "./shares";
import { readPosting } from "./postings";
import { renderDocx, textDocx } from "../render/docx";
import { renderResumeHtml } from "../render/template";
import {
  DATE_PATTERN,
  APPLICATION_STATUSES,
  FACT_KINDS,
  LEVELS,
  MAX_FACT_CHARS,
  MAX_JD_CHARS,
  MAX_JOB_NAME_CHARS,
  MAX_URL_CHARS,
  MIN_JD_CHARS,
  isWebUrl,
  MAX_LINE_CHARS,
  MAX_SENSITIVE_IDS,
  MAX_UPLOAD_BYTES,
  ROLE_KINDS,
  type FactKind,
  type Level,
  type ReviewState,
  type RoleKind,
} from "../shared/api";
import { AppError, errorCode, errorDetail, httpStatus } from "../shared/errors";
import { MAX_SHARE_LABEL_CHARS, type CoachClient, type SharedView } from "../shared/sharing";
import type { CommentThread, OwnerCommentThread } from "../shared/sharing";
import { MAX_VAULT_COMMENTS } from "../vault/share-comments";
import { hintFor, type CfLocation } from "../shared/location";
import { PREFERENCES_REFUSED, cleanPreferences } from "../shared/preferences";
import { docxKey, pdfKey, sourceKey } from "../shared/r2";
import { directoryForSignIn, settleRoutedPlacement } from "../directory/routing";
import { validShardInviteClaim, type ShardInviteClaim } from "../directory/shard-invite-binding";
import { maintenance } from "./maintenance";
import {
  directory,
  directoryForUser,
  allDirectories,
  vault,
} from "../shared/stubs";
import type { SignInInput, Who } from "../shared/types";
import { verifyAccess } from "./access";
import { sameSecret } from "./crypto";
import { beginLogin, clearOidcCookie, finishLogin, OIDC_COOKIE } from "./oidc";
import {
  clearSessionCookie,
  createSession,
  readSession,
  SESSION_COOKIE,
  sessionCookie,
  type Session,
} from "./session";

// The only HTTP surface. /auth/* and /admin/* may call the Directory; /api/* routes go
// straight to the caller's vault, addressed by the ID in their signed session cookie.

type AppEnv = { Bindings: Env; Variables: { session: Session; who: Who } };
type C = Context<AppEnv>;

export const app = new Hono<AppEnv>();

const tooLarge = (message: string) => (c: Context) => c.json({ error: "too_large", message }, 413);
const JSON_LIMIT = bodyLimit({ maxSize: 64 * 1024, onError: tooLarge("This request is too large to process.") });
const UPLOAD_LIMIT = bodyLimit({
  maxSize: MAX_UPLOAD_BYTES + 64 * 1024,
  onError: tooLarge("Files can be up to 10 MB."),
});

app.onError((err, c) => {
  // Errors from libraries and RPCs can have accessor-backed properties or
  // hostile prototypes. Never let classifying one rethrow its contents.
  try {
    if (err instanceof z.ZodError)
      return c.json({ error: "invalid", message: "invalid request" }, 400);
    if (err instanceof HTTPException) {
      return c.json(
        {
          error: err.status === 413 ? "too_large" : "invalid",
          message: err.message || "bad request",
        },
        err.status,
      );
    }
    const code = errorCode(err);
    if (code)
      return c.json(
        { error: code, message: errorDetail(err) },
        httpStatus(code) as 400,
      );
  } catch {
    // The fixed response below does not inspect the thrown value.
  }
  try {
    console.error("unhandled error", {
      code: "unexpected",
      route: httpRoute(new URL(c.req.url).pathname),
    });
  } catch { /* Logging must not surface an exception either. */ }
  return c.json({ error: "internal", message: "something went wrong" }, 500);
});

app.notFound((c) =>
  c.json({ error: "not_found", message: "no such route" }, 404),
);

// Security headers on every Worker response, and no caching of personal data.
app.use("*", async (c, next) => {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header(
    "referrer-policy",
    c.req.path.startsWith("/share") ? "no-referrer" : "same-origin",
  );
  c.header("x-frame-options", "DENY");
  if (!c.res.headers.has("cache-control"))
    c.header("cache-control", "no-store");
});

// Writes must come from this site. SameSite=Lax cookies already block most cross-site writes.
app.use("*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin)
      throw new AppError("forbidden", "cross-site request refused");
  }
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true }));

// ------------------------------------------------------------------ auth

app.get("/auth/login", async (c) => {
  // The authorization is not issued until the global coordinator snapshot is read.
  const authEpoch = await directory(c.env).googleAuthEpoch();
  const { location, cookie } = await beginLogin(
    c.env,
    new URL(c.req.url).origin,
    c.req.query("returnTo"),
    authEpoch,
  );
  c.header("set-cookie", cookie);
  return c.redirect(location, 302);
});

app.get("/auth/callback", async (c) => {
  const url = new URL(c.req.url);
  c.header("set-cookie", clearOidcCookie(), { append: true });
  try {
    const { subject, email, authExpiryMs, authEpoch, returnTo } = await finishLogin(
      c.env,
      url.origin,
      url.searchParams,
      getCookie(c, OIDC_COOKIE),
    );
    const cookie = await startSession(c.env, {
      provider: "google",
      subject,
      email,
      authExpiryMs,
      authEpoch,
      hint: hintFor(cfOf(c)),
    });
    c.header("set-cookie", cookie, { append: true });
    return c.redirect(returnTo ?? "/", 302);
  } catch (e) {
    return c.redirect(`/?error=${errorCode(e) ?? "unavailable"}`, 302);
  }
});

app.post("/auth/logout", (c) => {
  c.header("set-cookie", clearSessionCookie());
  return c.body(null, 204);
});

app.delete("/auth/account", requireSession(), async (c) => {
  const s = c.get("session");
  // Establish authorization and stop access in one vault event, before a
  // sign-out or other request can revoke this session between objects.
  await vault(c.env, s.vid).beginAccountDeletion(c.get("who"));
  await directoryForUser(c.env, s.uid).deleteAccount(s.uid, s.vid);
  // Do not acknowledge deletion while a copied session can still use an
  // initialized vault. Inventory and destruction remain asynchronous.
  await vault(c.env, s.vid).quiesce();
  c.header("set-cookie", clearSessionCookie());
  return c.json({ deleting: true }, 202);
});

/** Staging only: exists when the TEST_SIGNIN_KEY secret is set, which production never has. */
app.post("/auth/test-login", JSON_LIMIT, async (c) => {
  const key = c.env.TEST_SIGNIN_KEY;
  if (!key || c.env.ALLOW_TEST_SIGNIN !== "true")
    return c.json({ error: "not_found", message: "no such route" }, 404);
  if (!sameSecret(c.req.header("x-test-signin-key") ?? "", key))
    throw new AppError("forbidden", "wrong test key");
  const { email } = await jsonBody(c, z.object({ email: z.email() }));
  const cookie = await startSession(c.env, {
    provider: "test",
    subject: email.toLowerCase(),
    email,
    // Test sign-ins share the same post-inventory shard authorization floor.
    // Read before routing so an in-flight login cannot outlive a seal.
    authEpoch: await directory(c.env).googleAuthEpoch(),
    hint: hintFor(cfOf(c)),
  });
  c.header("set-cookie", cookie);
  return c.body(null, 204);
});

/** Staging-only, fixed-name budget coordinator. No model text is accepted. */
function pilotBudget(c: C) {
  const key = c.env.PILOT_BUDGET_KEY;
  if (c.env.ALLOW_TEST_SIGNIN !== "true" || !c.env.PILOT_BUDGET || !key || new TextEncoder().encode(key).length < 32)
    throw new AppError("not_found", "no such route");
  if (!sameSecret(c.req.header("x-pilot-budget-key") ?? "", key))
    throw new AppError("forbidden", "wrong pilot key");
  return stagingPilotBudget(c.env);
}
const PilotAttemptId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
app.post("/auth/test/pilot-budget/initialize", JSON_LIMIT, async (c) => {
  const pilot = pilotBudget(c);
  const body = await jsonBody(c, z.object({
    maxMicros: z.number().int().positive().max(PILOT_MAX_MICROS),
    maxCalls: z.number().int().positive().max(PILOT_MAX_CALLS),
  }).strict());
  await pilot.initialize(body.maxMicros, body.maxCalls);
  return c.body(null, 204);
});
app.post("/auth/test/pilot-budget/reserve", JSON_LIMIT, async (c) => {
  const pilot = pilotBudget(c);
  const body = await jsonBody(c, z.object({
    id: PilotAttemptId,
    micros: z.number().int().positive().max(PILOT_MAX_MICROS),
    calls: z.number().int().positive().max(PILOT_MAX_CALLS),
  }).strict());
  await pilot.reserve(body.id, body.micros, body.calls);
  return c.body(null, 204);
});
app.post("/auth/test/pilot-budget/settle", JSON_LIMIT, async (c) => {
  const pilot = pilotBudget(c);
  const body = await jsonBody(c, z.object({
    id: PilotAttemptId,
    actualMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  }).strict());
  return c.json(await pilot.settle(body.id, body.actualMicros));
});
app.post("/auth/test/pilot-budget/freeze", async (c) => {
  await pilotBudget(c).freeze();
  return c.body(null, 204);
});
app.get("/auth/test/pilot-budget/status", async (c) => {
  c.header("cache-control", "no-store");
  return c.json(await pilotBudget(c).status());
});
app.get("/auth/test/pilot-budget/attempts", async (c) => {
  c.header("cache-control", "no-store");
  return c.json(await pilotBudget(c).auditAttempts());
});

// This diagnostic uses a server-generated public nonce and metadata only. An
// authenticated caller cannot submit an observation: only a real model-call
// path writes the witness, before the paid-dispatch safety gate rejects it.
app.post("/auth/test/pilot-budget/identity/begin", JSON_LIMIT, async (c) => {
  const pilot = pilotBudget(c);
  // The diagnostic deliberately triggers a real model-attempt path. Refuse to
  // create a challenge unless that path is configured to fail before dispatch.
  if (c.env.PILOT_SHARED_BUDGET !== "true")
    throw new AppError("unavailable", "the shared pilot mode is required for identity diagnostics");
  const body = await jsonBody(c, z.object({
    path: z.enum(PILOT_IDENTITY_PATHS),
    vaultId: z.string().regex(/^[0-9a-f]{64}$/i),
  }).strict());
  const version = c.env.PILOT_VERSION_METADATA?.id;
  if (!version) throw new AppError("unavailable", "worker version metadata is unavailable");
  return c.json(await pilot.beginIdentity(crypto.randomUUID(), body.path, body.vaultId, version), 201);
});
app.post("/auth/test/pilot-budget/identity/status", JSON_LIMIT, async (c) => {
  const pilot = pilotBudget(c);
  const body = await jsonBody(c, z.object({ nonce: z.uuid() }).strict());
  return c.json(await pilot.identityStatus(body.nonce));
});
app.post("/auth/test/pilot-budget/identity/consume", JSON_LIMIT, async (c) => {
  const pilot = pilotBudget(c);
  const body = await jsonBody(c, z.object({ nonce: z.uuid(), runId: PilotAttemptId }).strict());
  return c.json(await pilot.consumeIdentity(body.nonce, body.runId));
});

/** Establish a session only while the OAuth state that authorized it is fresh. */
export async function startSession(env: Env, input: SignInInput): Promise<string> {
  if (!env.SESSION_KEY)
    throw new AppError("unavailable", "sessions are not configured");
  if (input.authExpiryMs !== undefined) requireFreshAuth(input.authExpiryMs);
  const target = await directoryForSignIn(env, input);
  let account: { userId: string; vaultId: string; created?: boolean; shardClaimToken?: string | null; shardInviteClaim?: ShardInviteClaim | null };
  try {
    account = input.provider === "google" && target.input.homeShard !== undefined
      ? await target.directory.signInWithInviteClaimV2({ ...target.input, reportCreation: true })
      : await target.directory.signIn({ ...target.input, reportCreation: true });
  } finally {
    await settleRoutedPlacement(env, target.directory, target.input);
  }
  const { userId, vaultId } = account;
  if (input.authExpiryMs !== undefined) requireFreshAuth(input.authExpiryMs);
  // A shard identity found by the target may have appeared after routing's
  // lookup. Only the RPC that actually inserted it can bind an unbound home.
  // An older Directory omits `created`, which fails closed on sharded homes.
  const requireBound = target.input.homeShard !== undefined && account.created !== true;
  const checkClaim = input.provider === "google" && target.input.homeShard !== undefined;
  if (checkClaim) {
    if (!Object.hasOwn(account, "shardInviteClaim") ||
        (account.shardInviteClaim !== null && (!validShardInviteClaim(account.shardInviteClaim) ||
          account.shardClaimToken !== account.shardInviteClaim.token)))
      throw new AppError("unavailable", "account placement requires review");
    await directory(env).bindIdentityHomeV3(input.provider, input.subject, userId, input.authEpoch, input.authExpiryMs, requireBound, account.shardInviteClaim ?? null);
  }
  else
    await directory(env).bindIdentityHome(input.provider, input.subject, userId, input.authEpoch, input.authExpiryMs, requireBound);
  if (input.authExpiryMs !== undefined) requireFreshAuth(input.authExpiryMs);
  const { gen, epoch } = await vault(env, vaultId).openSession(userId);
  const cookie = sessionCookie(
    await createSession(env.SESSION_KEY, {
      uid: userId,
      vid: vaultId,
      gen,
      epoch,
      // The address the provider verified for this sign-in.
      email: input.email,
    }),
  );
  if (input.authExpiryMs !== undefined) requireFreshAuth(input.authExpiryMs);
  return cookie;
}

function cfOf(c: C): CfLocation | undefined {
  return (c.req.raw as Request & { cf?: CfLocation }).cf;
}

// ------------------------------------------------------------------ api (session required)

function requireSession(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const s = await readSession(
      c.env.SESSION_KEY,
      getCookie(c, SESSION_COOKIE),
    );
    if (!s) throw new AppError("unauthenticated", "sign in to continue");
    c.set("session", s);
    c.set("who", { userId: s.uid, gen: s.gen, epoch: s.epoch });
    const limited = await rateLimitRequest(c.req.raw, c.env, s.uid);
    if (limited) return limited;
    await next();
  };
}

const myVault = (c: C) => vault(c.env, c.get("session").vid);

const api = new Hono<AppEnv>();
api.use("*", requireSession());

const ProfilePatch = z
  .object({
    name: z.string().max(200),
    email: z.string().max(200),
    phone: z.string().max(60),
    location: z.string().max(200),
    links: z.array(z.string().max(300)).max(10),
  })
  .partial();

const roleDate = z
  .string()
  .regex(DATE_PATTERN, "use a year, or a year and month such as 2021-03")
  .nullable();

const NewRoleBody = z.object({
  kind: z.enum(ROLE_KINDS as [RoleKind, ...RoleKind[]]),
  org: z.string().trim().min(1).max(200),
  title: z.string().trim().max(200).nullable(),
  startDate: roleDate,
  endDate: roleDate,
});

const RolePatch = NewRoleBody.partial().extend({
  expectedRevision: z.number().int().positive().optional(),
});
const NewRoleV2Body = NewRoleBody.extend({ unknownEndStartDate: roleDate }).strict();
const NewRoleV3Body = NewRoleBody.extend({ unknownEndStartDate: roleDate.optional() }).strict();
const RolePatchV2 = NewRoleV2Body.partial().extend({
  expectedRevision: z.number().int().positive().optional(),
}).strict();

const FactPatchBody = z
  .object({
    expectedRevision: z.number().int().positive().optional(),
    text: z.string().trim().min(1).max(MAX_FACT_CHARS),
    roleId: z.string().max(64).nullable(),
    level: z.enum(LEVELS as [Level, ...Level[]]).nullable(),
  })
  .partial()
  .refine(
    (p) => p.text !== undefined || p.roleId !== undefined || p.level !== undefined,
    "change the text, role, or level",
  );

const NewFactBody = z.object({
  roleId: z.string().max(64).nullable(),
  kind: z.enum(FACT_KINDS as [FactKind, ...FactKind[]]),
  text: z.string().trim().min(1).max(MAX_FACT_CHARS),
  level: z.enum(LEVELS as [Level, ...Level[]]).nullable(),
});

const JdText = z.string().trim().min(MIN_JD_CHARS, "paste the whole job description").max(MAX_JD_CHARS);
const WebUrl = z.string().trim().max(MAX_URL_CHARS).refine(isWebUrl, "enter the posting's web address, starting with https://");
/** A title or company: one line of the person's own text. An empty line clears it. */
const JobName = z.string().trim().max(MAX_JOB_NAME_CHARS).refine((value) => !/[\r\n]/.test(value), "use a single line")
  .transform((value) => value || null);

const NewApplicationBody = z.object({
  jdText: JdText,
  url: WebUrl.optional(),
  // What the posting's own page calls the job, when it was read from a link.
  title: JobName.optional(),
  company: JobName.optional(),
});

const Ids = z.array(z.string().max(64)).max(1000);

api.get("/live", async (c) => {
  if (c.req.header("origin") !== new URL(c.req.url).origin)
    throw new AppError("forbidden", "cross-site socket refused");
  const headers = new Headers({
    upgrade: "websocket",
    "x-vault-session": JSON.stringify({
      ...c.get("who"),
      exp: c.get("session").exp,
    }),
  });
  return myVault(c).fetch(
    new Request("https://vault.internal/live", { headers }),
  );
});

api.post("/test/model-budget", JSON_LIMIT, async (c) => {
  const secret = c.env.TEST_SIGNIN_KEY;
  if (!secret || c.env.ALLOW_TEST_SIGNIN !== "true")
    throw new AppError("not_found", "no such route");
  if (!sameSecret(c.req.header("x-test-signin-key") ?? "", secret))
    throw new AppError("forbidden", "wrong test key");
  const budget = await jsonBody(
    c,
    z
      .object({
        maxCostMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        maxCalls: z.number().int().positive().max(100000),
      })
      .strict(),
  );
  await myVault(c).freezeModelBudget(
    c.get("who"),
    budget.maxCostMicros,
    budget.maxCalls,
  );
  return c.body(null, 204);
});

api.get("/me", async (c) => {
  const me = await myVault(c).me(c.get("who"));
  const signInEmail = c.get("session").email;
  return c.json({ ...me, ...(signInEmail ? { signInEmail } : {}), capabilities: {
    ocr: me.capabilities?.ocr ?? false,
    connectedApps: me.capabilities?.connectedApps ?? false,
    // Both this Worker and the Vault must understand v2 writes.
    roleDateUnknownEnd: c.env.ROLE_UNKNOWN_END_ENABLED === "true" && me.capabilities?.roleDateUnknownEnd === true,
    // The Worker does the reading, so its own setting decides.
    postingReader: c.env.POSTING_READER_ENABLED === "true",
  } });
});

api.get("/profile", async (c) =>
  c.json(
    unwrapResult(
      await durableReadResult(
        () => myVault(c),
        (v) => v.getProfile(c.get("who")),
      ),
    ),
  ),
);

api.put("/profile", JSON_LIMIT, async (c) =>
  c.json(
    await myVault(c).updateProfile(
      c.get("who"),
      await jsonBody(c, ProfilePatch),
    ),
  ),
);

api.put("/v2/profile", JSON_LIMIT, async (c) => {
  const { expectedRevision, ...patch } = await jsonBody(c,
    ProfilePatch.extend({ expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1) }).strict());
  return c.json(await myVault(c).updateProfileChecked(c.get("who"), patch, expectedRevision));
});

// Job preferences belong to the session's own vault and to nobody else: the request names no
// account, vault or row. A save sends all four values with the revision they were read at.
// Each value is taken as it comes here and judged whole by cleanPreferences, the same rule the
// form and the Vault run, so the three can't disagree about what a save takes.
const PreferencesBody = z
  .object({
    place: z.unknown(),
    jobTypes: z.unknown(),
    availableFrom: z.unknown(),
    payFloor: z.unknown(),
    // 0 is a vault where nothing has been saved yet.
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();

api.get("/preferences", async (c) =>
  c.json(
    unwrapResult(
      await durableReadResult(
        () => myVault(c),
        (v) => v.getPreferences(c.get("who")),
      ),
    ),
  ),
);

api.put("/preferences", JSON_LIMIT, async (c) => {
  const { expectedRevision, ...values } = await jsonBody(c, PreferencesBody);
  const clean = cleanPreferences(values);
  if (!clean) throw new AppError("invalid", PREFERENCES_REFUSED);
  return c.json(await myVault(c).updatePreferences(c.get("who"), clean, expectedRevision));
});

api.post("/account/sign-out-everywhere", async (c) => {
  await myVault(c).signOutEverywhere(c.get("who"));
  c.header("set-cookie", clearSessionCookie());
  return c.body(null, 204);
});

const ALLOWED_UPLOADS: Record<string, string> = {
  zip: "application/zip",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

api.post("/sources", UPLOAD_LIMIT, async (c) => {
  const form = await c.req.formData().catch(() => {
    throw new AppError("invalid", "expected a multipart upload");
  });
  const file = form.get("file");
  if (!(file instanceof File))
    throw new AppError("invalid", 'attach the file as the "file" field');
  if (file.name.length > 8192)
    throw new AppError("invalid", "This file's name is too long. Rename it, then upload it again.");
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const contentType = ALLOWED_UPLOADS[extension];
  if (!contentType)
    throw new AppError(
      "invalid",
      "Upload a PDF, a Word file (.docx) or a LinkedIn data export (.zip).",
    );
  if (file.size === 0) throw new AppError("invalid", "This file is empty.");
  if (file.size > MAX_UPLOAD_BYTES)
    throw new AppError("too_large", "Files can be up to 10 MB.");

  await myVault(c).checkSession(c.get("who"));
  const bytes = await file.arrayBuffer();
  const request = requestKey(c);
  const digest = await uploadDescriptorDigest(
    { filename: file.name, contentType },
    bytes,
  );
  const descriptor = {
    requestKey: request,
    descriptorDigest: digest,
    filename: uploadFilename(file.name, extension),
    contentType,
    byteLength: file.size,
    r2Key: sourceKey(c.get("session").vid, `${request}-${digest}`),
    sha256: await uploadBodyDigest(bytes),
  };
  const reserved = await myVault(c).reserveUpload(c.get("who"), descriptor);
  if (reserved.intent.state === "complete")
    return c.json({ sourceId: reserved.intent.sourceId }, 201);
  const authorized = await myVault(c).writeReservedSource(c.get("who"), descriptor, bytes, file.name);
  if (authorized.sourceId) return c.json({ sourceId: authorized.sourceId }, 201);
  return c.json(
    await completeReservedUpload(c.env.FILES, descriptor.r2Key, () =>
      myVault(c).completeUpload(c.get("who"), descriptor), {
        expired: () => myVault(c).expiredUploadForCleanup(c.get("who"), descriptor),
      },
    ),
    201,
  );
});

api.get("/sources/:id/text", async (c) =>
  c.json(await myVault(c).sourceEvidence(c.get("who"), c.req.param("id"))),
);
api.post(
  "/sources/:id/ocr",
  bodyLimit({ maxSize: 12 * 1024 * 1024, onError: tooLarge("These page images are too large. Upload a Word file (.docx) or a smaller PDF.") }),
  async (c) => {
    if (!c.env.MODEL_TRANSCRIBE)
      throw new AppError(
        "unavailable",
        "image transcription is not configured",
      );
    const original = await myVault(c).sourceFile(
      c.get("who"),
      c.req.param("id"),
    );
    if (!original.filename.toLowerCase().endsWith(".pdf"))
      throw new AppError("invalid", "image recovery requires a PDF source");
    const images = await jsonBody(c, OcrImagesSchema);
    validateTranscriptionInput({
      ...images,
      referenceDate: new Date().toISOString().slice(0, 10),
    });
    const metadata = {
      filename: `${safePrefix(original.filename, 170)} (image transcription)`,
      contentType: "application/json",
      origin: "ocr" as const,
      parentSourceId: c.req.param("id"),
    };
    const stableBody = JSON.stringify(images);
    const digest = await uploadDescriptorDigest(metadata, stableBody);
    const request = requestKey(c);
    const descriptor = {
      ...metadata,
      requestKey: request,
      descriptorDigest: digest,
      byteLength: new TextEncoder().encode(stableBody).byteLength,
      r2Key: sourceKey(c.get("session").vid, `${request}-${digest}.ocr.json`),
    };
    const reserved = await myVault(c).reserveUpload(c.get("who"), descriptor);
    if (reserved.intent.state === "complete")
      return c.json({ sourceId: reserved.intent.sourceId }, 202);
    const input = {
      ...images,
      referenceDate: new Date(reserved.intent.createdAt)
        .toISOString()
        .slice(0, 10),
    };
    const encoded = new TextEncoder().encode(JSON.stringify(input));
    const authorized = await myVault(c).writeReservedSource(c.get("who"), descriptor, encoded.buffer as ArrayBuffer, descriptor.filename);
    if (authorized.sourceId) return c.json({ sourceId: authorized.sourceId }, 202);
    return c.json(
      await completeReservedUpload(c.env.FILES, descriptor.r2Key, () =>
        myVault(c).completeUpload(c.get("who"), descriptor), {
          expired: () => myVault(c).expiredUploadForCleanup(c.get("who"), descriptor),
        },
      ),
      202,
    );
  },
);

api.get("/sources", async (c) =>
  c.json({ sources: await myVault(c).listSources(c.get("who")) }),
);

// One Vault turn keeps source state and proposed items from different moments
// from being combined into a misleading ready/empty review screen.
api.get("/v2/vault", async (c) => {
  const response = unwrapResult(await durableReadResult(() => myVault(c), (v) => v.reviewView(c.get("who"))));
  if (!response.body) throw new AppError("unavailable", "the review view is unavailable");
  return new Response(guardedStream(response.body, () => myVault(c).checkSession(c.get("who"))), {
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  });
});

api.post("/sources/:id/cancel", async (c) => {
  await myVault(c).cancelSource(c.get("who"), c.req.param("id"));
  return c.body(null, 202);
});

/** The source's stored object; image-transcription sources contain JSON input. */
api.get("/sources/:id/file", async (c) => {
  const { r2Key, filename, origin } = await myVault(c).sourceFile(
    c.get("who"),
    c.req.param("id"),
  );
  const object = await c.env.FILES.get(r2Key);
  if (!object) throw new AppError("not_found", "the file is no longer stored");
  const v = myVault(c);
  const who = c.get("who");
  try {
    await v.checkSession(who);
  } catch (error) {
    await object.body.cancel().catch(() => {});
    throw error;
  }
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  const name = origin === "ocr"
    ? `${fileName(filename.replace(/\s*\(image transcription\)$/i, "").replace(/\.[^.]*$/, ""))}-image-inputs.json`
    : `${fileName(filename.replace(/\.[^.]*$/, ""))}${ALLOWED_UPLOADS[extension] ? `.${extension}` : ""}`;
  return new Response(guardedStream(object.body, () => v.checkSession(who)), {
    headers: {
      "content-type": origin === "ocr"
        ? "application/json"
        : object.httpMetadata?.contentType ?? "application/octet-stream",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "private, no-store",
    },
  });
});

api.get("/roles", async (c) =>
  c.json({
    roles: unwrapResult(
      await durableReadResult(
        () => myVault(c),
        (v) => v.listRoles(c.get("who")),
      ),
    ),
  }),
);

api.post("/roles", JSON_LIMIT, async (c) =>
  c.json(
    await myVault(c).addRole(c.get("who"), await jsonBody(c, NewRoleBody)),
    201,
  ),
);

api.patch("/roles/:id", JSON_LIMIT, async (c) => {
  await myVault(c).editRole(
    c.get("who"),
    c.req.param("id"),
    await jsonBody(c, RolePatch),
  );
  return c.body(null, 204);
});

// New method names ensure an old Worker or Vault cannot silently strip this
// field. The feature remains disabled until mixed-version rollout is verified.
api.post("/v2/roles", JSON_LIMIT, async (c) => {
  if (c.env.ROLE_UNKNOWN_END_ENABLED !== "true")
    throw new AppError("unavailable", "unknown end dates are not enabled");
  return c.json(await myVault(c).addRoleV2(c.get("who"), await jsonBody(c, NewRoleV2Body)), 201);
});
// The separate route and RPC prevent older code from silently discarding the
// idempotency key, including while the optional role-date feature is enabled.
api.post("/v3/roles", JSON_LIMIT, async (c) => {
  const input = await jsonBody(c, NewRoleV3Body);
  return c.json(await myVault(c).addRoleIdempotent(
    c.get("who"), input, requestKey(c), c.env.ROLE_UNKNOWN_END_ENABLED === "true",
  ), 201);
});
api.patch("/v2/roles/:id", JSON_LIMIT, async (c) => {
  if (c.env.ROLE_UNKNOWN_END_ENABLED !== "true")
    throw new AppError("unavailable", "unknown end dates are not enabled");
  await myVault(c).editRoleV2(c.get("who"), c.req.param("id"), await jsonBody(c, RolePatchV2));
  return c.body(null, 204);
});

api.get("/facts", async (c) => {
  const state = c.req.query("state");
  if (state && !["proposed", "confirmed", "rejected"].includes(state))
    throw new AppError("invalid", "unknown state");
  return c.json({
    facts: unwrapResult(
      await durableReadResult(
        () => myVault(c),
        (v) => v.listFacts(c.get("who"), state as ReviewState | undefined),
      ),
    ),
  });
});

api.post("/facts", JSON_LIMIT, async (c) =>
  c.json(
    await myVault(c).addFact(c.get("who"), await jsonBody(c, NewFactBody)),
    201,
  ),
);

// A new route and RPC name ensure older Workers/Vaults cannot silently drop
// the request key and promise idempotency they do not provide.
api.post("/v2/facts", JSON_LIMIT, async (c) =>
  c.json(
    await myVault(c).addFactIdempotent(
      c.get("who"),
      await jsonBody(c, NewFactBody),
      requestKey(c),
    ),
    201,
  ),
);

api.patch("/facts/:id", JSON_LIMIT, async (c) => {
  await myVault(c).editFact(
    c.get("who"),
    c.req.param("id"),
    await jsonBody(c, FactPatchBody),
  );
  return c.body(null, 204);
});

api.post("/review", JSON_LIMIT, async (c) => {
  await myVault(c).review(
    c.get("who"),
    await jsonBody(
      c,
      z.object({
        confirm: Ids,
        reject: Ids,
        expectedRevisions: z
          .record(z.string(), z.number().int().positive())
          .optional(),
      }),
    ),
  );
  return c.body(null, 204);
});

// Marks facts sensitive, or unmarks them. The vault is the caller's own, from their session, so a
// fact in anyone else's is simply not found. The request names the state it wants, which makes a
// repeat harmless without a key, and the answer says nothing.
api.post("/facts/sensitive", JSON_LIMIT, async (c) => {
  await myVault(c).markSensitive(
    c.get("who"),
    await jsonBody(
      c,
      z
        .object({
          ids: Ids.min(1).max(MAX_SENSITIVE_IDS),
          sensitive: z.boolean(),
          expectedRevisions: z
            .record(z.string(), z.number().int().positive())
            .optional(),
        })
        .strict(),
    ),
  );
  return c.body(null, 204);
});

api.post("/applications", JSON_LIMIT, async (c) => {
  const { jdText } = await jsonBody(c, NewApplicationBody);
  return c.json(await myVault(c).addApplication(c.get("who"), jdText), 201);
});

// Separate route and RPC fail closed if an older deployment cannot honor the key.
api.post("/v2/applications", JSON_LIMIT, async (c) => {
  const { jdText, url, title, company } = await jsonBody(c, NewApplicationBody);
  return c.json(
    await myVault(c).addApplicationIdempotent(c.get("who"), jdText, requestKey(c), url ?? null, {
      title: title ?? null,
      company: company ?? null,
    }),
    201,
  );
});

// Reads a posting from its page for the person to check. Nothing is saved, and the page's text is
// only ever returned to the person who asked for it.
api.post("/postings/read", JSON_LIMIT, async (c) => {
  if (c.env.POSTING_READER_ENABLED !== "true")
    throw new AppError("unavailable", "reading a posting from a link is not enabled");
  const { url } = await jsonBody(c, z.object({ url: WebUrl }));
  return c.json(await readPosting(url, new URL(c.req.url).hostname));
});

// Read-only: says whether this posting is already saved, so the person can be asked first.
api.post("/applications/duplicates", JSON_LIMIT, async (c) => {
  const { jdText } = await jsonBody(c, z.object({ jdText: JdText }));
  return c.json({ duplicate: await myVault(c).findDuplicateApplication(c.get("who"), jdText) });
});

api.get("/applications", async (c) =>
  c.json({ applications: await myVault(c).listApplications(c.get("who")) }),
);

api.get("/applications/:id", async (c) =>
  c.json(await myVault(c).getApplication(c.get("who"), c.req.param("id"))),
);

api.delete("/applications/:id", async (c) => {
  await myVault(c).deleteApplication(c.get("who"), c.req.param("id"));
  return c.body(null, 204);
});

api.post("/applications/:id/resumes", async (c) =>
  c.json(
    await myVault(c).tailor(c.get("who"), c.req.param("id"), requestKey(c)),
    202,
  ),
);

api.get("/resumes/:id", async (c) =>
  c.json(
    await myVault(c).getResume(
      c.get("who"),
      c.req.param("id"),
      versionQuery(c),
    ),
  ),
);

api.patch("/resumes/:id/lines/:lineId", JSON_LIMIT, async (c) => {
  const { text, expectedVersion } = await jsonBody(
    c,
    z.object({
      text: z.string().trim().min(1).max(MAX_LINE_CHARS),
      expectedVersion: z.number().int().positive().optional(),
    }),
  );
  await myVault(c).editLine(
    c.get("who"),
    c.req.param("id"),
    c.req.param("lineId"),
    text,
    expectedVersion,
  );
  return c.body(null, 204);
});

api.post("/resumes/:id/legacy-finalize", JSON_LIMIT, async (c) => {
  const { expectedVersion } = await jsonBody(c, z.object({ expectedVersion: z.number().int().positive() }));
  return c.json(await myVault(c).finalizeLegacyResume(c.get("who"), c.req.param("id"), expectedVersion));
});

api.post("/resumes/:id/legacy-remove-line", JSON_LIMIT, async (c) => {
  const { lineId, expectedVersion } = await jsonBody(c, z.object({ lineId: z.string().min(1).max(256), expectedVersion: z.number().int().positive() }));
  return c.json(await myVault(c).removeLegacyLine(c.get("who"), c.req.param("id"), lineId, expectedVersion));
});

api.post("/resumes/:id/legacy-remove-section", JSON_LIMIT, async (c) => {
  const { sectionIndex, expectedVersion } = await jsonBody(c, z.object({ sectionIndex: z.number().int().nonnegative(), expectedVersion: z.number().int().positive() }));
  return c.json(await myVault(c).removeLegacySection(c.get("who"), c.req.param("id"), sectionIndex, expectedVersion));
});

api.post("/resumes/:id/legacy-remove-skill", JSON_LIMIT, async (c) => {
  const { skillIndex, expectedVersion } = await jsonBody(c, z.object({ skillIndex: z.number().int().nonnegative(), expectedVersion: z.number().int().positive() }));
  return c.json(await myVault(c).removeLegacySkill(c.get("who"), c.req.param("id"), skillIndex, expectedVersion));
});

api.post("/resumes/:id/remove-line", JSON_LIMIT, async (c) => {
  const { lineId, expectedVersion } = await jsonBody(c, z.object({ lineId: z.string().min(1).max(256), expectedVersion: z.number().int().positive() }));
  return c.json(await myVault(c).removeResumeLine(c.get("who"), c.req.param("id"), lineId, expectedVersion));
});

api.post("/resumes/:id/remove-skill", JSON_LIMIT, async (c) => {
  const { skillIndex, expectedVersion } = await jsonBody(c, z.object({ skillIndex: z.number().int().nonnegative(), expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1) }));
  return c.json(await myVault(c).removeResumeSkill(c.get("who"), c.req.param("id"), skillIndex, expectedVersion));
});

api.post("/resumes/:id/grounding-review", JSON_LIMIT, async (c) => {
  const { expectedVersion } = await jsonBody(c, z.object({ expectedVersion: z.number().int().positive() }));
  return c.json(await myVault(c).beginResumeReview(c.get("who"), c.req.param("id"), expectedVersion));
});

/** Renders once per resume version and serves the cached PDF after that. */
api.get("/resumes/:id/pdf", async (c) => {
  const resumeId = c.req.param("id");
  const data = await myVault(c).renderData(
    c.get("who"),
    resumeId,
    versionQuery(c),
  );
  // Legacy renderers ignore unknown-end starts. Isolate their cached output
  // from new output for this same immutable version; old versions keep keys.
  const hasUnknownEndDates = data.body.sections.some((s) => !!s.unknownEndStartDate);
  const key = await snapshotCacheKey(pdfKey(c.get("session").vid, resumeId, data.version, hasUnknownEndDates), data);
  const pdf = await cachedExport(() => myVault(c), c.get("who"), key,
    () => renderPdf(c.env, renderResumeHtml(data)));
  const name = fileName(
    [data.profile.name, data.company].filter(Boolean).join(" ") || "resume",
  );
  return new Response(pdf, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${name}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
});

/** The HTML the PDF is printed from, for a print preview. It holds only escaped text, and the CSP keeps it inert. */
api.get("/resumes/:id/preview", async (c) => {
  const data = await myVault(c).renderData(
    c.get("who"),
    c.req.param("id"),
    versionQuery(c),
  );
  return new Response(renderResumeHtml(data), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox",
      "cache-control": "private, no-store",
    },
  });
});

api.get("/export", async (c) => {
  const response = unwrapResult(await durableReadResult(() => myVault(c), (v) => v.exportJson(c.get("who"))));
  if (!response.body) throw new AppError("unavailable", "the export is unavailable");
  return new Response(guardedStream(response.body, () => myVault(c).checkSession(c.get("who"))), {
    headers: {
      "content-type": "application/json",
      "content-disposition": response.headers.get("content-disposition") ?? "attachment; filename=\"resumatic-export.json\"",
      "cache-control": "private, no-store",
    },
  });
});

/** Download a bounded point-in-time vault snapshot and the referenced original objects. */
api.get("/export/archive", async (c) => {
  const v = myVault(c);
  const who = c.get("who");
  const response = await archivePreflight(c.req.raw.signal, async () => {
    const result = unwrapResult(await durableReadResult(() => myVault(c), (stub) => stub.exportArchiveStream(who)));
    // A disconnected caller may abandon the RPC before its response arrives.
    if (c.req.raw.signal.aborted) void result.body?.cancel("archive aborted").catch(() => {});
    return result;
  });
  let snapshot: Awaited<ReturnType<typeof readArchiveSnapshot>>;
  try { snapshot = await readArchiveSnapshot(response, c.get("session").vid, c.req.raw.signal); }
  catch { throw new AppError("unavailable", "the archive snapshot is unavailable"); }
  try {
    const entries: ArchiveEntry[] = [];
    let bytes = snapshot.manifest.jsonBytes;
    for (const file of snapshot.manifest.files) {
      const head = await archivePreflight(c.req.raw.signal, () => c.env.FILES.head(file.key));
      if (!head) throw new AppError("conflict", "An original file is missing from your vault. Download the JSON and the available files one at a time.");
      const fileLimit = file.origin === "ocr" ? 12 * 1024 * 1024 + 1024 : MAX_UPLOAD_BYTES;
      if (!Number.isSafeInteger(head.size) || head.size < 0 || head.size > fileLimit || head.size > MAX_ARCHIVE_BYTES - bytes)
        throw new AppError("too_large", "Your vault is too large for one archive. Download the JSON and the original files one at a time.");
      bytes += head.size;
      const etag = head.etag;
      entries.push({
        name: file.path,
        size: head.size,
        open: async () => {
          await v.checkSession(who);
          const object = await c.env.FILES.get(file.key, { onlyIf: { etagMatches: etag } });
          if (!object || !("body" in object)) throw new Error("archive_source_changed");
          try {
            await v.checkSession(who);
          } catch (error) {
            await object.body.cancel().catch(() => {});
            throw error;
          }
          const reader = object.body.getReader();
          return new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                await v.checkSession(who);
                const chunk = await reader.read();
                await v.checkSession(who);
                if (chunk.done) controller.close();
                else controller.enqueue(chunk.value);
              } catch (error) {
                await reader.cancel().catch(() => {});
                controller.error(error);
              }
            },
            cancel: (reason) => reader.cancel(reason),
          });
        },
      });
    }
    entries.unshift({ name: "vault.json", size: snapshot.manifest.jsonBytes, open: async () => {
      await v.checkSession(who);
      return guardedStream(snapshot.body, () => v.checkSession(who));
    } });
    // Closure can race the metadata preflight. Check once more before sending headers.
    await archivePreflight(c.req.raw.signal, () => v.checkSession(who));
    const archive = createArchive(entries, { signal: c.req.raw.signal, maxEntries: 129 });
    const archiveReader = archive.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          await v.checkSession(who);
          const chunk = await archiveReader.read();
          await v.checkSession(who);
          if (chunk.done) { void snapshot.cancel().catch(() => {}); controller.close(); }
          else controller.enqueue(chunk.value);
        } catch (error) {
          void snapshot.cancel(error).catch(() => {});
          void archiveReader.cancel(error).catch(() => {});
          controller.error(error);
        }
      },
      cancel(reason) {
        void snapshot.cancel(reason).catch(() => {});
        void archiveReader.cancel(reason).catch(() => {});
      },
    }, { highWaterMark: 0 });
    return new Response(body, { headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="resumatic-export-${snapshot.manifest.exportedAt.slice(0, 10)}.zip"`,
      "cache-control": "private, no-store",
    } });
  } catch (error) {
    void snapshot.cancel(error).catch(() => {});
    throw error;
  }
});

api.get("/resumes/:id/docx", async (c) => {
  const data = await myVault(c).renderData(
    c.get("who"),
    c.req.param("id"),
    versionQuery(c),
  );
  const hasUnknownEndDates = data.body.sections.some((s) => !!s.unknownEndStartDate);
  const key = await snapshotCacheKey(docxKey(c.get("session").vid, c.req.param("id"), data.version, hasUnknownEndDates), data);
  const bytes = await cachedExport(() => myVault(c), c.get("who"), key,
    async () => renderDocx(data));
  return new Response(bytes, {
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "content-disposition": 'attachment; filename="resume.docx"',
    },
  });
});
api.get("/documents/:id/docx", async (c) => {
  const doc = await myVault(c).getDocument(c.get("who"), c.req.param("id"));
  if (doc.kind !== "letter" && doc.kind !== "prep")
    throw new AppError("invalid", "only cover letters and interview preparation can be exported as documents");
  if (doc.state !== "ready" || !doc.result)
    throw new AppError("conflict", "This document isn't ready yet. Wait for it to finish, then try again.");
  const paragraphs =
    doc.kind === "prep"
      ? doc.result.questions.flatMap((q, i) => [
          q.question,
          ...doc.result!.units.filter((u) => u.group === i).map((u) => u.text),
        ])
      : [...new Set(doc.result.units.map((unit) => unit.group))]
          .sort((a, b) => a - b)
          .map((group) =>
            doc.result!.units.filter((unit) => unit.group === group)
              .map((unit) => unit.text).join(" "),
          );
  return new Response(
    textDocx(
      doc.kind === "prep" ? "Interview preparation" : "Cover letter",
      paragraphs,
    ),
    {
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "content-disposition": doc.kind === "prep"
          ? 'attachment; filename="interview-preparation.docx"'
          : 'attachment; filename="cover-letter.docx"',
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
});
api.get("/runs", async (c) =>
  c.json({ runs: await myVault(c).listRuns(c.get("who")) }),
);
api.get("/runs/:id", async (c) =>
  c.json(await myVault(c).runInfo(c.get("who"), c.req.param("id"))),
);
api.post("/runs/:id/retry", async (c) =>
  c.json(
    await myVault(c).retryRun(c.get("who"), c.req.param("id"), requestKey(c)),
    202,
  ),
);
// A distinct route and RPC name ensure an older Worker or Vault cannot
// silently turn an explicit extractor change into an ordinary retry.
api.post("/runs/:id/retry-current-extractor", async (c) =>
  c.json(
    await myVault(c).retryRunCurrentExtractorV1(c.get("who"), c.req.param("id"), requestKey(c), currentDefaultExtractor(c.env)),
    202,
  ),
);
api.post("/runs/:id/cancel", async (c) => {
  await myVault(c).cancelRun(c.get("who"), c.req.param("id"));
  return c.body(null, 202);
});
api.post("/resumes/:id/cancel", async (c) => {
  await myVault(c).cancelResume(c.get("who"), c.req.param("id"));
  return c.body(null, 202);
});
api.get("/resumes/:id/versions", async (c) =>
  c.json({
    versions: await myVault(c).resumeVersions(c.get("who"), c.req.param("id")),
  }),
);
api.patch("/applications/:id", JSON_LIMIT, async (c) => {
  const patch = await jsonBody(
    c,
    z.object({
      status: z.enum(APPLICATION_STATUSES).optional(),
      // HTML date inputs cannot display impossible dates or year zero. Reject
      // them at the API boundary as well, including non-leap February 29.
      appliedAt: z.iso.date().refine((date) => !date.startsWith("0000-"))
        .nullable().optional(),
      notes: z.string().max(10000).optional(),
      title: JobName.optional(),
      company: JobName.optional(),
      url: z.union([WebUrl, z.literal("").transform(() => null), z.null()]).optional(),
      jdText: JdText.optional(),
      expectedRevision: z.number().int().positive().optional(),
    }),
  );
  await myVault(c).updateApplication(c.get("who"), c.req.param("id"), patch);
  return c.body(null, 204);
});
api.get("/applications/:id/documents", async (c) =>
  c.json({
    documents: await myVault(c).listDocuments(c.get("who"), c.req.param("id")),
  }),
);
api.post("/applications/:id/documents", JSON_LIMIT, async (c) => {
  const options = await jsonBody(
    c,
    z.object({
      kind: z.enum(["refine", "letter", "prep", "questions", "fit"]),
      instruction: z.string().trim().max(2000).optional(),
      resumeId: z.string().max(100).optional(),
      expectedVersion: z.number().int().positive().optional(),
      lineIds: z.array(z.string().max(100)).max(100).optional(),
      manualText: z.string().trim().min(1).max(MAX_LINE_CHARS).optional(),
      manualFactIds: z.array(z.string().min(1).max(100)).min(1).max(4).optional(),
    }),
  );
  return c.json(
    await myVault(c).startDocument(
      c.get("who"),
      c.req.param("id"),
      options,
      requestKey(c),
    ),
    202,
  );
});
api.post(
  "/documents/:id/questions/:questionId/answer",
  JSON_LIMIT,
  async (c) => {
    const body = await jsonBody(
      c,
      z
        .object({
          roleId: z.string().max(100).nullable(),
          answer: z.string().trim().min(1).max(MAX_FACT_CHARS),
        })
        .strict(),
    );
    return c.json(
      await myVault(c).answerInterview(
        c.get("who"),
        c.req.param("id"),
        c.req.param("questionId"),
        body,
        requestKey(c),
      ),
      201,
    );
  },
);
// The finished letters and preparation a copy can be made from, without their text.
api.get("/documents", async (c) =>
  c.json({ documents: await myVault(c).listShareableDocuments(c.get("who")) }),
);
api.get("/documents/:id", async (c) =>
  c.json(await myVault(c).getDocument(c.get("who"), c.req.param("id"))),
);
api.get("/shares", async (c) =>
  c.json({ grants: await myVault(c).listShares(c.get("who")) }),
);
api.post("/shares", JSON_LIMIT, async (c) => {
  const selection = await jsonBody(
    c,
    z.object({
      factIds: z.array(z.string().max(100)).max(100),
      resumes: z
        .array(
          z.object({
            id: z.string().max(100),
            version: z.number().int().positive(),
          }),
        )
        .max(20),
      // Finished cover letters and interview preparation.
      documents: z
        .array(
          z.object({
            id: z.string().max(100),
            version: z.number().int().positive(),
          }),
        )
        .max(20)
        .optional(),
      expiresAt: z.number().int().positive().optional(),
      // The owner's note of who the link is for: one short line.
      label: z
        .string()
        .trim()
        .max(MAX_SHARE_LABEL_CHARS)
        .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "use a single line")
        .optional(),
      showName: z.boolean().optional(),
      showJobs: z.boolean().optional(),
      // The one account that may act as this copy's coach, by the address it signs in with.
      coachEmail: z.string().trim().max(254).optional(),
    }),
  );
  const grant = await myVault(c).createShare(c.get("who"), selection);
  const token = await createShareToken(c.env.SESSION_KEY, {
    vid: c.get("session").vid,
    grantId: grant.id,
    epoch: grant.epoch,
    exp: grant.expiresAt,
  });
  return c.json(
    { grant, url: shareLink(new URL(c.req.url).origin, token) },
    201,
  );
});
api.delete("/shares/:id", async (c) => {
  await myVault(c).revokeShare(c.get("who"), c.req.param("id"));
  return c.body(null, 204);
});

// What a coach wrote on the copies this person shared, and their own replies. These four are the
// owner's, in the owner's own vault. The length of a comment is the Vault's to refuse, in a
// sentence of its own, so the limit here is only on what is read at all.
const CommentBody = z.string().max(4000);
api.get("/shares/comments", async (c) => {
  const threads: OwnerCommentThread[] = await myVault(c).listShareComments(c.get("who"));
  return c.json({ threads });
});
// The page names the comments it showed as new. Only those are marked, so one a coach writes while
// the page is open is still counted, and still marked new, the next time the list is read.
api.post("/shares/comments/seen", JSON_LIMIT, async (c) => {
  const { ids } = await jsonBody(c, z.object({ ids: z.array(z.string().max(100)).max(MAX_VAULT_COMMENTS) }));
  await myVault(c).markShareCommentsSeen(c.get("who"), ids);
  return c.body(null, 204);
});
api.post("/shares/comments/:id/replies", JSON_LIMIT, async (c) => {
  const { body } = await jsonBody(c, z.object({ body: CommentBody }));
  return c.json(await myVault(c).replyToShareComment(c.get("who"), c.req.param("id"), body, requestKey(c)), 201);
});
api.delete("/shares/comments/:id", async (c) => {
  await myVault(c).removeShareComment(c.get("who"), c.req.param("id"));
  return c.body(null, 204);
});

// ------------------------------------------------------------------ coaches
// A copy can name a coach by the address they sign in with. That account, and no other, can keep
// the copy in its client list and open it again without the link. Naming a coach never widens who
// can read: the copy's owner's vault checks the account on every one of these calls.

/**
 * An ended copy, said as a conflict. Under /api a 410 means the caller's own vault is gone, and the
 * app signs them out on it, so a client's copy ending must never be said that way here.
 */
const copyEnded = () => new AppError("conflict", "this copy has ended; the person who shared it can share again");
/** For a call into the copy's owner's vault. Its error arrives without its class, so the code is read from the message. */
async function unlessEnded<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (errorCode(error) === "gone") throw copyEnded();
    throw error;
  }
}

/** The signed-in account as an owner's vault is told of it. A session without an address is nobody's coach. */
function coachAccount(c: C): { userId: string; email: string } {
  const session = c.get("session");
  if (!session.email)
    throw new AppError("conflict", "sign out and in again to use this account as a coach");
  return { userId: session.uid, email: session.email };
}

// Takes up a copy the reader has open. The link's own session says which copy, and the reader's
// account has to be the one the owner named.
api.post("/coach/clients", JSON_LIMIT, async (c) => {
  // Only a copy's ID names a cookie. Anything else is refused here, not by the cookie's own 410.
  const { grantId } = await jsonBody(c, z.object({ grantId: z.uuid() }));
  const claims = await readShareToken(c.env.SESSION_KEY, getCookie(c, shareCookieName(grantId)), "coach-session");
  if (!claims || claims.grantId.toLowerCase() !== grantId.toLowerCase()) throw copyEnded();
  const account = coachAccount(c);
  if (claims.vid === c.get("session").vid) throw new AppError("conflict", "this is your own copy");
  // Reading their own account both proves the session is current and gives the name they go by.
  const me = await myVault(c).me(c.get("who"));
  // A list with no room refuses here, before the copy's owner's vault records a take-up, so its
  // owner is never shown one that didn't happen.
  await myVault(c).requireCoachClientRoom(c.get("who"), claims.grantId);
  const joined = await unlessEnded(
    vault(c.env, claims.vid).joinShareAsCoach(
      { grantId: claims.grantId, epoch: claims.epoch },
      { ...account, name: me.profile.name },
    ),
  );
  await myVault(c).addCoachClient(c.get("who"), {
    grantId: claims.grantId,
    ownerVault: claims.vid,
    ownerName: joined.ownerName,
    expiresAt: joined.expiresAt,
  });
  return c.body(null, 204);
});

// The coach's list, with what each owner's vault says about its copy now. A copy whose link has
// ended, or whose owner is gone, is listed as ended and says nothing else.
api.get("/coach/clients", async (c) => {
  const entries = await myVault(c).listCoachClients(c.get("who"));
  const email = c.get("session").email;
  const account = email ? { userId: c.get("session").uid, email } : null;
  const clients: CoachClient[] = await Promise.all(
    entries.map(async (entry) => {
      const ended = { grantId: entry.grantId, ownerName: entry.ownerName, addedAt: entry.addedAt, expiresAt: entry.expiresAt, active: false, factCount: 0, resumeCount: 0, documentCount: 0 };
      if (!account) return ended;
      const live = await vault(c.env, entry.ownerVault).coachShareStatus(entry.grantId, account).catch(() => null);
      return live ? { ...ended, ...live } : ended;
    }),
  );
  return c.json({ clients, needsSignIn: account === null && entries.length > 0 });
});

// Opens a client's copy from the list: the same session the link would give, for the same hour.
api.post("/coach/clients/:grantId/open", async (c) => {
  const entry = await myVault(c).coachClient(c.get("who"), c.req.param("grantId"));
  if (!entry) throw new AppError("not_found", "no such client");
  const opened = await unlessEnded(vault(c.env, entry.ownerVault).openShareForCoach(entry.grantId, coachAccount(c)));
  // Shaped as the link's own claims are, because the session it makes is the one the link makes.
  const claims = { kind: "coach-link" as const, vid: entry.ownerVault, grantId: entry.grantId, epoch: opened.epoch, exp: opened.expiresAt };
  const now = Date.now();
  // The owner's vault found the copy live by its own clock, a moment ago. If its last moment has
  // passed since, that is the copy ending, and the session below would say it as a 410.
  if (opened.expiresAt <= now) throw copyEnded();
  c.header("set-cookie", await createShareSession(c.env.SESSION_KEY, claims, now, shareCookieName(entry.grantId)), { append: true });
  c.header("set-cookie", await createShareSession(c.env.SESSION_KEY, claims, now), { append: true });
  return c.json({ grantId: entry.grantId });
});

// Takes a copy off the coach's own list. The owner's link is theirs to end.
api.delete("/coach/clients/:grantId", async (c) => {
  await myVault(c).removeCoachClient(c.get("who"), c.req.param("grantId"));
  return c.body(null, 204);
});

// A coach's comments on a client's copy. They are reached as the copy is opened from the list:
// the caller's own vault says which copy and where it is kept, the session says who is asking, and
// the copy's owner's vault checks that account in the transaction that reads or writes. Nothing
// here is served to the link's own session, which a sign-out everywhere doesn't end.

/** The copy as the caller's own list holds it, and the caller as its owner's vault is told of them. */
async function coachCopy(c: C) {
  const entry = await myVault(c).coachClient(c.get("who"), c.req.param("grantId") ?? "");
  if (!entry) throw new AppError("not_found", "no such client");
  return { entry, account: coachAccount(c) };
}

/** Shape only. Whether the copy holds the line or the fact is the owner's vault's to say. */
const CommentTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("line"), resumeId: z.string().min(1).max(100), version: z.number().int().positive(), lineId: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("fact"), factId: z.string().min(1).max(100) }).strict(),
]);

api.get("/coach/clients/:grantId/comments", async (c) => {
  const { entry, account } = await coachCopy(c);
  const threads: CommentThread[] = await unlessEnded(vault(c.env, entry.ownerVault).coachComments(entry.grantId, account));
  return c.json({ threads });
});
api.post("/coach/clients/:grantId/comments", JSON_LIMIT, async (c) => {
  const { entry, account } = await coachCopy(c);
  const input = await jsonBody(c, z.object({ target: CommentTarget, body: CommentBody }));
  const key = requestKey(c);
  return c.json(await unlessEnded(vault(c.env, entry.ownerVault).commentAsCoach(entry.grantId, account, input, key)), 201);
});
// Answers 204 whether or not anything of the caller's matched, as taking a copy off the list does.
api.delete("/coach/clients/:grantId/comments/:id", async (c) => {
  const { entry, account } = await coachCopy(c);
  await unlessEnded(vault(c.env, entry.ownerVault).removeCommentAsCoach(entry.grantId, account, c.req.param("id")));
  return c.body(null, 204);
});
app.post("/share/session", JSON_LIMIT, async (c) => {
  const { token } = await jsonBody(
    c,
    z.object({ token: z.string().max(4096) }),
  );
  const claims = await readShareToken(c.env.SESSION_KEY, token);
  if (!claims)
    throw new AppError("gone", "this share link is unavailable or expired");
  await vault(c.env, claims.vid).readShare({
    grantId: claims.grantId,
    epoch: claims.epoch,
  });
  const now = Date.now();
  // The copy's own cookie, and the single cookie that pages loaded before it existed still send.
  c.header(
    "set-cookie",
    await createShareSession(c.env.SESSION_KEY, claims, now, shareCookieName(claims.grantId)),
    { append: true },
  );
  c.header("set-cookie", await createShareSession(c.env.SESSION_KEY, claims, now), {
    append: true,
  });
  // Not a secret: it only says which of the reader's copies to open.
  return c.json({ grantId: claims.grantId });
});
app.get("/share/snapshot", async (c) => {
  // A page names the copy it wants, and that copy's own cookie has to open it. A page loaded before
  // copies had their own cookie names none and sends the single one.
  const wanted = c.req.query("g");
  const claims = await readShareToken(
    c.env.SESSION_KEY,
    getCookie(c, wanted === undefined ? SHARE_COOKIE : shareCookieName(wanted)),
    "coach-session",
  );
  if (
    !claims ||
    (wanted !== undefined && claims.grantId.toLowerCase() !== wanted.toLowerCase())
  )
    throw new AppError("gone", "this share link is unavailable or expired");
  // The owner looking at their own copy, signed in in the same browser, isn't the copy being opened.
  const own = await readSession(c.env.SESSION_KEY, getCookie(c, SESSION_COOKIE));
  const view = await vault(c.env, claims.vid).readShare(
    { grantId: claims.grantId, epoch: claims.epoch },
    own?.vid !== claims.vid,
    own?.email ? { userId: own.uid, email: own.email } : null,
  );
  // What the copy says about its named coach depends on who is reading. Its owner is told nothing,
  // and so is everyone when it names no coach.
  const { reviewer, ...copy } = view;
  let standing: SharedView["reviewer"] | null =
    reviewer === "none" || own?.vid === claims.vid
      ? null
      : reviewer === "named"
        ? own ? "sign-in-again" : "sign-in"
        : reviewer;
  // "joined" is the owner's vault saying this account took the copy up. Whether the copy is in the
  // account's client list is for the account's own vault to say. A copy taken off that list, or one
  // that never reached it, is read as not added: the page then offers to add it.
  if (standing === "joined" && own) {
    try {
      const listed = await vault(c.env, own.vid).coachClient({ userId: own.uid, gen: own.gen, epoch: own.epoch }, claims.grantId);
      if (!listed) standing = "you";
    } catch {
      // Their vault can't be asked: a session since signed out, or a vault that is away. The owner's
      // vault's word stands, as it did before this was asked, and the list it points to is where a
      // session that has ended is told so. Offering an add that same session can't make helps nobody.
    }
  }
  return c.json(standing ? { ...copy, reviewer: standing } : copy);
});
api.get("/billing", async (c) =>
  c.json(await myVault(c).billingInfo(c.get("who"))),
);
api.post("/billing/checkout", JSON_LIMIT, async (c) => {
  const { planId } = await jsonBody(
    c,
    z.object({ planId: z.string().max(40) }),
  );
  return c.json(
    await myVault(c).billingCheckout(c.get("who"), planId, requestKey(c)),
  );
});
api.post("/billing/checkout/cancel", async (c) => {
  await myVault(c).billingCancelCheckout(c.get("who"));
  return c.body(null, 204);
});
api.post("/billing/portal", async (c) =>
  c.json(await myVault(c).billingPortal(c.get("who"), requestKey(c))),
);
app.post(
  "/billing/webhook",
  bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge("This request is too large to process.") }),
  async (c) => {
    const cfg = billingConfig(c.env);
    if (!cfg) throw new AppError("unavailable", "billing is not configured");
    const payload = new Uint8Array(await c.req.arrayBuffer());
    if (
      !(await verifyStripe(
        payload,
        c.req.header("stripe-signature") ?? "",
        cfg.webhookSecret,
      ))
    )
      throw new AppError("forbidden", "invalid billing signature");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        payload,
      );
    } catch {
      throw new AppError("invalid", "billing payload is not UTF-8");
    }
    const event = parseStripeEvent(text);
    const customer = event.data.object.customer;
    if (typeof customer !== "string") return c.body(null, 204);
    const account = await stripeClient(cfg).customer(customer);
    const uid = account.metadata.account_uid;
    if (!uid) return c.body(null, 204);
    await directoryForUser(c.env, uid).acceptBillingEvent(event, uid);
    return c.body(null, 204);
  },
);
api.get("/mcp/grants", async (c) =>
  c.json({ grants: await myVault(c).listMcpGrants(c.get("who")) }),
);
api.delete("/mcp/grants/:id", async (c) => {
  const grant = await myVault(c).revokeMcpGrant(
    c.get("who"),
    c.req.param("id"),
  );
  if (grant.oauthGrantId)
    await revokeOAuthGrant(c.env, c.get("session").uid, grant.oauthGrantId);
  return c.body(null, 204);
});
app.route("/api", api);

// ------------------------------------------------------------------ admin (Cloudflare Access)

const admin = new Hono<AppEnv>();
admin.use("*", async (c, next) => {
  await verifyAccess(c.env, c.req.raw);
  await next();
});

admin.get("/vaults", async (c) => {
  const limit = Number(c.req.query("limit") ?? 50);
  const size = Math.min(200, Math.max(1, Number.isFinite(limit) ? limit : 50));
  const pages = await Promise.all(
    [...allDirectories(c.env)].map((d) =>
      d.listVaults({ after: c.req.query("after"), limit: size }),
    ),
  );
  return c.json({
    vaults: pages
      .flat()
      .sort((a, b) => a.vaultId.localeCompare(b.vaultId))
      .slice(0, size),
  });
});

admin.post("/vaults/:id/runs/:run/retry", async (c) =>
  c.json(
    await vault(c.env, c.req.param("id")).adminRetry(
      c.req.param("run"),
      requestKey(c),
    ),
    202,
  ),
);
admin.post("/vaults/:id/runs/:run/retry-current-extractor", async (c) =>
  c.json(
    await vault(c.env, c.req.param("id")).adminRetryCurrentExtractorV1(
      c.req.param("run"),
      requestKey(c),
      currentDefaultExtractor(c.env),
    ),
    202,
  ),
);

admin.get("/vaults/:id/extraction-feedback", async (c) =>
  c.json({
    sources: await vault(c.env, c.req.param("id")).extractionFeedback(),
  }),
);

admin.get("/vaults/:id/runs", async (c) =>
  c.json({ runs: await vault(c.env, c.req.param("id")).adminRuns() }),
);

admin.get("/invites", async (c) =>
  c.json({ invites: await directory(c.env).listInvites() }),
);

admin.post("/invites", JSON_LIMIT, async (c) => {
  const { email } = await jsonBody(c, z.object({ email: z.email() }));
  await directory(c.env).addInvite(email);
  return c.body(null, 201);
});

admin.delete("/invites/:email", async (c) => {
  const operation = c.req.header("Idempotency-Key") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operation))
    throw new AppError("invalid", "a UUID idempotency key is required");
  const result = await directory(c.env).revokeInviteV3(c.req.param("email"), operation);
  if (result.state === "complete") return c.body(null, 204);
  return c.json({ ...result, operationId: operation }, 202);
});

admin.get("/invites/revocations", async (c) => {
  const afterValues = c.req.queries("after"), limitValues = c.req.queries("limit");
  if ((afterValues?.length ?? 0) > 1 || (limitValues?.length ?? 0) > 1)
    throw new AppError("invalid", "invalid invitation inventory page");
  const rawLimit = limitValues?.[0];
  if (rawLimit !== undefined && !/^(?:[1-9]|[1-9]\d|100)$/.test(rawLimit))
    throw new AppError("invalid", "invalid invitation inventory page");
  return c.json(await directory(c.env).listInviteRevocations(afterValues?.[0] ?? null, rawLimit === undefined ? 25 : Number(rawLimit)));
});

admin.get("/invites/revocations/:operation/accounts", async (c) => {
  const afterValues = c.req.queries("after");
  const limitValues = c.req.queries("limit");
  if ((afterValues?.length ?? 0) > 1 || (limitValues?.length ?? 0) > 1)
    throw new AppError("invalid", "invalid invitation account page");
  const rawLimit = limitValues?.[0];
  if (rawLimit !== undefined && !/^(?:[1-9]|1\d|2[0-5])$/.test(rawLimit))
    throw new AppError("invalid", "invalid invitation account page");
  return c.json(await directory(c.env).inspectInviteRevocationAccountsV1(c.req.param("operation"), afterValues?.[0] ?? null, rawLimit === undefined ? 25 : Number(rawLimit)));
});

admin.get("/invites/revocations/:operation", async (c) => {
  const result = await directory(c.env).inviteRevocationStatus(c.req.param("operation"));
  if (result.state === "unknown") throw new AppError("not_found", "invitation revocation not found");
  return c.json(result);
});

admin.route("/", maintenance);
app.route("/admin", admin);

// ------------------------------------------------------------------ helpers

async function jsonBody<T>(c: C, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError("invalid", "expected a JSON body");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new AppError(
      "invalid",
      z.prettifyError(parsed.error).replace(/\s+/g, " ").slice(0, 300),
    );
  return parsed.data;
}

/** Keep filenames within the storage limit without splitting a Unicode code point. */
function safePrefix(value: string, maxUnits: number): string {
  const prefix = value.slice(0, maxUnits);
  return /[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix;
}

/** Preserve the original extension because conversion and routing depend on it. */
function uploadFilename(value: string, extension: string): string {
  if (value.length <= 200) return value;
  const suffix = `.${extension}`;
  return safePrefix(value, 200 - suffix.length) + suffix;
}

function fileName(text: string): string {
  return (
    text
      .replace(/[^\w\- ]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 80) || "resume"
  );
}

/** This recovery route targets the Worker's configured default LLM only. */
function currentDefaultExtractor(env: Env): string {
  const model = env.MODEL_EXTRACT;
  if (typeof model !== "string" || !model || model !== model.trim() || model.length > 196)
    throw new AppError("unavailable", "extraction configuration is not available");
  return `llm:${model}`;
}

function requestKey(c: C): string {
  const key = c.req.header("idempotency-key") ?? crypto.randomUUID();
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key))
    throw new AppError("invalid", "invalid request key");
  return key;
}
function versionQuery(c: C): number | undefined {
  const value = c.req.query("version");
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new AppError("invalid", "invalid document version");
  return Number(value);
}
