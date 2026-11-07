import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, expect, it, vi } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directory, directoryByName } from "../../src/shared/stubs";
import { nowSeconds, rsaSigner } from "../support/keys";
import { call } from "../integration/support";

let headersPromise: Promise<Record<string, string>> | undefined;
function adminHeaders(): Promise<Record<string, string>> {
  return headersPromise ??= (async () => {
    const signer = await rsaSigner();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input instanceof Request ? input.url : input) === `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`)
        return Response.json(signer.jwks);
      return new Response("unexpected fetch in test", { status: 599 });
    });
    const token = await signer.sign({ iss: env.ACCESS_TEAM_DOMAIN, aud: [env.ACCESS_AUD], email: "admin@example.com", exp: nowSeconds() + 600 });
    return { "cf-access-jwt-assertion": token };
  })();
}
afterAll(() => vi.unstubAllGlobals());

// An old unbound claim remains dispatchable across a later reissue.
// Opt in with RESUMATIC_PLACEMENT_DIAGNOSTIC=1. The test binding sets the
// drain assertion; production must independently verify the rollout first.
async function fixture() {
  const global = directory(env), nonce = crypto.randomUUID();
  const email = `old-claim-${nonce}@example.test`, subject = `old-claim-${nonce}`, shard = 5;
  await global.addInvite(email);
  const authEpoch = await global.googleAuthEpoch();
  const { shardInviteClaim: claim } = await global.claimIdentityHomeV3("google", subject, shard, email, undefined, authEpoch);
  expect(claim).not.toBeNull();
  await global.addInvite(email); // Rotate G1 to G2 while G1 may still be dispatched.
  const target = directoryByName(env, `directory-${shard}`);
  const request = { provider: "google" as const, subject, email, hint: "enam" as const,
    homeShard: shard, inviteAuthorized: true, authEpoch,
    shardClaimToken: claim!.token, shardInviteClaim: claim!, reportCreation: true };
  const boundUser = () => runInDurableObject(global, (_instance, state) =>
    state.storage.sql.exec<{ user_id: string | null }>(
      `SELECT user_id FROM identity_homes WHERE provider='google' AND subject=?`, subject,
    ).toArray()[0]?.user_id ?? null);
  return { global, target, email, subject, authEpoch, claim: claim!, request, boundUser };
}

it("fences an older unbound claim when a reissued invitation is revoked", async () => {
  const f = await fixture();
  const operation = crypto.randomUUID();
  const headers = await adminHeaders();
  const response = await call(`/admin/invites/${encodeURIComponent(f.email)}`, { method: "DELETE", headers: { ...headers, "Idempotency-Key": operation } });
  expect(response.status).toBe(204);
  const poll = await call(`/admin/invites/revocations/${operation}`, { headers });
  expect(poll.status).toBe(200);
  expect(await poll.json()).toMatchObject({ state: "complete" });
  const rejected = await runInDurableObject(f.target, async (instance) => {
    try { await (instance as Directory).signInWithInviteClaim(f.request); return false; }
    catch { return true; }
  });
  expect(await f.boundUser()).toBeNull();
  const persisted = await runInDurableObject(f.target, (_instance, state) => {
    const sql = state.storage.sql;
    return {
      identities: sql.exec(`SELECT user_id FROM identities WHERE provider='google' AND subject=?`, f.subject).toArray().length,
      tokens: sql.exec(`SELECT user_id FROM shard_identity_claim_tokens WHERE token=?`, f.claim.token).toArray().length,
      bindings: sql.exec(`SELECT user_id FROM shard_invite_account_bindings WHERE token=?`, f.claim.token).toArray().length,
    };
  });
  expect(await f.target.existingIdentity("google", f.subject)).toBeNull();
  expect(persisted).toEqual({ identities: 0, tokens: 0, bindings: 0 });
  expect(rejected).toBe(true);
}, 30_000);

it("does not report completed revocation while an earlier target creation is still unbound", async () => {
  const f = await fixture();
  const created = await f.target.signInWithInviteClaimV2(f.request);
  const operation = crypto.randomUUID();
  const headers = await adminHeaders();
  const response = await call(`/admin/invites/${encodeURIComponent(f.email)}`, { method: "DELETE", headers: { ...headers, "Idempotency-Key": operation } });
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ state: "pending", operationId: operation, orphans: 1 });
  const poll = await call(`/admin/invites/revocations/${operation}`, { headers });
  expect(poll.status).toBe(200);
  const status = await poll.json();
  const remaining = await f.target.existingIdentity("google", f.subject);
  expect(await f.boundUser()).toBeNull();
  expect(status).toMatchObject({ state: "pending", orphans: 1 });
  expect(remaining).toEqual({ userId: created.userId, vaultId: created.vaultId });
  expect((await f.global.listInvites()).some((i) => i.email === f.email)).toBe(true);
  // Pending work must not later bind this token, including after a retry.
  const rejected = await runInDurableObject(f.global, async (instance) => {
    try {
      await (instance as Directory).bindIdentityHomeV3("google", f.subject, created.userId,
        f.authEpoch, undefined, false, created.shardInviteClaim!);
      return false;
    } catch { return true; }
  });
  expect(rejected).toBe(true);
}, 30_000);
