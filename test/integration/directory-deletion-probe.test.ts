import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("counts orphaned billing, deletion and initialization markers for the requested account", async () => {
  // A separate local Directory has no identity records or external services.
  const stub = env.DIRECTORY.getByName(`probe-${crypto.randomUUID()}`);
  const userId = crypto.randomUUID();
  const otherUser = crypto.randomUUID();
  const vaultId = "a".repeat(64);
  const otherVault = "b".repeat(64);
  await runInDurableObject(stub, async (instance, state) => {
    const sql = state.storage.sql;
    expect(await instance.deletionProbe(userId, vaultId)).toBe(0);
    const inserts: (() => void)[] = [
      () => { sql.exec(`INSERT INTO billing_delivery_retries(user_id,revision,next_attempt_at) VALUES (?,1,0)`, userId); },
      () => { sql.exec(`INSERT INTO shard_identity_delete_marker(user_id) VALUES (?)`, userId); },
      () => { sql.exec(`INSERT INTO shard_google_delete_v3_marker(user_id) VALUES (?)`, userId); },
      () => { sql.exec(`INSERT INTO global_shard_home_release_marker(provider,subject,user_id) VALUES ('google','subject',?)`, userId); },
      () => { sql.exec(`INSERT INTO global_google_release_v3_marker(provider,subject,user_id) VALUES ('google','subject',?)`, userId); },
      () => { sql.exec(`INSERT INTO vault_initializations(vault_id,sticky) VALUES (?,1)`, vaultId); },
    ];
    for (const [index, insert] of inserts.entries()) {
      insert();
      expect(await instance.deletionProbe(userId, vaultId)).toBe(index + 1);
    }
    // Markers belonging to a different account must not affect this probe.
    sql.exec(`INSERT INTO billing_delivery_retries(user_id,revision,next_attempt_at) VALUES (?,1,0)`, otherUser);
    sql.exec(`INSERT INTO vault_initializations(vault_id,sticky) VALUES (?,1)`, otherVault);
    expect(await instance.deletionProbe(userId, vaultId)).toBe(6);
    for (const table of ["billing_delivery_retries", "shard_identity_delete_marker", "shard_google_delete_v3_marker", "global_shard_home_release_marker", "global_google_release_v3_marker"])
      sql.exec(`DELETE FROM ${table} WHERE user_id=?`, userId);
    // This is an isolated fixture, not an operator recovery procedure for an
    // unresolved production initialization.
    sql.exec(`UPDATE vault_initializations SET sticky=0 WHERE vault_id=?`, vaultId);
    sql.exec(`DELETE FROM vault_initializations WHERE vault_id=?`, vaultId);
    expect(await instance.deletionProbe(userId, vaultId)).toBe(0);
  });
});

it("holds every probe pending for customer-only legacy billing events", async () => {
  const stub = env.DIRECTORY.getByName(`billing-probe-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`INSERT INTO billing_events(id,customer_id,user_id,created_at) VALUES
      ('unattributed','cus_legacy',NULL,0),('empty','cus_empty','',0),
      ('owned','cus_owned','owner',0),('other','cus_other','other',0)`);
    expect(await instance.deletionProbe("owner", "vault")).toBe(3);
    expect(await instance.deletionProbe("unrelated", "vault")).toBe(2);
    sql.exec(`DELETE FROM billing_events WHERE id IN ('unattributed','empty')`);
    expect(await instance.deletionProbe("unrelated", "vault")).toBe(0);
    expect(await instance.deletionProbe("owner", "vault")).toBe(1);
  });
});
