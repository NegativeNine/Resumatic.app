import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { Directory } from "../../src/directory/directory";
import { directoryForSignIn } from "../../src/directory/routing";
import { directory, directoryForUser } from "../../src/shared/stubs";
import { eventually } from "./support";

const global = () => directory(env);
const id = (shard: number) => `s${shard}:${crypto.randomUUID()}`;
async function boundHome(shard = 3) {
  const g = global();
  const subject = `epoch-${crypto.randomUUID()}@example.test`;
  const userId = id(shard);
  const epoch = await g.googleAuthEpoch();
  await g.addInvite(subject);
  await g.claimIdentityHome("google", subject, shard, subject, undefined, epoch);
  await g.bindIdentityHome("google", subject, userId, epoch);
  return { g, subject, userId, shard };
}
async function home(subject: string) {
  return runInDurableObject(global(), (_instance, state) => state.storage.sql
    .exec<{ user_id: string | null; shard: number | null }>(
      `SELECT user_id,shard FROM identity_homes WHERE provider='google' AND subject=?`, subject,
    ).toArray()[0] ?? null);
}

describe("sharded Google home release: adversarial ordering", () => {
  it("invalidates an authorization issued after an unrelated deletion but before release", async () => {
    const { g, subject, userId, shard } = await boundHome();
    const otherSubject = `other-${crypto.randomUUID()}@example.test`;
    const other = await g.signIn({ provider: "test", subject: otherSubject, email: otherSubject, hint: "enam" });
    const before = await g.googleAuthEpoch();
    await g.deleteAccount(other.userId, other.vaultId);
    const afterOtherDelete = await g.googleAuthEpoch();
    expect(afterOtherDelete).toBeGreaterThan(before);
    // This challenge is issued during the deletion, after the unrelated bump.
    const staleEpoch = afterOtherDelete;
    await g.forgetGoogleShardHomeV3(subject, shard, userId);
    expect(await g.googleAuthEpoch()).toBeGreaterThan(staleEpoch);
    expect(await home(subject)).toBeNull();
    await runInDurableObject(g, async (instance) => {
      await expect(instance.claimIdentityHome("google", subject, shard, subject, undefined, staleEpoch))
        .rejects.toThrow("sign-in is stale");
    });
  });

  it("does not remove a newer bound home when an old release is repeated", async () => {
    const { g, subject, userId, shard } = await boundHome();
    await g.forgetGoogleShardHomeV3(subject, shard, userId);
    const newerUser = id(shard);
    const fresh = await g.googleAuthEpoch();
    await g.claimIdentityHome("google", subject, shard, subject, undefined, fresh);
    await g.bindIdentityHome("google", subject, newerUser, fresh);
    const beforeRepeat = await g.googleAuthEpoch();
    await runInDurableObject(g, async (instance) => {
      await expect(instance.forgetGoogleShardHomeV3(subject, shard, userId)).rejects.toThrow("account placement requires review");
    });
    expect(await home(subject)).toEqual({ user_id: newerUser, shard });
    expect(await g.googleAuthEpoch()).toBe(beforeRepeat);
  });

  it("advances on an absent home but fails closed on an unbound claim", async () => {
    const { g, subject, userId, shard } = await boundHome();
    await g.forgetGoogleShardHomeV3(subject, shard, userId);
    const beforeMissing = await g.googleAuthEpoch();
    await g.forgetGoogleShardHomeV3(subject, shard, userId);
    expect(await g.googleAuthEpoch()).toBeGreaterThan(beforeMissing);
    const fresh = await g.googleAuthEpoch();
    await g.claimIdentityHome("google", subject, shard, subject, undefined, fresh);
    await runInDurableObject(g, async (instance) => {
      await expect(instance.forgetGoogleShardHomeV3(subject, shard, userId))
        .rejects.toThrow("account placement requires review");
    });
    expect(await home(subject)).toEqual({ user_id: null, shard });
    expect(await g.googleAuthEpoch()).toBe(fresh);
  });

  it("blocks legacy raw home deletion after migration without leaving a marker", async () => {
    const { g, subject, userId, shard } = await boundHome();
    await runInDurableObject(g, (instance, state) => {
      const sql = state.storage.sql;
      expect(() => sql.exec(`DELETE FROM identity_homes WHERE provider='google' AND subject=?`, subject))
        .toThrow(/(?:shard_deletion_barrier_required|shard_auth_floor_required)/);
      expect(sql.exec(`SELECT * FROM global_shard_home_release_marker`).toArray()).toHaveLength(0);
      return expect(instance.forgetIdentityHome("google", subject, shard, userId))
        .rejects.toThrow(/(?:shard_deletion_barrier_required|shard_auth_floor_required)/);
    });
    expect(await home(subject)).toEqual({ user_id: userId, shard });
    await g.forgetGoogleShardHomeV3(subject, shard, userId);
    expect(await home(subject)).toBeNull();
  });

  it("keeps an unacknowledged release pending and finishes after a lost reply", async () => {
    const g = global();
    const subject = `lost-ack-${crypto.randomUUID()}@example.test`;
    const p = { provider: "google" as const, subject, email: subject, hint: "enam" as const, authEpoch: await g.googleAuthEpoch() };
    await g.addInvite(subject);
    const target = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "16" }, p);
    const account = await target.directory.signIn(target.input);
    await g.bindIdentityHome("google", subject, account.userId, p.authEpoch);
    const shard = directoryForUser(env, account.userId);
    await shard.deleteAccount(account.userId, account.vaultId);

    const original = Directory.prototype.forgetGoogleShardHomeV3;
    let calls = 0;
    const spy = vi.spyOn(Directory.prototype, "forgetGoogleShardHomeV3").mockImplementation(async function (this: Directory, ...args) {
      const result = await original.call(this, ...args);
      if (++calls === 1) throw new Error("synthetic lost acknowledgement");
      return result;
    });
    try {
      await runDurableObjectAlarm(shard);
      expect(calls).toBe(1);
      expect(await shard.existingIdentity("google", subject)).toEqual(account);
      expect(await home(subject)).toBeNull();
      expect(await runInDurableObject(shard, (_instance, state) => state.storage.sql
        .exec<{state: string}>(`SELECT state FROM shard_deletion_releases WHERE user_id=? AND subject=?`, account.userId, subject)
        .toArray())).toEqual([{ state: "pending" }]);
      await runDurableObjectAlarm(shard);
      await eventually(async () => !(await shard.existingIdentity("google", subject)), "shard identity erasure");
      expect(calls).toBe(2);
      expect(await runInDurableObject(shard, (_instance, state) => ({
        releases: state.storage.sql.exec(`SELECT * FROM shard_deletion_releases WHERE user_id=?`, account.userId).toArray(),
        markers: state.storage.sql.exec(`SELECT * FROM shard_identity_delete_marker WHERE user_id=?`, account.userId).toArray(),
      }))).toEqual({ releases: [], markers: [] });
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it("rolls back the epoch, home removal and marker together if global deletion fails", async () => {
    const { g, subject, userId, shard } = await boundHome();
    const before = await g.googleAuthEpoch();
    await runInDurableObject(g, async (instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`CREATE TRIGGER adversarial_release_failure BEFORE DELETE ON identity_homes WHEN OLD.provider='google' BEGIN SELECT RAISE(ABORT,'synthetic release failure'); END`);
      try {
        await expect(instance.forgetGoogleShardHomeV3(subject, shard, userId)).rejects.toThrow("synthetic release failure");
        expect(sql.exec(`SELECT * FROM global_shard_home_release_marker`).toArray()).toHaveLength(0);
      } finally { sql.exec(`DROP TRIGGER adversarial_release_failure`); }
    });
    expect(await g.googleAuthEpoch()).toBe(before);
    expect(await home(subject)).toEqual({ user_id: userId, shard });
    await g.forgetGoogleShardHomeV3(subject, shard, userId);
    expect(await g.googleAuthEpoch()).toBe(before + 1);
    expect(await home(subject)).toBeNull();
  });

  it("does not repeat an acknowledged release after local deletion rolls back", async () => {
    const g = global();
    const subject = `local-rollback-${crypto.randomUUID()}@example.test`;
    const p = { provider: "google" as const, subject, email: subject, hint: "enam" as const, authEpoch: await g.googleAuthEpoch() };
    await g.addInvite(subject);
    const target = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "16" }, p);
    const account = await target.directory.signIn(target.input);
    await g.bindIdentityHome("google", subject, account.userId, p.authEpoch);
    const shard = directoryForUser(env, account.userId);
    await shard.deleteAccount(account.userId, account.vaultId);
    await runInDurableObject(shard, (_instance, state) => {
      expect(() => state.storage.sql.exec(`DELETE FROM identities WHERE provider='google' AND subject=?`, subject))
        .toThrow(/(?:shard_deletion_barrier_required|shard_auth_floor_required)/);
      state.storage.sql.exec(`CREATE TRIGGER adversarial_user_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT,'synthetic local failure'); END`);
    });
    try {
      await runDurableObjectAlarm(shard);
      expect(await shard.existingIdentity("google", subject)).toEqual(account);
      expect(await home(subject)).toBeNull();
      const afterRelease = await g.googleAuthEpoch();
      expect(await runInDurableObject(shard, (_instance, state) => ({
        releases: state.storage.sql.exec<{state: string}>(`SELECT state FROM shard_deletion_releases WHERE user_id=?`, account.userId).toArray(),
        markers: state.storage.sql.exec(`SELECT * FROM shard_identity_delete_marker WHERE user_id=?`, account.userId).toArray(),
      }))).toEqual({ releases: [{ state: "acknowledged" }], markers: [] });
      // Model a newer home bound while the old local deletion is retrying.
      // A retry of the old cleanup must neither release it nor bump again.
      const newUserId = id(Number(account.userId.match(/^s(\d+):/)![1]));
      const shardNumber = Number(account.userId.match(/^s(\d+):/)![1]);
      // Old cleanup can concurrently revoke the invitation; this test models
      // public registration so a newer home can still be claimed.
      await runInDurableObject(g, async (instance) => {
        const local = (instance as unknown as { env: Env }).env;
        const previous = local.INVITE_ONLY;
        local.INVITE_ONLY = "false";
        try {
          await instance.claimIdentityHome("google", subject, shardNumber, subject, undefined, afterRelease);
          await instance.bindIdentityHome("google", subject, newUserId, afterRelease);
        } finally { local.INVITE_ONLY = previous; }
      });
      await runInDurableObject(shard, (_instance, state) => state.storage.sql.exec(`DROP TRIGGER adversarial_user_delete`));
      await runDurableObjectAlarm(shard);
      await eventually(async () => !(await shard.existingIdentity("google", subject)), "shard identity erasure after rollback");
      expect(await g.googleAuthEpoch()).toBe(afterRelease);
      expect(await home(subject)).toEqual({ user_id: newUserId, shard: shardNumber });
      expect(await runInDurableObject(shard, (_instance, state) => state.storage.sql.exec(`SELECT * FROM shard_deletion_releases WHERE user_id=?`, account.userId).toArray())).toHaveLength(0);
    } finally {
      await runInDurableObject(shard, (_instance, state) => state.storage.sql.exec(`DROP TRIGGER IF EXISTS adversarial_user_delete`));
    }
  }, 30_000);

  it("refuses local finalization when an unacknowledged identity appears after the scan", async () => {
    const g = global();
    const subject = `scan-race-${crypto.randomUUID()}@example.test`;
    const addedSubject = `new-identity-${crypto.randomUUID()}@example.test`;
    const p = { provider: "google" as const, subject, email: subject, hint: "enam" as const, authEpoch: await g.googleAuthEpoch() };
    await g.addInvite(subject);
    const target = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "16" }, p);
    const account = await target.directory.signIn(target.input);
    await g.bindIdentityHome("google", subject, account.userId, p.authEpoch);
    const shard = directoryForUser(env, account.userId);
    await shard.deleteAccount(account.userId, account.vaultId);

    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = Directory.prototype.forgetGoogleShardHomeV3;
    const spy = vi.spyOn(Directory.prototype, "forgetGoogleShardHomeV3").mockImplementation(async function (this: Directory, ...args) {
      // Keep a subsequent alarm from acknowledging the added test identity.
      if (args[0] === addedSubject) throw new Error("synthetic release unavailable");
      const result = await original.call(this, ...args);
      entered();
      await gate;
      return result;
    });
    try {
      await runInDurableObject(shard, async (instance, state) => {
        const running = instance.alarm();
        try {
          await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("release not reached")), 5000))]);
          // Direct SQL models a later implementation or administrative change;
          // the current HTTP API does not offer this account-linking operation.
          state.storage.sql.exec(`INSERT INTO shard_auth_marker(slot,epoch) VALUES (1,?)`, p.authEpoch);
          try {
            state.storage.sql.exec(`INSERT INTO identities(provider,subject,user_id) VALUES ('google',?,?)`, addedSubject, account.userId);
          } finally { state.storage.sql.exec(`DELETE FROM shard_auth_marker WHERE slot=1`); }
          release();
          await running;
          const identities = state.storage.sql.exec<{subject: string}>(`SELECT subject FROM identities WHERE user_id=? ORDER BY subject`, account.userId).toArray();
          expect(identities.map((row) => row.subject).sort()).toEqual([subject, addedSubject].sort());
          const releases = state.storage.sql.exec<{subject: string; state: string}>(`SELECT subject,state FROM shard_deletion_releases WHERE user_id=?`, account.userId).toArray();
          expect(releases).toContainEqual({ subject, state: "acknowledged" });
          expect(releases).not.toContainEqual({ subject: addedSubject, state: "acknowledged" });
          expect(state.storage.sql.exec(`SELECT * FROM shard_identity_delete_marker WHERE user_id=?`, account.userId).toArray()).toEqual([]);
        } finally {
          release();
          await running.catch(() => {});
        }
      });
    } finally {
      release();
      spy.mockRestore();
    }
  }, 30_000);
});
