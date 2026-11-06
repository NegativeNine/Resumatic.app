import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directory, directoryByName } from "../../src/shared/stubs";

it.each(["owner", "identity"] as const)("does not activate a Vault when its %s changes during initialization", async (change) => {
  const home = directoryByName(env, "directory-12");
  const epoch = await directory(env).googleAuthEpoch();
  const subject = `init-owner-${crypto.randomUUID()}`;
  await runInDurableObject(home, async (instance, state) => {
    const object = instance as Directory;
    const local = (instance as unknown as { env: Env }).env;
    const original = local.VAULT;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    local.VAULT = {
      newUniqueId: () => original.newUniqueId(),
      idFromString: (value: string) => original.idFromString(value),
      get: (id: DurableObjectId, options: DurableObjectNamespaceGetDurableObjectOptions) => ({
        init: async (userId: string) => { entered(); await hold; await original.get(id, options).init(userId); },
      }),
    } as unknown as typeof original;
    const pending = object.signIn({ provider: "test", subject, email: `${subject}@example.test`,
      hint: "enam", homeShard: 12, authEpoch: epoch }).then(() => "ok", (error: unknown) => String(error));
    try {
      await started;
      const row = state.storage.sql.exec<{ user_id: string; vault_id: string }>(
        `SELECT user_id,vault_id FROM vaults WHERE user_id IN (SELECT user_id FROM identities WHERE provider='test' AND subject=?)`, subject,
      ).one();
      const otherUser = `s12:${crypto.randomUUID()}`;
      state.storage.transactionSync(() => {
        if (change === "owner") {
          state.storage.sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,?,'active',?)`, otherUser, `${otherUser}@example.test`, Date.now());
          state.storage.sql.exec(`UPDATE identities SET user_id=? WHERE provider='test' AND subject=?`, otherUser, subject);
          state.storage.sql.exec(`UPDATE vaults SET user_id=? WHERE vault_id=?`, otherUser, row.vault_id);
        } else {
          state.storage.sql.exec(`UPDATE identities SET subject=? WHERE provider='test' AND subject=?`, `changed-${subject}`, subject);
        }
      });
      release();
      expect(await pending).toContain("account");
      const after = state.storage.sql.exec<{ user_id: string; state: string }>(`SELECT user_id,state FROM vaults WHERE vault_id=?`, row.vault_id).one();
      expect(after).toEqual({ user_id: change === "owner" ? otherUser : row.user_id, state: "creating" });
    } finally { release(); await pending; local.VAULT = original; }
  });
}, 30_000);
