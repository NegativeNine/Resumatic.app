import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { Directory } from "../../src/directory/directory";
import { directoryForSignIn } from "../../src/directory/routing";
import { allDirectories, directory, directoryForUser } from "../../src/shared/stubs";
import type { SignInInput } from "../../src/shared/types";
import { eventually } from "./support";

async function account() {
  const global = directory(env);
  const nonce = crypto.randomUUID();
  const input: SignInInput = { provider: "google", subject: `floor-${nonce}`, email: `floor-${nonce}@example.test`, hint: "enam", authEpoch: await global.googleAuthEpoch() };
  await global.addInvite(input.email);
  const config = { ...env, DIRECTORY_SHARDS: "16" };
  const held = await directoryForSignIn(config, input);
  const first = await directoryForSignIn(config, input);
  const current = await first.directory.signIn(first.input);
  await global.bindIdentityHome("google", input.subject, current.userId, input.authEpoch);
  return { global, input, held, current, home: directoryForUser(env, current.userId) };
}

it("rejects a previously dispatched shard create after deletion and a new global placement", async () => {
  const f = await account();
  await f.home.deleteAccount(f.current.userId, f.current.vaultId);
  await runDurableObjectAlarm(f.home);
  await eventually(async () => !(await f.home.existingIdentity("google", f.input.subject)), "identity erasure");
  await f.global.addInvite(f.input.email);
  const fresh = { ...f.input, authEpoch: await f.global.googleAuthEpoch() };
  const target = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, fresh);
  const replacement = await target.directory.signIn(target.input);
  await f.global.bindIdentityHome("google", f.input.subject, replacement.userId, fresh.authEpoch);
  await runInDurableObject(f.home, async (instance) => {
    await expect(instance.signIn(f.held.input)).rejects.toThrow("sign-in is stale");
  });
  const locations = await Promise.all([...allDirectories(env)].map((d) => d.existingIdentity("google", f.input.subject)));
  expect(locations.filter(Boolean)).toEqual([replacement]);
}, 30_000);

it("rejects a stale invited shard create after deletion even without a replacement", async () => {
  const f = await account();
  await f.home.deleteAccount(f.current.userId, f.current.vaultId);
  await runDurableObjectAlarm(f.home);
  await eventually(async () => !(await f.home.existingIdentity("google", f.input.subject)), "identity erasure");
  await runInDurableObject(f.home, async (instance) => {
    await expect(instance.signIn(f.held.input)).rejects.toThrow("sign-in is stale");
  });
  expect((await Promise.all([...allDirectories(env)].map((d) => d.existingIdentity("google", f.input.subject)))).filter(Boolean)).toHaveLength(0);
}, 30_000);

it("blocks a markerless legacy shard insertion and legacy global release after migration", async () => {
  const f = await account();
  await runInDurableObject(f.home, (_instance, state) => {
    expect(() => state.storage.sql.exec(`INSERT INTO identities(provider,subject,user_id) VALUES ('google',?,?)`, `legacy-${crypto.randomUUID()}`, f.current.userId)).toThrow(/shard_auth_required/);
    expect(state.storage.sql.exec(`SELECT * FROM shard_auth_marker`).toArray()).toHaveLength(0);
  });
  const shard = Number(f.current.userId.match(/^s(\d+):/)![1]);
  const before = await f.global.googleAuthEpoch();
  await runInDurableObject(f.global, async (instance) => {
    await expect(instance.forgetGoogleShardHomeV2(f.input.subject, shard, f.current.userId)).rejects.toThrow(/shard_auth_floor_required/);
  });
  expect(await f.global.googleAuthEpoch()).toBe(before);
  expect(await f.home.existingIdentity("google", f.input.subject)).toEqual(f.current);
  await f.home.deleteAccount(f.current.userId, f.current.vaultId);
  await runInDurableObject(f.home, (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO shard_identity_delete_marker(user_id) VALUES (?)`, f.current.userId);
    try {
      expect(() => state.storage.sql.exec(`DELETE FROM identities WHERE provider='google' AND subject=?`, f.input.subject)).toThrow(/shard_auth_floor_required/);
    } finally { state.storage.sql.exec(`DELETE FROM shard_identity_delete_marker WHERE user_id=?`, f.current.userId); }
  });
});

it("raises the shard floor at erasure and forces unrelated older callbacks to restart", async () => {
  const f = await account();
  const oldEpoch = f.input.authEpoch!;
  await f.home.deleteAccount(f.current.userId, f.current.vaultId);
  await runDurableObjectAlarm(f.home);
  await eventually(async () => !(await f.home.existingIdentity("google", f.input.subject)), "identity erasure");
  const floor = await runInDurableObject(f.home, (_instance, state) => Number(state.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='shard_auth_floor'`).one().value));
  expect(floor).toBeGreaterThan(oldEpoch);
  await runInDurableObject(f.home, async (instance) => {
    await expect(instance.signIn({ provider: "google", subject: `other-${crypto.randomUUID()}`, email: "unrelated@example.test", hint: "enam", homeShard: Number(f.current.userId.match(/^s(\d+):/)![1]), inviteAuthorized: true, authEpoch: oldEpoch })).rejects.toThrow("sign-in is stale");
  });
});

it("reissues a legacy acknowledgement that has no epoch", async () => {
  const f = await account();
  await f.home.deleteAccount(f.current.userId, f.current.vaultId);
  const shard = Number(f.current.userId.match(/^s(\d+):/)![1]);
  await runInDurableObject(f.home, async (instance, state) => {
    state.storage.sql.exec(`INSERT INTO shard_deletion_releases(user_id,provider,subject,state,fence_epoch) VALUES (?,'google',?,'acknowledged',NULL)`, f.current.userId, f.input.subject);
    await (instance as unknown as { releaseGoogleShardHome(userId: string, subject: string, shard: number): Promise<void> }).releaseGoogleShardHome(f.current.userId, f.input.subject, shard);
    expect(state.storage.sql.exec<{state:string;fence_epoch:number}>(`SELECT state,fence_epoch FROM shard_deletion_releases WHERE user_id=?`, f.current.userId).one()).toEqual({ state: "acknowledged", fence_epoch: expect.any(Number) });
  });
  await runDurableObjectAlarm(f.home);
  await eventually(async () => !(await f.home.existingIdentity("google", f.input.subject)), "legacy acknowledgement erasure");
});

it("keeps the maximum epoch when release replies arrive out of order", async () => {
  const f = await account();
  await f.home.deleteAccount(f.current.userId, f.current.vaultId);
  const shard = Number(f.current.userId.match(/^s(\d+):/)![1]);
  let entered!: () => void, release!: () => void;
  const paused = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const original = Directory.prototype.forgetGoogleShardHomeV3;
  let calls = 0;
  const spy = vi.spyOn(Directory.prototype, "forgetGoogleShardHomeV3").mockImplementation(async function (this: Directory, ...args) {
    const epoch = await original.call(this, ...args);
    if (++calls === 1) { entered(); await held; }
    return epoch;
  });
  try {
    await runInDurableObject(f.home, async (instance, state) => {
      const local = instance as unknown as { releaseGoogleShardHome(userId: string, subject: string, shard: number): Promise<void> };
      const first = local.releaseGoogleShardHome(f.current.userId, f.input.subject, shard);
      try {
        await paused;
        await local.releaseGoogleShardHome(f.current.userId, f.input.subject, shard);
        const newer = state.storage.sql.exec<{fence_epoch:number}>(`SELECT fence_epoch FROM shard_deletion_releases WHERE user_id=?`, f.current.userId).one().fence_epoch;
        release();
        await first;
        expect(state.storage.sql.exec<{fence_epoch:number}>(`SELECT fence_epoch FROM shard_deletion_releases WHERE user_id=?`, f.current.userId).one().fence_epoch).toBe(newer);
        expect(calls).toBe(2);
      } finally { release(); await first.catch(() => {}); }
    });
  } finally { release(); spy.mockRestore(); }
});
