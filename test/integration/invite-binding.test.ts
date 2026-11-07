import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { directory, vault } from "../../src/shared/stubs";
import type { Directory } from "../../src/directory/directory";

async function sweep(d: ReturnType<typeof directory>) {
  await runInDurableObject(d, async (instance) => {
    const local = (instance as unknown as { env: Env }).env, delay = local.SWEEP_DELAY_MS;
    local.SWEEP_DELAY_MS = "0";
    try { await (instance as Directory).alarm(); }
    finally { local.SWEEP_DELAY_MS = delay; }
  });
}

it("preserves a reissue between durable Vault intent and Directory capture", async () => {
  const d = directory(env), id = crypto.randomUUID(), email = `intent-${id}@example.test`;
  await d.addInvite(email);
  const user = await d.signIn({ provider: "test", subject: id, email, hint: "enam" });
  const v = vault(env, user.vaultId), session = await v.openSession(user.userId);
  await v.beginAccountDeletion({ userId: user.userId, ...session });
  await d.addInvite(email);
  await d.deleteAccount(user.userId, user.vaultId);
  await sweep(d);
  expect((await d.listInvites()).some((row) => row.email === email)).toBe(true);
  expect(await d.deletionProbe(user.userId, user.vaultId)).toBe(0);
});

it("preserves a grant issued after an account was created without an invitation", async () => {
  const d = directory(env), id = crypto.randomUUID(), email = `no-invite-${id}@example.test`;
  const user = await d.signIn({ provider: "test", subject: id, email, hint: "enam" });
  await d.addInvite(email);
  await d.deleteAccount(user.userId, user.vaultId);
  await sweep(d);
  expect((await d.listInvites()).some((row) => row.email === email)).toBe(true);
  expect(await d.deletionProbe(user.userId, user.vaultId)).toBe(0);
});

it("holds a legacy account until its ambiguous invitation is reissued or revoked", async () => {
  const d = directory(env), id = crypto.randomUUID(), email = `legacy-${id}@example.test`;
  await d.addInvite(email);
  const user = await d.signIn({ provider: "test", subject: id, email, hint: "enam" });
  await runInDurableObject(d, (_instance, state) => state.storage.sql.exec(`DELETE FROM account_invite_bindings WHERE user_id=?`, user.userId));
  await d.deleteAccount(user.userId, user.vaultId);
  await sweep(d);
  expect((await d.listInvites()).some((row) => row.email === email)).toBe(true);
  expect(await d.deletionProbe(user.userId, user.vaultId)).toBeGreaterThan(0);
  await d.addInvite(email);
  await sweep(d);
  expect((await d.listInvites()).some((row) => row.email === email)).toBe(true);
  expect(await d.deletionProbe(user.userId, user.vaultId)).toBe(0);
});

it("prevents an older deletion writer from authorizing an unconditional invite delete", async () => {
  const d = directory(env), email = `old-writer-${crypto.randomUUID()}@example.test`;
  await d.addInvite(email);
  await runInDurableObject(d, (_instance, state) => {
    expect(() => state.storage.sql.exec(`INSERT INTO invite_delete_authorizations(email) VALUES (?)`, email))
      .toThrow("invite_delete_authorization_v2_required");
  });
  expect((await d.listInvites()).some((row) => row.email === email)).toBe(true);
  expect(await d.revokeInviteV3(email, crypto.randomUUID())).toMatchObject({ state: "complete" });
  expect((await d.listInvites()).some((row) => row.email === email)).toBe(false);
});

it("does not upgrade an earlier ambiguous capture into a trusted account binding", async () => {
  const d = directory(env), id = crypto.randomUUID(), email = `old-capture-${id}@example.test`;
  await d.addInvite(email);
  const user = await d.signIn({ provider: "test", subject: id, email, hint: "enam" });
  await d.addInvite(email);
  await d.deleteAccount(user.userId, user.vaultId);
  const finalGeneration = crypto.randomUUID(), sweptAt = Date.now();
  // Model the durable state of a final sweep and an older receipt that had no
  // binding proof. The public removal now checks this owner and incarnation.
  const op = await runInDurableObject(d, (_instance, state) => state.storage.transactionSync(() => {
    const op = state.storage.sql.exec<{ operation_id: string }>(`SELECT operation_id FROM account_invite_deletions WHERE user_id=?`, user.userId).one().operation_id;
    state.storage.sql.exec(`UPDATE invite_deletion_receipts SET generation=(SELECT generation FROM invites WHERE email=?),binding_verified=0 WHERE operation_id=?`, email, op);
    state.storage.sql.exec(`UPDATE vaults SET state='swept',swept_at=? WHERE vault_id=?`, sweptAt, user.vaultId);
    state.storage.sql.exec(`INSERT INTO account_final_sweeps(vault_id,user_id,generation,swept_at,phase,invite_closed) VALUES (?,?,?,?,'destroyed',0)`, user.vaultId, user.userId, finalGeneration, sweptAt);
    return op;
  }));
  await d.captureInviteForDeletion(op, user.userId, user.vaultId, email);
  await runInDurableObject(d, async (instance) => {
    await expect((instance as Directory).removeCapturedInvite(op, user.userId, user.vaultId, email, finalGeneration))
      .rejects.toThrow("invitation generation requires operator review");
  });
  await d.addInvite(email);
  await d.removeCapturedInvite(op, user.userId, user.vaultId, email, finalGeneration);
  await d.closeInviteDeletion(op, user.userId, user.vaultId, email);
  expect((await d.listInvites()).some((row) => row.email === email)).toBe(true);
});
