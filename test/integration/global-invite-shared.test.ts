import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directory } from "../../src/shared/stubs";

async function alarmNow(stub: ReturnType<typeof directory>) {
  await runInDurableObject(stub, async (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    const delay = local.SWEEP_DELAY_MS;
    local.SWEEP_DELAY_MS = "0";
    try { await (instance as Directory).alarm(); }
    finally { local.SWEEP_DELAY_MS = delay; }
  });
}

async function bindSyntheticUser(stub: ReturnType<typeof directory>, userId: string, email: string) {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO account_invite_bindings(user_id,email,generation)
      SELECT ?,email,generation FROM invites WHERE email=?`, userId, email);
  });
}

it("preserves the shared invitation when one of two global accounts is deleted", async () => {
  const global = directory(env), id = crypto.randomUUID();
  const email = `shared-${id}@example.test`;
  await global.addInvite(email);
  const a = await global.signIn({ provider: "test", subject: `a-${id}`, email, hint: "enam", authEpoch: await global.googleAuthEpoch() });
  const b = await global.signIn({ provider: "test", subject: `b-${id}`, email, hint: "enam", authEpoch: await global.googleAuthEpoch() });
  expect(a.userId).not.toBe(b.userId);
  await global.deleteAccount(a.userId, a.vaultId);
  await alarmNow(global);
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  expect(await global.deletionProbe(a.userId, a.vaultId)).toBe(0);
  await expect(env.VAULT.get(env.VAULT.idFromString(b.vaultId)).openSession(b.userId)).resolves.toBeDefined();
  // When the last local account is later erased, its own captured generation
  // can be removed. This is not proof that other shard accounts do not exist.
  await global.deleteAccount(b.userId, b.vaultId);
  await alarmNow(global);
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(false);
  expect(await global.deletionProbe(b.userId, b.vaultId)).toBe(0);
}, 30_000);

it("preserves a shared legacy email under the same JavaScript normalization as sign-in", async () => {
  const global = directory(env), id = crypto.randomUUID();
  const email = `shared-\u0130-${id}@example.test`, normalized = email.trim().toLowerCase();
  await global.addInvite(email);
  const a = await global.signIn({ provider: "test", subject: `a-${id}`, email, hint: "enam", authEpoch: await global.googleAuthEpoch() });
  const b = await global.signIn({ provider: "test", subject: `b-${id}`, email, hint: "enam", authEpoch: await global.googleAuthEpoch() });
  // Older rows may not have used the current case normalization; SQLite's
  // lower() does not implement JavaScript's Unicode case mapping.
  await runInDurableObject(global, (_instance, state) => state.storage.sql.exec(`UPDATE users SET email=? WHERE user_id=?`, `  ${email.toUpperCase()}  `, b.userId));
  await global.deleteAccount(a.userId, a.vaultId);
  await alarmNow(global);
  expect((await global.listInvites()).some((invite) => invite.email === normalized)).toBe(true);
  expect(await global.deletionProbe(a.userId, a.vaultId)).toBe(0);
  expect(await global.revokeInviteV3(email, crypto.randomUUID())).toMatchObject({ state: "complete" });
}, 30_000);

it("removes the invite when both same-email accounts are already deleting", async () => {
  const global = directory(env), id = crypto.randomUUID(), email = `both-${id}@example.test`;
  await global.addInvite(email);
  const a = await global.signIn({ provider: "test", subject: `a-${id}`, email, hint: "enam", authEpoch: await global.googleAuthEpoch() });
  const b = await global.signIn({ provider: "test", subject: `b-${id}`, email, hint: "enam", authEpoch: await global.googleAuthEpoch() });
  await global.deleteAccount(a.userId, a.vaultId);
  await global.deleteAccount(b.userId, b.vaultId);
  // The global coordinator serializes inventories; a competing finalization
  // remains pending until the next alarm rather than being lost.
  for (let attempt = 0; attempt < 4; attempt++) {
    await alarmNow(global);
    if ((await global.deletionProbe(a.userId, a.vaultId)) === 0 && (await global.deletionProbe(b.userId, b.vaultId)) === 0) break;
  }
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(false);
  expect(await global.deletionProbe(a.userId, a.vaultId)).toBe(0);
  expect(await global.deletionProbe(b.userId, b.vaultId)).toBe(0);
}, 30_000);

it("completes concurrent global and shard deletion without orphaning their shared invitation", async () => {
  const global = directory(env), id = crypto.randomUUID(), email = `global-shard-both-${id}@example.test`;
  const shard = env.DIRECTORY.getByName("directory-7"), shardSubject = `shard-${id}`;
  await global.addInvite(email);
  const epoch = await global.googleAuthEpoch();
  const a = await global.signIn({ provider: "test", subject: `global-${id}`, email, hint: "enam", authEpoch: epoch });
  expect(await global.claimIdentityHome("test", shardSubject, 7, email, undefined, epoch)).toBe(7);
  const b = await shard.signIn({ provider: "test", subject: shardSubject, email, hint: "enam", homeShard: 7, authEpoch: epoch });
  await global.bindIdentityHome("test", shardSubject, b.userId, epoch);
  await global.deleteAccount(a.userId, a.vaultId);
  await shard.deleteAccount(b.userId, b.vaultId);
  // Independent alarms can overlap, and a busy coordinator can require retry.
  for (let i = 0; i < 6; i++) {
    await alarmNow(global);
    await alarmNow(shard);
    if ((await global.deletionProbe(a.userId, a.vaultId)) === 0 && (await shard.deletionProbe(b.userId, b.vaultId)) === 0) break;
  }
  expect(await global.deletionProbe(a.userId, a.vaultId)).toBe(0);
  expect(await shard.deletionProbe(b.userId, b.vaultId)).toBe(0);
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(false);
}, 60_000);

it("does not skip a malformed row following a known shared user", async () => {
  const global = directory(env), id = crypto.randomUUID(), email = `${id}@example.test`;
  const user = crypto.randomUUID(), vault = env.VAULT.newUniqueId().toString(), op = crypto.randomUUID();
  await global.addInvite(email);
  await bindSyntheticUser(global, user, email);
  await global.captureInviteForDeletion(op, user, vault, email);
  await runInDurableObject(global, async (instance, state) => {
    state.storage.sql.exec(`INSERT INTO global_auth_marker(slot,epoch) SELECT 1,CAST(value AS INTEGER) FROM meta WHERE key='global_auth_epoch'`);
    state.storage.sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,?,'active',?)`, `first-${id}`, email, Date.now());
    state.storage.sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,x'FF','active',?)`, `last-${id}`, Date.now());
    state.storage.sql.exec(`DELETE FROM global_auth_marker WHERE slot=1`);
    try {
      const scan = instance as unknown as { hasOtherLocalInviteUser(userId: string, email: string, includeDeleting: boolean): boolean };
      expect(() => scan.hasOtherLocalInviteUser(user, email, true)).toThrow("invitation ownership requires review");
    } finally { state.storage.sql.exec(`DELETE FROM users WHERE user_id IN (?,?)`, `first-${id}`, `last-${id}`); }
  });
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  expect(await global.revokeInviteV3(email, crypto.randomUUID())).toMatchObject({ state: "complete" });
});

it("holds a same-email user whose state is unknown", async () => {
  const global = directory(env), id = crypto.randomUUID(), email = `${id}@example.test`;
  const user = crypto.randomUUID(), vault = env.VAULT.newUniqueId().toString(), op = crypto.randomUUID();
  await global.addInvite(email);
  await bindSyntheticUser(global, user, email);
  await global.captureInviteForDeletion(op, user, vault, email);
  await runInDurableObject(global, async (instance, state) => {
    state.storage.sql.exec(`INSERT INTO global_auth_marker(slot,epoch) SELECT 1,CAST(value AS INTEGER) FROM meta WHERE key='global_auth_epoch'`);
    state.storage.sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,?,'unexpected',?)`, `unknown-${id}`, email, Date.now());
    state.storage.sql.exec(`DELETE FROM global_auth_marker WHERE slot=1`);
    try {
      const scan = instance as unknown as { hasOtherLocalInviteUser(userId: string, email: string, includeDeleting: boolean): boolean };
      expect(() => scan.hasOtherLocalInviteUser(user, email, true)).toThrow("invitation ownership requires review");
    } finally { state.storage.sql.exec(`DELETE FROM users WHERE user_id=?`, `unknown-${id}`); }
  });
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  expect(await global.revokeInviteV3(email, crypto.randomUUID())).toMatchObject({ state: "complete" });
});

it("holds an oversized local inventory and can retry after it is reduced", async () => {
  const global = directory(env), id = crypto.randomUUID(), email = `${id}@example.test`;
  const user = crypto.randomUUID(), vault = env.VAULT.newUniqueId().toString(), op = crypto.randomUUID();
  await global.addInvite(email);
  await bindSyntheticUser(global, user, email);
  await global.captureInviteForDeletion(op, user, vault, email);
  await runInDurableObject(global, async (instance, state) => {
    state.storage.sql.exec(`INSERT INTO global_auth_marker(slot,epoch) SELECT 1,CAST(value AS INTEGER) FROM meta WHERE key='global_auth_epoch'`);
    state.storage.sql.exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<10001)
      INSERT INTO users(user_id,email,state,created_at) SELECT ? || n, 'other-' || n || '@example.test', 'active', ? FROM seq`, `bulk-${id}-`, Date.now());
    state.storage.sql.exec(`DELETE FROM global_auth_marker WHERE slot=1`);
    try {
      const scan = instance as unknown as { hasOtherLocalInviteUser(userId: string, email: string, includeDeleting: boolean): boolean };
      expect(() => scan.hasOtherLocalInviteUser(user, email, true)).toThrow("invitation ownership inventory requires review");
    } finally { state.storage.sql.exec(`DELETE FROM users WHERE user_id LIKE ?`, `bulk-${id}-%`); }
  });
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  await runInDurableObject(global, (instance) => {
    const scan = instance as unknown as { hasOtherLocalInviteUser(userId: string, email: string, includeDeleting: boolean): boolean };
    expect(scan.hasOtherLocalInviteUser(user, email, true)).toBe(false);
  });
  expect(await global.revokeInviteV3(email, crypto.randomUUID())).toMatchObject({ state: "complete" });
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(false);
}, 30_000);

it("holds an ambiguous malformed local email and retries without deleting a reissue", async () => {
  const global = directory(env), id = crypto.randomUUID(), email = `${id}@example.test`;
  const user = crypto.randomUUID(), vault = env.VAULT.newUniqueId().toString(), op = crypto.randomUUID();
  await global.addInvite(email);
  await bindSyntheticUser(global, user, email);
  await global.captureInviteForDeletion(op, user, vault, email);
  await runInDurableObject(global, async (instance, state) => {
    state.storage.sql.exec(`INSERT INTO global_auth_marker(slot,epoch) SELECT 1,CAST(value AS INTEGER) FROM meta WHERE key='global_auth_epoch'`);
    state.storage.sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,x'FF','active',?)`, `malformed-${id}`, Date.now());
    state.storage.sql.exec(`DELETE FROM global_auth_marker WHERE slot=1`);
    try {
      const scan = instance as unknown as { hasOtherLocalInviteUser(userId: string, email: string, includeDeleting: boolean): boolean };
      expect(() => scan.hasOtherLocalInviteUser(user, email, true)).toThrow("invitation ownership requires review");
      expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM invite_deletion_receipts WHERE operation_id=?`, op).one().state).toBe("captured");
      state.storage.sql.exec(`DELETE FROM users WHERE user_id=?`, `malformed-${id}`);
    } finally { state.storage.sql.exec(`DELETE FROM users WHERE user_id=?`, `malformed-${id}`); }
  });
  await global.addInvite(email);
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  expect(await global.revokeInviteV3(email, crypto.randomUUID())).toMatchObject({ state: "complete" });
});
