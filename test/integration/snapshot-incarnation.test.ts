import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { ResumeBody } from "../../src/shared/api";
import type { FactRecord, RoleRecord } from "../../src/shared/types";
import { SnapshotStore, type InputMetadata } from "../../src/vault/snapshots";

const metadata: InputMetadata = {
  applicationId: "job", jdText: "job", analysis: null,
  profile: { revision: 1, name: "", email: "", phone: "", location: "", links: [] },
};

it("rejects identical fact or role reincarnations and does not overwrite a run on capture retry", async () => {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  await stub.init("incarnation-owner");
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql, snapshots = new SnapshotStore(sql);
    const fact: FactRecord = { id: crypto.randomUUID(), revision: 1, roleId: null, kind: "accomplishment", text: "Built a service", origin: "user", level: null, levelExplicit: false, quote: null };
    const role: RoleRecord = { id: crypto.randomUUID(), revision: 1, kind: "job", org: "Example", title: null, startDate: null, endDate: null };
    const factBody: ResumeBody = { summary: { id: "line", text: fact.text, factIds: [fact.id], status: "kept" }, skills: [], sections: [] };
    const roleBody: ResumeBody = { summary: null, skills: [], sections: [{ ...role, roleId: role.id, lines: [] }] };
    const insertFact = () => sql.exec(`INSERT INTO facts(id,kind,text,origin,state,updated_at) VALUES (?, 'accomplishment','Built a service','user','confirmed',1)`, fact.id);
    const insertRole = () => sql.exec(`INSERT INTO roles(id,kind,org,state) VALUES (?, 'job','Example','confirmed')`, role.id);
    insertFact(); insertRole();
    const runId = crypto.randomUUID();
    snapshots.capture(runId, metadata, [fact], [role], new Map());
    expect(() => snapshots.assertCurrent(runId, factBody)).not.toThrow();
    expect(() => snapshots.assertCurrent(runId, roleBody)).not.toThrow();
    const originalFact = sql.exec<{ value: number }>(`SELECT value FROM entity_incarnations WHERE kind='fact' AND item_id=?`, fact.id).one().value;
    const originalRole = sql.exec<{ value: number }>(`SELECT value FROM entity_incarnations WHERE kind='role' AND item_id=?`, role.id).one().value;
    expect(() => sql.exec(`UPDATE facts SET id=? WHERE id=?`, crypto.randomUUID(), fact.id)).toThrow();
    expect(() => sql.exec(`UPDATE roles SET id=? WHERE id=?`, crypto.randomUUID(), role.id)).toThrow();
    expect(() => sql.exec(`UPDATE entity_incarnations SET value=0 WHERE kind='fact' AND item_id=?`, fact.id)).toThrow();
    expect(() => sql.exec(`UPDATE entity_incarnation_clock SET value=0 WHERE slot=1`)).toThrow();
    expect(() => sql.exec(`DELETE FROM entity_incarnation_clock`)).toThrow();
    expect(() => sql.exec(`INSERT OR REPLACE INTO entity_incarnation_clock(slot,value) VALUES(1,0)`)).toThrow();
    sql.exec(`DELETE FROM facts WHERE id=?`, fact.id);
    expect(sql.exec(`SELECT value FROM entity_incarnations WHERE kind='fact' AND item_id=?`, fact.id).toArray()).toHaveLength(0);
    insertFact();
    expect(sql.exec<{ value: number }>(`SELECT value FROM entity_incarnations WHERE kind='fact' AND item_id=?`, fact.id).one().value).toBeGreaterThan(originalFact);
    expect(() => snapshots.assertCurrent(runId, factBody)).toThrow("Your facts changed while this draft was being made");
    snapshots.capture(runId, metadata, [fact], [role], new Map());
    expect(() => snapshots.assertCurrent(runId, factBody)).toThrow("Your facts changed while this draft was being made");
    sql.exec(`INSERT OR REPLACE INTO roles(id,kind,org,state) VALUES (?, 'job','Example','confirmed')`, role.id);
    expect(sql.exec<{ value: number }>(`SELECT value FROM entity_incarnations WHERE kind='role' AND item_id=?`, role.id).one().value).toBeGreaterThan(originalRole);
    expect(() => snapshots.assertCurrent(runId, roleBody)).toThrow("role changed");
    const newRun = crypto.randomUUID();
    snapshots.capture(newRun, metadata, [fact], [role], new Map());
    expect(() => snapshots.assertCurrent(newRun, factBody)).not.toThrow();
    expect(() => snapshots.assertCurrent(newRun, roleBody)).not.toThrow();
    // REPLACE also fences a fact even when every stored field is unchanged.
    sql.exec(`INSERT OR REPLACE INTO facts(id,kind,text,origin,state,updated_at) VALUES (?, 'accomplishment','Built a service','user','confirmed',1)`, fact.id);
    expect(() => snapshots.assertCurrent(newRun, factBody)).toThrow("Your facts changed while this draft was being made");
  });
});

it("fails closed for pre-migration or incomplete snapshot incarnation records", async () => {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  await stub.init("legacy-snapshot-owner");
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql, snapshots = new SnapshotStore(sql), id = crypto.randomUUID();
    const fact: FactRecord = { id, revision: 1, roleId: null, kind: "skill", text: "Go", origin: "user", level: null, levelExplicit: false, quote: null };
    const body: ResumeBody = { summary: null, sections: [], skills: ["Go"] };
    sql.exec(`INSERT INTO facts(id,kind,text,origin,state,updated_at) VALUES (?, 'skill','Go','user','confirmed',1)`, id);
    // A snapshot written by an old runtime has no captured incarnation.
    sql.exec(`INSERT INTO generation_input_items(run_id,kind,item_id,data) VALUES ('legacy','fact',?,?)`, id, JSON.stringify(fact));
    expect(() => snapshots.assertCurrent("legacy", body)).toThrow("Your facts changed while this draft was being made");
    sql.exec(`INSERT INTO entity_incarnation_guard(slot) VALUES(1)`);
    expect(() => snapshots.assertCurrent("legacy", body)).toThrow("still needs checking");
    sql.exec(`DELETE FROM entity_incarnation_guard WHERE slot=1`);
  });
});

it("fences reverted fact, role and evidence changes while allowing vector-only updates", async () => {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  await stub.init("incarnation-update-owner");
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql, snapshots = new SnapshotStore(sql);
    const sourceId = crypto.randomUUID(), evidenceId = crypto.randomUUID(), factId = crypto.randomUUID(), roleId = crypto.randomUUID();
    sql.exec(`INSERT INTO sources(id,filename,r2_key,markdown,state,created_at) VALUES (?, 'resume.pdf', 'key', 'Built a service', 'ready', 1)`, sourceId);
    sql.exec(`INSERT INTO evidence(id,source_id,quote) VALUES (?, ?, 'Built a service')`, evidenceId, sourceId);
    sql.exec(`INSERT INTO roles(id,kind,org,state,evidence_id) VALUES (?, 'job','Example','confirmed',?)`, roleId, evidenceId);
    sql.exec(`INSERT INTO facts(id,kind,text,origin,state,updated_at,evidence_id) VALUES (?, 'accomplishment','Built a service','extracted','confirmed',1,?)`, factId, evidenceId);
    const fact: FactRecord = { id: factId, revision: 1, roleId: null, kind: "accomplishment", text: "Built a service", origin: "extracted", level: null, quote: "Built a service" };
    const role: RoleRecord = { id: roleId, revision: 1, kind: "job", org: "Example", title: null, startDate: null, endDate: null };
    const factBody: ResumeBody = { summary: { id: "line", text: fact.text, factIds: [fact.id], status: "kept" }, skills: [], sections: [] };
    const roleBody: ResumeBody = { summary: null, skills: [], sections: [{ ...role, roleId, lines: [] }] };
    let runId = crypto.randomUUID();
    snapshots.capture(runId, metadata, [fact], [role], new Map());
    const before = sql.exec<{ value: number }>(`SELECT value FROM entity_incarnations WHERE kind='fact' AND item_id=?`, factId).one().value;
    sql.exec(`UPDATE facts SET vector=x'01020304' WHERE id=?`, factId);
    sql.exec(`UPDATE facts SET text=text WHERE id=?`, factId);
    expect(sql.exec<{ value: number }>(`SELECT value FROM entity_incarnations WHERE kind='fact' AND item_id=?`, factId).one().value).toBe(before);
    expect(() => snapshots.assertCurrent(runId, factBody)).not.toThrow();
    sql.exec(`UPDATE facts SET text='Changed' WHERE id=?`, factId);
    sql.exec(`UPDATE facts SET text='Built a service' WHERE id=?`, factId);
    expect(() => snapshots.assertCurrent(runId, factBody)).toThrow("Your facts changed while this draft was being made");
    sql.exec(`UPDATE roles SET org='Other' WHERE id=?`, roleId);
    sql.exec(`UPDATE roles SET org='Example' WHERE id=?`, roleId);
    expect(() => snapshots.assertCurrent(runId, roleBody)).toThrow("role changed");
    runId = crypto.randomUUID();
    snapshots.capture(runId, metadata, [fact], [role], new Map());
    sql.exec(`UPDATE evidence SET quote='Other text' WHERE id=?`, evidenceId);
    sql.exec(`UPDATE evidence SET quote='Built a service' WHERE id=?`, evidenceId);
    expect(() => snapshots.assertCurrent(runId, factBody)).toThrow("Your facts changed while this draft was being made");
    expect(() => snapshots.assertCurrent(runId, roleBody)).toThrow("role changed");
    runId = crypto.randomUUID();
    snapshots.capture(runId, metadata, [fact], [role], new Map());
    sql.exec(`INSERT OR REPLACE INTO evidence(id,source_id,quote) VALUES (?, ?, 'Built a service')`, evidenceId, sourceId);
    expect(() => snapshots.assertCurrent(runId, factBody)).toThrow("Your facts changed while this draft was being made");
    expect(() => snapshots.assertCurrent(runId, roleBody)).toThrow("role changed");
    expect(() => sql.exec(`UPDATE evidence SET id=? WHERE id=?`, crypto.randomUUID(), evidenceId)).toThrow();
  });
});

it("counts incarnation state in deletion audits and removes it on destruction", async () => {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  await stub.init("incarnation-delete-owner");
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO facts(id,kind,text,origin,state,updated_at) VALUES ('fact','skill','Go','user','confirmed',1)`);
    expect(state.storage.sql.exec(`SELECT value FROM entity_incarnations WHERE kind='fact' AND item_id='fact'`).toArray()).toHaveLength(1);
  });
  expect((await stub.deletionProbe()).rows).toBeGreaterThan(0);
  await stub.close();
  await stub.destroy();
  expect(await stub.deletionProbe()).toEqual({ rows: 0 });
});
