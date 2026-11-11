import {
  AuthorizationError,
  CimdFetchError,
  OAuthAuthorizationServer,
  OAuthError,
  OAuthResourceServer,
  insufficientScope,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { MAX_JD_CHARS, MAX_URL_CHARS, MIN_JD_CHARS, isWebUrl } from "../shared/api";
import { errorCode } from "../shared/errors";
import {
  MCP_GRANT_TTL_MS,
  MCP_SCOPES,
  McpClaimsSchema,
  oauthSubject,
  type McpClaims,
  type McpGrant,
  type McpScope,
  type NewMcpGrant,
} from "../shared/mcp";
import { vault } from "../shared/stubs";
import type { Who } from "../shared/types";
import { signToken, verifyToken } from "./crypto";
import { readSession, SESSION_COOKIE } from "./session";

export interface McpVault {
  mcpIdentity(who: Who): Promise<{ epoch: string }>;
  createMcpGrant(who: Who, grant: NewMcpGrant): Promise<McpGrant>;
  bindMcpGrant(claims: McpClaims, oauthGrantId: string): Promise<void>;
  listMcpGrants(who: Who): Promise<McpGrant[]>;
  revokeMcpGrant(
    who: Who,
    id: string,
  ): Promise<{ oauthGrantId: string | null }>;
  authorizeMcp(claims: McpClaims, scope: McpScope): Promise<Who>;
  mcpFacts(
    claims: McpClaims,
    input: { query?: string; limit?: number },
  ): Promise<unknown>;
  mcpResume(claims: McpClaims, id: string, version?: number): Promise<unknown>;
  mcpJobs(claims: McpClaims, input: { limit?: number }): Promise<unknown>;
  mcpAddJob(
    claims: McpClaims,
    input: { description: string; url: string | null },
    requestKey: string,
  ): Promise<unknown>;
  mcpTailor(
    claims: McpClaims,
    applicationId: string,
    requestKey: string,
  ): Promise<unknown>;
}
type McpEnvironment = Env & {
  OAUTH_KV?: KVNamespace;
  MCP_ENABLED?: string;
  MCP_ALLOWED_ORIGINS?: string;
};
const localVault = (env: Env, vid: string) =>
  vault(env, vid) as unknown as McpVault;
const Scope = z.enum(MCP_SCOPES);
const CookieBinding = z
  .object({
    kind: z.literal("mcp-consent"),
    uid: z.string(),
    vid: z.string(),
    gen: z.number(),
    epoch: z.string(),
    hash: z.string(),
    exp: z.number(),
  })
  .strict();
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const cookie = (request: Request, name: string) =>
  request.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const privateHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

async function boundedRequest(
  request: Request,
  maximum = 65_536,
): Promise<Request | null> {
  if (!request.body) return request;
  if (Number(request.headers.get("content-length")) > maximum) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request, { body });
}

function configured(
  env: McpEnvironment,
  requireEnabled = true,
): { origin: string; origins: string[] } | null {
  if (
    (requireEnabled && env.MCP_ENABLED !== "true") ||
    !env.OAUTH_KV ||
    !env.APP_ORIGIN
  )
    return null;
  try {
    const url = new URL(env.APP_ORIGIN);
    if (
      url.protocol !== "https:" ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      return null;
    const origins = [
      url.origin,
      ...(env.MCP_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ];
    if (
      origins.some((value) => {
        const origin = new URL(value);
        return origin.origin !== value || origin.protocol !== "https:";
      })
    )
      return null;
    return { origin: url.origin, origins };
  } catch {
    return null;
  }
}

function authorizationServer(env: McpEnvironment, origin: string) {
  return new OAuthAuthorizationServer<McpEnvironment>({
    issuer: origin,
    resources: [`${origin}/mcp`],
    authorizeEndpoint: "/oauth/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [...MCP_SCOPES],
    accessTokenTTL: 3600,
    refreshTokenTTL: MCP_GRANT_TTL_MS / 1000,
    clientRegistrationTTL: 90 * 24 * 60 * 60,
    allowTokenExchangeGrant: false,
    async tokenExchangeCallback(options) {
      const parsed = McpClaimsSchema.safeParse(options.props);
      if (
        !parsed.success ||
        oauthSubject(parsed.data.uid) !== options.userId ||
        parsed.data.clientId !== options.clientId ||
        options.requestedScope.some(
          (s) => !parsed.data.scopes.includes(s as McpScope),
        )
      )
        throw new OAuthError("invalid_grant", {
          description: "Connected app authorization is invalid",
        });
      const claims = parsed.data;
      try {
        await localVault(env, claims.vid).bindMcpGrant(claims, options.grantId);
        await localVault(env, claims.vid).authorizeMcp(claims, "vault:read");
      } catch (error) {
        if (
          ["unauthenticated", "forbidden", "gone"].includes(
            errorCode(error) ?? "",
          )
        )
          throw new OAuthError("invalid_grant", {
            description: "Connected app access has ended",
          });
        throw new OAuthError("temporarily_unavailable", {
          description: "Account access is temporarily unavailable",
          statusCode: 503,
        });
      }
      const remaining = Math.floor((claims.expiresAt - Date.now()) / 1000);
      if (remaining < 60)
        throw new OAuthError("invalid_grant", {
          description: "Connected app access has expired",
        });
      return {
        accessTokenTTL: Math.min(3600, remaining),
        refreshTokenTTL: claims.scopes.includes("offline_access")
          ? remaining
          : 0,
      };
    },
    // Never log provider error detail, client URLs, authorization headers, or credential bodies.
    onError() {},
  });
}

function consentPage(details: ConsentDescription, handle: string): string {
  const domain = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app's name is self-reported.";
  const generate = details.scope.includes("vault:generate")
    ? '<p><label><input type="checkbox" name="scope" value="vault:generate"> Generate resumes using my plan quota</label></p>'
    : "";
  const jobs = details.scope.includes("vault:jobs")
    ? '<p><label><input type="checkbox" name="scope" value="vault:jobs"> See my saved jobs and add new ones</label></p>'
    : "";
  const offline = details.scope.includes("offline_access")
    ? '<p><label><input type="checkbox" name="scope" value="offline_access"> Keep access for up to 30 days</label></p>'
    : "";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect an app · Resumatic</title><main><h1>Connect ${escapeHtml(details.clientName)}</h1><p>${domain} Access returns to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>${details.redirectIsLoopback ? "<p><strong>This connects an app on your computer.</strong> Continue only if you started this connection.</p>" : ""}<p>The app can read your confirmed facts and finished resumes. Original uploads, evidence quotes, private application notes and facts you've marked sensitive are excluded. You can revoke access in Account.</p><form method="post"><input type="hidden" name="handle" value="${escapeHtml(handle)}"><p><label><input type="checkbox" name="scope" value="vault:read" checked required> Read confirmed facts and finished resumes</label></p>${jobs}${generate}${offline}<p><button name="decision" value="approve">Connect app</button> <button name="decision" value="deny" formnovalidate>Cancel</button></p></form></main></html>`;
}

async function handleHash(handle: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(handle),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function authorize(
  request: Request,
  env: McpEnvironment,
  origin: string,
): Promise<Response> {
  const oauth = authorizationServer(env, origin).getOAuthApi(env);
  const session = await readSession(
    env.SESSION_KEY,
    cookie(request, SESSION_COOKIE),
  );
  const who = session
    ? {
        userId: session.uid,
        gen: session.gen,
        epoch: (session as { epoch?: string }).epoch ?? "legacy",
      }
    : null;
  const current =
    session && who ? await localVault(env, session.vid).mcpIdentity(who) : null;
  if (request.method === "GET") {
    const authRequest = await oauth.parseAuthRequest(request);
    if (!session || !who || !current) {
      const returnTo = `${new URL(request.url).pathname}${new URL(request.url).search}`;
      return new Response(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign in · Resumatic</title><main><h1>Sign in to connect an app</h1><p><a href="/auth/login?returnTo=${escapeHtml(encodeURIComponent(returnTo))}">Continue with Google</a></p></main></html>`,
        {
          headers: {
            ...privateHeaders,
            "content-type": "text/html; charset=utf-8",
          },
        },
      );
    }
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    const hash = await handleHash(consent.handle);
    const token = await signToken(`mcp-consent:${env.SESSION_KEY}`, {
      kind: "mcp-consent",
      uid: session.uid,
      vid: session.vid,
      gen: session.gen,
      epoch: current.epoch,
      hash,
      exp: Date.now() + 600_000,
    });
    consent.headers.append(
      "set-cookie",
      `__Host-resumatic-consent-${hash.slice(0, 16)}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
    );
    for (const [key, value] of Object.entries(privateHeaders))
      consent.headers.set(key, value);
    consent.headers.set("content-type", "text/html; charset=utf-8");
    return new Response(consentPage(details, consent.handle), {
      headers: consent.headers,
    });
  }
  if (request.method !== "POST")
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, POST", ...privateHeaders },
    });
  if (
    !session ||
    !who ||
    !current ||
    request.headers.get("origin") !== origin ||
    !request.headers
      .get("content-type")
      ?.startsWith("application/x-www-form-urlencoded")
  )
    return new Response("Start this connection again.", {
      status: 403,
      headers: privateHeaders,
    });
  const body = await request.arrayBuffer();
  if (body.byteLength > 16_384)
    return new Response(null, { status: 413, headers: privateHeaders });
  const form = new URLSearchParams(new TextDecoder().decode(body));
  const handle = form.get("handle") ?? "";
  if (handle.length > 4096)
    return new Response(null, { status: 400, headers: privateHeaders });
  const hash = await handleHash(handle);
  const cookieName = `__Host-resumatic-consent-${hash.slice(0, 16)}`;
  const binding = CookieBinding.safeParse(
    await verifyToken<unknown>(
      `mcp-consent:${env.SESSION_KEY}`,
      cookie(request, cookieName),
    ),
  );
  if (
    !binding.success ||
    binding.data.exp <= Date.now() ||
    binding.data.hash !== hash ||
    binding.data.uid !== session.uid ||
    binding.data.vid !== session.vid ||
    binding.data.gen !== session.gen ||
    binding.data.epoch !== current.epoch
  )
    return new Response("Start this connection again.", {
      status: 403,
      headers: privateHeaders,
    });
  const finish = (headers: Headers) => {
    headers.append(
      "set-cookie",
      `${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
    for (const [key, value] of Object.entries(privateHeaders))
      headers.set(key, value);
    return new Response(null, { status: 302, headers });
  };
  if (form.get("decision") !== "approve")
    return finish((await oauth.denyConsent(request, handle)).headers);
  const scopes = z.array(Scope).max(MCP_SCOPES.length).safeParse(form.getAll("scope"));
  if (
    !scopes.success ||
    !scopes.data.includes("vault:read") ||
    new Set(scopes.data).size !== scopes.data.length
  )
    return new Response("Select valid permissions.", {
      status: 400,
      headers: privateHeaders,
    });
  const approved = await oauth.approveConsent(request, handle, {
    scope: scopes.data,
  });
  const details = await oauth.describeConsent(approved.request);
  const grant = await localVault(env, session.vid).createMcpGrant(who, {
    id: crypto.randomUUID(),
    clientId: approved.request.clientId,
    clientName: details.clientName.slice(0, 200),
    scopes: scopes.data,
    expiresAt:
      Date.now() +
      (scopes.data.includes("offline_access") ? MCP_GRANT_TTL_MS : 3_600_000),
  });
  const claims: McpClaims = {
    uid: session.uid,
    vid: session.vid,
    gen: grant.gen,
    epoch: grant.epoch,
    grantId: grant.id,
    clientId: grant.clientId,
    scopes: grant.scopes,
    expiresAt: grant.expiresAt,
  };
  try {
    const completed = await oauth.completeAuthorization({
      request: approved.request,
      userId: oauthSubject(session.uid),
      metadata: { localGrantId: grant.id },
      scope: grant.scopes,
      props: claims,
      revokeExistingGrants: false,
    });
    approved.headers.set("location", completed.redirectTo);
    return finish(approved.headers);
  } catch (error) {
    await localVault(env, session.vid).revokeMcpGrant(who, grant.id);
    throw error;
  }
}

function serverFor(env: Env, claims: McpClaims): McpServer {
  const server = new McpServer({ name: "resumatic", version: "1.0.0" });
  const reply = (result: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
  });
  const run = async (scope: McpScope, action: () => Promise<unknown>) => {
    try {
      await localVault(env, claims.vid).authorizeMcp(claims, scope);
      return reply(await action());
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              errorCode(error) === "quota"
                ? "The account's generation limit has been reached."
                : "This operation is unavailable or permission has ended.",
          },
        ],
      };
    }
  };
  server.registerTool(
    "list_facts",
    {
      description:
        "Read confirmed career facts. Excludes original uploads, evidence quotes, private notes and facts marked sensitive.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(50),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ limit }) =>
      run("vault:read", () =>
        localVault(env, claims.vid).mcpFacts(claims, { limit }),
      ),
  );
  server.registerTool(
    "search_facts",
    {
      description:
        "Search confirmed facts by words without making a model call. Excludes original uploads, evidence quotes, private notes and facts marked sensitive.",
      inputSchema: z.object({
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ query, limit }) =>
      run("vault:read", () =>
        localVault(env, claims.vid).mcpFacts(claims, { query, limit }),
      ),
  );
  server.registerTool(
    "get_resume",
    {
      description:
        "Read a finished resume version. Edited wording is labelled user-authored.",
      inputSchema: z.object({
        id: z.uuid(),
        version: z.number().int().min(1).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ id, version }) =>
      run("vault:read", () =>
        localVault(env, claims.vid).mcpResume(claims, id, version),
      ),
  );
  if (claims.scopes.includes("vault:jobs")) {
    server.registerTool(
      "list_jobs",
      {
        description:
          "List saved jobs, newest first, with each job's resumes. Use a job's id with start_tailoring and a resume's id with get_resume. Private notes and the full posting are not included.",
        inputSchema: z.object({
          limit: z.number().int().min(1).max(100).default(50),
        }),
        annotations: { readOnlyHint: true },
      },
      ({ limit }) =>
        run("vault:jobs", () =>
          localVault(env, claims.vid).mcpJobs(claims, { limit }),
        ),
    );
    server.registerTool(
      "add_job",
      {
        description:
          "Save a job from its description, the whole posting as text. If the same posting is already saved, that job is returned and nothing is added. Reuse requestKey when retrying the same request.",
        inputSchema: z.object({
          description: z.string().trim().min(MIN_JD_CHARS).max(MAX_JD_CHARS),
          url: z.string().trim().max(MAX_URL_CHARS).refine(isWebUrl, "must be an http or https address").optional(),
          requestKey: z.uuid(),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      ({ description, url, requestKey }) =>
        run("vault:jobs", () =>
          localVault(env, claims.vid).mcpAddJob(claims, { description, url: url ?? null }, requestKey),
        ),
    );
  }
  if (claims.scopes.includes("vault:generate"))
    server.registerTool(
      "start_tailoring",
      {
        description:
          "Generate a resume for a saved job: applicationId is the job's id, as list_jobs returns it. Uses the account's generation quota. Reuse requestKey when retrying the same request.",
        inputSchema: z.object({
          applicationId: z.uuid(),
          requestKey: z.uuid(),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      ({ applicationId, requestKey }) =>
        run("vault:generate", () =>
          localVault(env, claims.vid).mcpTailor(
            claims,
            applicationId,
            requestKey,
          ),
        ),
    );
  return server;
}

/** Compose before Hono; return null for routes belonging to the existing application. */
export async function handleMcp(
  request: Request,
  env: McpEnvironment,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const resourceRoute =
    url.pathname === "/mcp" ||
    url.pathname === "/.well-known/oauth-protected-resource/mcp";
  const authorizationRoute =
    url.pathname.startsWith("/oauth/") ||
    url.pathname === "/.well-known/oauth-authorization-server";
  if (!resourceRoute && !authorizationRoute) return null;
  const config = configured(env);
  if (!config)
    return new Response("Connected apps are not configured.", {
      status: 503,
      headers: privateHeaders,
    });
  if (url.origin !== config.origin)
    return new Response(null, { status: 404, headers: privateHeaders });
  try {
    const bounded = await boundedRequest(request);
    if (!bounded)
      return new Response("Request is too large.", {
        status: 413,
        headers: privateHeaders,
      });
    request = bounded;
    const auth = authorizationServer(env, config.origin);
    if (url.pathname === "/oauth/authorize")
      return await authorize(request, env, config.origin);
    if (authorizationRoute) return await auth.fetch(request, env, ctx);
    const presentOrigin = request.headers.get("origin");
    if (presentOrigin && !config.origins.includes(presentOrigin))
      return new Response(null, { status: 403, headers: privateHeaders });
    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": presentOrigin ?? config.origin,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers":
            "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Accept, Last-Event-ID",
          "access-control-max-age": "600",
          vary: "Origin",
        },
      });
    const resource = new OAuthResourceServer<McpEnvironment, McpClaims>({
      resourceMetadata: {
        resource: `${config.origin}/mcp`,
        authorization_servers: [config.origin],
      },
      requiredScopes: ["vault:read"],
      validateToken: () => async (resourceId, token) => {
        const result = await auth.validateToken<unknown>(
          resourceId,
          token,
          env,
        );
        if (!result) return null;
        const parsed = McpClaimsSchema.safeParse(result.props);
        if (
          !parsed.success ||
          result.userId !== oauthSubject(parsed.data.uid) ||
          result.clientId !== parsed.data.clientId
        )
          return null;
        const claims = {
          ...parsed.data,
          scopes: parsed.data.scopes.filter((scope) =>
            result.scope?.includes(scope),
          ),
        };
        try {
          await localVault(env, claims.vid).authorizeMcp(claims, "vault:read");
        } catch (error) {
          if (
            ["unauthenticated", "forbidden", "gone"].includes(
              errorCode(error) ?? "",
            )
          )
            return null;
          throw error;
        }
        return { ...result, props: claims };
      },
      handler: {
        async fetch(req, bindings, context) {
          if (!context.auth.scope.includes("vault:read"))
            return insufficientScope(context.auth, ["vault:read"]);
          const handler = createMcpHandler(
            () => serverFor(bindings, context.props),
            {
              route: "/mcp",
              allowedHostnames: [url.hostname],
              allowedOriginHostnames: config.origins.map(
                (origin) => new URL(origin).hostname,
              ),
              corsOptions: false,
            },
          );
          const response = await handler(req, bindings, context);
          const headers = new Headers(response.headers);
          headers.set("cache-control", "no-store");
          headers.set("referrer-policy", "no-referrer");
          if (presentOrigin) {
            headers.set("access-control-allow-origin", presentOrigin);
            headers.set("vary", "Origin");
          }
          return new Response(response.body, {
            status: response.status,
            headers,
          });
        },
      },
    });
    const response = await resource.fetch(request, env, ctx);
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("referrer-policy", "no-referrer");
    if (presentOrigin) {
      headers.set("access-control-allow-origin", presentOrigin);
      headers.set(
        "access-control-expose-headers",
        "WWW-Authenticate, MCP-Protocol-Version",
      );
      headers.set("vary", "Origin");
    }
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    if (
      error instanceof AuthorizationError &&
      error.redirectTo &&
      request.method === "GET"
    )
      return new Response(null, {
        status: 302,
        headers: { ...privateHeaders, location: error.redirectTo },
      });
    if (error instanceof AuthorizationError || error instanceof CimdFetchError)
      return new Response(
        "This authorization request is invalid or expired. Start again from the app.",
        { status: 400, headers: privateHeaders },
      );
    return new Response("Connected apps are temporarily unavailable.", {
      status: 503,
      headers: privateHeaders,
    });
  }
}

export async function revokeOAuthGrant(
  env: McpEnvironment,
  userId: string,
  grantId: string,
): Promise<void> {
  const config = configured(env, false);
  if (!config) throw new Error("OAuth cleanup is not configured");
  await authorizationServer(env, config.origin)
    .getOAuthApi(env)
    .revokeGrant(grantId, oauthSubject(userId));
}

/** Use in deletion's retrying alarm; a later sweep and audit check cover KV propagation. */
export async function revokeOAuthUserGrants(
  env: McpEnvironment,
  userId: string,
): Promise<number> {
  const config = configured(env, false);
  if (!config) {
    if (!env.OAUTH_KV) return 0;
    throw new Error("OAuth cleanup is not configured");
  }
  const oauth = authorizationServer(env, config.origin).getOAuthApi(env);
  let cursor: string | undefined;
  let count = 0;
  do {
    const page = await oauth.listUserGrants(oauthSubject(userId), {
      limit: 100,
      cursor,
    });
    for (const grant of page.items) {
      await oauth.revokeGrant(grant.id, oauthSubject(userId));
      count++;
    }
    cursor = page.cursor;
  } while (cursor);
  // An interrupted earlier revoke may leave token records without a grant. Sweep that user prefix too.
  cursor = undefined;
  do {
    const page: KVNamespaceListResult<unknown> = await env.OAUTH_KV!.list({
      prefix: `token:${oauthSubject(userId)}:`,
      limit: 100,
      cursor,
    });
    for (const key of page.keys) {
      await env.OAUTH_KV!.delete(key.name);
      count++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return count;
}

export async function oauthUserGrantCount(
  env: McpEnvironment,
  userId: string,
): Promise<number | null> {
  const config = configured(env, false);
  if (!config) return env.OAUTH_KV ? null : 0;
  let count = 0;
  for (const prefix of [
    `grant:${oauthSubject(userId)}:`,
    `token:${oauthSubject(userId)}:`,
  ]) {
    let cursor: string | undefined;
    do {
      const page: KVNamespaceListResult<unknown> = await env.OAUTH_KV!.list({
        prefix,
        limit: 100,
        cursor,
      });
      count += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
  return count;
}
