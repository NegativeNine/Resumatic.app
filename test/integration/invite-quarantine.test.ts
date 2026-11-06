import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import type { InviteRevocation } from "../../src/directory/invite-revocation";
import { directory, directoryByName } from "../../src/shared/stubs";

async function unboundCreated() {
  const global = directory(env), id = crypto.randomUUID(), email = `quarantine-${id}@example.test`, subject = `subject-${id}`;
  await global.addInvite(email);
  const epoch = await global.googleAuthEpoch();
  const { shardInviteClaim: claim } = await global.claimIdentityHomeV3("google", subject, 5, email, undefined, epoch);
  const target = directoryByName(env, "directory-5");
  const request = { provider: "google" as const, subject, email, hint: "enam" as const, homeShard: 5,
    inviteAuthorized: true, authEpoch: epoch, shardClaimToken: claim!.token, shardInviteClaim: claim!, reportCreation: true };
  const account = await target.signInWithInviteClaimV2(request);
  return { global, target, email, subject, claim: claim!, request, account, operation: crypto.randomUUID() };
}

async function deleteQuarantine(global: ReturnType<typeof directory>, operation: string) {
  // Test-only teardown; production exposes no quarantine-removal API.
  await runInDurableObject(global, (_instance, ctx) => {
    const sql = ctx.storage.sql;
    sql.exec(`INSERT INTO invite_quarantine_marker(slot,operation_id) VALUES (1,?)`, operation);
    sql.exec(`DELETE FROM invite_revocation_quarantines WHERE operation_id=?`, operation);
    sql.exec(`DELETE FROM invite_quarantine_marker WHERE slot=1`);
    sql.exec(`DELETE FROM invite_revocation_claims WHERE operation_id=?`, operation);
  });
}

it("detaches a created orphan while preserving all same-email fences and unrelated account erasure", async () => {
  const f = await unboundCreated();
  try {
    expect(await f.global.revokeInviteV3(f.email, f.operation)).toEqual({ state: "pending", remaining: 1, orphans: 1 });
    await runInDurableObject(f.global, (_instance, ctx) => {
      const sql = ctx.storage.sql;
      expect(sql.exec(`SELECT operation_id FROM invite_revocation_barrier`).toArray()).toHaveLength(0);
      expect(sql.exec(`SELECT operation_id FROM invite_revocation_quarantines WHERE operation_id=?`, f.operation).toArray()).toHaveLength(1);
      expect(() => sql.exec(`INSERT OR IGNORE INTO invites(email,created_at) VALUES (?,?)`, f.email, Date.now())).toThrow();
      expect(() => sql.exec(`UPDATE shard_home_claim_tokens SET token=? WHERE provider='google' AND subject=?`, crypto.randomUUID(), f.subject)).toThrow();
      expect(() => sql.exec(`UPDATE identity_homes SET user_id=? WHERE provider='google' AND subject=?`, f.account.userId, f.subject)).toThrow();
      expect(() => sql.exec(`DELETE FROM identity_homes WHERE provider='google' AND subject=?`, f.subject)).toThrow();
      expect(() => sql.exec(`DELETE FROM invite_revocation_quarantines WHERE operation_id=?`, f.operation)).toThrow();
      expect(() => sql.exec(`INSERT INTO invite_inventory_barrier(slot,operation_id,attempt_id,user_id,vault_id,email,final_generation,seal_epoch,phase)
        VALUES(1,?,?,?,?,?,?,1,'sealing')`, crypto.randomUUID(), crypto.randomUUID(), "u", "v", f.email, crypto.randomUUID())).toThrow();
    });
    expect(await f.target.existingIdentity("google", f.subject)).toEqual({ userId: f.account.userId, vaultId: f.account.vaultId });
    const rejected = await runInDurableObject(f.target, async (instance) => {
      try { await (instance as Directory).signInWithInviteClaimV2(f.request); return false; } catch { return true; }
    });
    expect(rejected).toBe(true);

    const unrelated = `unrelated-${crypto.randomUUID()}@example.test`;
    await f.global.addInvite(unrelated);
    const epoch = await f.global.googleAuthEpoch();
    const owner = await f.global.signIn({ provider: "test", subject: `owner-${crypto.randomUUID()}`, email: unrelated, hint: "enam", authEpoch: epoch });
    await f.global.deleteAccount(owner.userId, owner.vaultId);
    await runInDurableObject(f.global, async (instance) => (instance as Directory).alarm());
    expect((await f.global.listInvites()).some((i) => i.email === unrelated)).toBe(false);
    expect(await f.global.inviteRevocationStatus(f.operation)).toEqual({ state: "pending", remaining: 1, orphans: 1 });
  } finally { await deleteQuarantine(f.global, f.operation); }
}, 30_000);

it("preserves multiple fences and reports an older quarantine while another operation is active", async () => {
  const a = await unboundCreated();
  expect(await a.global.revokeInviteV3(a.email, a.operation)).toMatchObject({ state: "pending", orphans: 1 });
  const b = await unboundCreated();
  try {
    expect(await b.global.revokeInviteV3(b.email, b.operation)).toMatchObject({ state: "pending", orphans: 1 });
    const email = `active-${crypto.randomUUID()}@example.test`, subject = `active-${crypto.randomUUID()}`;
    await a.global.addInvite(email);
    const epoch = await a.global.googleAuthEpoch();
    await a.global.claimIdentityHomeV3("google", subject, 6, email, undefined, epoch);
    const operation = crypto.randomUUID();
    await runInDurableObject(a.global, async (instance) => {
      const coordinator = (instance as unknown as { inviteRevocation: InviteRevocation }).inviteRevocation;
      expect(await coordinator.begin(email, operation)).toMatchObject({ state: "pending", remaining: 1 });
    });
    expect(await a.global.inviteRevocationStatus(a.operation)).toEqual({ state: "pending", remaining: 1, orphans: 1 });
    await runInDurableObject(a.global, (_instance, ctx) => {
      const sql = ctx.storage.sql;
      sql.exec(`INSERT INTO invite_registration_marker(slot,email) VALUES (1,?)`, `free-${crypto.randomUUID()}@example.test`);
      expect(() => sql.exec(`UPDATE shard_home_claim_tokens SET token=? WHERE provider='google' AND subject=?`, crypto.randomUUID(), a.subject)).toThrow();
      sql.exec(`DELETE FROM invite_registration_marker WHERE slot=1`);
      sql.exec(`INSERT INTO invite_revocation_mutation_marker(slot,operation_id) VALUES (1,?)`, operation);
      expect(() => sql.exec(`UPDATE invites SET created_at=created_at+1 WHERE email=?`, a.email)).toThrow();
      expect(() => sql.exec(`UPDATE shard_home_invite_claims SET email=email WHERE provider='google' AND subject=?`, a.subject)).toThrow();
      sql.exec(`DELETE FROM invite_revocation_mutation_marker WHERE slot=1`);
    });
    await evictDurableObject(a.target);
    await evictDurableObject(a.global);
    expect(await a.global.revokeInviteV3(a.email, a.operation)).toEqual({ state: "pending", remaining: 1, orphans: 1 });
    expect(await a.global.inviteRevocationStatus(operation)).toEqual({ state: "pending", remaining: 1, orphans: 0 });
    await runInDurableObject(a.global, async (instance) => {
      const coordinator = (instance as unknown as { inviteRevocation: InviteRevocation }).inviteRevocation;
      await coordinator.resume();
    });
    expect(await a.global.inviteRevocationStatus(operation)).toEqual({ state: "complete" });
    expect(await a.global.inviteRevocationStatus(b.operation)).toEqual({ state: "pending", remaining: 1, orphans: 1 });
  } finally {
    await deleteQuarantine(a.global, a.operation);
    await deleteQuarantine(b.global, b.operation);
  }
}, 30_000);

it("keeps the active fence when detachment fails and resumes after eviction", async () => {
  const f = await unboundCreated();
  try {
    await runInDurableObject(f.global, async (instance, ctx) => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TRIGGER fail_quarantine BEFORE INSERT ON invite_revocation_quarantines BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
      let rejected = false;
      try { await (instance as Directory).revokeInviteV3(f.email, f.operation); } catch { rejected = true; }
      expect(rejected).toBe(true);
      expect(sql.exec(`SELECT operation_id FROM invite_revocation_barrier WHERE operation_id=?`, f.operation).toArray()).toHaveLength(1);
      expect(sql.exec(`SELECT operation_id FROM invite_revocation_quarantines WHERE operation_id=?`, f.operation).toArray()).toHaveLength(0);
      expect(sql.exec<{ state: string }>(`SELECT state FROM invite_revocation_claims WHERE operation_id=?`, f.operation).one().state).toBe("created");
      expect(() => sql.exec(`UPDATE invites SET created_at=created_at+1 WHERE email=?`, f.email)).toThrow();
      expect(sql.exec(`SELECT operation_id FROM invite_quarantine_marker`).toArray()).toHaveLength(0);
      sql.exec(`DROP TRIGGER fail_quarantine`);
    });
    await evictDurableObject(f.global);
    expect(await f.global.revokeInviteV3(f.email, f.operation)).toEqual({ state: "pending", remaining: 1, orphans: 1 });
    await runInDurableObject(f.global, (_instance, ctx) => {
      expect(ctx.storage.sql.exec(`SELECT operation_id FROM invite_revocation_barrier WHERE operation_id=?`, f.operation).toArray()).toHaveLength(0);
      expect(ctx.storage.sql.exec(`SELECT operation_id FROM invite_revocation_quarantines WHERE operation_id=?`, f.operation).toArray()).toHaveLength(1);
    });
    expect(await f.target.existingIdentity("google", f.subject)).toEqual({ userId: f.account.userId, vaultId: f.account.vaultId });
  } finally { await deleteQuarantine(f.global, f.operation); }
}, 30_000);
