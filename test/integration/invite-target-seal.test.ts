import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import type { InviteTarget } from "../../src/directory/invite-target-seal";

async function fixture(shard: number, rawEmail = `target-${crypto.randomUUID()}@example.test`, generation: string | null = "a".repeat(32)) {
  const home = env.DIRECTORY.getByName(`directory-${shard}`);
  await home.existingIdentity("google", crypto.randomUUID()); // install the shard rollout floor
  const email = rawEmail.trim().toLowerCase();
  const token = crypto.randomUUID(), subject = crypto.randomUUID(), userId = `s${shard}:${crypto.randomUUID()}`;
  const vaultId = Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) => n.toString(16).padStart(2, "0")).join("");
  const operationId = crypto.randomUUID(), finalGeneration = crypto.randomUUID();
  const sweptAt = Date.now();
  const floor = await runInDurableObject(home, (_instance, state) => state.storage.transactionSync(() => {
    const sql = state.storage.sql;
    const value = Number(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='shard_auth_floor'`).one().value);
    sql.exec(`INSERT INTO shard_auth_marker(slot,epoch) VALUES (1,?)`, value);
    try {
      sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,?,'deleting',?)`, userId, email, sweptAt);
      sql.exec(`INSERT INTO identities(provider,subject,user_id) VALUES ('google',?,?)`, subject, userId);
      sql.exec(`INSERT INTO shard_identity_claim_tokens(provider,subject,user_id,token) VALUES ('google',?,?,?)`, subject, userId, token);
      sql.exec(`INSERT INTO shard_invite_account_bindings(user_id,provider,subject,token,email,generation) VALUES (?,'google',?,?,?,?)`, userId, subject, token, email, generation);
      sql.exec(`INSERT INTO vaults(vault_id,user_id,hint,state,swept_at,updated_at) VALUES (?,?,'enam','swept',?,?)`, vaultId, userId, sweptAt, sweptAt);
      sql.exec(`INSERT INTO account_invite_deletions(user_id,vault_id,operation_id) VALUES (?,?,?)`, userId, vaultId, operationId);
      sql.exec(`INSERT INTO account_final_sweeps(vault_id,user_id,generation,swept_at,phase,invite_closed) VALUES (?,?,?,?,'destroyed',0)`, vaultId, userId, finalGeneration, sweptAt);
    } finally { sql.exec(`DELETE FROM shard_auth_marker WHERE slot=1`); }
    return value;
  }));
  const proof: InviteTarget = { userId, vaultId, operationId, finalGeneration, email, provider: "google", subject, claimToken: token, generation };
  return { home, proof, floor, sweptAt, subject };
}

const local = <T>(home: ReturnType<typeof env.DIRECTORY.getByName>, run: (instance: Directory) => Promise<T>) =>
  runInDurableObject(home, (instance) => run(instance as Directory));

describe("shard invitation target proof", () => {
  it("treats a bound null generation as known absence and never upgrades a prior V1 or closed seal", async () => {
    const { home, proof, floor } = await fixture(7, undefined, null);
    const epoch = floor + 10, oldAttempt = crypto.randomUUID();
    expect(await home.sealInviteInventory(oldAttempt, proof.email, proof.userId, epoch)).toEqual({ state: "active", otherUsers: 0 });
    await expect(local(home, (d) => d.sealInviteInventoryV2(oldAttempt, proof.email, proof.userId, epoch, proof))).rejects.toThrow(/changed/);
    await home.closeInviteInventory(oldAttempt, epoch, epoch + 1);
    const attempt = crypto.randomUUID();
    expect(await home.sealInviteInventoryV2(attempt, proof.email, proof.userId, epoch + 1, proof)).toEqual({ state: "active", otherUsers: 0, targetVerified: true });
    await home.closeInviteInventory(attempt, epoch + 1, epoch + 2);
    const earlyClose = crypto.randomUUID();
    await home.closeInviteInventory(earlyClose, epoch + 2, epoch + 3);
    expect(await home.sealInviteInventoryV2(earlyClose, proof.email, proof.userId, epoch + 2, proof)).toEqual({ state: "closed" });
    await runInDurableObject(home, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT operation_id FROM shard_invite_target_seals WHERE operation_id IN (?,?,?)`, oldAttempt, attempt, earlyClose).toArray()).toHaveLength(0);
    });
  });

  it("attests one exact finalization and fences every proof row until a redacted close", async () => {
    // U+0130 lowercases to two code points; the proof uses sign-in's JS normalization.
    const { home, proof, floor } = await fixture(5, `target-İ-${crypto.randomUUID()}@example.test`);
    const attempt = crypto.randomUUID(), epoch = floor + 10;
    const otherRetirement = "d".repeat(64);
    await runInDurableObject(home, (_instance, state) => state.storage.sql.exec(
      `INSERT INTO retired_vaults(vault_id,user_id,state) VALUES (?,?,'deleting')`, otherRetirement, `s5:${crypto.randomUUID()}`,
    ));
    const expected = { state: "active", otherUsers: 0, targetVerified: true };
    expect(await home.sealInviteInventoryV2(attempt, proof.email, proof.userId, epoch, proof)).toEqual(expected);
    expect(await home.sealInviteInventoryV2(attempt, proof.email, proof.userId, epoch, proof)).toEqual(expected);
    await expect(local(home, (d) => d.sealInviteInventoryV2(attempt, proof.email, proof.userId, epoch, { ...proof, claimToken: crypto.randomUUID() })))
      .rejects.toThrow(/changed/);
    await expect(local(home, (d) => d.sealInviteInventory(attempt, proof.email, proof.userId, epoch))).rejects.toThrow(/changed/);
    await runInDurableObject(home, (_instance, state) => {
      const sql = state.storage.sql;
      for (const query of [
        () => sql.exec(`UPDATE users SET email='other@example.test' WHERE user_id=?`, proof.userId),
        () => sql.exec(`UPDATE vaults SET user_id='other' WHERE vault_id=?`, proof.vaultId),
        () => sql.exec(`UPDATE account_final_sweeps SET generation=? WHERE vault_id=?`, crypto.randomUUID(), proof.vaultId),
        () => sql.exec(`DELETE FROM account_invite_deletions WHERE user_id=?`, proof.userId),
        () => sql.exec(`INSERT INTO retired_vaults(vault_id,user_id,state) VALUES (?,?, 'deleting')`, "b".repeat(64), proof.userId),
        // This row was unrelated at seal time; neither OLD nor NEW ownership
        // can be changed to introduce a new target retirement afterwards.
        () => sql.exec(`UPDATE retired_vaults SET user_id=? WHERE vault_id=?`, proof.userId, otherRetirement),
        () => sql.exec(`DELETE FROM shard_invite_account_bindings WHERE user_id=?`, proof.userId),
        () => sql.exec(`DELETE FROM shard_identity_claim_tokens WHERE user_id=?`, proof.userId),
        () => sql.exec(`UPDATE identities SET subject=? WHERE user_id=?`, crypto.randomUUID(), proof.userId),
        () => sql.exec(`UPDATE shard_invite_inventory SET state='closed' WHERE operation_id=?`, attempt),
        () => sql.exec(`DELETE FROM shard_invite_target_seals WHERE operation_id=?`, attempt),
      ]) expect(query).toThrow(/sealed|close_required/);
    });
    await home.closeInviteInventory(attempt, epoch, epoch + 1);
    await home.closeInviteInventory(attempt, epoch, epoch + 1);
    expect(await home.sealInviteInventoryV2(attempt, proof.email, proof.userId, epoch, proof)).toEqual({ state: "closed" });
    await runInDurableObject(home, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT operation_id FROM shard_invite_target_seals WHERE operation_id=?`, attempt).toArray()).toHaveLength(0);
      expect(state.storage.sql.exec(`SELECT operation_id FROM shard_invite_target_close_marker WHERE operation_id=?`, attempt).toArray()).toHaveLength(0);
      const row = state.storage.sql.exec<{ email: string | null; excluded_user_id: string | null }>(`SELECT email,excluded_user_id FROM shard_invite_inventory WHERE operation_id=?`, attempt).one();
      expect(row).toEqual({ email: null, excluded_user_id: null });
      state.storage.sql.exec(`UPDATE vaults SET updated_at=updated_at+1 WHERE vault_id=?`, proof.vaultId);
      state.storage.sql.exec(`DELETE FROM retired_vaults WHERE vault_id=?`, otherRetirement);
    });
  });

  it("rejects missing or mismatched creation bindings, stale ownership and retirement without installing a seal", async () => {
    const { home, proof, floor, sweptAt } = await fixture(6);
    const epoch = floor + 10;
    const missing = crypto.randomUUID();
    await expect(local(home, (d) => d.sealInviteInventoryV2(missing, proof.email, proof.userId, epoch, undefined as unknown as InviteTarget))).rejects.toThrow(/target/);
    await runInDurableObject(home, (_instance, state) => expect(state.storage.sql.exec(`SELECT operation_id FROM shard_invite_inventory WHERE operation_id=?`, missing).toArray()).toHaveLength(0));
    for (const bad of [
      { ...proof, claimToken: crypto.randomUUID() }, { ...proof, generation: null },
      { ...proof, subject: crypto.randomUUID() },
      { ...proof, userId: `s7:${crypto.randomUUID()}` }, { ...proof, vaultId: "b".repeat(64) },
      { ...proof, operationId: crypto.randomUUID() }, { ...proof, finalGeneration: crypto.randomUUID() },
      { ...proof, email: `other-${crypto.randomUUID()}@example.test` },
    ]) {
      const attempt = crypto.randomUUID();
      await expect(local(home, (d) => d.sealInviteInventoryV2(attempt, proof.email, proof.userId, epoch, bad))).rejects.toThrow();
      await runInDurableObject(home, (_instance, state) => expect(state.storage.sql.exec(`SELECT operation_id FROM shard_invite_inventory WHERE operation_id=?`, attempt).toArray()).toHaveLength(0));
    }
    for (const [mutate, restore] of [
      [() => `UPDATE users SET state='active' WHERE user_id='${proof.userId}'`, () => `UPDATE users SET state='deleting' WHERE user_id='${proof.userId}'`],
      [() => `UPDATE account_final_sweeps SET phase='awaiting' WHERE vault_id='${proof.vaultId}'`, () => `UPDATE account_final_sweeps SET phase='destroyed' WHERE vault_id='${proof.vaultId}'`],
      [() => `UPDATE shard_identity_claim_tokens SET token='${crypto.randomUUID()}' WHERE user_id='${proof.userId}'`, () => `UPDATE shard_identity_claim_tokens SET token='${proof.claimToken}' WHERE user_id='${proof.userId}'`],
      [() => `UPDATE vaults SET swept_at=0 WHERE vault_id='${proof.vaultId}';`, () => `UPDATE vaults SET swept_at=${sweptAt} WHERE vault_id='${proof.vaultId}'`],
      [() => `INSERT INTO retired_vaults(vault_id,user_id,state) VALUES ('${"c".repeat(64)}','${proof.userId}','deleting')`, () => `DELETE FROM retired_vaults WHERE vault_id='${"c".repeat(64)}'`],
      [() => `INSERT INTO retired_vaults(vault_id,user_id,state) VALUES ('${proof.vaultId}','s6:${crypto.randomUUID()}','deleting')`, () => `DELETE FROM retired_vaults WHERE vault_id='${proof.vaultId}'`],
    ]) {
      await runInDurableObject(home, (_instance, state) => state.storage.sql.exec(mutate()));
      try {
        const attempt = crypto.randomUUID();
        await expect(local(home, (d) => d.sealInviteInventoryV2(attempt, proof.email, proof.userId, epoch, proof))).rejects.toThrow(/requires review/);
        await runInDurableObject(home, (_instance, state) => expect(state.storage.sql.exec(`SELECT operation_id FROM shard_invite_inventory WHERE operation_id=?`, attempt).toArray()).toHaveLength(0));
      } finally { await runInDurableObject(home, (_instance, state) => state.storage.sql.exec(restore())); }
    }
    await runInDurableObject(home, (_instance, state) => state.storage.sql.exec(`DELETE FROM shard_invite_account_bindings WHERE user_id=?`, proof.userId));
    try {
      await expect(local(home, (d) => d.sealInviteInventoryV2(crypto.randomUUID(), proof.email, proof.userId, epoch, proof))).rejects.toThrow(/requires review/);
    } finally {
      await runInDurableObject(home, (_instance, state) => state.storage.sql.exec(
        `INSERT INTO shard_invite_account_bindings(user_id,provider,subject,token,email,generation) VALUES (?,?,?,?,?,?)`,
        proof.userId, proof.provider, proof.subject, proof.claimToken, proof.email, proof.generation,
      ));
    }
    await runInDurableObject(home, (_instance, state) => {
      state.storage.sql.exec(`UPDATE vaults SET swept_at=0 WHERE vault_id=?`, proof.vaultId);
      state.storage.sql.exec(`UPDATE account_final_sweeps SET swept_at=0 WHERE vault_id=?`, proof.vaultId);
    });
    try {
      await expect(local(home, (d) => d.sealInviteInventoryV2(crypto.randomUUID(), proof.email, proof.userId, epoch, proof))).rejects.toThrow(/requires review/);
    } finally {
      await runInDurableObject(home, (_instance, state) => {
        state.storage.sql.exec(`UPDATE vaults SET swept_at=? WHERE vault_id=?`, sweptAt, proof.vaultId);
        state.storage.sql.exec(`UPDATE account_final_sweeps SET swept_at=? WHERE vault_id=?`, sweptAt, proof.vaultId);
      });
    }
    await runInDurableObject(home, (_instance, state) => {
      expect(Number(state.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='shard_auth_floor'`).one().value)).toBe(floor);
      expect(state.storage.sql.exec(`SELECT operation_id FROM shard_invite_target_seals`).toArray()).toHaveLength(0);
    });
  });
});
