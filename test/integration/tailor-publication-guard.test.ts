import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { composeBody } from "../../src/pipeline/tailor";
import type { FactRecord, RoleRecord, Selection, VerifiedDraft } from "../../src/shared/types";

it("publishes only the body and report recomposed from the verified checkpoint", async () => {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  await stub.init("publication-owner");
  await runInDurableObject(stub, async (instance, state) => {
    const runId = crypto.randomUUID();
    const appId = crypto.randomUUID();
    const role: RoleRecord = { id: "role", kind: "job", org: "Example", title: "Engineer", startDate: "2021", endDate: "2022", revision: 1 };
    const fact: FactRecord = { id: "fact", roleId: role.id, kind: "accomplishment", text: "Built a service", level: null, quote: null, origin: "user", revision: 1 };
    const selection: Selection = { factIds: [fact.id], skillIds: [], gaps: [] };
    const verified: VerifiedDraft = {
      lines: [{ id: "line", roleId: role.id, text: "Built a service", factIds: [fact.id], status: "kept" }],
      report: { kept: 1, repaired: 0, replaced: 0, dropped: 0, gaps: [] },
    };
    const sql = state.storage.sql;
    sql.exec(`INSERT INTO applications (id,jd_text,created_at) VALUES (?, 'job', 1)`, appId);
    sql.exec(`INSERT INTO roles (id,kind,org,title,start_date,end_date,state) VALUES (?, 'job','Example','Engineer','2021','2022','confirmed')`, role.id);
    sql.exec(`INSERT INTO facts (id,role_id,kind,text,origin,state,updated_at) VALUES (?,?,'accomplishment','Built a service','user','confirmed',1)`, fact.id, role.id);
    const internals = instance as unknown as {
      runs: { begin(input: object, write: () => void): unknown };
      snapshots: { capture(id: string, metadata: object, facts: FactRecord[], roles: RoleRecord[], vectors: Map<string, Float32Array>): void };
    };
    internals.runs.begin({ id: runId, kind: "tailor", targetId: runId, requestKey: runId, inputDigest: runId, steps: ["analyze", "select", "write", "verify"] }, () => {
      sql.exec(`INSERT INTO resumes (id,application_id,state,run_id,created_at) VALUES (?,?,'running',?,1)`, runId, appId, runId);
      internals.snapshots.capture(runId, { applicationId: appId, jdText: "job", analysis: null, profile: { name: "", email: "", phone: "", location: "", links: [] } }, [fact], [role], new Map());
    });
    await instance.claimRun(runId, { kind: "tailor", targetId: runId });
    await expect(instance.saveStep(runId, "analyze", { verified }, runId)).rejects.toThrow(/verified checkpoint/);
    await instance.saveStep(runId, "analyze", {}, runId);
    await expect(instance.saveStep(runId, "select", { selection, verified }, runId)).rejects.toThrow(/verified checkpoint/);
    await instance.saveStep(runId, "select", { selection }, runId);
    // Replaying an already committed step is a no-op even if its payload is stale.
    await expect(instance.saveStep(runId, "select", { selection, verified }, runId)).resolves.toBeUndefined();
    await instance.saveStep(runId, "write", { draft: { lines: verified.lines } }, runId);
    await expect(instance.saveStep(runId, "verify", {}, runId)).rejects.toThrow(/verified checkpoint/);
    await expect(instance.saveStep(runId, "verify", { verified, body: { summary: null, sections: [], skills: [] } }, runId)).rejects.toThrow(/verified checkpoint/);
    await instance.saveStep(runId, "verify", { verified }, runId);
    const body = composeBody(verified, [role], [fact], selection);
    const changedText = structuredClone(body); changedText.sections[0]!.lines[0]!.text = "Founded a company";
    const changedHeader = structuredClone(body); changedHeader.sections[0]!.org = "Another company";
    const changedCitations = structuredClone(body); changedCitations.sections[0]!.lines[0]!.factIds = [];
    for (const candidate of [changedText, changedHeader, changedCitations])
      await expect(instance.saveStep(runId, "finish", { state: "ready", body: candidate, report: verified.report }, runId)).rejects.toThrow(/verified checkpoint/);
    await expect(instance.saveStep(runId, "finish", { state: "ready", body, report: { ...verified.report, kept: 2 } }, runId)).rejects.toThrow(/verified checkpoint/);
    await expect(instance.saveStep(runId, "finish", { state: "ready", report: verified.report }, runId)).rejects.toThrow(/verified checkpoint/);
    await expect(instance.saveStep(runId, "finish", { state: "ready", body, report: verified.report, selection }, runId)).rejects.toThrow(/verified checkpoint/);
    sql.exec(`UPDATE resumes SET verified=NULL WHERE id=?`, runId);
    await expect(instance.saveStep(runId, "finish", { state: "ready", body, report: verified.report }, runId)).rejects.toThrow(/verified checkpoint/);
    sql.exec(`UPDATE resumes SET verified=? WHERE id=?`, JSON.stringify(verified), runId);
    sql.exec(`UPDATE resumes SET selection=NULL WHERE id=?`, runId);
    await expect(instance.saveStep(runId, "finish", { state: "ready", body, report: verified.report }, runId)).rejects.toThrow(/verified checkpoint/);
    sql.exec(`UPDATE resumes SET selection=? WHERE id=?`, JSON.stringify(selection), runId);
    const stale = structuredClone(verified); stale.lines[0]!.text = "Different verified text";
    sql.exec(`UPDATE resumes SET verified=? WHERE id=?`, JSON.stringify(stale), runId);
    await expect(instance.saveStep(runId, "finish", { state: "ready", body, report: verified.report }, runId)).rejects.toThrow(/verified checkpoint/);
    sql.exec(`UPDATE resumes SET verified=? WHERE id=?`, JSON.stringify(verified), runId);
    // RPC object property order is irrelevant to the content being published.
    const reordered = JSON.parse(JSON.stringify(body, (_key, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value,
    )) as typeof body;
    const reorderedReport = Object.fromEntries(Object.entries(verified.report).reverse()) as typeof verified.report;
    await expect(instance.saveStep(runId, "finish", { state: "ready", body: reordered, report: reorderedReport }, runId)).resolves.toBeUndefined();
    expect(sql.exec<{ state: string }>(`SELECT state FROM resumes WHERE id=?`, runId).one().state).toBe("ready");
    // A duplicate finish after success is idempotent and cannot overwrite it.
    await expect(instance.saveStep(runId, "finish", { state: "ready", body: changedText, report: verified.report }, runId)).resolves.toBeUndefined();
    expect(JSON.parse(sql.exec<{ body: string }>(`SELECT body FROM resumes WHERE id=?`, runId).one().body)).toEqual(body);
  });
}, 30_000);
