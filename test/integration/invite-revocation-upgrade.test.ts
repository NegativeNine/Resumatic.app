import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { DIRECTORY_MIGRATIONS, migrateDirectory } from "../../src/directory/schema";
import { InviteRevocation } from "../../src/directory/invite-revocation";
import { directoryForSignIn } from "../../src/directory/routing";
import { directory } from "../../src/shared/stubs";
import { undoInviteGlobalOrphansMigration } from "../support/undo-invite-inventory";

async function fingerprint(operation: string, email: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.SESSION_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(["invite-revocation-v1", operation, email])));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

it.each(["active", "detached"] as const)("fences and rescans an inherited %s operation before admitting an unbound global account", async (kind) => {
  const global = directory(env), nonce = crypto.randomUUID(), op = crypto.randomUUID(), other = crypto.randomUUID();
  const epoch = await global.googleAuthEpoch();
  const p = { provider: "google" as const, subject: `upgrade-${nonce}`, email: `upgrade-${nonce}@example.test`, hint: "enam" as const, authEpoch: epoch };
  const safe = { provider: "google" as const, subject: `bound-${other}`, email: `bound-${other}@example.test`, hint: "enam" as const, authEpoch: epoch };
  await global.addInvite(p.email);
  await global.addInvite(safe.email);
  const route = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, p);
  const account = await route.directory.signIn(route.input);
  const safeRoute = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, safe);
  const existing = await safeRoute.directory.signIn(safeRoute.input);
  await global.bindIdentityHome(safe.provider, safe.subject, existing.userId, epoch);
  const signature = await fingerprint(op, p.email);
  await runInDurableObject(global, async (instance, state) => {
    const d = instance as Directory, sql = state.storage.sql;
    const local = (instance as unknown as { env: Env & { INVITE_REVOCATION_DRAIN_VERIFIED?: string } }).env;
    const previous = local.INVITE_REVOCATION_DRAIN_VERIFIED;
    const tx = <T>(fn: () => T): T => state.storage.transactionSync(fn);
    try {
      undoInviteGlobalOrphansMigration(sql);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(DIRECTORY_MIGRATIONS.length - 1));
      const grant = sql.exec<{ generation: string }>(`SELECT generation FROM invites WHERE email=?`, p.email).one().generation;
      sql.exec(`INSERT INTO invite_revocation_barrier(slot,operation_id,email,email_fingerprint,generation,created_at) VALUES(1,?,?,?,?,?)`, op, p.email, signature, grant, Date.now());
      if (kind === "detached") {
        sql.exec(`INSERT INTO invite_quarantine_marker(slot,operation_id) VALUES(1,?)`, op);
        sql.exec(`INSERT INTO invite_revocation_quarantines(operation_id,email,email_fingerprint,generation,created_at)
          SELECT operation_id,email,email_fingerprint,generation,created_at FROM invite_revocation_barrier WHERE operation_id=?`, op);
        sql.exec(`DELETE FROM invite_revocation_barrier WHERE operation_id=?`, op);
        sql.exec(`DELETE FROM invite_quarantine_marker WHERE slot=1`);
      }
      const before = Number(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='global_auth_epoch'`).one().value);
      migrateDirectory(sql, tx, true, false);
      expect(Number(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='global_auth_epoch'`).one().value)).toBe(before + 1);
      local.INVITE_REVOCATION_DRAIN_VERIFIED = "";
      expect(await d.inviteRevocationStatus(op)).toEqual({ state: "pending", remaining: 1, orphans: 0, inventoryPending: true });
      const fresh = await d.googleAuthEpoch();
      await expect(d.signIn({ ...p, authEpoch: fresh })).rejects.toThrow(/review/);
      const same = await d.signIn({ ...safe, authEpoch: fresh });
      await d.bindIdentityHome(safe.provider, safe.subject, same.userId, fresh);
      expect(same.userId).toBe(existing.userId);
      expect(() => sql.exec(`DELETE FROM identities WHERE provider=? AND subject=?`, p.provider, p.subject)).toThrow(/invite_legacy_inventory_required/);
      local.INVITE_REVOCATION_DRAIN_VERIFIED = "verified-v2";
      const failingSql = new Proxy(sql, { get(target, key) {
        if (key === "exec") return (query: string, ...args: SqlStorageValue[]) => {
          if (query.startsWith("INSERT INTO invite_revocation_legacy_proofs")) throw new Error("synthetic interrupted proof");
          return target.exec(query, ...args);
        };
        return Reflect.get(target, key, target);
      } }) as SqlStorage;
      const interrupted = new InviteRevocation({ sql: failingSql, storage: state.storage, transaction: tx,
        fingerprint: async () => signature, verifyRollout: () => {}, seal: async () => ({ state: "absent" }), close: async () => {}, removeInvite: () => {} });
      await expect(interrupted.rescanLegacyBatch()).rejects.toThrow(/synthetic interrupted proof/);
      expect(sql.exec(`SELECT operation_id FROM invite_revocation_legacy_operations WHERE operation_id=?`, op).toArray()).toHaveLength(1);
      expect(sql.exec(`SELECT user_id FROM invite_revocation_global_orphans WHERE operation_id=?`, op).toArray()).toHaveLength(0);
      let started!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const delayed = new InviteRevocation({ sql, storage: state.storage, transaction: tx,
        fingerprint: async () => { started(); await hold; return signature; }, verifyRollout: () => {},
        seal: async () => ({ state: "absent" }), close: async () => {}, removeInvite: () => {} });
      const scan = delayed.rescanLegacyBatch();
      try {
        await entered;
        if (kind === "active") expect(() => sql.exec(`UPDATE invite_revocation_barrier SET email='changed@example.test' WHERE operation_id=?`, op)).toThrow();
        else expect(() => sql.exec(`UPDATE invite_revocation_quarantines SET email='changed@example.test' WHERE operation_id=?`, op)).toThrow();
      } finally { release(); await scan; }
      await d.googleAuthEpoch();
      expect(sql.exec(`SELECT operation_id FROM invite_revocation_legacy_operations WHERE operation_id=?`, op).toArray()).toHaveLength(0);
      expect(sql.exec<{ local_orphans: number }>(`SELECT local_orphans FROM invite_revocation_legacy_proofs WHERE operation_id=?`, op).one().local_orphans).toBe(1);
      expect(await d.inviteRevocationStatus(op)).toEqual({ state: "pending", remaining: 1, orphans: 1 });
      if (kind === "active") {
        const c = (instance as unknown as { inviteRevocation: { resume(): Promise<void> } }).inviteRevocation;
        await c.resume();
      }
      await expect(d.bindIdentityHome(p.provider, p.subject, account.userId, await d.googleAuthEpoch())).rejects.toThrow(/review/);
    } finally {
      local.INVITE_REVOCATION_DRAIN_VERIFIED = previous;
      sql.exec(`INSERT INTO invite_quarantine_marker(slot,operation_id) VALUES (1,?)`, op);
      try {
        sql.exec(`DELETE FROM invite_revocation_global_orphans WHERE operation_id=?`, op);
        sql.exec(`DELETE FROM invite_revocation_quarantines WHERE operation_id=?`, op);
        sql.exec(`DELETE FROM invite_revocation_barrier WHERE operation_id=?`, op);
      } finally { sql.exec(`DELETE FROM invite_quarantine_marker WHERE slot=1`); }
    }
  });
}, 30_000);

it("does not activate an unbound global Vault when an inherited barrier appears during init", async () => {
  const global = directory(env), nonce = crypto.randomUUID(), op = crypto.randomUUID();
  const epoch = await global.googleAuthEpoch();
  const p = { provider: "google" as const, subject: `during-${nonce}`, email: `during-${nonce}@example.test`, hint: "enam" as const, authEpoch: epoch };
  await global.addInvite(p.email);
  const route = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, p);
  const signature = await fingerprint(op, p.email);
  await runInDurableObject(global, async (instance, state) => {
    const d = instance as Directory, sql = state.storage.sql;
    const local = (instance as unknown as { env: Env & { INVITE_REVOCATION_DRAIN_VERIFIED?: string } }).env;
    const original = local.VAULT, oldFlag = local.INVITE_REVOCATION_DRAIN_VERIFIED;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    local.VAULT = {
      newUniqueId: () => original.newUniqueId(), idFromString: (id: string) => original.idFromString(id),
      get: (id: DurableObjectId, options: DurableObjectNamespaceGetDurableObjectOptions) => ({
        init: async (userId: string) => { entered(); await hold; await original.get(id, options).init(userId); },
      }),
    } as unknown as typeof original;
    const pending = d.signIn(route.input);
    try {
      await started;
      const row = sql.exec<{ vault_id: string }>(`SELECT v.vault_id FROM vaults v JOIN identities i ON i.user_id=v.user_id WHERE i.provider=? AND i.subject=?`, p.provider, p.subject).one();
      undoInviteGlobalOrphansMigration(sql);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(DIRECTORY_MIGRATIONS.length - 1));
      const generation = sql.exec<{ generation: string }>(`SELECT generation FROM invites WHERE email=?`, p.email).one().generation;
      sql.exec(`INSERT INTO invite_revocation_barrier(slot,operation_id,email,email_fingerprint,generation,created_at) VALUES(1,?,?,?,?,?)`, op, p.email, signature, generation, Date.now());
      migrateDirectory(sql, (fn) => state.storage.transactionSync(fn), true, false);
      local.INVITE_REVOCATION_DRAIN_VERIFIED = "";
      release();
      await expect(pending).rejects.toThrow(/review/);
      expect(sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, row.vault_id).one().state).toBe("creating");
      expect(await d.inviteRevocationStatus(op)).toEqual({ state: "pending", remaining: 1, orphans: 0, inventoryPending: true });
      local.INVITE_REVOCATION_DRAIN_VERIFIED = "verified-v2";
      await d.googleAuthEpoch();
      const c = (instance as unknown as { inviteRevocation: { resume(): Promise<void> } }).inviteRevocation;
      await c.resume();
      expect(await d.inviteRevocationStatus(op)).toEqual({ state: "pending", remaining: 1, orphans: 1 });
    } finally {
      release(); await pending.catch(() => {}); local.VAULT = original;
      local.INVITE_REVOCATION_DRAIN_VERIFIED = oldFlag;
      sql.exec(`INSERT INTO invite_quarantine_marker(slot,operation_id) VALUES(1,?)`, op);
      try {
        sql.exec(`DELETE FROM invite_revocation_global_orphans WHERE operation_id=?`, op);
        sql.exec(`DELETE FROM invite_revocation_quarantines WHERE operation_id=?`, op);
        sql.exec(`DELETE FROM invite_revocation_barrier WHERE operation_id=?`, op);
      } finally { sql.exec(`DELETE FROM invite_quarantine_marker WHERE slot=1`); }
    }
  });
}, 30_000);

it("requires the new revocation drain assertion without advancing the epoch on failure", async () => {
  const global = directory(env), nonce = crypto.randomUUID(), email = `gate-${nonce}@example.test`, op = crypto.randomUUID();
  await global.addInvite(email);
  await runInDurableObject(global, async (instance, state) => {
    const d = instance as Directory;
    const local = (instance as unknown as { env: Env & { INVITE_REVOCATION_DRAIN_VERIFIED?: string } }).env;
    const oldFlag = local.INVITE_REVOCATION_DRAIN_VERIFIED;
    try {
      local.INVITE_REVOCATION_DRAIN_VERIFIED = "";
      const before = await d.googleAuthEpoch();
      await expect(d.revokeInviteV3(email, op)).rejects.toThrow(/verification/);
      expect(await d.googleAuthEpoch()).toBe(before);
      expect(state.storage.sql.exec(`SELECT operation_id FROM invite_revocation_barrier WHERE operation_id=?`, op).toArray()).toHaveLength(0);
    } finally { local.INVITE_REVOCATION_DRAIN_VERIFIED = oldFlag; }
  });
}, 30_000);
