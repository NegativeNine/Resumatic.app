import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { vault } from "../../src/shared/stubs";
import { sha256 } from "../../src/worker/crypto";
import { app } from "../../src/worker/routes";
import { readSession } from "../../src/worker/session";
import { clearKeyCache } from "../../src/worker/jwt";
import { nowSeconds, rsaSigner } from "../support/keys";
import { signIn } from "./support";

it("correlates a current object without exposing its key or settling the fence", async () => {
  const user = await signIn();
  const session = await readSession(env.SESSION_KEY, user.cookie.slice("__Host-session=".length));
  if (!session) throw new Error("missing synthetic session");
  const stub = vault(env, session.vid);
  const who = { userId: session.uid, gen: session.gen, epoch: session.epoch };
  const key = `vaults/${session.vid}/exports/private-resume.pdf`;
  const hash = Array.from(new Uint8Array(await sha256(key)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const attempt = crypto.randomUUID();
  await stub.beginCacheWrite(who, attempt, "pdf", hash);
  await env.FILES.put(key, "synthetic data", { customMetadata: { resumatic_cache_attempt: attempt, other: "private-metadata" } });
  try {
    const denied = await app.fetch(new Request(`https://resumatic.test/admin/vaults/${session.vid}/cache-write-correlation`), env);
    expect(denied.status).toBe(403);
    const signer = await rsaSigner();
    clearKeyCache();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      return url === `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs` ? Response.json(signer.jwks) : new Response("unexpected", { status: 599 });
    });
    const token = await signer.sign({ iss: env.ACCESS_TEAM_DOMAIN, aud: [env.ACCESS_AUD], email: "admin@example.com", exp: nowSeconds() + 600 });
    const response = await app.fetch(new Request(`https://resumatic.test/admin/vaults/${session.vid}/cache-write-correlation`, {
      headers: { "cf-access-jwt-assertion": token },
    }), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const report = await response.json();
    expect(report).toMatchObject({ status: "pending", scan: "exhausted", total: 1, observations: [{ id: attempt, observation: "current-match" }] });
    expect(JSON.stringify(report)).not.toContain("private-resume");
    expect(JSON.stringify(report)).not.toContain("private-metadata");
    expect(await stub.cacheWriteFences()).toMatchObject({ status: "available", total: 1 });
  } finally {
    vi.unstubAllGlobals();
    clearKeyCache();
    await env.FILES.delete(key);
  }
}, 30_000);
