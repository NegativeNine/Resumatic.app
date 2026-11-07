import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { ResumeBody } from "../../src/shared/api";
import type { FactRecord, RoleRecord } from "../../src/shared/types";
import { SnapshotStore } from "../../src/vault/snapshots";

function captureItem(sql: SqlStorage, runId: string, kind: "fact" | "role", id: string, data: string) {
  sql.exec(`INSERT INTO generation_input_items(run_id,kind,item_id,data,incarnation) VALUES (?,?,?,?,(SELECT value FROM entity_incarnations WHERE kind=? AND item_id=?))`,
    runId, kind, id, data, kind, id);
}

it("requires captured facts and rechecks their complete verification inputs", async () => {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  await stub.init("snapshot-fact-owner");
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql, snapshots = new SnapshotStore(sql);
    let runId = crypto.randomUUID();
    const roleId = crypto.randomUUID(), factId = crypto.randomUUID();
    const role: RoleRecord = { id: roleId, revision: 1, kind: "job", org: "Example", title: "Engineer", startDate: "2020", endDate: "2021" };
    const fact: FactRecord = { id: factId, revision: 1, roleId, kind: "accomplishment", text: "Built a service", origin: "user", level: null, quote: null };
    sql.exec(`INSERT INTO roles(id,kind,org,title,start_date,end_date,state) VALUES (?, 'job', 'Example', 'Engineer', '2020', '2021', 'confirmed')`, roleId);
    sql.exec(`INSERT INTO facts(id,role_id,kind,text,origin,state,updated_at) VALUES (?, ?, 'accomplishment', 'Built a service', 'user', 'confirmed', 1)`, factId, roleId);
    captureItem(sql, runId, "role", roleId, JSON.stringify(role));
    const body: ResumeBody = { summary: { id: "line", text: fact.text, factIds: [factId], status: "kept" }, skills: [], sections: [] };
    const reject = () => expect(() => snapshots.assertCurrent(runId, body)).toThrow("experience changed");
    reject();
    for (const corrupt of ["null", "{", JSON.stringify({ ...fact, id: "different" }), JSON.stringify({ ...fact, revision: 0 }), JSON.stringify({ ...fact, origin: undefined }), JSON.stringify({ ...fact, text: "" })]) {
      captureItem(sql, runId, "fact", factId, corrupt);
      reject();
      sql.exec(`DELETE FROM generation_input_items WHERE run_id=? AND kind='fact'`, runId);
    }
    // Historical user snapshots with no level selection remain valid without levelExplicit.
    captureItem(sql, runId, "fact", factId, JSON.stringify(fact));
    expect(() => snapshots.assertCurrent(runId, body)).not.toThrow();
    for (const [field, changed, original] of [
      ["role_id", null, roleId], ["kind", "credential", "accomplishment"], ["text", "Destroyed a service", fact.text],
      ["origin", "extracted", "user"], ["state", "rejected", "confirmed"],
    ] as const) {
      sql.exec(`UPDATE facts SET ${field}=? WHERE id=?`, changed, factId);
      reject();
      sql.exec(`UPDATE facts SET ${field}=? WHERE id=?`, original, factId);
      // Restoring the old values does not revive the earlier generation.
      reject();
      runId = crypto.randomUUID();
      captureItem(sql, runId, "role", roleId, JSON.stringify(role));
      captureItem(sql, runId, "fact", factId, JSON.stringify(fact));
      expect(() => snapshots.assertCurrent(runId, body)).not.toThrow();
    }
    sql.exec(`UPDATE facts SET level='led',level_revision=revision WHERE id=?`, factId);
    reject();
    sql.exec(`UPDATE facts SET level=NULL,level_revision=NULL WHERE id=?`, factId);
    reject();
    runId = crypto.randomUUID();
    captureItem(sql, runId, "role", roleId, JSON.stringify(role));
    captureItem(sql, runId, "fact", factId, JSON.stringify(fact));
    // A current fact recreated under the same ID and revision does not authenticate new text.
    sql.exec(`DELETE FROM facts WHERE id=?`, factId);
    sql.exec(`INSERT INTO facts(id,role_id,kind,text,origin,state,updated_at) VALUES (?, ?, 'accomplishment', 'Invented a service', 'user', 'confirmed', 1)`, factId, roleId);
    reject();
    sql.exec(`UPDATE facts SET text=? WHERE id=?`, fact.text, factId);
    // Identical contents do not revive the captured incarnation.
    reject();
    // A fresh generation can capture the replacement as a new input.
    runId = crypto.randomUUID();
    captureItem(sql, runId, "role", roleId, JSON.stringify(role));
    captureItem(sql, runId, "fact", factId, JSON.stringify(fact));
    expect(() => snapshots.assertCurrent(runId, body)).not.toThrow();

    // Extracted facts also recheck the captured source quote, even at the same revision.
    const sourceId = crypto.randomUUID(), evidenceId = crypto.randomUUID();
    sql.exec(`INSERT INTO sources(id,filename,r2_key,markdown,state,created_at) VALUES (?, 'resume.pdf', 'key', 'Built a service', 'ready', 1)`, sourceId);
    sql.exec(`INSERT INTO evidence(id,source_id,quote) VALUES (?, ?, 'Built a service')`, evidenceId, sourceId);
    sql.exec(`UPDATE facts SET origin='extracted',evidence_id=? WHERE id=?`, evidenceId, factId);
    const extracted = { ...fact, origin: "extracted", quote: "Built a service" };
    runId = crypto.randomUUID();
    captureItem(sql, runId, "role", roleId, JSON.stringify(role));
    captureItem(sql, runId, "fact", factId, JSON.stringify(extracted));
    expect(() => snapshots.assertCurrent(runId, body)).not.toThrow();
    sql.exec(`UPDATE evidence SET quote='Modified quote' WHERE id=?`, evidenceId);
    reject();
    sql.exec(`UPDATE evidence SET quote='Built a service' WHERE id=?`, evidenceId);
    reject();
  });
});

it("requires every printed skill to have a captured, still-confirmed skill fact", async () => {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  await stub.init("snapshot-skill-owner");
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql, snapshots = new SnapshotStore(sql), runId = crypto.randomUUID(), factId = crypto.randomUUID();
    const skill: FactRecord = { id: factId, revision: 1, roleId: null, kind: "skill", text: "TypeScript", origin: "user", level: null, quote: null, levelExplicit: false };
    const body: ResumeBody = { summary: null, sections: [], skills: ["TypeScript"] };
    sql.exec(`INSERT INTO facts(id,kind,text,origin,state,updated_at) VALUES (?, 'skill', 'TypeScript', 'user', 'confirmed', 1)`, factId);
    expect(() => snapshots.assertCurrent(runId, body)).toThrow("experience changed");
    captureItem(sql, runId, "fact", factId, JSON.stringify(skill));
    expect(() => snapshots.assertCurrent(runId, body)).not.toThrow();
    sql.exec(`UPDATE facts SET state='rejected' WHERE id=?`, factId);
    expect(() => snapshots.assertCurrent(runId, body)).toThrow("experience changed");
    const duplicateId = crypto.randomUUID();
    const duplicate = { ...skill, id: duplicateId };
    sql.exec(`INSERT INTO facts(id,kind,text,origin,state,updated_at) VALUES (?, 'skill', 'TypeScript', 'user', 'confirmed', 1)`, duplicateId);
    captureItem(sql, runId, "fact", duplicateId, JSON.stringify(duplicate));
    // A rejected duplicate does not invalidate the still-confirmed skill.
    expect(() => snapshots.assertCurrent(runId, body)).not.toThrow();
    // Cited lines, unlike skill strings, must still use their exact fact ID.
    const cited: ResumeBody = { ...body, summary: { id: "line", text: "TypeScript", factIds: [factId], status: "kept" } };
    expect(() => snapshots.assertCurrent(runId, cited)).toThrow("experience changed");
    sql.exec(`UPDATE facts SET text='Go' WHERE id=?`, duplicateId);
    expect(() => snapshots.assertCurrent(runId, body)).toThrow("experience changed");
    sql.exec(`UPDATE facts SET text='TypeScript',state='rejected' WHERE id=?`, duplicateId);
    expect(() => snapshots.assertCurrent(runId, body)).toThrow("experience changed");
  });
});

it("accepts a duplicate skill only when its captured role remains confirmed and unchanged", async () => {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  await stub.init("snapshot-skill-role-owner");
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql, snapshots = new SnapshotStore(sql);
    let runId = crypto.randomUUID();
    const roles = [crypto.randomUUID(), crypto.randomUUID()].map((id) => ({ id, revision: 1, kind: "job" as const, org: "Example", title: null, startDate: null, endDate: null }));
    const facts = roles.map((role) => ({ id: crypto.randomUUID(), revision: 1, roleId: role.id, kind: "skill" as const, text: "TypeScript", origin: "user" as const, level: null, quote: null, levelExplicit: false }));
    for (const role of roles) {
      sql.exec(`INSERT INTO roles(id,kind,org,state) VALUES (?, 'job', 'Example', 'confirmed')`, role.id);
      captureItem(sql, runId, "role", role.id, JSON.stringify(role));
    }
    for (const fact of facts) {
      sql.exec(`INSERT INTO facts(id,role_id,kind,text,origin,state,updated_at) VALUES (?, ?, 'skill', 'TypeScript', 'user', 'confirmed', 1)`, fact.id, fact.roleId);
      captureItem(sql, runId, "fact", fact.id, JSON.stringify(fact));
    }
    const body: ResumeBody = { summary: null, sections: [], skills: ["TypeScript"] };
    sql.exec(`UPDATE roles SET state='rejected' WHERE id=?`, roles[0]!.id);
    expect(() => snapshots.assertCurrent(runId, body)).not.toThrow();
    sql.exec(`UPDATE roles SET org='Changed' WHERE id=?`, roles[1]!.id);
    expect(() => snapshots.assertCurrent(runId, body)).toThrow("experience changed");
    sql.exec(`UPDATE roles SET org='Example' WHERE id=?`, roles[1]!.id);
    expect(() => snapshots.assertCurrent(runId, body)).toThrow("experience changed");
    runId = crypto.randomUUID();
    captureItem(sql, runId, "role", roles[1]!.id, JSON.stringify(roles[1]));
    captureItem(sql, runId, "fact", facts[1]!.id, JSON.stringify(facts[1]));
    expect(() => snapshots.assertCurrent(runId, body)).not.toThrow();
  });
});
