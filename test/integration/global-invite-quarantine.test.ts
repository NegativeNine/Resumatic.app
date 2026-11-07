import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directoryForSignIn } from "../../src/directory/routing";
import { directory } from "../../src/shared/stubs";
import { startSession } from "../../src/worker/routes";

async function input() {
  const nonce = crypto.randomUUID();
  return { provider: "google" as const, subject: `global-${nonce}`, email: `global-${nonce}@example.test`,
    hint: "enam" as const, authEpoch: await directory(env).googleAuthEpoch() };
}

async function teardown(operation: string) {
  await runInDurableObject(directory(env), (_instance, ctx) => {
    const sql = ctx.storage.sql;
    sql.exec(`INSERT INTO invite_quarantine_marker(slot,operation_id) VALUES (1,?)`, operation);
    try {
      sql.exec(`DELETE FROM invite_revocation_global_orphans WHERE operation_id=?`, operation);
      sql.exec(`DELETE FROM invite_revocation_quarantines WHERE operation_id=?`, operation);
      sql.exec(`DELETE FROM invite_revocation_barrier WHERE operation_id=?`, operation);
    } finally { sql.exec(`DELETE FROM invite_quarantine_marker WHERE slot=1`); }
  });
}

it.each(["unbound", "no-home"] as const)("holds ambiguous legacy %s identities for review", async (shape) => {
  const p = await input(), global = directory(env), operation = crypto.randomUUID();
  await global.addInvite(p.email);
  if (shape === "unbound") await global.claimIdentityHomeV3(p.provider, p.subject, null, p.email, undefined, p.authEpoch);
  const account = await global.signIn(p);
  await runInDurableObject(global, (_object, state) => state.storage.sql.exec(`DELETE FROM account_invite_bindings WHERE user_id=?`, account.userId));
  try {
    expect(await global.revokeInviteV3(p.email, operation)).toEqual({ state: "pending", remaining: 1, orphans: 1 });
    await evictDurableObject(global);
    const epoch = await global.googleAuthEpoch();
    await runInDurableObject(global, async (object, state) => {
      await expect((object as Directory).bindIdentityHome(p.provider, p.subject, account.userId, epoch)).rejects.toThrow(/review/);
      await expect((object as Directory).bindIdentityHome(p.provider, p.subject, crypto.randomUUID(), epoch)).rejects.toThrow(/review/);
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO global_auth_marker(slot,epoch) VALUES (1,?)`, epoch);
      try {
        expect(() => sql.exec(`UPDATE identities SET user_id=? WHERE provider=? AND subject=?`, crypto.randomUUID(), p.provider, p.subject)).toThrow(/invite_global_orphan_pending/);
        expect(() => sql.exec(`DELETE FROM identities WHERE provider=? AND subject=?`, p.provider, p.subject)).toThrow(/invite_global_orphan_pending/);
        expect(() => sql.exec(`INSERT OR REPLACE INTO identities(provider,subject,user_id) VALUES (?,?,?)`, p.provider, p.subject, account.userId)).toThrow(/invite_global_orphan_pending/);
      } finally { sql.exec(`DELETE FROM global_auth_marker WHERE slot=1`); }
    });
    expect(await global.existingIdentity(p.provider, p.subject)).toEqual({ userId: account.userId, vaultId: account.vaultId });
  } finally { await teardown(operation); }
}, 30_000);

it("allows an unrelated new global account to bind while the target stays quarantined", async () => {
  const p = await input(), global = directory(env), operation = crypto.randomUUID();
  await global.addInvite(p.email);
  await global.claimIdentityHomeV3(p.provider, p.subject, null, p.email, undefined, p.authEpoch);
  const account = await global.signIn(p);
  try {
    expect(await global.revokeInviteV3(p.email, operation)).toEqual({ state: "pending", remaining: 1, orphans: 1 });
    const other = await input();
    await global.addInvite(other.email);
    const route = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, other);
    const created = await route.directory.signIn(route.input);
    await runInDurableObject(global, (_object, ctx) => {
      const sql = ctx.storage.sql;
      sql.exec(`INSERT INTO global_auth_marker(slot,epoch) VALUES (1,?)`, other.authEpoch);
      sql.exec(`INSERT INTO invite_global_bind_marker(slot,provider,subject,user_id,email) VALUES (1,?,?,?,?)`,
        other.provider, other.subject, created.userId, other.email);
      try {
        expect(() => sql.exec(`UPDATE invite_global_bind_marker SET email=? WHERE slot=1`, p.email)).toThrow();
        expect(() => sql.exec(`UPDATE identity_homes SET user_id=?,shard=4 WHERE provider=? AND subject=?`, created.userId, other.provider, other.subject)).toThrow();
        expect(() => sql.exec(`UPDATE identity_homes SET user_id=?,generation='changed' WHERE provider=? AND subject=?`, created.userId, other.provider, other.subject)).toThrow();
        expect(() => sql.exec(`UPDATE identity_homes SET user_id=?,placement_state='closing' WHERE provider=? AND subject=?`, created.userId, other.provider, other.subject)).toThrow();
        expect(() => sql.exec(`UPDATE identity_homes SET user_id=? WHERE provider=? AND subject=?`, account.userId, other.provider, other.subject)).toThrow();
      } finally {
        sql.exec(`DELETE FROM invite_global_bind_marker WHERE slot=1`);
        sql.exec(`DELETE FROM global_auth_marker WHERE slot=1`);
      }
      expect(() => sql.exec(`INSERT INTO invite_global_bind_marker(slot,provider,subject,user_id,email) VALUES (1,?,?,?,?)`,
        p.provider, p.subject, account.userId, p.email)).toThrow();
    });
    await global.bindIdentityHome(other.provider, other.subject, created.userId, other.authEpoch);
    await runInDurableObject(global, (_object, ctx) => {
      const sql = ctx.storage.sql;
      sql.exec(`INSERT INTO global_auth_marker(slot,epoch) VALUES (1,?)`, other.authEpoch);
      try {
        expect(() => sql.exec(`UPDATE identity_homes SET user_id=? WHERE provider=? AND subject=?`, account.userId, other.provider, other.subject)).toThrow();
      } finally { sql.exec(`DELETE FROM global_auth_marker WHERE slot=1`); }
    });
    expect(await global.inviteRevocationStatus(operation)).toEqual({ state: "pending", remaining: 1, orphans: 1 });
  } finally { await teardown(operation); }
}, 30_000);

it("retains an in-flight global initialization in quarantine and issues no later session", async () => {
  const p = await input(), global = directory(env), operation = crypto.randomUUID();
  await global.addInvite(p.email);
  const routed = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, p);
  let account: { userId: string; vaultId: string } | undefined;
  try {
    await runInDurableObject(global, async (instance, state) => {
      const object = instance as Directory, local = (instance as unknown as { env: Env }).env, original = local.VAULT;
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      local.VAULT = {
        newUniqueId: () => original.newUniqueId(),
        idFromString: (id: string) => original.idFromString(id),
        get: (id: DurableObjectId, options: DurableObjectNamespaceGetDurableObjectOptions) => ({
          init: async (userId: string) => { entered(); await hold; await original.get(id, options).init(userId); },
        }),
      } as unknown as typeof original;
      const pending = object.signIn(routed.input);
      try {
        await started;
        const row = state.storage.sql.exec<{ user_id: string; vault_id: string }>(`SELECT i.user_id,v.vault_id FROM identities i
          JOIN vaults v ON v.user_id=i.user_id WHERE i.provider=? AND i.subject=?`, p.provider, p.subject).one();
        account = { userId: row.user_id, vaultId: row.vault_id };
        expect(await object.revokeInviteV3(p.email, operation)).toEqual({ state: "pending", remaining: 1, orphans: 1 });
        release();
        await expect(pending).rejects.toThrow(/review/);
        expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, account.vaultId).one().state).toBe("creating");
        await expect(object.bindIdentityHome(p.provider, p.subject, account.userId, p.authEpoch)).rejects.toThrow(/stale|review/);
        await expect(object.signIn({ ...p, authEpoch: await object.googleAuthEpoch() })).rejects.toThrow(/review/);
      } finally { release(); await pending.catch(() => {}); local.VAULT = original; }
    });
    expect(account).toBeDefined();
    await evictDurableObject(global);
    expect(await global.inviteRevocationStatus(operation)).toEqual({ state: "pending", remaining: 1, orphans: 1 });
    await expect(startSession(env, { ...p, authEpoch: await global.googleAuthEpoch() })).rejects.toThrow(/review/);
    expect(await global.existingIdentity(p.provider, p.subject)).toEqual(account);
  } finally { await teardown(operation); }
}, 30_000);

it.each(["owner", "binding"] as const)("fails closed for noncanonical matching %s email, including Unicode", async (field) => {
  const nonce = crypto.randomUUID(), raw = `İRENE-${nonce}@EXAMPLE.test`, email = raw.trim().toLowerCase();
  const global = directory(env), operation = crypto.randomUUID(), epoch = await global.googleAuthEpoch();
  await global.addInvite(email);
  const account = await global.signIn({ provider: "google", subject: `unicode-${nonce}`, email, hint: "enam", authEpoch: epoch });
  await runInDurableObject(global, (_instance, ctx) => {
    if (field === "owner") ctx.storage.sql.exec(`UPDATE users SET email=? WHERE user_id=?`, `  ${raw}  `, account.userId);
    else ctx.storage.sql.exec(`UPDATE account_invite_bindings SET email=? WHERE user_id=?`, `  ${raw}  `, account.userId);
  });
  try {
    await runInDurableObject(global, async (instance) => {
      await expect((instance as Directory).revokeInviteV3(email, operation)).rejects.toThrow(/review/);
    });
    expect(await global.googleAuthEpoch()).toBe(epoch);
    expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  } finally {
    await runInDurableObject(global, (_instance, ctx) => {
      if (field === "owner") ctx.storage.sql.exec(`UPDATE users SET email=? WHERE user_id=?`, email, account.userId);
      else ctx.storage.sql.exec(`UPDATE account_invite_bindings SET email=? WHERE user_id=?`, email, account.userId);
    });
  }
}, 30_000);

it("accepts a no-home legacy bind only for the current active identity owner", async () => {
  const p = await input(), global = directory(env);
  await global.addInvite(p.email);
  const account = await global.signIn(p);
  await runInDurableObject(global, async (object) => {
    await expect((object as Directory).bindIdentityHome(p.provider, p.subject, crypto.randomUUID(), p.authEpoch)).rejects.toThrow(/changed/);
    await expect((object as Directory).bindIdentityHome(p.provider, p.subject, account.userId, p.authEpoch)).resolves.toBeUndefined();
  });
  await runInDurableObject(global, (object, state) => state.storage.transactionSync(() => {
    (object as unknown as { deleteInvite(email: string): void }).deleteInvite(p.email);
  }));
  await runInDurableObject(global, async (object) => {
    await expect((object as Directory).bindIdentityHome(p.provider, p.subject, account.userId, p.authEpoch)).rejects.toThrow(/review/);
  });
  await global.addInvite(p.email);
  await runInDurableObject(global, async (object) => {
    await expect((object as Directory).bindIdentityHome(p.provider, p.subject, account.userId, p.authEpoch)).rejects.toThrow(/review/);
  });
}, 30_000);

it.each(["matching", "malformed"] as const)("does not ignore an unidentified legacy user with %s email", async (shape) => {
  const global = directory(env), nonce = crypto.randomUUID(), email = `unknown-${nonce}@example.test`, userId = crypto.randomUUID();
  await global.addInvite(email);
  await runInDurableObject(global, (_instance, ctx) => {
    const sql = ctx.storage.sql;
    const epoch = Number(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='global_auth_epoch'`).one().value);
    sql.exec(`INSERT INTO global_auth_marker(slot,epoch) VALUES (1,?)`, epoch);
    try { sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,?,'active',?)`, userId, shape === "matching" ? ` ${email.toUpperCase()} ` : "", Date.now()); }
    finally { sql.exec(`DELETE FROM global_auth_marker WHERE slot=1`); }
  });
  try {
    await runInDurableObject(global, async (instance) => {
      await expect((instance as Directory).revokeInviteV3(email, crypto.randomUUID())).rejects.toThrow(/review/);
    });
    expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  } finally {
    await runInDurableObject(global, (_instance, ctx) => ctx.storage.sql.exec(`DELETE FROM users WHERE user_id=?`, userId));
  }
}, 30_000);

it.each(["matching", "malformed"] as const)("does not ignore a dangling invitation binding with %s email", async (shape) => {
  const global = directory(env), nonce = crypto.randomUUID(), raw = `İRENE-${nonce}@EXAMPLE.test`, email = raw.trim().toLowerCase();
  const userId = crypto.randomUUID(), operation = crypto.randomUUID();
  await global.addInvite(email);
  await runInDurableObject(global, (_instance, ctx) => ctx.storage.sql.exec(
    `INSERT INTO account_invite_bindings(user_id,email,generation) VALUES (?,?,?)`, userId, shape === "matching" ? ` ${raw} ` : "", "a".repeat(32),
  ));
  try {
    await runInDurableObject(global, async (instance) => {
      await expect((instance as Directory).revokeInviteV3(email, operation)).rejects.toThrow(/review/);
    });
    expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  } finally {
    await runInDurableObject(global, (_instance, ctx) => ctx.storage.sql.exec(`DELETE FROM account_invite_bindings WHERE user_id=?`, userId));
  }
}, 30_000);

it("allows revocation when an unrelated dangling binding has an attributable email", async () => {
  const global = directory(env), nonce = crypto.randomUUID(), email = `clear-${nonce}@example.test`, userId = crypto.randomUUID();
  await global.addInvite(email);
  await runInDurableObject(global, (_instance, ctx) => ctx.storage.sql.exec(
    `INSERT INTO account_invite_bindings(user_id,email,generation) VALUES (?,?,?)`, userId, `other-${nonce}@example.test`, "a".repeat(32),
  ));
  try { expect(await global.revokeInviteV3(email, crypto.randomUUID())).toEqual({ state: "complete" }); }
  finally { await runInDurableObject(global, (_instance, ctx) => ctx.storage.sql.exec(`DELETE FROM account_invite_bindings WHERE user_id=?`, userId)); }
}, 30_000);
