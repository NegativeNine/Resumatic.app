import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directory, vault } from "../../src/shared/stubs";

// Known-unsatisfied release invariant: an invite reissued after the Vault has
// durably accepted deletion must not be removed by that deletion. Run with
// RESUMATIC_PLACEMENT_DIAGNOSTIC=1; this test currently fails intentionally.
it("preserves an invitation reissued after Vault deletion intent", async () => {
  const global = directory(env), id = crypto.randomUUID();
  const email = `intent-reissue-${id}@example.test`;
  await global.addInvite(email);
  const account = await global.signIn({ provider: "test", subject: id, email, hint: "enam" });
  const target = vault(env, account.vaultId);
  const session = await target.openSession(account.userId);
  const generation = async () => runInDurableObject(global, (_instance, state) =>
    state.storage.sql.exec<{ generation: string }>(`SELECT generation FROM invites WHERE email=?`, email).one().generation,
  );
  const originalGeneration = await generation();

  // This is the precise ordering in DELETE /auth/account, with an admin
  // reissue landing during the cross-object gap before Directory capture.
  await target.beginAccountDeletion({ userId: account.userId, ...session });
  await global.addInvite(email);
  const reissuedGeneration = await generation();
  expect(reissuedGeneration).not.toBe(originalGeneration);
  await global.deleteAccount(account.userId, account.vaultId);
  const capturedGeneration = await runInDurableObject(global, (_instance, state) =>
    state.storage.sql.exec<{ generation: string }>(
      `SELECT generation FROM invite_deletion_receipts WHERE user_id=?`, account.userId,
    ).one().generation,
  );
  expect(capturedGeneration).toBe(reissuedGeneration);
  await runInDurableObject(global, async (instance) => {
    const local = (instance as unknown as { env: Env }).env, delay = local.SWEEP_DELAY_MS;
    local.SWEEP_DELAY_MS = "0";
    try { await (instance as Directory).alarm(); }
    finally { local.SWEEP_DELAY_MS = delay; }
  });

  expect(await global.deletionProbe(account.userId, account.vaultId)).toBe(0);
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
}, 30_000);
