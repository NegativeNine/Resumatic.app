import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { Directory } from "../../src/directory/directory";
import { directoryForSignIn } from "../../src/directory/routing";
import { allDirectories, directory, directoryByName, directoryForUser } from "../../src/shared/stubs";
import type { SignInInput } from "../../src/shared/types";
import { eventually } from "./support";
import { undoInviteInventoryMigrations } from "../support/undo-invite-inventory";

async function account() {
  const global = directory(env);
  const nonce = crypto.randomUUID();
  const input: SignInInput = { provider: "google", subject: `floor-${nonce}`, email: `floor-${nonce}@example.test`, hint: "enam", authEpoch: await global.googleAuthEpoch() };
  await global.addInvite(input.email);
  const config = { ...env, DIRECTORY_SHARDS: "16" };
  const held = await directoryForSignIn(config, input);
  const first = await directoryForSignIn(config, input);
  const current = await first.directory.signInWithInviteClaimV2({ ...first.input, reportCreation: true });
  await global.bindIdentityHomeV3("google", input.subject, current.userId, input.authEpoch, undefined, false, current.shardInviteClaim ?? null);
  return { global, input, held, current, home: directoryForUser(env, current.userId) };
}

it("rejects a pre-migration create after a previously erased shard wakes", async () => {
  const f = await account();
  await f.home.deleteAccount(f.current.userId, f.current.vaultId);
  // Resolve the sharded invitation before testing identity-floor erasure.
  expect((await f.global.revokeInviteV3(f.input.email, crypto.randomUUID())).state).toBe("complete");
  await runDurableObjectAlarm(f.home);
  await eventually(async () => {
    await runDurableObjectAlarm(f.global);
    await runDurableObjectAlarm(f.home);
    return !(await f.home.existingIdentity("google", f.input.subject));
  }, "identity erasure");
  expect(await f.global.googleAuthEpoch()).toBeGreaterThan(f.input.authEpoch!);
  const barrier = await f.global.googleShardRolloutEpoch();
  const beforeRollout = { ...f.held.input, authEpoch: barrier - 1 };
  // Recreate the persisted V12 state of an already-erased legacy shard: its
  // V3 floor has no memory of an older deletion, and V13 has not run yet.
  await runInDurableObject(f.home, (_instance, state) => {
    state.storage.sql.exec(`UPDATE meta SET value='0' WHERE key='shard_auth_floor'`);
    state.storage.sql.exec(`DELETE FROM meta WHERE key='shard_rollout_epoch'`);
    undoInviteInventoryMigrations(state.storage.sql);
    for (const trigger of ["assign_invite_generation", "rotate_reissued_invite", "guard_invite_delete"])
      state.storage.sql.exec(`DROP TRIGGER ${trigger}`);
    state.storage.sql.exec(`DROP TRIGGER guard_invite_delete_permit`);
    state.storage.sql.exec(`DROP TRIGGER guard_invite_delete_authorization_v2`);
    state.storage.sql.exec(`DROP TABLE invite_delete_authorizations_v2`);
    state.storage.sql.exec(`DROP TRIGGER remove_account_invite_binding`);
    state.storage.sql.exec(`DROP TABLE account_invite_bindings`);
    state.storage.sql.exec(`DROP TABLE invite_delete_authorizations`);
    for (const table of ["invite_delete_permits", "invite_deletion_receipts", "account_invite_deletions"])
      state.storage.sql.exec(`DROP TABLE ${table}`);
    state.storage.sql.exec(`ALTER TABLE invites DROP COLUMN generation`);
    state.storage.sql.exec(`DROP TRIGGER guard_account_finalization`);
    state.storage.sql.exec(`DROP TABLE account_final_sweeps`);
    state.storage.sql.exec(`ALTER TABLE retired_vaults DROP COLUMN generation`);
    for (const trigger of ["billing_account_insert_token", "billing_account_update_token", "billing_account_delete_token"])
      state.storage.sql.exec(`DROP TRIGGER ${trigger}`);
    state.storage.sql.exec(`DROP TABLE billing_state_clock`);
    state.storage.sql.exec(`ALTER TABLE billing_accounts DROP COLUMN state_token`);
    state.storage.sql.exec(`ALTER TABLE billing_events DROP COLUMN incarnation`);
    state.storage.sql.exec(`DROP TRIGGER guard_shard_home_claim_bind`);
    state.storage.sql.exec(`DROP TRIGGER remove_shard_home_claim_token`);
    state.storage.sql.exec(`DROP TRIGGER remove_shard_identity_claim_on_identity`);
    state.storage.sql.exec(`DROP TRIGGER remove_shard_identity_claim_token`);
    state.storage.sql.exec(`DROP TABLE shard_home_claim_tokens`);
    state.storage.sql.exec(`DROP TABLE shard_identity_claim_tokens`);
    state.storage.sql.exec(`DROP TABLE shard_home_bind_claim_marker`);
    state.storage.sql.exec(`DROP TABLE shard_rollout_barrier`);
    state.storage.sql.exec(`UPDATE meta SET value='12' WHERE key='schema_version'`);
  });
  await evictDurableObject(f.home);
  await runInDurableObject(f.home, async (instance) => {
    const legacy = { ...beforeRollout };
    delete legacy.shardInviteClaim;
    await expect(instance.signIn(legacy)).rejects.toThrow("sign-in is stale");
    await expect(instance.signInWithInviteClaim(beforeRollout)).rejects.toThrow("sign-in is stale");
  });
  expect((await Promise.all([...allDirectories(env)].map((d) => d.existingIdentity("google", f.input.subject)))).filter(Boolean)).toHaveLength(0);
}, 30_000);

it("preserves a higher existing floor when installing the rollout barrier", async () => {
  const shard = directoryByName(env, "directory-0");
  const barrier = await directory(env).googleShardRolloutEpoch();
  let oldFloor = "0";
  await runInDurableObject(shard, (_instance, state) => {
    oldFloor = state.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='shard_auth_floor'`).one().value;
    state.storage.sql.exec(`UPDATE meta SET value=? WHERE key='shard_auth_floor'`, String(barrier + 10));
    state.storage.sql.exec(`DELETE FROM meta WHERE key='shard_rollout_epoch'`);
  });
  try {
    await evictDurableObject(shard);
    await runInDurableObject(shard, (_instance, state) => {
      expect(state.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='shard_auth_floor'`).one().value).toBe(String(barrier + 10));
      expect(state.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='shard_rollout_epoch'`).one().value).toBe(String(barrier));
    });
  } finally {
    await runInDurableObject(shard, (_instance, state) => state.storage.sql.exec(`UPDATE meta SET value=? WHERE key='shard_auth_floor'`, oldFloor));
  }
});

it("lets global synthetic recovery call a cold shard that reads the rollout barrier", async () => {
  const global = directory(env);
  const shard = directoryByName(env, "directory-1");
  await runInDurableObject(shard, (_instance, state) => {
    state.storage.sql.exec(`DELETE FROM meta WHERE key='shard_rollout_epoch'`);
  });
  await evictDurableObject(shard);
  const subject = `placement-${crypto.randomUUID()}@placement.invalid`;
  const epoch = await global.placementEpoch();
  await global.reservePlacementAttempt("test", subject, 1, epoch);
  // The coordinator awaits the shard's seal RPC; the shard constructor in
  // turn reads the coordinator. Both calls must complete under input gates.
  expect(await global.reconcileSyntheticPlacement("test", subject)).toEqual({ remaining: 0 });
  const barrier = await global.googleShardRolloutEpoch();
  await runInDurableObject(shard, (_instance, state) => {
    expect(Number(state.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='shard_rollout_epoch'`).one().value)).toBe(barrier);
  });
}, 30_000);

it("fails closed when the global rollout barrier is unavailable", async () => {
  const shard = directoryByName(env, "directory-2");
  await runInDurableObject(shard, async (instance, state) => {
    state.storage.sql.exec(`DELETE FROM meta WHERE key='shard_rollout_epoch'`);
    const bootstrap = instance as unknown as { installShardRolloutBarrier(): Promise<void> };
    const lookup = vi.spyOn(Directory.prototype, "googleShardRolloutEpoch").mockRejectedValue(new Error("coordinator offline"));
    try {
      await expect(bootstrap.installShardRolloutBarrier()).rejects.toThrow();
      expect(lookup).toHaveBeenCalled();
      expect(state.storage.sql.exec(`SELECT value FROM meta WHERE key='shard_rollout_epoch'`).toArray()).toHaveLength(0);
    } finally { lookup.mockRestore(); }
    await bootstrap.installShardRolloutBarrier();
    expect(state.storage.sql.exec(`SELECT value FROM meta WHERE key='shard_rollout_epoch'`).toArray()).toHaveLength(1);
  });
}, 30_000);

it("rejects a previously dispatched shard create after deletion and a new global placement", async () => {
  const f = await account();
  await f.home.deleteAccount(f.current.userId, f.current.vaultId);
  // Resolve the sharded invitation before testing identity-floor erasure.
  expect((await f.global.revokeInviteV3(f.input.email, crypto.randomUUID())).state).toBe("complete");
  await runDurableObjectAlarm(f.home);
  await eventually(async () => {
    await runDurableObjectAlarm(f.global);
    await runDurableObjectAlarm(f.home);
    return !(await f.home.existingIdentity("google", f.input.subject));
  }, "identity erasure");
  await f.global.addInvite(f.input.email);
  const fresh = { ...f.input, authEpoch: await f.global.googleAuthEpoch() };
  const target = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, fresh);
  const replacement = await target.directory.signIn(target.input);
  await f.global.bindIdentityHome("google", f.input.subject, replacement.userId, fresh.authEpoch);
  await runInDurableObject(f.home, async (instance) => {
    const legacy = { ...f.held.input };
    delete legacy.shardInviteClaim;
    await expect(instance.signIn(legacy)).rejects.toThrow("sign-in is stale");
    await expect(instance.signInWithInviteClaim(f.held.input)).rejects.toThrow("sign-in is stale");
  });
  const locations = await Promise.all([...allDirectories(env)].map((d) => d.existingIdentity("google", f.input.subject)));
  expect(locations.filter(Boolean)).toEqual([replacement]);
}, 30_000);

it("rejects a stale invited shard create after deletion even without a replacement", async () => {
  const f = await account();
  await f.home.deleteAccount(f.current.userId, f.current.vaultId);
  // Resolve the sharded invitation before testing identity-floor erasure.
  expect((await f.global.revokeInviteV3(f.input.email, crypto.randomUUID())).state).toBe("complete");
  await runDurableObjectAlarm(f.home);
  await eventually(async () => {
    await runDurableObjectAlarm(f.global);
    await runDurableObjectAlarm(f.home);
    return !(await f.home.existingIdentity("google", f.input.subject));
  }, "identity erasure");
  await runInDurableObject(f.home, async (instance) => {
    const legacy = { ...f.held.input };
    delete legacy.shardInviteClaim;
    await expect(instance.signIn(legacy)).rejects.toThrow("sign-in is stale");
    await expect(instance.signInWithInviteClaim(f.held.input)).rejects.toThrow("sign-in is stale");
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
    await expect(instance.forgetGoogleShardHomeV2(f.input.subject, shard, f.current.userId)).rejects.toThrow("account placement requires review");
  });
  expect(await f.global.googleAuthEpoch()).toBe(before);
  expect(await f.home.existingIdentity("google", f.input.subject)).toEqual({ userId: f.current.userId, vaultId: f.current.vaultId });
  await f.home.deleteAccount(f.current.userId, f.current.vaultId);
  await runInDurableObject(f.home, (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO shard_identity_delete_marker(user_id) VALUES (?)`, f.current.userId);
    try {
      expect(() => state.storage.sql.exec(`DELETE FROM identities WHERE provider='google' AND subject=?`, f.input.subject)).toThrow(/shard_auth_floor_required/);
    } finally { state.storage.sql.exec(`DELETE FROM shard_identity_delete_marker WHERE user_id=?`, f.current.userId); }
  });
});

it("does not acknowledge a legacy V2 release after the home is already absent", async () => {
  const f = await account();
  const shard = Number(f.current.userId.match(/^s(\d+):/)![1]);
  await f.global.forgetGoogleShardHomeV3(f.input.subject, shard, f.current.userId);
  const afterRelease = await f.global.googleAuthEpoch();
  await runInDurableObject(f.global, async (instance) => {
    await expect(instance.forgetGoogleShardHomeV2(f.input.subject, shard, f.current.userId))
      .rejects.toThrow("account placement requires review");
    await expect(instance.forgetIdentityHome("google", f.input.subject, shard, f.current.userId))
      .rejects.toThrow("account placement requires review");
    await expect(instance.releasePlacementHome("google", f.input.subject, crypto.randomUUID(), f.current.userId))
      .rejects.toThrow("placement fencing is restricted to synthetic identities");
  });
  expect(await f.global.googleAuthEpoch()).toBe(afterRelease);
  // V3 remains retryable after a lost reply and emits a new fence epoch.
  expect(await f.global.forgetGoogleShardHomeV3(f.input.subject, shard, f.current.userId)).toBeGreaterThan(afterRelease);
}, 30_000);

it("raises the shard floor at erasure and forces unrelated older callbacks to restart", async () => {
  const f = await account();
  const oldEpoch = f.input.authEpoch!;
  await f.home.deleteAccount(f.current.userId, f.current.vaultId);
  // Resolve the sharded invitation before testing identity-floor erasure.
  expect((await f.global.revokeInviteV3(f.input.email, crypto.randomUUID())).state).toBe("complete");
  await runDurableObjectAlarm(f.home);
  await eventually(async () => {
    await runDurableObjectAlarm(f.global);
    await runDurableObjectAlarm(f.home);
    return !(await f.home.existingIdentity("google", f.input.subject));
  }, "identity erasure");
  const floor = await runInDurableObject(f.home, (_instance, state) => Number(state.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='shard_auth_floor'`).one().value));
  expect(floor).toBeGreaterThan(oldEpoch);
  await runInDurableObject(f.home, async (instance) => {
    await expect(instance.signIn({ provider: "google", subject: `other-${crypto.randomUUID()}`, email: "unrelated@example.test", hint: "enam", homeShard: Number(f.current.userId.match(/^s(\d+):/)![1]), inviteAuthorized: true, authEpoch: oldEpoch })).rejects.toThrow("sign-in is stale");
  });
});

it("reissues a legacy acknowledgement that has no epoch", async () => {
  const f = await account();
  await f.home.deleteAccount(f.current.userId, f.current.vaultId);
  // Revoke while the globally bound claim still proves the account's invite;
  // the synthetic early home release below removes that ownership evidence.
  expect((await f.global.revokeInviteV3(f.input.email, crypto.randomUUID())).state).toBe("complete");
  const shard = Number(f.current.userId.match(/^s(\d+):/)![1]);
  await runInDurableObject(f.home, async (instance, state) => {
    state.storage.sql.exec(`INSERT INTO shard_deletion_releases(user_id,provider,subject,state,fence_epoch) VALUES (?,'google',?,'acknowledged',NULL)`, f.current.userId, f.input.subject);
    await (instance as unknown as { releaseGoogleShardHome(userId: string, subject: string, shard: number): Promise<void> }).releaseGoogleShardHome(f.current.userId, f.input.subject, shard);
    expect(state.storage.sql.exec<{state:string;fence_epoch:number}>(`SELECT state,fence_epoch FROM shard_deletion_releases WHERE user_id=?`, f.current.userId).one()).toEqual({ state: "acknowledged", fence_epoch: expect.any(Number) });
  });
  await runDurableObjectAlarm(f.home);
  await eventually(async () => {
    await runDurableObjectAlarm(f.global);
    await runDurableObjectAlarm(f.home);
    return !(await f.home.existingIdentity("google", f.input.subject));
  }, "legacy acknowledgement erasure");
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
