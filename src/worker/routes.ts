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
import { uploadDescriptorDigest } from "../vault/uploads";
import { renderPdf } from "../render/pdf";
import { PILOT_IDENTITY_PATHS, PILOT_MAX_CALLS, PILOT_MAX_MICROS } from "./pilot/ledger";
import { stagingPilotBudget } from "./pilot/access";
import { createArchive, MAX_ARCHIVE_BYTES, type ArchiveEntry } from "../render/archive";
import { guardedStream } from "./guarded-stream";
import { cacheFenceEnabled, putExportCache } from "./cache-write";
import { billingConfig } from "../shared/billing";
import { verifyStripe, parseStripeEvent, stripeClient } from "./billing";
import {
  createShareToken,
  readShareToken,
  createShareSession,
  shareLink,
  SHARE_COOKIE,
} from "./shares";
import { renderDocx, textDocx } from "../render/docx";
import { renderResumeHtml } from "../render/template";
import {
  DATE_PATTERN,
  APPLICATION_STATUSES,
  FACT_KINDS,
  LEVELS,
  MAX_FACT_CHARS,
  MAX_JD_CHARS,
  MAX_LINE_CHARS,
  MAX_UPLOAD_BYTES,
  ROLE_KINDS,
  type FactKind,
  type Level,
  type ReviewState,
  type RoleKind,
} from "../shared/api";
import { AppError, errorCode, errorDetail, httpStatus } from "../shared/errors";
import { hintFor, type CfLocation } from "../shared/location";
import { docxKey, pdfKey, sourceKey } from "../shared/r2";
import { directoryForSignIn, settleRoutedPlacement } from "../directory/routing";
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

const tooLarge = (c: Context) =>
  c.json({ error: "too_large", message: "the request body is too large" }, 413);
const JSON_LIMIT = bodyLimit({ maxSize: 64 * 1024, onError: tooLarge });
const UPLOAD_LIMIT = bodyLimit({
  maxSize: MAX_UPLOAD_BYTES + 64 * 1024,
  onError: tooLarge,
});

app.onError((err, c) => {
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
  console.error("unhandled error", {
    name: err instanceof Error ? err.name : "unknown",
    route: httpRoute(new URL(c.req.url).pathname),
  });
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
  const { location, cookie } = await beginLogin(
    c.env,
    new URL(c.req.url).origin,
    c.req.query("returnTo"),
  );
  c.header("set-cookie", cookie);
  return c.redirect(location, 302);
});

app.get("/auth/callback", async (c) => {
  const url = new URL(c.req.url);
  c.header("set-cookie", clearOidcCookie(), { append: true });
  try {
    const { subject, email, authExpiryMs, returnTo } = await finishLogin(
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
app.get("/auth/test/pilot-budget/status", async (c) => c.json(await pilotBudget(c).status()));

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
  let account: { userId: string; vaultId: string };
  try {
    account = await target.directory.signIn(target.input);
  } finally {
    await settleRoutedPlacement(env, target.directory, target.input);
  }
  const { userId, vaultId } = account;
  if (input.authExpiryMs !== undefined) requireFreshAuth(input.authExpiryMs);
  await directory(env).bindIdentityHome(input.provider, input.subject, userId);
  if (input.authExpiryMs !== undefined) requireFreshAuth(input.authExpiryMs);
  const { gen, epoch } = await vault(env, vaultId).openSession(userId);
  const cookie = sessionCookie(
    await createSession(env.SESSION_KEY, {
      uid: userId,
      vid: vaultId,
      gen,
      epoch,
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
  return c.json({ ...me, capabilities: {
    ocr: me.capabilities?.ocr ?? false,
    connectedApps: me.capabilities?.connectedApps ?? false,
    // Both this Worker and the Vault must understand v2 writes.
    roleDateUnknownEnd: c.env.ROLE_UNKNOWN_END_ENABLED === "true" && me.capabilities?.roleDateUnknownEnd === true,
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
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const contentType = ALLOWED_UPLOADS[extension];
  if (!contentType)
    throw new AppError(
      "invalid",
      "upload a PDF, DOCX, or LinkedIn export ZIP file",
    );
  if (file.size === 0) throw new AppError("invalid", "the file is empty");
  if (file.size > MAX_UPLOAD_BYTES)
    throw new AppError("too_large", "files can be at most 10 MB");

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
  };
  const reserved = await myVault(c).reserveUpload(c.get("who"), descriptor);
  if (reserved.intent.state === "complete")
    return c.json({ sourceId: reserved.intent.sourceId }, 201);
  await c.env.FILES.put(descriptor.r2Key, bytes, {
    httpMetadata: { contentType },
  });
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
  bodyLimit({ maxSize: 12 * 1024 * 1024, onError: tooLarge }),
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
    await c.env.FILES.put(descriptor.r2Key, JSON.stringify(input), {
      httpMetadata: { contentType: "application/json" },
    });
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

api.post("/applications", JSON_LIMIT, async (c) => {
  const { jdText } = await jsonBody(
    c,
    z.object({
      jdText: z
        .string()
        .trim()
        .min(40, "paste the whole job description")
        .max(MAX_JD_CHARS),
    }),
  );
  return c.json(await myVault(c).addApplication(c.get("who"), jdText), 201);
});

api.get("/applications", async (c) =>
  c.json({ applications: await myVault(c).listApplications(c.get("who")) }),
);

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
  const key = pdfKey(c.get("session").vid, resumeId, data.version, hasUnknownEndDates);
  let pdf: ArrayBuffer | Uint8Array;
  const cached = await c.env.FILES.get(key);
  if (cached) {
    pdf = await cached.arrayBuffer();
  } else {
    pdf = await renderPdf(c.env, renderResumeHtml(data));
    await putExportCache(c.env.FILES, myVault(c), c.get("who"), key, pdf, "pdf", cacheFenceEnabled(c.env));
  }
  try {
    await myVault(c).checkSession(c.get("who"));
  } catch (error) {
    await c.env.FILES.delete(key);
    throw error;
  }
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
  const data = await myVault(c).exportAll(c.get("who"));
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="resumatic-export-${data.exportedAt.slice(0, 10)}.json"`,
      "cache-control": "private, no-store",
    },
  });
});

/** Download a bounded point-in-time vault snapshot and the referenced original objects. */
api.get("/export/archive", async (c) => {
  const v = myVault(c);
  const who = c.get("who");
  const snapshot = await v.exportArchiveSnapshot(who);
  if (snapshot.files.length > 128)
    throw new AppError("too_large", "too many files for one archive; download the originals individually");

  const entries: ArchiveEntry[] = [];
  let bytes = 0;
  for (const file of snapshot.files) {
    // IDs are generated by the Vault; reject corrupt values rather than making an unsafe ZIP path.
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(file.id))
      throw new AppError("unavailable", "a source identifier cannot be exported");
    const extension = file.origin === "ocr" ? "json" : file.filename.split(".").pop()?.toLowerCase();
    const safeExtension = extension && ["pdf", "docx", "zip", "json"].includes(extension) ? extension : "bin";
    const path = `sources/${file.id}.${safeExtension}`;
    const source = snapshot.data.sources.find((item) => item.id === file.id);
    if (!source) throw new AppError("unavailable", "the source snapshot is incomplete");
    source.file = path;
    const head = await c.env.FILES.head(file.key);
    if (!head) throw new AppError("conflict", "an original file is missing; download the available files individually");
    const fileLimit = file.origin === "ocr" ? 12 * 1024 * 1024 + 1024 : MAX_UPLOAD_BYTES;
    if (!Number.isSafeInteger(head.size) || head.size < 0 || head.size > fileLimit || head.size > MAX_ARCHIVE_BYTES - bytes)
      throw new AppError("too_large", "the export exceeds the archive size limit; download the originals individually");
    bytes += head.size;
    const etag = head.etag;
    entries.push({
      name: path,
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
  const json = new TextEncoder().encode(JSON.stringify(snapshot.data, null, 2));
  if (json.byteLength > MAX_ARCHIVE_BYTES - bytes)
    throw new AppError("too_large", "the export exceeds the archive size limit; download the originals individually");
  entries.unshift({ name: "vault.json", size: json.byteLength, open: async () => {
    await v.checkSession(who);
    let position = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          await v.checkSession(who);
          if (position === json.byteLength) return controller.close();
          const end = Math.min(position + 64 * 1024, json.byteLength);
          controller.enqueue(json.subarray(position, end));
          position = end;
        } catch (error) { controller.error(error); }
      },
    }, { highWaterMark: 0 });
  } });
  // Closure can race the metadata preflight. Check once more before sending headers.
  await v.checkSession(who);
  const body = createArchive(entries, { signal: c.req.raw.signal, maxEntries: 129 });
  return new Response(body, { headers: {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="resumatic-export-${snapshot.data.exportedAt.slice(0, 10)}.zip"`,
    "cache-control": "private, no-store",
  } });
});

api.get("/resumes/:id/docx", async (c) => {
  const data = await myVault(c).renderData(
    c.get("who"),
    c.req.param("id"),
    versionQuery(c),
  );
  const hasUnknownEndDates = data.body.sections.some((s) => !!s.unknownEndStartDate);
  const key = docxKey(c.get("session").vid, c.req.param("id"), data.version, hasUnknownEndDates);
  const stored = await c.env.FILES.get(key);
  const bytes = stored ? await stored.arrayBuffer() : renderDocx(data);
  if (!stored)
    await putExportCache(c.env.FILES, myVault(c), c.get("who"), key, bytes, "docx", cacheFenceEnabled(c.env));
  try {
    await myVault(c).checkSession(c.get("who"));
  } catch (error) {
    await c.env.FILES.delete(key);
    throw error;
  }
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
    throw new AppError("conflict", "the document is not ready");
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
      kind: z.enum(["refine", "letter", "prep", "questions"]),
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
      expiresAt: z.number().int().positive().optional(),
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
  c.header("set-cookie", await createShareSession(c.env.SESSION_KEY, claims));
  return c.body(null, 204);
});
app.get("/share/snapshot", async (c) => {
  const claims = await readShareToken(
    c.env.SESSION_KEY,
    getCookie(c, SHARE_COOKIE),
    "coach-session",
  );
  if (!claims)
    throw new AppError("gone", "this share link is unavailable or expired");
  return c.json(
    await vault(c.env, claims.vid).readShare({
      grantId: claims.grantId,
      epoch: claims.epoch,
    }),
  );
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
  bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge }),
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
    await directoryForUser(c.env, uid).acceptBillingEvent(event);
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
  await directory(c.env).removeInvite(c.req.param("email"));
  return c.body(null, 204);
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
