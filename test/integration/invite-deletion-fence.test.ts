import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { directory } from "../../src/shared/stubs";

it("preserves a reissued invite and same-email replacement account through old-account cleanup", async () => {
  const global = directory(env);
  // The production coordinator only accepts canonical global and shard homes.
  const home = env.DIRECTORY.getByName("directory-0");
  const email = `${crypto.randomUUID()}@example.test`;
  await global.addInvite(email);
  const old = await home.signIn({ provider: "test", subject: `old-${crypto.randomUUID()}`, email, hint: "enam", homeShard: 0, authEpoch: await global.googleAuthEpoch() });
  await home.deleteAccount(old.userId, old.vaultId);
  const op = await runInDurableObject(home, (_instance, state) => state.storage.sql.exec<{operation_id:string}>(
    `SELECT operation_id FROM account_invite_deletions WHERE user_id=?`, old.userId,
  ).one().operation_id);
  // The old row is still present: another admin issuance is a new grant.
  const before = await runInDurableObject(global, (_instance, state) => state.storage.sql.exec<{generation:string}>(`SELECT generation FROM invites WHERE email=?`, email).one().generation);
  await global.addInvite(email);
  const after = await runInDurableObject(global, (_instance, state) => state.storage.sql.exec<{generation:string}>(`SELECT generation FROM invites WHERE email=?`, email).one().generation);
  expect(after).not.toBe(before);
  const replacement = await global.signIn({ provider: "test", subject: `new-${crypto.randomUUID()}`, email, hint: "enam", authEpoch: await global.googleAuthEpoch() });
  await runInDurableObject(home, async (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    const delay = local.SWEEP_DELAY_MS;
    local.SWEEP_DELAY_MS = "0";
    try { await instance.alarm(); } finally { local.SWEEP_DELAY_MS = delay; }
  });
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  expect(await home.deletionProbe(old.userId, old.vaultId)).toBe(0);
  await expect(env.VAULT.get(env.VAULT.idFromString(replacement.vaultId)).openSession(replacement.userId)).resolves.toBeDefined();
  const receipt = await runInDurableObject(global, (_instance, state) => state.storage.sql.exec<{state:string;user_id:string|null;vault_id:string|null;email:string|null;generation:string|null}>(
    `SELECT state,user_id,vault_id,email,generation FROM invite_deletion_receipts WHERE operation_id=?`, op,
  ).one());
  expect(receipt).toEqual({ state: "closed", user_id: null, vault_id: null, email: null, generation: null });
  // A delayed old capture/removal after closure cannot adopt the new invite.
  await global.captureInviteForDeletion(op, old.userId, old.vaultId, email);
  await global.removeCapturedInvite(op, old.userId, old.vaultId, email);
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  await global.removeInviteV2(email);
}, 30_000);

it("retries a lost capture without adopting a newer or previously absent invite", async () => {
  const global = directory(env);
  const email = `${crypto.randomUUID()}@example.test`;
  const account = await global.signIn({ provider: "test", subject: `old-${crypto.randomUUID()}`, email, hint: "enam", authEpoch: await global.googleAuthEpoch() });
  await global.deleteAccount(account.userId, account.vaultId);
  const op = await runInDurableObject(global, (_instance, state) => state.storage.sql.exec<{operation_id:string}>(
    `SELECT operation_id FROM account_invite_deletions WHERE user_id=?`, account.userId,
  ).one().operation_id);
  await global.addInvite(email);
  await global.captureInviteForDeletion(op, account.userId, account.vaultId, email);
  await runInDurableObject(global, async (instance) => { await instance.alarm(); });
  expect(await global.deletionProbe(account.userId, account.vaultId)).toBe(0);
  await global.captureInviteForDeletion(op, account.userId, account.vaultId, email);
  await global.removeCapturedInvite(op, account.userId, account.vaultId, email);
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  await global.removeInviteV2(email);
});

it("captures a global-home invite atomically at deletion initiation", async () => {
  const global = directory(env), email = `${crypto.randomUUID()}@example.test`;
  await global.addInvite(email);
  const old = await global.signIn({ provider: "test", subject: `old-${crypto.randomUUID()}`, email, hint: "enam", authEpoch: await global.googleAuthEpoch() });
  await global.deleteAccount(old.userId, old.vaultId);
  const captured = await runInDurableObject(global, (_instance, state) => state.storage.sql.exec<{generation:string;operation_id:string}>(
    `SELECT r.generation,r.operation_id FROM invite_deletion_receipts r JOIN account_invite_deletions a ON a.operation_id=r.operation_id WHERE a.user_id=?`, old.userId,
  ).one());
  expect(captured.generation).toMatch(/^[a-f0-9]{32}$/);
  await global.addInvite(email);
  await runInDurableObject(global, async (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    const delay = local.SWEEP_DELAY_MS;
    local.SWEEP_DELAY_MS = "0";
    try { await instance.alarm(); } finally { local.SWEEP_DELAY_MS = delay; }
  });
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  expect(await global.deletionProbe(old.userId, old.vaultId)).toBe(0);
  await global.removeInviteV2(email);
}, 30_000);

it("holds a legacy deletion with no invitation operation rather than adopting a reissue", async () => {
  const global = directory(env), home = env.DIRECTORY.getByName(`invite-delete-legacy-${crypto.randomUUID()}`);
  const email = `${crypto.randomUUID()}@example.test`;
  const old = await home.signIn({ provider: "test", subject: `legacy-${crypto.randomUUID()}`, email, hint: "enam" });
  await global.addInvite(email);
  await runInDurableObject(home, async (instance, state) => {
    state.storage.sql.exec(`UPDATE users SET state='deleting' WHERE user_id=?`, old.userId);
    state.storage.sql.exec(`UPDATE vaults SET state='deleting' WHERE vault_id=?`, old.vaultId);
    await instance.alarm();
    expect(state.storage.sql.exec<{state:string}>(`SELECT state FROM vaults WHERE vault_id=?`, old.vaultId).one().state).toBe("deleting");
    expect(state.storage.sql.exec(`SELECT operation_id FROM account_invite_deletions WHERE user_id=?`, old.userId).toArray()).toEqual([]);
    await expect(instance.deleteAccount(old.userId, old.vaultId)).rejects.toThrow("account invitation requires review");
  });
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  await global.removeInviteV2(email);
}, 30_000);

it("rejects legacy unconditional removal and guards old SQL, including after a reissue", async () => {
  const global = directory(env);
  const email = `${crypto.randomUUID()}@example.test`;
  await global.addInvite(email);
  await runInDurableObject(global, async (instance) => {
    await expect(instance.removeInvite(email)).rejects.toThrow("invitation service is updating");
  });
  await runInDurableObject(global, (_instance, state) => {
    const sql = state.storage.sql;
    const generation = sql.exec<{generation:string}>(`SELECT generation FROM invites WHERE email=?`, email).one().generation;
    sql.exec(`INSERT OR IGNORE INTO invites(email,created_at) VALUES (?,?)`, email, Date.now());
    expect(sql.exec<{generation:string}>(`SELECT generation FROM invites WHERE email=?`, email).one().generation).not.toBe(generation);
    expect(() => sql.exec(`DELETE FROM invites WHERE email=?`, email)).toThrow(/invite_delete_permit_required/);
  });
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  await global.removeInviteV2(email);
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(false);
});

it("does not treat an unredacted closed or unattributed receipt as erased", async () => {
  const global = directory(env), op = crypto.randomUUID(), user = crypto.randomUUID();
  const vault = env.VAULT.newUniqueId().toString(), email = `${crypto.randomUUID()}@example.test`;
  await runInDurableObject(global, async (instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`INSERT INTO invite_deletion_receipts(operation_id,user_id,vault_id,email,generation,state) VALUES (?,NULL,NULL,?,NULL,'closed')`, op, email);
    try {
      expect(await instance.deletionProbe(user, vault)).toBeGreaterThan(0);
      await expect(instance.captureInviteForDeletion(op, user, vault, email)).rejects.toThrow("receipt requires review");
      sql.exec(`UPDATE invite_deletion_receipts SET state='captured',email=NULL WHERE operation_id=?`, op);
      expect(await instance.deletionProbe(user, vault)).toBeGreaterThan(0);
    } finally { sql.exec(`DELETE FROM invite_deletion_receipts WHERE operation_id=?`, op); }
  });
});
