import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  handleMcp,
  oauthUserGrantCount,
  revokeOAuthUserGrants,
} from "../../src/worker/mcp";
import { createSession } from "../../src/worker/session";

// Real provider crypto/protocol and real Vault RPC, with isolated ephemeral KV. No remote requests.
function memoryKv(): KVNamespace {
  const values = new Map<string, { value: string; metadata?: unknown }>();
  return {
    async get(key: string, options?: string | { type?: string }) {
      const value = values.get(key)?.value;
      return value === undefined
        ? null
        : options === "json" ||
            (typeof options === "object" && options.type === "json")
          ? JSON.parse(value)
          : value;
    },
    async put(key: string, value: string, options?: { metadata?: unknown }) {
      values.set(key, { value, metadata: options?.metadata });
    },
    async delete(key: string) {
      values.delete(key);
    },
    async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
      const entries = [...values.entries()]
        .filter(([key]) => key.startsWith(options?.prefix ?? ""))
        .sort(([a], [b]) => a.localeCompare(b));
      const start = options?.cursor
        ? entries.findIndex(([key]) => key > options.cursor!)
        : 0;
      const selected =
        start < 0 ? [] : entries.slice(start, start + (options?.limit ?? 1000));
      const done = start < 0 || start + selected.length >= entries.length;
      return {
        keys: selected.map(([name, value]) => ({
          name,
          metadata: value.metadata,
        })),
        list_complete: done,
        ...(done ? {} : { cursor: selected.at(-1)![0] }),
        cacheStatus: null,
      };
    },
  } as unknown as KVNamespace;
}

async function fixture() {
  const bindings = {
    ...env,
    MCP_ENABLED: "true",
    APP_ORIGIN: "https://resumatic.test",
    OAUTH_KV: memoryKv(),
  };
  const ctx = createExecutionContext();
  const id = env.VAULT.newUniqueId();
  const stub = env.VAULT.get(id);
  const userId = crypto.randomUUID();
  await stub.init(userId);
  const session = `__Host-session=${await createSession(env.SESSION_KEY, { uid: userId, vid: id.toString(), gen: 1 })}`;
  const call = async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("host", "resumatic.test");
    return (await handleMcp(
      new Request(`https://resumatic.test${path}`, { ...init, headers }),
      bindings,
      ctx,
    ))!;
  };
  const registration = await call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "<script>bad</script>",
      redirect_uris: ["https://client.example.test/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(registration.status, await registration.clone().text()).toBe(201);
  const client = (await registration.json()) as { client_id: string };
  const verifier = "v".repeat(43);
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const challenge = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const parameters = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: "https://client.example.test/callback",
    response_type: "code",
    scope: "vault:read vault:generate offline_access",
    state: "client-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: "https://resumatic.test/mcp",
  });
  const authorize = await call(`/oauth/authorize?${parameters}`, {
    headers: { cookie: session },
  });
  expect(authorize.status, await authorize.clone().text()).toBe(200);
  const html = await authorize.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  expect(handle).toBeTruthy();
  const cookies = [
    session,
    ...authorize.headers.getSetCookie().map((value) => value.split(";")[0]!),
  ].join("; ");
  return {
    bindings,
    ctx,
    stub,
    userId,
    call,
    client,
    verifier,
    html,
    handle: handle!,
    cookies,
  };
}

describe("OAuth MCP integration", () => {
  it("uses browser-bound consent, defaults to read-only and enforces immediate local revocation", async () => {
    const f = await fixture();
    expect(f.html).not.toContain("<script>bad</script>");
    expect(f.html).toContain("&#60;script&#62;");
    expect(f.html).toContain("client.example.test");
    expect(f.html).toContain('value="vault:generate">');
    const form = new URLSearchParams({ handle: f.handle, decision: "approve" });
    form.append("scope", "vault:read");
    form.append("scope", "offline_access");
    const rejected = await f.call("/oauth/authorize", {
      method: "POST",
      headers: {
        origin: "https://evil.test",
        cookie: f.cookies,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    expect(rejected.status).toBe(403);
    const approved = await f.call("/oauth/authorize", {
      method: "POST",
      headers: {
        origin: "https://resumatic.test",
        cookie: f.cookies,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    expect(approved.status, await approved.clone().text()).toBe(302);
    const redirect = new URL(approved.headers.get("location")!);
    expect(redirect.searchParams.get("state")).toBe("client-state");
    const token = await f.call("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: redirect.searchParams.get("code")!,
        client_id: f.client.client_id,
        redirect_uri: "https://client.example.test/callback",
        code_verifier: f.verifier,
        resource: "https://resumatic.test/mcp",
      }),
    });
    expect(token.status, await token.clone().text()).toBe(200);
    const credentials = (await token.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(credentials.refresh_token).toBeTruthy();
    const tools = await f.call("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(tools.status, await tools.clone().text()).toBe(200);
    const body = await tools.text();
    const listed = JSON.parse(
      tools.headers.get("content-type")?.includes("text/event-stream")
        ? body
            .split("\n")
            .find((line) => line.startsWith("data: "))!
            .slice(6)
        : body,
    ) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual([
      "list_facts",
      "search_facts",
      "get_resume",
    ]);
    const grants = await f.stub.listMcpGrants({ userId: f.userId, gen: 1 });
    expect(grants[0]?.state).toBe("active");
    await f.stub.revokeMcpGrant({ userId: f.userId, gen: 1 }, grants[0]!.id);
    // Leave valid KV tokens untouched: the strongly consistent Vault still blocks this request.
    expect(
      (
        await f.call("/mcp", {
          headers: { authorization: `Bearer ${credentials.access_token}` },
        })
      ).status,
    ).toBe(401);
    const refresh = await f.call("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials.refresh_token,
        client_id: f.client.client_id,
      }),
    });
    expect(refresh.status).toBe(400);
    await revokeOAuthUserGrants(f.bindings, f.userId);
    expect(await oauthUserGrantCount(f.bindings, f.userId)).toBe(0);
    await waitOnExecutionContext(f.ctx);
  });

  it("keeps disabled integration pending and does not consume unrelated routes", async () => {
    const ctx = createExecutionContext();
    expect(
      (
        await handleMcp(
          new Request("https://resumatic.test/mcp"),
          { ...env, MCP_ENABLED: "false" },
          ctx,
        )
      )?.status,
    ).toBe(503);
    expect(
      await handleMcp(
        new Request("https://resumatic.test/api/health"),
        env,
        ctx,
      ),
    ).toBeNull();
    await waitOnExecutionContext(ctx);
  });

  it("bounds streaming request bodies without relying on Content-Length", async () => {
    const ctx = createExecutionContext();
    const bindings = {
      ...env,
      MCP_ENABLED: "true",
      APP_ORIGIN: "https://resumatic.test",
      OAUTH_KV: memoryKv(),
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40_000));
        controller.enqueue(new Uint8Array(40_000));
        controller.close();
      },
    });
    const response = await handleMcp(
      new Request("https://resumatic.test/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      bindings,
      ctx,
    );
    expect(response?.status).toBe(413);
    await waitOnExecutionContext(ctx);
  });
});
