import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { directory, directoryByName } from "../../src/shared/stubs";
import { nowSeconds, rsaSigner } from "../support/keys";
import { call } from "./support";
import type { Directory } from "../../src/directory/directory";
import { InviteOrphanInspection } from "../../src/directory/invite-orphan-inspection";
import type { InviteRevocation } from "../../src/directory/invite-revocation";

const global = directory(env);
let headers: Record<string, string>;
beforeAll(async () => {
  const signer = await rsaSigner();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => String(input instanceof Request ? input.url : input) === `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`
    ? Response.json(signer.jwks) : new Response("unexpected fetch", { status: 599 }));
  headers = { "cf-access-jwt-assertion": await signer.sign({ iss: env.ACCESS_TEAM_DOMAIN, aud: [env.ACCESS_AUD], email: "admin@example.com", exp: nowSeconds() + 600 }) };
});
afterAll(() => vi.unstubAllGlobals());

async function fixture() {
  const id = crypto.randomUUID(), email = `inspect-${id}@example.test`, operation = crypto.randomUUID();
  const subject = `global-${id}`, shardSubject = `shard-${id}`;
  await global.addInvite(email);
  const epoch = await global.googleAuthEpoch();
  await global.claimIdentityHomeV3("google", subject, null, email, undefined, epoch);
  const local = await global.signIn({ provider: "google", subject, email, hint: "enam", authEpoch: epoch });
  const { shardInviteClaim: claim } = await global.claimIdentityHomeV3("google", shardSubject, 5, email, undefined, epoch);
  const target = directoryByName(env, "directory-5");
  const remote = await target.signInWithInviteClaimV2({ provider: "google", subject: shardSubject, email, hint: "enam", homeShard: 5,
    inviteAuthorized: true, authEpoch: epoch, shardClaimToken: claim!.token, shardInviteClaim: claim!, reportCreation: true });
  expect(await global.revokeInviteV3(email, operation)).toEqual({ state: "pending", remaining: 2, orphans: 2 });
  return { email, subject, shardSubject, operation, claim: claim!, target, local, remote };
}
async function cleanup(operation: string) {
  await runInDurableObject(global, (_object, ctx) => {
    const sql = ctx.storage.sql;
    sql.exec(`INSERT INTO invite_quarantine_marker(slot,operation_id) VALUES (1,?)`, operation);
    try {
      sql.exec(`DELETE FROM invite_revocation_global_orphans WHERE operation_id=?`, operation);
      sql.exec(`DELETE FROM invite_revocation_quarantines WHERE operation_id=?`, operation);
      sql.exec(`DELETE FROM invite_revocation_barrier WHERE operation_id=?`, operation);
      sql.exec(`DELETE FROM invite_revocation_claims WHERE operation_id=?`, operation);
    } finally { sql.exec(`DELETE FROM invite_quarantine_marker WHERE slot=1`); }
  });
}

it("requires Access, then returns bounded validated global and shard owner identifiers without secrets", async () => {
  const f = await fixture();
  try {
    const url = `/admin/invites/revocations/${f.operation}/accounts`;
    expect((await call(url)).status).toBe(403);
    const before = await global.inviteRevocationStatus(f.operation);
    const firstResponse = await call(`${url}?limit=1`, { headers });
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as { status: string; inventoryPending: boolean; scope: string; totalOrphans: number; accounts: { userId: string; vaultId: string; placement: string; initializationMarkerPresent: boolean }[]; nextCursor: string | null };
    expect(first).toMatchObject({ status: "pending", inventoryPending: false, scope: "directory_observation_only", totalOrphans: 2,
      accounts: [{ userId: f.local.userId, vaultId: f.local.vaultId, placement: "global", initializationMarkerPresent: false }], nextCursor: f.local.userId });
    const secondResponse = await call(`${url}?limit=1&after=${encodeURIComponent(first.nextCursor!)}`, { headers });
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json() as typeof first;
    expect(second).toMatchObject({ totalOrphans: 2, accounts: [{ userId: f.remote.userId, vaultId: f.remote.vaultId, placement: "shard", initializationMarkerPresent: false }], nextCursor: null });
    const output = JSON.stringify([first, second]);
    for (const secret of [f.email, f.subject, f.shardSubject, f.claim.token, f.claim.generation!].filter(Boolean)) expect(output).not.toContain(secret);
    expect(await global.inviteRevocationStatus(f.operation)).toEqual(before);
    for (const query of ["?limit=0", "?limit=26", "?limit=01", "?limit=1&limit=2", "?after=bad", "?after="])
      expect((await call(`${url}${query}`, { headers })).status, query).toBe(422);
    const pendingToken = crypto.randomUUID();
    await runInDurableObject(global, (_object, ctx) => ctx.storage.sql.exec(`INSERT INTO invite_revocation_claims
      (operation_id,token,provider,subject,shard,email,generation,state) VALUES (?,?,'google',?,5,?,NULL,'pending')`,
      f.operation, pendingToken, `unfinished-${crypto.randomUUID()}`, f.email));
    try {
      const pending = await call(url, { headers });
      expect(await pending.json()).toEqual({ status: "pending", inventoryPending: true, scope: "directory_observation_only", accounts: [], nextCursor: null });
    } finally { await runInDurableObject(global, (_object, ctx) => ctx.storage.sql.exec(`DELETE FROM invite_revocation_claims WHERE token=?`, pendingToken)); }
  } finally { await cleanup(f.operation); }
}, 30_000);

it("does not expose accounts when legacy inventory is pending", async () => {
  const operation = crypto.randomUUID();
  await runInDurableObject(global, (_object, ctx) => ctx.storage.sql.exec(`INSERT INTO invite_revocation_legacy_operations(operation_id) VALUES (?)`, operation));
  try {
    const response = await call(`/admin/invites/revocations/${operation}/accounts`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "pending", inventoryPending: true, scope: "directory_observation_only", accounts: [], nextCursor: null });
  } finally {
    await runInDurableObject(global, (_object, ctx) => {
      const sql = ctx.storage.sql;
      sql.exec(`INSERT INTO invite_revocation_legacy_marker(slot,operation_id) VALUES (1,?)`, operation);
      sql.exec(`INSERT INTO invite_revocation_legacy_proofs(operation_id,local_orphans,scanned_at) VALUES (?,0,?)`, operation, Date.now());
      sql.exec(`DELETE FROM invite_revocation_legacy_operations WHERE operation_id=?`, operation);
      sql.exec(`DELETE FROM invite_revocation_legacy_marker WHERE slot=1`);
    });
  }
});

it("rejects target inspection under the wrong operation or token", async () => {
  const f = await fixture();
  try {
    const claim = { operationId: f.operation, provider: "google" as const, subject: f.shardSubject, shard: 5, ...f.claim };
    await runInDurableObject(f.target, async (object) => {
      await expect((object as Directory).inspectShardInviteClaimV3({ ...claim, operationId: crypto.randomUUID() })).rejects.toThrow();
      await expect((object as Directory).inspectShardInviteClaimV3({ ...claim, token: crypto.randomUUID() })).rejects.toThrow();
    });
    await runInDurableObject(f.target, async (object, ctx) => {
      const sql = ctx.storage.sql, extraUser = `s5:${crypto.randomUUID()}`;
      sql.exec(`INSERT INTO shard_invite_account_bindings(user_id,provider,subject,token,email,generation) VALUES (?,'google',?,?,?,?)`,
        extraUser, `conflict-${crypto.randomUUID()}`, f.claim.token, f.email, f.claim.generation);
      try { await expect((object as Directory).inspectShardInviteClaimV3(claim)).rejects.toThrow(/review/); }
      finally { sql.exec(`DELETE FROM shard_invite_account_bindings WHERE user_id=?`, extraUser); }
    });
    expect(await global.inviteRevocationStatus(f.operation)).toEqual({ state: "pending", remaining: 2, orphans: 2 });
  } finally { await cleanup(f.operation); }
}, 30_000);

it("fails closed if the operation changes while awaiting a shard observation", async () => {
  const f = await fixture();
  try {
    await runInDurableObject(global, async (object, ctx) => {
      const internal = object as unknown as { inviteRevocation: InviteRevocation; inviteFingerprint(operation: string, email: string): Promise<string> };
      const token = crypto.randomUUID();
      const inspector = new InviteOrphanInspection({ sql: ctx.storage.sql, transaction: (fn) => ctx.storage.transactionSync(fn),
        status: (operation) => internal.inviteRevocation.status(operation),
        fingerprint: (operation, email) => internal.inviteFingerprint(operation, email),
        validVault: (vaultId) => env.VAULT.idFromString(vaultId).toString() === vaultId,
        inspectShard: async (claim) => {
          ctx.storage.sql.exec(`INSERT INTO invite_revocation_claims(operation_id,token,provider,subject,shard,email,generation,state)
            VALUES (?,?,'google',?,5,?,NULL,'pending')`, f.operation, token, `racing-${crypto.randomUUID()}`, f.email);
          return f.target.inspectShardInviteClaimV3(claim);
        },
      });
      try { await expect(inspector.inspect(f.operation, f.local.userId, 1)).rejects.toThrow(/review/); }
      finally { ctx.storage.sql.exec(`DELETE FROM invite_revocation_claims WHERE token=?`, token); }
    });
  } finally { await cleanup(f.operation); }
}, 30_000);
