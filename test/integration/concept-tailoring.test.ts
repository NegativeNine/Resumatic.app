import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels, type Models } from "../../src/ai/models";
import { fromBase64url } from "../../src/worker/crypto";
import { vault } from "../../src/shared/stubs";
import type { ResumeView } from "../../src/shared/api";
import type { DocumentView } from "../../src/shared/documents";
import { MCP_FIT_SCOPES, type McpClaims } from "../../src/shared/mcp";
import { RecordStore } from "../../src/vault/record";
import type { Stamp } from "../../src/shared/record";
import type { SkillDurationClaim, SkillDurationPreview } from "../../src/shared/skill-years";
import { TAXONOMY_FIXTURE, TAXONOMY_FIXTURE_SQL } from "../support/taxonomy-fixture";
import { call, cookieFrom, eventually, fakeModels, signIn, waitForResume, type User } from "./support";

const settings = env as unknown as { TAILOR_CONCEPTS_ENABLED?: string; SKILL_YEARS_ENABLED?: string };
const original = settings.TAILOR_CONCEPTS_ENABLED;
const originalYears = settings.SKILL_YEARS_ENABLED;
const VERSION = TAXONOMY_FIXTURE.info.version;
const PYTHON = "onet:tool:python";
const TEXT = "Built Python services and trained the team";
const owner: Stamp = { proposedBy: "owner", model: null, method: "owner", taxonomyVersion: VERSION, confidence: null, shadow: false };
let active: Models;
beforeEach(async () => {
  settings.TAILOR_CONCEPTS_ENABLED = "true";
  for (const table of ["taxonomy_meta", "concepts", "labels", "relations"]) await env.TAXONOMY!.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  for (const statement of TAXONOMY_FIXTURE_SQL) await env.TAXONOMY!.prepare(statement).run();
  active = { ...fakeModels({ analysis: { company: "Example", title: "Engineer", requirements: ["Python services"] } }),
    judge: async (items) => ({ verdicts: items.map((item) => ({ id: item.alias, verdict: "supported" as const, reason: "" })) }) };
  setModels(() => active);
});
afterEach(() => { settings.TAILOR_CONCEPTS_ENABLED = original; settings.SKILL_YEARS_ENABLED = originalYears; setModels(null); });
function identity(user: User) {
  const token = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  return JSON.parse(new TextDecoder().decode(fromBase64url(token))) as { vid: string; uid: string; gen: number; epoch?: string };
}
const stub = (user: User) => vault(env, identity(user).vid);
async function person(part = false, shadow = false) {
  const user = await signIn();
  const role = await user.send("POST", "/api/roles", { kind: "job", org: "Example", title: "Engineer", startDate: "2020", endDate: null });
  const { roleId } = await role.json() as { roleId: string };
  const response = await user.send("POST", "/api/facts", { roleId, kind: "accomplishment", text: TEXT, level: "implemented" });
  expect(response.status, await response.clone().text()).toBe(201);
  const { factId } = await response.json() as { factId: string };
  const tag = await runInDurableObject(stub(user), (_instance, state) => {
    const record = new RecordStore(state.storage.sql, (fn) => state.storage.transactionSync(fn));
    const stamp = shadow ? { ...owner, proposedBy: "model" as const, model: "test", shadow: true } : owner;
    const split = part ? record.proposeSplit({ factId, line: TEXT, parts: [{ kind: "clause", ranges: [[0, "Built Python services".length]] }, { kind: "clause", ranges: [["Built Python services and ".length, TEXT.length]] }], stamp }) : null;
    const result = record.proposeTag({ subject: part ? { kind: "part", id: split!.partIds[0]! } : { kind: "fact", id: factId }, conceptId: PYTHON, conceptKind: "tool", label: "Python", stamp });
    if (split) {
      // Legacy/manual data can carry a tag on a mention. It must never become generation evidence.
      const mention = crypto.randomUUID();
      state.storage.sql.exec(`INSERT INTO fact_parts (id,split_id,position,kind,ranges,result_of) VALUES (?,?,2,'mention',?,NULL)`, mention, split.splitId, JSON.stringify([[TEXT.indexOf("Python"), TEXT.indexOf("Python") + 6]]));
      record.proposeTag({ subject: { kind: "part", id: mention }, conceptId: PYTHON, conceptKind: "tool", label: "Python", stamp });
    }
    return { ...result, splitId: split?.splitId };
  });
  const job = await user.send("POST", "/api/applications", { jdText: "Engineer role. Build Python services. You will develop applications, work closely with product teams, and maintain reliable services using Python." });
  expect(job.status, await job.clone().text()).toBe(201);
  const { applicationId } = await job.json() as { applicationId: string };
  return { user, factId, applicationId, ...tag };
}
async function duration(p: Awaited<ReturnType<typeof person>>) {
  settings.SKILL_YEARS_ENABLED = "true";
  const subject = { kind: "tag", id: p.tagId };
  async function mutate(path: string, body: unknown) {
    return p.user.fetch(path, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) });
  }
  const interval = await mutate("/api/v2/skill-years/intervals", { subject, start: "2020", end: "2024", ongoing: false, private: false });
  expect(interval.status, await interval.clone().text()).toBe(201);
  const { id } = await interval.json() as { id: string };
  const preview = await (await p.user.send("POST", "/api/v2/skill-years/preview", subject)).json() as SkillDurationPreview;
  const confirmed = await mutate("/api/v2/skill-years/claims", { subject, asOf: preview.asOf, inputHash: preview.inputHash });
  expect(confirmed.status, await confirmed.clone().text()).toBe(201);
  return { claim: await confirmed.json() as SkillDurationClaim, intervalId: id, mutate };
}
async function tailor(user: User, applicationId: string) {
  const response = await user.send("POST", `/api/applications/${applicationId}/resumes`);
  expect(response.status).toBe(202);
  const { resumeId } = await response.json() as { resumeId: string };
  return await waitForResume(user, resumeId) as ResumeView;
}
async function fit(user: User, applicationId: string) {
  const response = await user.fetch(`/api/applications/${applicationId}/documents`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ kind: "fit" }) });
  expect(response.status, await response.clone().text()).toBe(202);
  const { documentId } = await response.json() as { documentId: string };
  return eventually(async () => {
    const doc = await user.json<DocumentView>(`/api/documents/${documentId}`);
    return doc.state !== "running" ? doc : null;
  }, "concept fit preview", 60_000);
}

describe("concept tailoring in the actual Vault and generation Workflows", () => {
  it("closes a stale-tag run without a paused model callback", async () => {
    const p = await person();
    const base = active;
    let changed = false;
    active = { ...base, async complete(route, messages, schema, options) {
      if (route === "analyze" && !changed) {
        changed = true;
        await runInDurableObject(stub(p.user), (_instance, state) => new RecordStore(state.storage.sql, (fn) => state.storage.transactionSync(fn)).decideTag(p.tagId, "rejected"));
      }
      return base.complete(route, messages, schema, options);
    } };
    const response = await p.user.send("POST", `/api/applications/${p.applicationId}/resumes`);
    const { resumeId } = await response.json() as { resumeId: string };
    const done = await waitForResume(p.user, resumeId);
    expect(done.state).toBe("failed");
    const status = await p.user.json("/api/me");
    expect(status.quota.reserved ?? 0).toBe(0);
    expect(status.quota.used).toBe(0);
  });

  it("captures confirmed tags and publishes owner-only coverage while coach/MCP projections keep their shape", async () => {
    const { user, factId, applicationId } = await person();
    const resume = await tailor(user, applicationId);
    expect(resume.state, resume.error ?? "").toBe("ready");
    expect(resume.conceptCoverage?.coverage[0]).toMatchObject({ requirement: "Python services", status: "supported", factIds: [factId] });
    expect(resume.conceptCoverage?.taxonomyVersion).toBe(VERSION);
    const id = identity(user), who = { userId: id.uid, gen: id.gen, epoch: id.epoch };
    const granted = await stub(user).createMcpGrant(who, { id: crypto.randomUUID(), clientId: "concept-reader", clientName: "Reader", scopes: [...MCP_FIT_SCOPES], expiresAt: Date.now() + 60_000 });
    const claims: McpClaims = { uid: id.uid, vid: id.vid, gen: granted.gen, epoch: granted.epoch, grantId: granted.id, clientId: granted.clientId, scopes: granted.scopes, expiresAt: granted.expiresAt };
    await stub(user).bindMcpGrant(claims, `oauth-${granted.id}`);
    const read = await stub(user).mcpResume(claims, resume.id);
    expect(JSON.stringify(read)).not.toContain("conceptCoverage");
    expect(JSON.stringify(read)).not.toContain(PYTHON);
    const made = await user.send("POST", "/api/shares", { factIds: [], resumes: [{ id: resume.id, version: resume.version }] });
    expect(made.status, await made.clone().text()).toBe(201);
    const { grant, url } = await made.json() as { grant: { id: string }; url: string };
    const exchanged = await call("/share/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(url).hash.slice(1) }) });
    const copy = await call(`/share/snapshot?g=${grant.id}`, { cookie: cookieFrom(exchanged, `__Host-share-${grant.id}`)! });
    expect(copy.status).toBe(200);
    const copied = await copy.text();
    for (const value of ["conceptCoverage", PYTHON, VERSION, "concept-evidence/1"]) expect(copied).not.toContain(value);
  });

  it("uses confirmed part tags through their whole source fact in fit planning and keeps metadata out of connected-app fit answers", async () => {
    const { user, factId, applicationId, splitId } = await person(true);
    const doc = await fit(user, applicationId);
    expect(doc.state, doc.error ?? "").toBe("ready");
    expect(doc.conceptCoverage?.coverage[0]).toMatchObject({ status: "supported", factIds: [factId] });
    expect(doc.result?.fit?.requirements[0]?.factIds).toEqual([factId]);
    const saved = await runInDurableObject(stub(user), (_instance, state) => JSON.parse(state.storage.sql.exec<{ metadata: string }>(`SELECT metadata FROM generation_inputs WHERE run_id=?`, doc.id).one().metadata));
    expect(saved.conceptEvidence[0].part.splitId).toBe(splitId);
    expect(saved.conceptEvidence).toHaveLength(1);
    expect(saved.conceptEvidence[0].factText).toBe(TEXT);
    const id = identity(user), who = { userId: id.uid, gen: id.gen, epoch: id.epoch };
    const grant = await stub(user).createMcpGrant(who, { id: crypto.randomUUID(), clientId: "concept-fit-reader", clientName: "Reader", scopes: [...MCP_FIT_SCOPES], expiresAt: Date.now() + 60_000 });
    const claims: McpClaims = { uid: id.uid, vid: id.vid, gen: grant.gen, epoch: grant.epoch, grantId: grant.id, clientId: grant.clientId, scopes: grant.scopes, expiresAt: grant.expiresAt };
    await stub(user).bindMcpGrant(claims, `oauth-${grant.id}`);
    const answer = await stub(user).mcpFit(claims, applicationId, "read-current-fit");
    expect(answer.state).toBe("ready");
    expect(JSON.stringify(answer)).not.toContain("conceptCoverage");
    expect(JSON.stringify(answer)).not.toContain(PYTHON);
  });

  it("retains only explicitly selected duration text alongside private concept coverage without sending its receipt to models", async () => {
    const p = await person(), d = await duration(p), base = active, inputs: string[] = [];
    active = { ...base,
      async complete(route, messages, schema, options) { inputs.push(JSON.stringify(messages)); return base.complete(route, messages, schema, options); },
      async embed(texts, options) { inputs.push(JSON.stringify(texts)); return base.embed(texts, options); },
      async rerank(query, texts) { inputs.push(JSON.stringify([query, texts])); return base.rerank(query, texts); },
      async judge(items) { inputs.push(JSON.stringify(items)); return base.judge!(items); },
    };
    const started = await d.mutate(`/api/v2/applications/${p.applicationId}/resumes`, { skillDurationClaimIds: [d.claim.id] });
    expect(started.status, await started.clone().text()).toBe(202);
    const { resumeId } = await started.json() as { resumeId: string };
    const resume = await waitForResume(p.user, resumeId);
    expect(resume.state, resume.error ?? "").toBe("ready");
    expect(resume.body.skills).toContain(d.claim.text);
    expect(resume.conceptCoverage?.coverage[0]?.factIds).toEqual([p.factId]);
    const capture = await runInDurableObject(stub(p.user), (_instance, state) => ({
      metadata: JSON.parse(state.storage.sql.exec<{ metadata: string }>(`SELECT metadata FROM generation_inputs WHERE run_id=?`, resumeId).one().metadata),
      selection: JSON.parse(state.storage.sql.exec<{ selection: string }>(`SELECT selection FROM resumes WHERE id=?`, resumeId).one().selection),
    }));
    expect(capture.metadata.skillDurationClaimIds).toEqual([d.claim.id]);
    expect(capture.metadata.conceptEvidence).toHaveLength(1);
    expect(capture.selection.skillIds).toContain(d.claim.factId);
    expect(capture.selection.factIds).not.toContain(d.claim.factId);
    for (const value of [d.claim.text, d.claim.id, d.claim.inputHash, "skillDuration"]) expect(inputs.join("\n")).not.toContain(value);
    const plain = await tailor(p.user, p.applicationId);
    expect(plain.body?.skills).not.toContain(d.claim.text);
  });

  it("rejects a selected duration withdrawn during concept selection before another attempt or publication", async () => {
    const p = await person(), d = await duration(p), base = active;
    let changed = false, refusal: string | null = null;
    active = { ...base, async embed(texts, options) {
      if (options?.purpose === "query" && !changed) {
        changed = true;
        expect((await d.mutate(`/api/v2/skill-years/intervals/${d.intervalId}/withdraw`, { expectedRevision: 1 })).status).toBe(204);
        refusal = await runInDurableObject(stub(p.user), async (instance) => {
          try { await instance.reserveModelAttempt(resumeId, "select", { attemptId: crypto.randomUUID(), route: "judge", model: "@cf/cloudflare/clef", inputChars: 100, maxOutputTokens: 0 }, 1000, 1_000_000); return null; }
          catch (error) { return (error as Error).message; }
        });
      }
      return base.embed(texts, options);
    } };
    const started = await d.mutate(`/api/v2/applications/${p.applicationId}/resumes`, { skillDurationClaimIds: [d.claim.id] });
    const { resumeId } = await started.json() as { resumeId: string };
    expect((await waitForResume(p.user, resumeId)).state).toBe("failed");
    expect(changed).toBe(true);
    expect(refusal).toMatch(/facts changed/);
    const status = await p.user.json("/api/me");
    expect(status.quota.reserved ?? 0).toBe(0);
    expect(status.quota.used).toBe(0);
  });

  it("keeps requirements unknown in an owner fit preview when there is no confirmed evidence", async () => {
    const { user, factId, applicationId } = await person();
    expect((await user.send("POST", "/api/review", { confirm: [], reject: [factId], expectedRevisions: { [factId]: 1 } })).status).toBe(204);
    const doc = await fit(user, applicationId);
    expect(doc.state, doc.error ?? "").toBe("ready");
    expect(doc.conceptCoverage?.coverage[0]).toMatchObject({ requirement: "Python services", status: "unknown", factIds: [] });
    expect(doc.conceptCoverage?.requirements[0]?.text).toBe("Python services");
    expect(doc.result?.fit?.requirements[0]?.factIds).toEqual([]);
  });

  it("is inert by default and never promotes shadow tags into generation evidence", async () => {
    settings.TAILOR_CONCEPTS_ENABLED = undefined;
    const { user, applicationId } = await person();
    const resume = await tailor(user, applicationId);
    expect(resume.conceptCoverage).toBeUndefined();
    const saved = await runInDurableObject(stub(user), (_instance, state) => JSON.parse(state.storage.sql.exec<{ metadata: string }>(`SELECT metadata FROM generation_inputs WHERE run_id=?`, resume.id).one().metadata));
    expect(saved.conceptEvidence).toBeUndefined();
    settings.TAILOR_CONCEPTS_ENABLED = "true";
    const second = await person(false, true);
    const preview = await fit(second.user, second.applicationId);
    const captured = await runInDurableObject(stub(second.user), (_instance, state) => JSON.parse(state.storage.sql.exec<{ metadata: string }>(`SELECT metadata FROM generation_inputs WHERE run_id=?`, preview.id).one().metadata));
    expect(captured.conceptEvidence).toEqual([]);
  });

  it.each(["tag", "split", "source", "private"] as const)("refuses stale %s before another reservation and before a selection commits", async (change) => {
    const p = await person(change === "split");
    const base = active;
    let changed = false;
    let refusal: string | null = null;
    active = { ...base, async embed(texts, options) {
      if (options?.purpose === "query" && !changed) {
        changed = true;
        if (change === "private") expect((await p.user.send("POST", "/api/facts/sensitive", { ids: [p.factId], sensitive: true })).status).toBe(204);
        else await runInDurableObject(stub(p.user), (_instance, state) => {
          if (change === "source") state.storage.sql.exec(`UPDATE facts SET text='Changed Python services',revision=revision+1 WHERE id=?`, p.factId);
          else if (change === "split") new RecordStore(state.storage.sql, (fn) => state.storage.transactionSync(fn)).decideSplit(p.splitId!, "rejected");
          else new RecordStore(state.storage.sql, (fn) => state.storage.transactionSync(fn)).decideTag(p.tagId, "rejected");
        });
        // This is a new attempt after the edit, even though the already-started
        // synthetic embedding callback has not returned its result yet.
        refusal = await runInDurableObject(stub(p.user), async (instance) => {
          try { await instance.reserveModelAttempt(resumeId, "select", { attemptId: crypto.randomUUID(), route: "judge", model: "@cf/cloudflare/clef", inputChars: 100, maxOutputTokens: 0 }, 1000, 1_000_000); return null; }
          catch (error) { return (error as Error).message; }
        });
      }
      return base.embed(texts, options);
    } };
    const response = await p.user.send("POST", `/api/applications/${p.applicationId}/resumes`);
    const { resumeId } = await response.json() as { resumeId: string };
    const stopped = await waitForResume(p.user, resumeId);
    expect(changed).toBe(true);
    expect(refusal).toMatch(/facts changed/);
    expect(stopped.state).toBe("failed");
    const selection = await runInDurableObject(stub(p.user), (_instance, state) => state.storage.sql.exec<{ selection: string | null }>(`SELECT selection FROM resumes WHERE id=?`, resumeId).one().selection);
    expect(selection).toBeNull();
    const status = await p.user.json("/api/me");
    expect(status.quota.reserved ?? 0).toBe(0);
    expect(status.quota.used).toBe(0);
  });
});
