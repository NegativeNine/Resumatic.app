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

it("preserves the shared invitation when one of two global accounts is deleted", async () => {
  const global = directory(env), id = crypto.randomUUID();
  const email = `shared-${id}@example.test`;
  await global.addInvite(email);
  const a = await global.signIn({ provider: "test", subject: `a-${id}`, email, hint: "enam" });
  const b = await global.signIn({ provider: "test", subject: `b-${id}`, email, hint: "enam" });
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
  const a = await global.signIn({ provider: "test", subject: `a-${id}`, email, hint: "enam" });
  const b = await global.signIn({ provider: "test", subject: `b-${id}`, email, hint: "enam" });
  // Older rows may not have used the current case normalization; SQLite's
  // lower() does not implement JavaScript's Unicode case mapping.
  await runInDurableObject(global, (_instance, state) => state.storage.sql.exec(`UPDATE users SET email=? WHERE user_id=?`, `  ${email.toUpperCase()}  `, b.userId));
  await global.deleteAccount(a.userId, a.vaultId);
  await alarmNow(global);
  expect((await global.listInvites()).some((invite) => invite.email === normalized)).toBe(true);
  expect(await global.deletionProbe(a.userId, a.vaultId)).toBe(0);
  await global.removeInviteV2(email);
}, 30_000);

it("removes the invite when both same-email accounts are already deleting", async () => {
  const global = directory(env), id = crypto.randomUUID(), email = `both-${id}@example.test`;
  await global.addInvite(email);
  const a = await global.signIn({ provider: "test", subject: `a-${id}`, email, hint: "enam" });
  const b = await global.signIn({ provider: "test", subject: `b-${id}`, email, hint: "enam" });
  await global.deleteAccount(a.userId, a.vaultId);
  await global.deleteAccount(b.userId, b.vaultId);
  await alarmNow(global);
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(false);
  expect(await global.deletionProbe(a.userId, a.vaultId)).toBe(0);
  expect(await global.deletionProbe(b.userId, b.vaultId)).toBe(0);
}, 30_000);

it("does not skip a malformed row following a known shared user", async () => {
  const global = directory(env), id = crypto.randomUUID(), email = `${id}@example.test`;
  const user = crypto.randomUUID(), vault = env.VAULT.newUniqueId().toString(), op = crypto.randomUUID();
  await global.addInvite(email);
  await global.captureInviteForDeletion(op, user, vault, email);
  await runInDurableObject(global, async (instance, state) => {
    state.storage.sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,?,'active',?)`, `first-${id}`, email, Date.now());
    state.storage.sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,x'FF','active',?)`, `last-${id}`, Date.now());
    try {
      await expect((instance as Directory).removeCapturedInvite(op, user, vault, email))
        .rejects.toThrow("invitation ownership requires review");
    } finally { state.storage.sql.exec(`DELETE FROM users WHERE user_id IN (?,?)`, `first-${id}`, `last-${id}`); }
  });
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  await global.removeInviteV2(email);
});

it("holds a same-email user whose state is unknown", async () => {
  const global = directory(env), id = crypto.randomUUID(), email = `${id}@example.test`;
  const user = crypto.randomUUID(), vault = env.VAULT.newUniqueId().toString(), op = crypto.randomUUID();
  await global.addInvite(email);
  await global.captureInviteForDeletion(op, user, vault, email);
  await runInDurableObject(global, async (instance, state) => {
    state.storage.sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,?,'unexpected',?)`, `unknown-${id}`, email, Date.now());
    try {
      await expect((instance as Directory).removeCapturedInvite(op, user, vault, email))
        .rejects.toThrow("invitation ownership requires review");
    } finally { state.storage.sql.exec(`DELETE FROM users WHERE user_id=?`, `unknown-${id}`); }
  });
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  await global.removeInviteV2(email);
});

it("holds an oversized local inventory and can retry after it is reduced", async () => {
  const global = directory(env), id = crypto.randomUUID(), email = `${id}@example.test`;
  const user = crypto.randomUUID(), vault = env.VAULT.newUniqueId().toString(), op = crypto.randomUUID();
  await global.addInvite(email);
  await global.captureInviteForDeletion(op, user, vault, email);
  await runInDurableObject(global, async (instance, state) => {
    state.storage.sql.exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<10001)
      INSERT INTO users(user_id,email,state,created_at) SELECT ? || n, 'other-' || n || '@example.test', 'active', ? FROM seq`, `bulk-${id}-`, Date.now());
    try {
      await expect((instance as Directory).removeCapturedInvite(op, user, vault, email))
        .rejects.toThrow("invitation ownership inventory requires review");
    } finally { state.storage.sql.exec(`DELETE FROM users WHERE user_id LIKE ?`, `bulk-${id}-%`); }
  });
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  await global.removeCapturedInvite(op, user, vault, email);
  await global.closeInviteDeletion(op, user, vault, email);
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(false);
}, 30_000);

it("holds an ambiguous malformed local email and retries without deleting a reissue", async () => {
  const global = directory(env), id = crypto.randomUUID(), email = `${id}@example.test`;
  const user = crypto.randomUUID(), vault = env.VAULT.newUniqueId().toString(), op = crypto.randomUUID();
  await global.addInvite(email);
  await global.captureInviteForDeletion(op, user, vault, email);
  await runInDurableObject(global, async (instance, state) => {
    state.storage.sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,x'FF','active',?)`, `malformed-${id}`, Date.now());
    try {
      await expect((instance as Directory).removeCapturedInvite(op, user, vault, email))
        .rejects.toThrow("invitation ownership requires review");
      expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM invite_deletion_receipts WHERE operation_id=?`, op).one().state).toBe("captured");
      state.storage.sql.exec(`DELETE FROM users WHERE user_id=?`, `malformed-${id}`);
    } finally { state.storage.sql.exec(`DELETE FROM users WHERE user_id=?`, `malformed-${id}`); }
  });
  await global.addInvite(email);
  await global.removeCapturedInvite(op, user, vault, email);
  await global.closeInviteDeletion(op, user, vault, email);
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  await global.removeInviteV2(email);
});
