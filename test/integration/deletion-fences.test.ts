import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { directory, vault } from "../../src/shared/stubs";
import { app } from "../../src/worker/routes";
import { readSession } from "../../src/worker/session";
import { clearKeyCache } from "../../src/worker/jwt";
import { nowSeconds, rsaSigner } from "../support/keys";
import { signIn } from "./support";

it("requires Access and a matching deletion owner, returns only bounded metadata, and does not settle fences", async () => {
  const user = await signIn("private-fence-owner@example.test");
  const session = await readSession(env.SESSION_KEY, user.cookie.slice("__Host-session=".length));
  if (!session) throw new Error("missing synthetic session");
  const stub = vault(env, session.vid);
  const attempt = crypto.randomUUID(), original = crypto.randomUUID(), retried = crypto.randomUUID();
  await runInDurableObject(stub, (_instance, ctx) => {
    const sql = ctx.storage.sql;
    sql.exec(`UPDATE profile SET name='private-career-name' WHERE id=1`);
    sql.exec(`INSERT INTO r2_cache_dispatches(attempt_id,kind,created_at,key_digest) VALUES (?,'source',1,?)`, attempt, "a".repeat(64));
    sql.exec(`INSERT INTO workflow_dispatches(run_id) VALUES (?)`, original);
    sql.exec(`INSERT INTO workflow_redispatches(run_id,attempts,next_at) VALUES (?,1,2)`, retried);
    sql.exec(`INSERT OR REPLACE INTO meta(key,value) VALUES ('billing_customer_dispatches','2')`);
    sql.exec(`INSERT OR REPLACE INTO meta(key,value) VALUES ('billing_checkout_dispatches','not-a-count')`);
  });
  await directory(env).deleteAccount(session.uid, session.vid);
  const url = `https://resumatic.test/admin/vaults/${session.vid.toUpperCase()}/deletion-fences`;
  const body = JSON.stringify({ userId: session.uid });
  const denied = await app.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body }), env);
  expect(denied.status).toBe(403);

  const signer = await rsaSigner();
  clearKeyCache();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    return url === `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs` ? Response.json(signer.jwks) : new Response("unexpected", { status: 599 });
  });
  const token = await signer.sign({ iss: env.ACCESS_TEAM_DOMAIN, aud: [env.ACCESS_AUD], email: "admin@example.com", exp: nowSeconds() + 600 });
  const headers = { "content-type": "application/json", "cf-access-jwt-assertion": token };
  try {
    const response = await app.fetch(new Request(url, { method: "POST", headers, body }), env);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const report = await response.json();
    expect(report).toMatchObject({
      status: "pending", complete: false, scope: "observed_current_fences_only",
      vault: { status: "available", workflow: {
        dispatches: { ids: [original], truncated: false }, redispatches: { ids: [retried], truncated: false },
      }, r2: { sourceWrites: { count: 1, truncated: false }, otherWrites: { count: 0, truncated: false } },
      billing: { customerCreation: "present", checkoutCreation: "invalid" } },
    });
    const text = JSON.stringify(report);
    for (const secret of [user.email, session.uid, "private-career-name", "a".repeat(64), attempt]) expect(text).not.toContain(secret);
    await runInDurableObject(stub, (_instance, ctx) => {
      expect(ctx.storage.sql.exec(`SELECT attempt_id FROM r2_cache_dispatches WHERE attempt_id=?`, attempt).toArray()).toHaveLength(1);
      expect(ctx.storage.sql.exec(`SELECT run_id FROM workflow_dispatches WHERE run_id=?`, original).toArray()).toHaveLength(1);
      expect(ctx.storage.sql.exec(`SELECT run_id FROM workflow_redispatches WHERE run_id=?`, retried).toArray()).toHaveLength(1);
    });
    const wrong = await app.fetch(new Request(url, { method: "POST", headers, body: JSON.stringify({ userId: crypto.randomUUID() }) }), env);
    expect(wrong.status).toBe(503);
    expect(await wrong.text()).not.toContain(original);
    const malformed = await app.fetch(new Request(url, { method: "POST", headers, body: JSON.stringify({ userId: session.uid, extra: "private" }) }), env);
    expect(malformed.status).toBe(422);
  } finally { vi.unstubAllGlobals(); clearKeyCache(); }
}, 30_000);

it("caps large fence inventories and refuses corrupted IDs without exposing them", async () => {
  const vid = env.VAULT.newUniqueId().toString();
  const stub = vault(env, vid);
  const userId = crypto.randomUUID();
  await stub.init(userId);
  await runInDurableObject(stub, (_instance, ctx) => {
    for (let i = 0; i < 66; i++) ctx.storage.sql.exec(`INSERT INTO workflow_dispatches(run_id) VALUES (?)`, crypto.randomUUID());
    for (let i = 0; i < 1002; i++) ctx.storage.sql.exec(`INSERT INTO r2_cache_dispatches(attempt_id,kind,created_at) VALUES (?,'source',1)`, crypto.randomUUID());
    ctx.storage.sql.exec(`INSERT INTO r2_cache_dispatches(attempt_id,kind,created_at) VALUES (?,'pdf',1)`, crypto.randomUUID());
  });
  await runInDurableObject(stub, (instance) => {
    expect(() => instance.deletionFenceSummary(userId)).toThrow(/not closing/);
  });
  await stub.quiesce();
  await runInDurableObject(stub, (instance) => {
    expect(() => instance.deletionFenceSummary(crypto.randomUUID())).toThrow(/not this user's vault/);
  });
  const summary = await stub.deletionFenceSummary(userId);
  expect(summary.status).toBe("available");
  if (summary.status !== "available") throw new Error("missing synthetic summary");
  expect(summary.workflow.dispatches).toMatchObject({ truncated: true });
  expect(summary.workflow.dispatches.ids).toHaveLength(64);
  expect(summary.r2).toEqual({ sourceWrites: { count: 1000, truncated: true }, otherWrites: { count: 1, truncated: false } });
  await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec(`INSERT INTO workflow_dispatches(run_id) VALUES ('!private-not-a-uuid')`));
  const invalid = await stub.deletionFenceSummary(userId);
  expect(invalid).toEqual({ status: "unavailable" });
  expect(JSON.stringify(invalid)).not.toContain("private-not-a-uuid");
});
