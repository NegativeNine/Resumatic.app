import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directoryForSignIn } from "../../src/directory/routing";
import { directory } from "../../src/shared/stubs";
import type { SignInInput } from "../../src/shared/types";
import { eventually } from "./support";

async function input(): Promise<SignInInput> {
  const id = crypto.randomUUID();
  return { provider: "google", subject: `invite-${id}`, email: `invite-${id}@example.test`, hint: "enam", authEpoch: await directory(env).googleAuthEpoch() };
}

async function clearGlobalQuarantineForTest(global: ReturnType<typeof directory>, operation: string) {
  await runInDurableObject(global, (_object, state) => {
    const sql = state.storage.sql;
    sql.exec(`INSERT INTO invite_quarantine_marker(slot,operation_id) VALUES (1,?)`, operation);
    try {
      sql.exec(`DELETE FROM invite_revocation_global_orphans WHERE operation_id=?`, operation);
      sql.exec(`DELETE FROM invite_revocation_quarantines WHERE operation_id=?`, operation);
      sql.exec(`DELETE FROM invite_revocation_barrier WHERE operation_id=?`, operation);
    } finally { sql.exec(`DELETE FROM invite_quarantine_marker WHERE slot=1`); }
  });
}

describe("global-home invite authorization", () => {
  it("rejects a stale authorization after deletion, and accepts a new invite", async () => {
    const p = await input();
    const global = directory(env);
    await global.addInvite(p.email);
    // This decision predates the other sign-in and must not authorize a later
    // creation after deletion has revoked the invitation.
    const held = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, p);
    expect(held.input.inviteAuthorized).toBe(true);
    expect(held.input.expectedUserId).toBeUndefined();
    const original = await held.directory.signIn(held.input);
    await global.bindIdentityHome(p.provider, p.subject, original.userId, p.authEpoch);
    await global.deleteAccount(original.userId, original.vaultId);
    await runDurableObjectAlarm(global);
    await eventually(async () => !(await global.existingIdentity(p.provider, p.subject)), "identity erasure");
    expect((await global.listInvites()).some((invite) => invite.email === p.email)).toBe(false);
    await runInDurableObject(held.directory, async (instance) => {
      await expect((instance as Directory).signIn(held.input)).rejects.toThrow(/sign-in is stale|not been invited/);
    });
    expect(await global.existingIdentity(p.provider, p.subject)).toBeNull();

    await global.addInvite(p.email);
    const fresh = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, { ...p, authEpoch: await global.googleAuthEpoch() });
    const replacement = await fresh.directory.signIn(fresh.input);
    expect(replacement.userId).not.toBe(original.userId);
    expect(await fresh.directory.signIn(fresh.input)).toEqual(replacement);
  }, 30_000);

  it("keeps existing accounts accessible when their invite is removed", async () => {
    const p = await input();
    const global = directory(env);
    await global.addInvite(p.email);
    const routed = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, p);
    const account = await routed.directory.signIn(routed.input);
    await global.bindIdentityHome(p.provider, p.subject, account.userId, p.authEpoch);
    expect(await global.revokeInviteV3(p.email, crypto.randomUUID())).toMatchObject({ state: "complete" });
    expect(await global.signIn({ ...p, authEpoch: await global.googleAuthEpoch() })).toEqual(account);
  }, 30_000);

  it("preserves explicit open registration and test identities", async () => {
    const global = directory(env);
    const p = await input();
    await runInDurableObject(global, async (instance) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.INVITE_ONLY;
      try {
        local.INVITE_ONLY = "false";
        expect((await (instance as Directory).signIn(p)).userId).toBeTruthy();
      } finally {
        local.INVITE_ONLY = previous;
      }
    });
    const email = `test-${crypto.randomUUID()}@example.test`;
    // Test login reads a fresh epoch before routing, just like the Worker.
    expect((await global.signIn({ provider: "test", subject: email, email, hint: "enam", authEpoch: await global.googleAuthEpoch() })).userId).toBeTruthy();
  }, 30_000);

  it("preserves control-plane authorization for a new sharded account", async () => {
    const p = await input();
    await directory(env).addInvite(p.email);
    const routed = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "16" }, p);
    expect(routed.input.inviteAuthorized).toBe(true);
    expect(routed.input.shardInviteClaim).toBeDefined();
    const account = await routed.directory.signInWithInviteClaim({ ...routed.input, reportCreation: true });
    expect(account.userId).toMatch(/^s(?:[0-9]|1[0-5]):/);
    expect(account.shardInviteClaim).toEqual(routed.input.shardInviteClaim);
    await directory(env).bindIdentityHomeV3(p.provider, p.subject, account.userId, p.authEpoch, undefined, false, account.shardInviteClaim ?? null);
  }, 30_000);
});

describe("global-home revocation fencing", () => {
  it("rejects an old routed signup after revocation and reissue", async () => {
    const p = await input();
    const global = directory(env);
    await global.addInvite(p.email);
    const routed = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, p);
    expect((await global.revokeInviteV3(p.email, crypto.randomUUID())).state).toBe("complete");
    await global.addInvite(p.email);
    await runInDurableObject(global, async (object) => {
      await expect((object as Directory).signIn(routed.input)).rejects.toThrow(/stale|invited/);
    });
    expect(await global.existingIdentity(p.provider, p.subject)).toBeNull();
    const fresh = { ...p, authEpoch: await global.googleAuthEpoch() };
    const newRoute = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, fresh);
    const account = await newRoute.directory.signIn(newRoute.input);
    await global.bindIdentityHome(fresh.provider, fresh.subject, account.userId, fresh.authEpoch);
    expect(await global.existingIdentity(fresh.provider, fresh.subject)).toEqual({ userId: account.userId, vaultId: account.vaultId });
  }, 30_000);

  it("quarantines a creation-bound account without erasing or adopting it", async () => {
    const p = await input(), global = directory(env), operation = crypto.randomUUID();
    await global.addInvite(p.email);
    const routed = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, p);
    const account = await routed.directory.signIn(routed.input);
    try {
      expect(await global.revokeInviteV3(p.email, operation)).toEqual({ state: "pending", remaining: 1, orphans: 1 });
      expect(await global.revokeInviteV3(p.email, operation)).toEqual({ state: "pending", remaining: 1, orphans: 1 });
      const freshEpoch = await global.googleAuthEpoch();
      await runInDurableObject(global, async (object) => {
        await expect((object as Directory).bindIdentityHome(p.provider, p.subject, account.userId, p.authEpoch)).rejects.toThrow(/stale|review/);
        await expect((object as Directory).bindIdentityHome(p.provider, p.subject, account.userId, freshEpoch)).rejects.toThrow(/review/);
        await expect((object as Directory).addInvite(p.email)).rejects.toThrow();
      });
      expect(await global.deletionProbe(account.userId, account.vaultId)).toBeGreaterThan(0);
      expect(await global.existingIdentity(p.provider, p.subject)).toEqual({ userId: account.userId, vaultId: account.vaultId });
    } finally { await clearGlobalQuarantineForTest(global, operation); }
  }, 30_000);

  it("advances the authorization epoch once per revocation, including retries", async () => {
    const p = await input(), global = directory(env);
    await global.addInvite(p.email);
    const operation = crypto.randomUUID(), before = await global.googleAuthEpoch();
    await runInDurableObject(global, async (object) => {
      const d = object as Directory;
      const coordinator = (object as unknown as { inviteRevocation: { begin(email: string, id: string): Promise<unknown>; resume(): Promise<void> } }).inviteRevocation;
      await coordinator.begin(p.email, operation);
      expect(await d.googleAuthEpoch()).toBe(before + 1);
      await coordinator.begin(p.email, operation);
      expect(await d.googleAuthEpoch()).toBe(before + 1);
      await coordinator.resume();
    });
    expect((await global.revokeInviteV3(p.email, operation)).state).toBe("complete");
    expect(await global.googleAuthEpoch()).toBe(before + 1);
  }, 30_000);

  it("does not first-bind the affected account during an active barrier, even with a fresh epoch", async () => {
    const p = await input(), global = directory(env);
    await global.addInvite(p.email);
    const routed = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, p);
    const account = await routed.directory.signIn(routed.input);
    const operation = crypto.randomUUID();
    await runInDurableObject(global, async (object) => {
      const d = object as Directory;
      const coordinator = (object as unknown as { inviteRevocation: { begin(email: string, id: string): Promise<unknown>; resume(): Promise<void> } }).inviteRevocation;
      await coordinator.begin(p.email, operation);
      try {
        const epoch = await d.googleAuthEpoch();
        await expect(d.bindIdentityHome(p.provider, p.subject, account.userId, epoch)).rejects.toThrow();
      } finally {
        await coordinator.resume();
      }
    });
    try {
      expect(await global.inviteRevocationStatus(operation)).toEqual({ state: "pending", remaining: 1, orphans: 1 });
      expect(await global.existingIdentity(p.provider, p.subject)).toEqual({ userId: account.userId, vaultId: account.vaultId });
    } finally { await clearGlobalQuarantineForTest(global, operation); }
  }, 30_000);

  it("allows an unrelated existing account to sign in with a fresh epoch during the barrier", async () => {
    const p = await input(), other = await input(), global = directory(env);
    await global.addInvite(p.email);
    await global.addInvite(other.email);
    const routed = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, other);
    const account = await routed.directory.signIn(routed.input);
    await global.bindIdentityHome(other.provider, other.subject, account.userId, other.authEpoch);
    const operation = crypto.randomUUID();
    await runInDurableObject(global, async (object) => {
      const d = object as Directory;
      const coordinator = (object as unknown as { inviteRevocation: { begin(email: string, id: string): Promise<unknown>; resume(): Promise<void> } }).inviteRevocation;
      await coordinator.begin(p.email, operation);
      try {
        const freshEpoch = await d.googleAuthEpoch();
        const signedIn = await d.signIn({ ...other, authEpoch: freshEpoch });
        await d.bindIdentityHome(other.provider, other.subject, signedIn.userId, freshEpoch);
        expect(signedIn.userId).toBe(account.userId);
      } finally {
        await coordinator.resume();
      }
    });
    expect((await global.inviteRevocationStatus(operation)).state).toBe("complete");
  }, 30_000);

  it("keeps previously bound accounts usable after their invitation is revoked", async () => {
    const p = await input(), global = directory(env);
    await global.addInvite(p.email);
    const routed = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, p);
    const account = await routed.directory.signIn(routed.input);
    await global.bindIdentityHome(p.provider, p.subject, account.userId, p.authEpoch);
    expect((await global.revokeInviteV3(p.email, crypto.randomUUID())).state).toBe("complete");
    const freshEpoch = await global.googleAuthEpoch();
    const again = await global.signIn({ ...p, authEpoch: freshEpoch, expectedUserId: account.userId });
    await global.bindIdentityHome(p.provider, p.subject, again.userId, freshEpoch);
    expect(again).toEqual(account);
  }, 30_000);
});
