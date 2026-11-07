import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("counts bound, unbound and orphaned claim tokens without falsely reporting erasure", async () => {
  const stub = env.DIRECTORY.getByName(`claim-audit-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES ('u','u@example.test','active',1)`);
    sql.exec(`INSERT INTO identities(provider,subject,user_id) VALUES ('test','bound','u')`);
    sql.exec(`INSERT INTO identity_homes(provider,subject,shard,user_id) VALUES ('test','bound',3,'u'),('test','unbound',3,NULL)`);
    sql.exec(`INSERT INTO shard_home_claim_tokens(provider,subject,token) VALUES ('test','bound','a'),('test','unbound','b'),('test','orphan','c')`);
    sql.exec(`INSERT INTO shard_identity_claim_tokens(provider,subject,user_id,token) VALUES ('test','bound','u','a')`);
    // One user and identity, one home, two linked tokens, one unbound and one orphan.
    expect(await instance.deletionProbe("u", "vault")).toBe(7);
    // Unattributable tokens prevent a false zero for any user.
    expect(await instance.deletionProbe("another", "vault")).toBe(2);
    sql.exec(`DELETE FROM shard_home_claim_tokens WHERE subject='orphan'`);
    sql.exec(`DELETE FROM identity_homes WHERE provider='test' AND subject='unbound'`);
    expect(await instance.deletionProbe("another", "vault")).toBe(0);
    sql.exec(`DELETE FROM identity_homes WHERE provider='test' AND subject='bound'`);
    expect(sql.exec(`SELECT * FROM shard_home_claim_tokens`).toArray()).toEqual([]);
    sql.exec(`DELETE FROM identities WHERE provider='test' AND subject='bound'`);
    expect(sql.exec(`SELECT * FROM shard_identity_claim_tokens`).toArray()).toEqual([]);
    sql.exec(`DELETE FROM users WHERE user_id='u'`);
    expect(sql.exec(`SELECT * FROM shard_identity_claim_tokens`).toArray()).toEqual([]);
    expect(await instance.deletionProbe("u", "vault")).toBe(0);
    sql.exec(`INSERT INTO shard_home_bind_claim_marker(provider,subject,token) VALUES ('test','unknown','z')`);
    expect(await instance.deletionProbe("u", "vault")).toBe(1);
    sql.exec(`DELETE FROM shard_home_bind_claim_marker`);
    expect(await instance.deletionProbe("u", "vault")).toBe(0);
  });
});
