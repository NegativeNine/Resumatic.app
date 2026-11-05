import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { renderPdf } from "../render/pdf";
import { renderResumeHtml } from "../render/template";
import {
  DATE_PATTERN,
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
import { pdfKey, sourceKey } from "../shared/r2";
import { directory, vault } from "../shared/stubs";
import type { SignInInput, Who } from "../shared/types";
import { verifyAccess } from "./access";
import { sameSecret } from "./crypto";
import { beginLogin, clearOidcCookie, finishLogin, OIDC_COOKIE } from "./oidc";
import { clearSessionCookie, createSession, readSession, SESSION_COOKIE, sessionCookie, type Session } from "./session";

// The only HTTP surface. /auth/* and /admin/* may call the Directory; /api/* routes go
// straight to the caller's vault, addressed by the ID in their signed session cookie.

type AppEnv = { Bindings: Env; Variables: { session: Session; who: Who } };
type C = Context<AppEnv>;

export const app = new Hono<AppEnv>();

const tooLarge = (c: Context) => c.json({ error: "too_large", message: "the request body is too large" }, 413);
const JSON_LIMIT = bodyLimit({ maxSize: 64 * 1024, onError: tooLarge });
const UPLOAD_LIMIT = bodyLimit({ maxSize: MAX_UPLOAD_BYTES + 64 * 1024, onError: tooLarge });

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.status === 413 ? "too_large" : "invalid", message: err.message || "bad request" }, err.status);
  }
  const code = errorCode(err);
  if (code) return c.json({ error: code, message: errorDetail(err) }, httpStatus(code) as 400);
  console.error("unhandled error", { name: err instanceof Error ? err.name : "unknown", path: new URL(c.req.url).pathname });
  return c.json({ error: "internal", message: "something went wrong" }, 500);
});

app.notFound((c) => c.json({ error: "not_found", message: "no such route" }, 404));

// Security headers on every Worker response, and no caching of personal data.
app.use("*", async (c, next) => {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "same-origin");
  c.header("x-frame-options", "DENY");
  if (!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
});

// Writes must come from this site. SameSite=Lax cookies already block most cross-site writes.
app.use("*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) throw new AppError("forbidden", "cross-site request refused");
  }
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true }));

// ------------------------------------------------------------------ auth

app.get("/auth/login", async (c) => {
  const { location, cookie } = await beginLogin(c.env, new URL(c.req.url).origin);
  c.header("set-cookie", cookie);
  return c.redirect(location, 302);
});

app.get("/auth/callback", async (c) => {
  const url = new URL(c.req.url);
  c.header("set-cookie", clearOidcCookie(), { append: true });
  try {
    const { subject, email } = await finishLogin(c.env, url.origin, url.searchParams, getCookie(c, OIDC_COOKIE));
    const cookie = await startSession(c.env, { provider: "google", subject, email, hint: hintFor(cfOf(c)) });
    c.header("set-cookie", cookie, { append: true });
    return c.redirect("/", 302);
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
  // A revoked cookie must not be able to delete the account.
  await vault(c.env, s.vid).checkSession(c.get("who"));
  await directory(c.env).deleteAccount(s.uid);
  c.header("set-cookie", clearSessionCookie());
  return c.json({ deleting: true }, 202);
});

/** Staging only: exists when the TEST_SIGNIN_KEY secret is set, which production never has. */
app.post("/auth/test-login", JSON_LIMIT, async (c) => {
  const key = c.env.TEST_SIGNIN_KEY;
  if (!key) return c.json({ error: "not_found", message: "no such route" }, 404);
  if (!sameSecret(c.req.header("x-test-signin-key") ?? "", key)) throw new AppError("forbidden", "wrong test key");
  const { email } = await jsonBody(c, z.object({ email: z.email() }));
  const cookie = await startSession(c.env, { provider: "test", subject: email.toLowerCase(), email, hint: hintFor(cfOf(c)) });
  c.header("set-cookie", cookie);
  return c.body(null, 204);
});

async function startSession(env: Env, input: SignInInput): Promise<string> {
  if (!env.SESSION_KEY) throw new AppError("unavailable", "sessions are not configured");
  const { userId, vaultId } = await directory(env).signIn(input);
  const { gen } = await vault(env, vaultId).openSession(userId);
  return sessionCookie(await createSession(env.SESSION_KEY, { uid: userId, vid: vaultId, gen }));
}

function cfOf(c: C): CfLocation | undefined {
  return (c.req.raw as Request & { cf?: CfLocation }).cf;
}

// ------------------------------------------------------------------ api (session required)

function requireSession(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const s = await readSession(c.env.SESSION_KEY, getCookie(c, SESSION_COOKIE));
    if (!s) throw new AppError("unauthenticated", "sign in to continue");
    c.set("session", s);
    c.set("who", { userId: s.uid, gen: s.gen });
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

const roleDate = z.string().regex(DATE_PATTERN, "use a year, or a year and month such as 2021-03").nullable();

const NewRoleBody = z.object({
  kind: z.enum(ROLE_KINDS as [RoleKind, ...RoleKind[]]),
  org: z.string().trim().min(1).max(200),
  title: z.string().trim().max(200).nullable(),
  startDate: roleDate,
  endDate: roleDate,
});

const RolePatch = NewRoleBody.partial();

const FactPatchBody = z
  .object({
    text: z.string().trim().min(1).max(MAX_FACT_CHARS),
    roleId: z.string().max(64).nullable(),
  })
  .partial()
  .refine((p) => p.text !== undefined || p.roleId !== undefined, "change the text, the role, or both");

const NewFactBody = z.object({
  roleId: z.string().max(64).nullable(),
  kind: z.enum(FACT_KINDS as [FactKind, ...FactKind[]]),
  text: z.string().trim().min(1).max(MAX_FACT_CHARS),
  level: z.enum(LEVELS as [Level, ...Level[]]).nullable(),
});

const Ids = z.array(z.string().max(64)).max(1000);

api.get("/me", async (c) => c.json(await myVault(c).me(c.get("who"))));

api.get("/profile", async (c) => c.json(await myVault(c).getProfile(c.get("who"))));

api.put("/profile", JSON_LIMIT, async (c) => c.json(await myVault(c).updateProfile(c.get("who"), await jsonBody(c, ProfilePatch))));

api.post("/account/sign-out-everywhere", async (c) => {
  await myVault(c).signOutEverywhere(c.get("who"));
  c.header("set-cookie", clearSessionCookie());
  return c.body(null, 204);
});

const ALLOWED_UPLOADS: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

api.post("/sources", UPLOAD_LIMIT, async (c) => {
  const form = await c.req.formData().catch(() => {
    throw new AppError("invalid", "expected a multipart upload");
  });
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("invalid", "attach the file as the \"file\" field");
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const contentType = ALLOWED_UPLOADS[extension];
  if (!contentType) throw new AppError("invalid", "upload a PDF or DOCX file");
  if (file.size === 0) throw new AppError("invalid", "the file is empty");
  if (file.size > MAX_UPLOAD_BYTES) throw new AppError("too_large", "files can be at most 10 MB");

  const key = sourceKey(c.get("session").vid, crypto.randomUUID());
  await c.env.FILES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType } });
  try {
    const { sourceId } = await myVault(c).addSource(c.get("who"), { filename: file.name.slice(0, 200), r2Key: key });
    return c.json({ sourceId }, 201);
  } catch (e) {
    await c.env.FILES.delete(key);
    throw e;
  }
});

api.get("/sources", async (c) => c.json({ sources: await myVault(c).listSources(c.get("who")) }));

/** The original upload, as the user sent it. */
api.get("/sources/:id/file", async (c) => {
  const { r2Key, filename } = await myVault(c).sourceFile(c.get("who"), c.req.param("id"));
  const object = await c.env.FILES.get(r2Key);
  if (!object) throw new AppError("not_found", "the file is no longer stored");
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  const name = `${fileName(filename.replace(/\.[^.]*$/, ""))}${ALLOWED_UPLOADS[extension] ? `.${extension}` : ""}`;
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "private, no-store",
    },
  });
});

api.get("/roles", async (c) => c.json({ roles: await myVault(c).listRoles(c.get("who")) }));

api.post("/roles", JSON_LIMIT, async (c) => c.json(await myVault(c).addRole(c.get("who"), await jsonBody(c, NewRoleBody)), 201));

api.patch("/roles/:id", JSON_LIMIT, async (c) => {
  await myVault(c).editRole(c.get("who"), c.req.param("id"), await jsonBody(c, RolePatch));
  return c.body(null, 204);
});

api.get("/facts", async (c) => {
  const state = c.req.query("state");
  if (state && !["proposed", "confirmed", "rejected"].includes(state)) throw new AppError("invalid", "unknown state");
  return c.json({ facts: await myVault(c).listFacts(c.get("who"), state as ReviewState | undefined) });
});

api.post("/facts", JSON_LIMIT, async (c) => c.json(await myVault(c).addFact(c.get("who"), await jsonBody(c, NewFactBody)), 201));

api.patch("/facts/:id", JSON_LIMIT, async (c) => {
  await myVault(c).editFact(c.get("who"), c.req.param("id"), await jsonBody(c, FactPatchBody));
  return c.body(null, 204);
});

api.post("/review", JSON_LIMIT, async (c) => {
  await myVault(c).review(c.get("who"), await jsonBody(c, z.object({ confirm: Ids, reject: Ids })));
  return c.body(null, 204);
});

api.post("/applications", JSON_LIMIT, async (c) => {
  const { jdText } = await jsonBody(c, z.object({ jdText: z.string().trim().min(40, "paste the whole job description").max(MAX_JD_CHARS) }));
  return c.json(await myVault(c).addApplication(c.get("who"), jdText), 201);
});

api.get("/applications", async (c) => c.json({ applications: await myVault(c).listApplications(c.get("who")) }));

api.post("/applications/:id/resumes", async (c) => c.json(await myVault(c).tailor(c.get("who"), c.req.param("id")), 202));

api.get("/resumes/:id", async (c) => c.json(await myVault(c).getResume(c.get("who"), c.req.param("id"))));

api.patch("/resumes/:id/lines/:lineId", JSON_LIMIT, async (c) => {
  const { text } = await jsonBody(c, z.object({ text: z.string().trim().min(1).max(MAX_LINE_CHARS) }));
  await myVault(c).editLine(c.get("who"), c.req.param("id"), c.req.param("lineId"), text);
  return c.body(null, 204);
});

/** Renders once per resume version and serves the cached PDF after that. */
api.get("/resumes/:id/pdf", async (c) => {
  const resumeId = c.req.param("id");
  const data = await myVault(c).renderData(c.get("who"), resumeId);
  const key = pdfKey(c.get("session").vid, resumeId, data.version);
  let pdf: ArrayBuffer | Uint8Array;
  const cached = await c.env.FILES.get(key);
  if (cached) {
    pdf = await cached.arrayBuffer();
  } else {
    pdf = await renderPdf(c.env, renderResumeHtml(data));
    await c.env.FILES.put(key, pdf, { httpMetadata: { contentType: "application/pdf" } });
  }
  const name = fileName([data.profile.name, data.company].filter(Boolean).join(" ") || "resume");
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
  const data = await myVault(c).renderData(c.get("who"), c.req.param("id"));
  return new Response(renderResumeHtml(data), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox",
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

app.route("/api", api);

// ------------------------------------------------------------------ admin (Cloudflare Access)

const admin = new Hono<AppEnv>();
admin.use("*", async (c, next) => {
  await verifyAccess(c.env, c.req.raw);
  await next();
});

admin.get("/vaults", async (c) => {
  const limit = Number(c.req.query("limit") ?? 50);
  return c.json({ vaults: await directory(c.env).listVaults({ after: c.req.query("after"), limit: Number.isFinite(limit) ? limit : 50 }) });
});

admin.get("/invites", async (c) => c.json({ invites: await directory(c.env).listInvites() }));

admin.post("/invites", JSON_LIMIT, async (c) => {
  const { email } = await jsonBody(c, z.object({ email: z.email() }));
  await directory(c.env).addInvite(email);
  return c.body(null, 201);
});

admin.delete("/invites/:email", async (c) => {
  await directory(c.env).removeInvite(c.req.param("email"));
  return c.body(null, 204);
});

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
  if (!parsed.success) throw new AppError("invalid", z.prettifyError(parsed.error).replace(/\s+/g, " ").slice(0, 300));
  return parsed.data;
}

function fileName(text: string): string {
  return text.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 80) || "resume";
}
