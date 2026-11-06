import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directory } from "../../src/shared/stubs";

async function prepareChange(change: "state" | "vault") {
  const global = directory(env), id = crypto.randomUUID();
  const email = `stale-${change}-${id}@example.test`;
  await global.addInvite(email);
  const user = await global.signIn({ provider: "test", subject: id, email, hint: "enam" });
  await global.deleteAccount(user.userId, user.vaultId);
  const { op, generation } = await runInDurableObject(global, async (raw, state) => {
    const instance = raw as Directory, local = (instance as unknown as { env: Env }).env, old = local.SWEEP_DELAY_MS;
    local.SWEEP_DELAY_MS = "3600000";
    try { await instance.alarm(); } finally { local.SWEEP_DELAY_MS = old; }
    const op = state.storage.sql.exec<{ operation_id: string }>(
      `SELECT operation_id FROM account_invite_deletions WHERE user_id=?`, user.userId,
    ).one().operation_id;
    const sweep = state.storage.sql.exec<{ generation: string; phase: string }>(
      `SELECT generation,phase FROM account_final_sweeps WHERE vault_id=?`, user.vaultId,
    ).one();
    expect(sweep.phase).toBe("awaiting");
    // Model the already-acknowledged destroy at the finalization dispatch.
    state.storage.sql.exec(`UPDATE account_final_sweeps SET phase='destroyed' WHERE vault_id=?`, user.vaultId);
    const guard = instance as unknown as { requireInventoryOwner(b: unknown): void };
    const captured = { operationId: op, userId: user.userId, vaultId: user.vaultId, email, finalGeneration: sweep.generation };
    expect(() => guard.requireInventoryOwner(captured)).not.toThrow();
    // Model a restore/maintenance change after sender preflight and before
    // the coordinator processes the already-dispatched removal. There is no
    // ordinary product reactivation path.
    if (change === "state") state.storage.sql.exec(`UPDATE users SET state='active' WHERE user_id=?`, user.userId);
    else state.storage.sql.exec(`UPDATE vaults SET vault_id=? WHERE user_id=?`, env.VAULT.newUniqueId().toString(), user.userId);
    return { op, generation: sweep.generation };
  });
  await runInDurableObject(global, async (raw) => {
    const instance = raw as Directory;
    await expect(instance.removeCapturedInvite(op, user.userId, user.vaultId, email, generation))
      .rejects.toThrow(/account deletion changed/i);
  });
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
}

it("does not remove an invitation for an account restored before delayed cleanup", async () => {
  await prepareChange("state");
}, 30_000);

it("does not remove an invitation after the account's vault mapping changes", async () => {
  await prepareChange("vault");
}, 30_000);
