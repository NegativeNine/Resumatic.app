import { introspectWorkflowInstance, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import type { ResumeView } from "../../src/shared/api";
import { vault } from "../../src/shared/stubs";
import { fromBase64url } from "../../src/worker/crypto";
import { call, cookieFrom, eventually, fakeModels, JOB_DESCRIPTION, RESUME, signIn, waitForResume, waitForSource, type User } from "./support";

beforeEach(() => setModels(() => fakeModels()));
afterEach(() => setModels(null));

async function fixture(mode: "legacy" | "blockedSnapshot" | "verifiedSnapshot" = "legacy") {
  const user = await signIn();
  const upload = await user.upload("synthetic.pdf", RESUME);
  const { sourceId } = await upload.json() as { sourceId: string };
  await waitForSource(user, sourceId);
  const { facts } = await user.json("/api/facts");
  const { roles } = await user.json("/api/roles");
  await user.send("POST", "/api/review", { confirm: [...facts, ...roles].map((item: { id: string }) => item.id), reject: [] });
  const application = await user.send("POST", "/api/applications", { jdText: JOB_DESCRIPTION });
  const { applicationId } = await application.json() as { applicationId: string };
  const started = await user.send("POST", `/api/applications/${applicationId}/resumes`);
  const { resumeId } = await started.json() as { resumeId: string };
  const generated = await waitForResume(user, resumeId) as ResumeView;
  const priorShare = await user.send("POST", "/api/shares", { factIds: [], resumes: [{ id: resumeId, version: generated.version }] });
  expect(priorShare.status, await priorShare.clone().text()).toBe(201);
  const { grant, url } = await priorShare.json() as { grant: { id: string }; url: string };
  const exchange = await call("/share/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(url).hash.slice(1) }) });
  const shareCookie = cookieFrom(exchange, "__Host-share")!;
  const original = generated.body!.sections.flatMap((section) => section.lines).find((line) => line.factIds.length)!;
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  const session = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { vid: string };
  const stub = vault(env, session.vid);
  await runInDurableObject(stub, (_instance, state) => {
    const row = state.storage.sql.exec<{ data: string }>("SELECT data FROM resume_versions WHERE resume_id=? AND version=?", resumeId, generated.version).one();
    const saved = JSON.parse(row.data);
    const section = saved.render.body.sections.find((item: { lines: { id: string }[] }) => item.lines.some((line) => line.id === original.id));
    section.lines = [
      mode === "blockedSnapshot" ? { ...original, text: `${original.text} 987654321` } : original,
      { ...original, id: "legacy-duplicate", factIds: [...original.factIds] },
    ];
    saved.render.body.summary = null;
    saved.render.body.sections = [section];
    saved.render.body.skills = [];
    saved.provenance = mode === "legacy" ? "legacy" : "snapshot";
    if (mode === "legacy") delete saved.evidence;
    delete saved.legacyReceipts;
    state.storage.sql.exec("UPDATE resume_versions SET data=? WHERE resume_id=? AND version=?", JSON.stringify(saved), resumeId, generated.version);
    state.storage.sql.exec("UPDATE resumes SET body=? WHERE id=?", JSON.stringify(saved.render.body), resumeId);
  });
  return { user, applicationId, resumeId, original, version: generated.version, stub, oldGrantId: grant.id, shareCookie };
}

async function checkLine(user: User, applicationId: string, resumeId: string, version: number, lineId: string, text: string, factIds: string[]) {
  const response = await user.send("POST", `/api/applications/${applicationId}/documents`, {
    kind: "refine", resumeId, expectedVersion: version, lineIds: [lineId], manualText: text, manualFactIds: factIds,
  });
  expect(response.status, await response.clone().text()).toBe(202);
  const { documentId } = await response.json() as { documentId: string };
  const doc = await eventually(async () => {
    const doc = await user.json<{ state: string; error: string | null }>(`/api/documents/${documentId}`);
    return doc.state === "running" ? null : doc;
  }, "legacy check");
  return { ...doc, documentId };
}

describe("legacy resume remediation", () => {
  it("removes a line from a checked resume while preserving printable history", async () => {
    const { user, resumeId, original, version } = await fixture("verifiedSnapshot");
    const before = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    const path = `/api/resumes/${resumeId}/remove-line`;
    const input = { lineId: original.id, expectedVersion: version };
    const share = await user.send("POST", "/api/shares", { factIds: [], resumes: [{ id: resumeId, version }] });
    expect(share.status).toBe(201);
    const { url } = await share.json() as { url: string };
    const exchange = await call("/share/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(url).hash.slice(1) }) });
    const shareCookie = cookieFrom(exchange, "__Host-share")!;
    const sharedBefore = await (await call("/share/snapshot", { cookie: shareCookie })).json();
    const stranger = await signIn();
    expect((await stranger.send("POST", path, input)).status).toBe(404);
    expect(await (await user.send("POST", path, input)).json()).toEqual({ version: version + 1 });
    expect(await (await user.send("POST", path, input)).json()).toEqual({ version: version + 1 });
    expect((await user.send("POST", path, { lineId: "legacy-duplicate", expectedVersion: version })).status).toBe(409);
    const after = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    expect(after.provenance).toBe("snapshot");
    expect(after.needsGroundingReview).toBeUndefined();
    expect(after.body!.sections.flatMap((section) => section.lines).map((line) => line.id)).toEqual(["legacy-duplicate"]);
    expect(after.report?.kept).toBe(1);
    expect((await user.fetch(`/api/resumes/${resumeId}/preview`)).status).toBe(200);
    expect((await user.json<ResumeView>(`/api/resumes/${resumeId}?version=${version}`)).body).toEqual(before.body);
    expect((await user.fetch(`/api/resumes/${resumeId}/preview?version=${version}`)).status).toBe(200);
    const sharedAfter = await call("/share/snapshot", { cookie: shareCookie });
    expect(sharedAfter.status).toBe(200);
    expect(await sharedAfter.json()).toEqual(sharedBefore);
  }, 30_000);

  it("serializes concurrent checked-line removals and blocks during generation", async () => {
    const { user, resumeId, original, version, stub } = await fixture("verifiedSnapshot");
    const path = `/api/resumes/${resumeId}/remove-line`;
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO runs (id,kind,target_id,request_key,input_digest,state,steps,credit_state,created_at,updated_at)
        VALUES ('pending-refine','refine',?,'pending-refine','digest','running','[]','none',1,1)`, resumeId);
    });
    expect((await user.send("POST", path, { lineId: original.id, expectedVersion: version })).status).toBe(409);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE runs SET state='failed' WHERE id='pending-refine'`);
    });
    const requests = [original.id, "legacy-duplicate"].map((lineId) => ({ lineId, expectedVersion: version }));
    const results = await Promise.all(requests.map((body) => user.send("POST", path, body)));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results.findIndex((result) => result.status === 200);
    expect((await user.send("POST", path, requests[winner]!)).status).toBe(200);
    const current = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    expect(current.version).toBe(version + 1);
    expect(current.body!.sections.flatMap((section) => section.lines)).toHaveLength(1);
  }, 30_000);

  it("does not use line removal to promote a blocked or legacy resume", async () => {
    for (const mode of ["blockedSnapshot", "legacy"] as const) {
      const { user, resumeId, original, version } = await fixture(mode);
      expect((await user.send("POST", `/api/resumes/${resumeId}/remove-line`, { lineId: original.id, expectedVersion: version })).status).toBe(409);
      expect((await user.json<ResumeView>(`/api/resumes/${resumeId}`)).version).toBe(version);
    }
  }, 30_000);

  it("removes an unwanted review line without losing other checks or changing shared history", async () => {
    const { user, applicationId, resumeId, original, version, oldGrantId, shareCookie } = await fixture("blockedSnapshot");
    const before = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    const beforeGrant = (await user.json<{ shares: { id: string; snapshot: unknown }[] }>("/api/export")).shares.find((item) => item.id === oldGrantId);
    expect((await user.send("POST", `/api/resumes/${resumeId}/grounding-review`, { expectedVersion: version })).status).toBe(200);
    expect((await checkLine(user, applicationId, resumeId, version + 1, "legacy-duplicate", original.text, original.factIds)).state).toBe("ready");
    const checked = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    expect(checked.legacyReview?.verifiedLineIds).toEqual(["legacy-duplicate"]);
    const path = `/api/resumes/${resumeId}/legacy-remove-line`;
    const input = { expectedVersion: checked.version, lineId: original.id };
    const stranger = await signIn();
    expect((await stranger.send("POST", path, input)).status).toBe(404);
    const removed = await user.send("POST", path, input);
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await removed.json()).toEqual({ version: checked.version + 1 });
    expect(await (await user.send("POST", path, input)).json()).toEqual({ version: checked.version + 1 });
    expect((await user.send("POST", path, { ...input, lineId: "legacy-duplicate" })).status).toBe(409);
    const reviewed = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    expect(reviewed.legacyReview).toMatchObject({ verifiedLineIds: ["legacy-duplicate"], totalLines: 1 });
    expect(reviewed.body!.sections.flatMap((s) => s.lines).map((line) => line.id)).toEqual(["legacy-duplicate"]);
    expect((await user.send("POST", `/api/resumes/${resumeId}/legacy-finalize`, { expectedVersion: reviewed.version })).status).toBe(200);
    expect((await user.fetch(`/api/resumes/${resumeId}/preview`)).status).toBe(200);
    expect((await user.send("POST", path, { lineId: "legacy-duplicate", expectedVersion: reviewed.version + 1 })).status).toBe(409);
    expect((await user.json<ResumeView>(`/api/resumes/${resumeId}?version=${version}`)).body).toEqual(before.body);
    expect((await call("/share/snapshot", { cookie: shareCookie })).status).toBe(410);
    const afterGrant = (await user.json<{ shares: { id: string; snapshot: unknown }[] }>("/api/export")).shares.find((item) => item.id === oldGrantId);
    expect(afterGrant?.snapshot).toEqual(beforeGrant?.snapshot);
  }, 30_000);

  it("does not finalize an empty review after every line is removed", async () => {
    const { user, resumeId, original, version } = await fixture("legacy");
    const path = `/api/resumes/${resumeId}/legacy-remove-line`;
    expect((await user.send("POST", path, { lineId: original.id, expectedVersion: version })).status).toBe(200);
    expect((await user.send("POST", path, { lineId: "legacy-duplicate", expectedVersion: version + 1 })).status).toBe(200);
    const empty = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    expect(empty.legacyReview?.totalLines).toBe(0);
    expect((await user.send("POST", `/api/resumes/${resumeId}/legacy-finalize`, { expectedVersion: empty.version })).status).toBe(409);
    expect((await user.fetch(`/api/resumes/${resumeId}/preview`)).status).toBe(409);
    expect((await user.send("POST", path, { lineId: "legacy-duplicate", expectedVersion: version + 1 })).status).toBe(200);
  }, 30_000);

  it("drops a removed line's receipt while preserving receipts for the remaining lines", async () => {
    const { user, applicationId, resumeId, original, version, stub } = await fixture("legacy");
    expect((await checkLine(user, applicationId, resumeId, version, original.id, original.text, original.factIds)).state).toBe("ready");
    expect((await checkLine(user, applicationId, resumeId, version + 1, "legacy-duplicate", original.text, original.factIds)).state).toBe("ready");
    const checkedVersion = version + 2;
    expect((await user.send("POST", `/api/resumes/${resumeId}/legacy-remove-line`, { lineId: original.id, expectedVersion: checkedVersion })).status).toBe(200);
    const after = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    expect(after.legacyReview?.verifiedLineIds).toEqual(["legacy-duplicate"]);
    await runInDurableObject(stub, (_instance, state) => {
      const read = (v: number) => JSON.parse(state.storage.sql.exec<{ data: string }>("SELECT data FROM resume_versions WHERE resume_id=? AND version=?", resumeId, v).one().data);
      expect(Object.keys(read(checkedVersion).legacyReceipts).sort()).toEqual([original.id, "legacy-duplicate"].sort());
      expect(Object.keys(read(after.version).legacyReceipts)).toEqual(["legacy-duplicate"]);
    });
    expect((await user.send("POST", `/api/resumes/${resumeId}/legacy-finalize`, { expectedVersion: after.version })).status).toBe(200);
  }, 30_000);

  it("serializes simultaneous removals from the same review version", async () => {
    const { user, resumeId, original, version } = await fixture("legacy");
    const path = `/api/resumes/${resumeId}/legacy-remove-line`;
    const requests = [original.id, "legacy-duplicate"].map((lineId) => ({ lineId, expectedVersion: version }));
    const results = await Promise.all(requests.map((body) => user.send("POST", path, body)));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results.findIndex((result) => result.status === 200);
    const after = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    expect(after.version).toBe(version + 1);
    expect(after.body!.sections.flatMap((section) => section.lines)).toHaveLength(1);
    expect((await user.send("POST", path, requests[winner])).status).toBe(200);
    expect((await user.send("POST", path, requests[1 - winner])).status).toBe(409);
  }, 30_000);

  it("requires a blocked current snapshot and an owner before starting review", async () => {
    const { user, resumeId, version } = await fixture("verifiedSnapshot");
    expect((await user.fetch(`/api/resumes/${resumeId}/preview`)).status).toBe(200);
    expect((await user.send("POST", `/api/resumes/${resumeId}/grounding-review`, { expectedVersion: version })).status).toBe(409);
    const stranger = await signIn();
    expect((await stranger.send("POST", `/api/resumes/${resumeId}/grounding-review`, { expectedVersion: version })).status).toBe(404);
    expect((await user.json<ResumeView>(`/api/resumes/${resumeId}`)).version).toBe(version);
  }, 30_000);

  it("reviews a blocked snapshot as a new current version without changing the original or its shares", async () => {
    const { user, applicationId, resumeId, original, version, oldGrantId, shareCookie } = await fixture("blockedSnapshot");
    const before = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    expect(before.needsGroundingReview).toBe(true);
    expect((await user.fetch(`/api/resumes/${resumeId}/preview`)).status).toBe(409);
    const beforeGrant = (await user.json<{ shares: { id: string; snapshot: unknown }[] }>("/api/export")).shares.find((item) => item.id === oldGrantId);
    const start = await user.send("POST", `/api/resumes/${resumeId}/grounding-review`, { expectedVersion: version });
    expect(start.status, await start.clone().text()).toBe(200);
    expect(await start.json()).toEqual({ version: version + 1 });
    expect(await (await user.send("POST", `/api/resumes/${resumeId}/grounding-review`, { expectedVersion: version })).json()).toEqual({ version: version + 1 });
    const review = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    expect(review.provenance).toBe("legacy");
    expect(review.legacyReview).toMatchObject({ verifiedLineIds: [], totalLines: 2 });
    expect((await user.fetch(`/api/resumes/${resumeId}/preview`)).status).toBe(409);
    expect((await user.send("POST", `/api/resumes/${resumeId}/legacy-finalize`, { expectedVersion: review.version })).status).toBe(409);
    expect((await checkLine(user, applicationId, resumeId, review.version, original.id, original.text, original.factIds)).state).toBe("ready");
    const first = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    expect((await user.send("POST", `/api/resumes/${resumeId}/grounding-review`, { expectedVersion: version })).status).toBe(409);
    expect(first.legacyReview?.verifiedLineIds).toEqual([original.id]);
    expect((await checkLine(user, applicationId, resumeId, first.version, "legacy-duplicate", original.text, original.factIds)).state).toBe("ready");
    const second = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    const finalized = await user.send("POST", `/api/resumes/${resumeId}/legacy-finalize`, { expectedVersion: second.version });
    expect(finalized.status, await finalized.clone().text()).toBe(200);
    expect((await user.fetch(`/api/resumes/${resumeId}/preview`)).status).toBe(200);
    const saved = await user.json<ResumeView>(`/api/resumes/${resumeId}?version=${version}`);
    expect(saved.body).toEqual(before.body);
    expect(saved.needsGroundingReview).toBe(true);
    expect((await user.fetch(`/api/resumes/${resumeId}/preview?version=${version}`)).status).toBe(409);
    expect((await call("/share/snapshot", { cookie: shareCookie })).status).toBe(410);
    const afterGrant = (await user.json<{ shares: { id: string; snapshot: unknown }[] }>("/api/export")).shares.find((item) => item.id === oldGrantId);
    expect(afterGrant?.snapshot).toEqual(beforeGrant?.snapshot);
  }, 30_000);

  it("does not give a review receipt to an unsupported line", async () => {
    const { user, applicationId, resumeId, original, version } = await fixture("blockedSnapshot");
    expect((await user.send("POST", `/api/resumes/${resumeId}/grounding-review`, { expectedVersion: version })).status).toBe(200);
    const result = await checkLine(user, applicationId, resumeId, version + 1, original.id, `${original.text} 987654321`, original.factIds);
    expect(result.state).toBe("failed");
    const review = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    expect(review.version).toBe(version + 1);
    expect(review.legacyReview?.verifiedLineIds).toEqual([]);
    expect((await user.send("POST", `/api/resumes/${resumeId}/legacy-finalize`, { expectedVersion: review.version })).status).toBe(409);
    expect((await user.fetch(`/api/resumes/${resumeId}/preview`)).status).toBe(409);
  }, 30_000);

  it("requires fresh checks for unchanged shared lines and finalizes without rewriting history", async () => {
    const { user, applicationId, resumeId, original, version, oldGrantId, shareCookie } = await fixture();
    const before = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    expect(before.legacyReview).toMatchObject({ verifiedLineIds: [], totalLines: 2, headersReady: true, skillsReady: true });
    expect((await user.fetch(`/api/resumes/${resumeId}/preview`)).status).toBe(409);
    expect((await call("/share/snapshot", { cookie: shareCookie })).status).toBe(410);
    const beforeGrant = (await user.json<{ shares: { id: string; snapshot: unknown }[] }>("/api/export")).shares.find((item) => item.id === oldGrantId);
    expect((await user.send("POST", `/api/resumes/${resumeId}/legacy-finalize`, { expectedVersion: version })).status).toBe(409);
    const firstCheck = await checkLine(user, applicationId, resumeId, version, original.id, original.text, original.factIds);
    expect(firstCheck.state).toBe("ready");
    const workflow = await introspectWorkflowInstance(env.DOCUMENTS, firstCheck.documentId);
    try {
      const outputs = await Promise.all(["plan", "write", "verify", "finish"].map((name) => workflow.waitForStepResult({ name })));
      expect(JSON.stringify(outputs)).not.toContain(original.text);
      expect(outputs).toEqual([expect.objectContaining({ facts: expect.any(Number), questions: expect.any(Number) }), { units: 1 }, { units: expect.any(Number), dropped: expect.any(Number) }, { units: expect.any(Number), questions: expect.any(Number) }]);
    } finally { await workflow.dispose(); }
    const first = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    expect(first.version).toBe(version + 1);
    expect(first.legacyReview?.verifiedLineIds).toEqual([original.id]);
    expect(first.facts[original.factIds[0]!]?.text).toBeTruthy();
    expect((await user.fetch(`/api/resumes/${resumeId}/preview`)).status).toBe(409);
    expect((await checkLine(user, applicationId, resumeId, first.version, "legacy-duplicate", original.text, original.factIds)).state).toBe("ready");
    const second = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    expect(second.legacyReview?.verifiedLineIds).toEqual([original.id, "legacy-duplicate"]);
    const stranger = await signIn();
    expect((await stranger.send("POST", `/api/resumes/${resumeId}/legacy-finalize`, { expectedVersion: second.version })).status).toBe(404);
    const finalized = await user.send("POST", `/api/resumes/${resumeId}/legacy-finalize`, { expectedVersion: second.version });
    expect(finalized.status, await finalized.clone().text()).toBe(200);
    expect(await finalized.json()).toEqual({ version: second.version + 1 });
    expect(await (await user.send("POST", `/api/resumes/${resumeId}/legacy-finalize`, { expectedVersion: second.version })).json()).toEqual({ version: second.version + 1 });
    expect((await user.fetch(`/api/resumes/${resumeId}/preview`)).status).toBe(200);
    expect((await user.fetch(`/api/resumes/${resumeId}/preview?version=${version}`)).status).toBe(409);
    expect((await user.json<ResumeView>(`/api/resumes/${resumeId}?version=${version}`)).provenance).toBe("legacy");
    expect((await call("/share/snapshot", { cookie: shareCookie })).status).toBe(410);
    const afterGrant = (await user.json<{ shares: { id: string; snapshot: unknown }[] }>("/api/export")).shares.find((item) => item.id === oldGrantId);
    expect(afterGrant?.snapshot).toEqual(beforeGrant?.snapshot);
    const newShare = await user.send("POST", "/api/shares", { factIds: [], resumes: [{ id: resumeId, version: second.version + 1 }] });
    expect(newShare.status, await newShare.clone().text()).toBe(201);
  }, 30_000);

  it("drops stale receipt progress and refuses finalization after fact or header changes", async () => {
    const { user, applicationId, resumeId, original, version, stub } = await fixture();
    expect((await checkLine(user, applicationId, resumeId, version, original.id, original.text, original.factIds)).state).toBe("ready");
    const first = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE facts SET revision=revision+1 WHERE id=?", original.factIds[0]);
      state.storage.sql.exec("UPDATE roles SET org='Changed role' WHERE id=?", first.body!.sections[0]!.roleId);
    });
    const stale = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    expect(stale.legacyReview?.verifiedLineIds).toEqual([]);
    expect(stale.legacyReview?.headersReady).toBe(false);
    expect((await user.send("POST", `/api/resumes/${resumeId}/legacy-finalize`, { expectedVersion: first.version })).status).toBe(409);
  }, 30_000);
});
