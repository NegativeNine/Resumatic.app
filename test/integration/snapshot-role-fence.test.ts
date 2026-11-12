import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { ResumeBody } from "../../src/shared/api";
import type { RoleRecord } from "../../src/shared/types";
import { SnapshotStore } from "../../src/vault/snapshots";

function captureItem(sql: SqlStorage, runId: string, kind: "fact" | "role", id: string, data: string) {
  sql.exec(`INSERT INTO generation_input_items(run_id,kind,item_id,data,incarnation) VALUES (?,?,?,?,(SELECT value FROM entity_incarnations WHERE kind=? AND item_id=?))`,
    runId, kind, id, data, kind, id);
}

it("requires a complete captured role before publishing a section or cited fact", async () => {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  await stub.init("snapshot-role-owner");
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql, snapshots = new SnapshotStore(sql);
    let runId = crypto.randomUUID();
    const id = crypto.randomUUID(), factId = crypto.randomUUID();
    const role: RoleRecord = { id, revision: 1, kind: "job", org: "Example", title: "Engineer", startDate: "2020", endDate: "2021" };
    sql.exec(`INSERT INTO roles(id,kind,org,title,start_date,end_date,state) VALUES (?, 'job', 'Example', 'Engineer', '2020', '2021', 'confirmed')`, id);
    sql.exec(`INSERT INTO facts(id,role_id,kind,text,origin,state,updated_at) VALUES (?, ?, 'accomplishment', 'Built a service', 'user', 'confirmed', 1)`, factId, id);
    const fact = { id: factId, roleId: id, revision: 1, kind: "accomplishment", text: "Built a service", origin: "user", level: null, quote: null };
    captureItem(sql, runId, "fact", factId, JSON.stringify(fact));
    const sectionBody: ResumeBody = { summary: null, skills: [], sections: [{ ...role, roleId: id, lines: [] }] };
    const summaryBody: ResumeBody = { summary: { id: "line", text: fact.text, factIds: [factId], status: "kept" }, skills: [], sections: [] };
    const expectRejected = () => {
      expect(() => snapshots.assertCurrent(runId, sectionBody)).toThrow("A role changed while this draft was being made");
      expect(() => snapshots.assertCurrent(runId, summaryBody)).toThrow("A role changed while this draft was being made");
    };
    // The current role happens to have revision 1, but it was not captured.
    expectRejected();
    for (const corrupt of ["null", "{", JSON.stringify({ ...role, id: "different" }), JSON.stringify({ ...role, revision: 0 }), JSON.stringify({ ...role, revision: undefined }), JSON.stringify({ ...role, org: undefined })]) {
      captureItem(sql, runId, "role", id, corrupt);
      expectRejected();
      sql.exec(`DELETE FROM generation_input_items WHERE run_id=? AND kind='role'`, runId);
    }
    captureItem(sql, runId, "role", id, JSON.stringify(role));
    // An unrelated malformed captured role cannot supply this role and need not block it.
    sql.exec(`INSERT INTO generation_input_items(run_id,kind,item_id,data) VALUES (?, 'role', 'unrelated', 'null')`, runId);
    expect(() => snapshots.assertCurrent(runId, sectionBody)).not.toThrow();
    expect(() => snapshots.assertCurrent(runId, summaryBody)).not.toThrow();
    for (const [field, changed, original] of [
      ["kind", "education", "job"], ["org", "Other", "Example"], ["title", "Director", "Engineer"],
      ["start_date", "2019", "2020"], ["end_date", "2022", "2021"], ["unknown_end_start_date", "2019", null],
    ] as const) {
      sql.exec(`UPDATE roles SET ${field}=? WHERE id=?`, changed, id);
      expectRejected();
      sql.exec(`UPDATE roles SET ${field}=? WHERE id=?`, original, id);
      expectRejected();
      runId = crypto.randomUUID();
      captureItem(sql, runId, "fact", factId, JSON.stringify(fact));
      captureItem(sql, runId, "role", id, JSON.stringify(role));
      expect(() => snapshots.assertCurrent(runId, sectionBody)).not.toThrow();
      expect(() => snapshots.assertCurrent(runId, summaryBody)).not.toThrow();
    }
    const secondId = crypto.randomUUID();
    const second: RoleRecord = { ...role, id: secondId };
    const secondBody: ResumeBody = { summary: null, skills: [], sections: [{ ...second, roleId: secondId, lines: [] }] };
    sql.exec(`INSERT INTO roles(id,kind,org,title,start_date,end_date,state) VALUES (?, 'job', 'Example', 'Engineer', '2020', '2021', 'confirmed')`, secondId);
    captureItem(sql, runId, "role", secondId, JSON.stringify(second));
    expect(() => snapshots.assertCurrent(runId, secondBody)).not.toThrow();
    sql.exec(`DELETE FROM roles WHERE id=?`, secondId);
    sql.exec(`INSERT INTO roles(id,kind,org,title,start_date,end_date,state) VALUES (?, 'job', 'Replacement', 'Engineer', '2020', '2021', 'confirmed')`, secondId);
    expect(() => snapshots.assertCurrent(runId, secondBody)).toThrow("A role changed while this draft was being made");
    sql.exec(`UPDATE roles SET revision=revision+1 WHERE id=?`, id);
    expectRejected();
  });
});
