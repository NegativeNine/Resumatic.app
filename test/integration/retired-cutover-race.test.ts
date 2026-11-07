import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it.each(["retired", "deletion", "source_reassigned", "user_deleting"]) ("does not publish a target when %s occurs during activation", async (variant) => {
  const directory = env.DIRECTORY.getByName(`retired-cutover-${crypto.randomUUID()}`);
  const email = `${crypto.randomUUID()}@example.test`;
  const user = await directory.signIn({ provider: "test", subject: email, email, hint: "enam" });
  const operation = crypto.randomUUID();
  const { targetVaultId } = await directory.prepareReplacement(user.vaultId, operation);
  await runInDurableObject(directory, async (instance, state) => {
    const local = (instance as unknown as { env: Env }).env;
    const original = local.VAULT, previousFence = local.RESTORE_FENCE_IDS;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    local.RESTORE_FENCE_IDS = `${user.vaultId},${targetVaultId}`;
    local.VAULT = {
      idFromString: (id: string) => original.idFromString(id),
      get: (id: DurableObjectId) => id.toString() === targetVaultId
        ? { activateImport: async () => { entered(); await hold; } }
        : original.get(id),
    } as unknown as typeof original;
    const pending = instance.cutover(user.vaultId, targetVaultId, operation);
    try {
      await ready;
      local.VAULT = original;
      if (variant === "deletion") await instance.deleteAccount(user.userId, user.vaultId);
      else if (variant === "retired") {
        state.storage.sql.exec(`INSERT INTO retired_vaults(vault_id,user_id) VALUES (?,?)`, targetVaultId, user.userId);
        // An active preparing operation prevents retirement from destroying
        // its target, while publication must reject the retired row.
        await instance.alarm();
      } else if (variant === "source_reassigned") {
        const newOwner = crypto.randomUUID();
        state.storage.sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,?,'active',?)`, newOwner, "other@example.test", Date.now());
        state.storage.sql.exec(`UPDATE vaults SET user_id=? WHERE vault_id=?`, newOwner, user.vaultId);
      } else state.storage.sql.exec(`UPDATE users SET state='deleting' WHERE user_id=?`, user.userId);
      release();
      await expect(pending).rejects.toThrow(["source_reassigned", "user_deleting"].includes(variant) ? /source vault is no longer active/ : /no longer preparing/);
      const row = state.storage.sql.exec<{vault_id:string;state:string}>(`SELECT vault_id,state FROM vaults WHERE vault_id=?`, user.vaultId).one();
      expect(row.vault_id).toBe(user.vaultId);
      expect(row.state).toBe(variant === "deletion" ? "deleting" : "active");
      expect(state.storage.sql.exec(`SELECT vault_id FROM retired_vaults WHERE vault_id=?`, targetVaultId).toArray()).toHaveLength(["source_reassigned", "user_deleting"].includes(variant) ? 0 : 1);
      if (variant === "deletion")
        expect(state.storage.sql.exec<{state:string}>(`SELECT state FROM vault_replacements WHERE operation_id=?`, operation).one().state).toBe("cancelled");
    } finally {
      release();
      await pending.catch(() => {});
      local.VAULT = original;
      local.RESTORE_FENCE_IDS = previousFence;
    }
  });
}, 30_000);
