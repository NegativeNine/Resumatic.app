import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import type { FactView, ResumeView, RoleView } from "../../src/shared/api";
import { vault } from "../../src/shared/stubs";
import { fromBase64url } from "../../src/worker/crypto";
import { eventually, fakeModels, JOB_DESCRIPTION, RESUME, signIn, waitForResume, waitForSource, type User } from "./support";

beforeEach(() => setModels(() => fakeModels()));
afterEach(() => setModels(null));

async function readyResume() {
  const user = await signIn();
  const upload = await user.upload("synthetic.pdf", RESUME);
  const { sourceId } = await upload.json() as { sourceId: string };
  await waitForSource(user, sourceId);
  const { facts } = await user.json<{ facts: FactView[] }>("/api/facts");
  const { roles } = await user.json<{ roles: RoleView[] }>("/api/roles");
  await user.send("POST", "/api/review", { confirm: [...facts, ...roles].map((x) => x.id), reject: [] });
  const application = await user.send("POST", "/api/applications", { jdText: JOB_DESCRIPTION });
  const { applicationId } = await application.json() as { applicationId: string };
  const generation = await user.send("POST", `/api/applications/${applicationId}/resumes`);
  const { resumeId } = await generation.json() as { resumeId: string };
  const resume = await waitForResume(user, resumeId) as ResumeView;
  const lines = resume.body!.sections.flatMap((s) => s.lines);
  const line = lines.find((item) => item.factIds.length && item.factIds.every((id) =>
    lines.every((other) => other.id === item.id || !other.factIds.includes(id)) &&
      !(resume.body!.summary?.factIds ?? []).includes(id),
  ))!;
  expect(line).toBeDefined();
  return { user, applicationId, resumeId, resume, line };
}

async function begin(user: User, applicationId: string, resumeId: string, version: number, lineId: string, text: string) {
  const response = await user.send("POST", `/api/applications/${applicationId}/documents`, {
    kind: "refine", resumeId, expectedVersion: version, lineIds: [lineId], manualText: text,
  });
  expect(response.status, await response.clone().text()).toBe(202);
  return (await response.json() as { documentId: string }).documentId;
}
async function done(user: User, id: string) {
  return eventually(async () => {
    const document = await user.json<{ state: string; error: string | null }>(`/api/documents/${id}`);
    return document.state === "running" ? null : document;
  }, "manual edit");
}

/** Add an identical already-verified line sharing the target fact, as a historical fixture. */
async function sharedEvidenceFixture(
  user: User, resumeId: string, version: number, lineId: string,
  mode: "matching" | "changed" | "missing",
) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  const session = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { vid: string };
  await runInDurableObject(vault(env, session.vid), (_instance, state) => {
    const row = state.storage.sql.exec<{ data: string }>(
      "SELECT data FROM resume_versions WHERE resume_id=? AND version=?", resumeId, version,
    ).one();
    const saved = JSON.parse(row.data);
    const section = saved.render.body.sections.find((s: { lines: { id: string }[] }) => s.lines.some((l) => l.id === lineId));
    const original = section.lines.find((line: { id: string }) => line.id === lineId);
    section.lines.push({ ...original, id: "historical-duplicate", factIds: [...original.factIds] });
    if (mode === "missing") delete saved.evidence;
    if (mode === "changed") saved.evidence[original.factIds[0]].revision += 1;
    state.storage.sql.exec("UPDATE resume_versions SET data=? WHERE resume_id=? AND version=?", JSON.stringify(saved), resumeId, version);
    state.storage.sql.exec("UPDATE resumes SET body=? WHERE id=?", JSON.stringify(saved.render.body), resumeId);
  });
}

describe("verified manual resume editing", () => {
  it("allows a shared fact when its complete historical evidence matches", async () => {
    const { user, applicationId, resumeId, resume, line } = await readyResume();
    await sharedEvidenceFixture(user, resumeId, resume.version, line.id, "matching");
    const id = await begin(user, applicationId, resumeId, resume.version, line.id, `${line.text}.`);
    expect(await done(user, id)).toMatchObject({ state: "ready" });
    const result = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    expect(result.version).toBe(resume.version + 1);
    const lines = result.body!.sections.flatMap((section) => section.lines);
    expect(lines.find((item) => item.id === line.id)).toMatchObject({ text: `${line.text}.`, factIds: line.factIds });
    expect(lines.find((item) => item.id === "historical-duplicate")).toMatchObject({ text: line.text, factIds: line.factIds });
    expect((await user.fetch(`/api/resumes/${resumeId}/preview`)).status).toBe(200);
    const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
    const session = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { vid: string };
    await runInDurableObject(vault(env, session.vid), (_instance, state) => {
      const rows = state.storage.sql.exec<{ version: number; data: string }>(
        "SELECT version,data FROM resume_versions WHERE resume_id=? ORDER BY version", resumeId,
      ).toArray();
      const original = JSON.parse(rows.find((row) => row.version === resume.version)!.data);
      const next = JSON.parse(rows.find((row) => row.version === result.version)!.data);
      expect(next.evidence[line.factIds[0]!]).toEqual(original.evidence[line.factIds[0]!]);
    });
  });

  it.each(["changed", "missing"] as const)("rejects shared evidence when historical metadata is %s", async (mode) => {
    const { user, applicationId, resumeId, resume, line } = await readyResume();
    await sharedEvidenceFixture(user, resumeId, resume.version, line.id, mode);
    const id = await begin(user, applicationId, resumeId, resume.version, line.id, `${line.text}.`);
    expect(await done(user, id)).toMatchObject({ state: "failed", error: "conflict" });
    expect((await user.json<ResumeView>(`/api/resumes/${resumeId}`)).version).toBe(resume.version);
  });

  it("leaves the original version unchanged when the independent judge rejects the exact edit", async () => {
    const { user, applicationId, resumeId, resume, line } = await readyResume();
    const text = line.text.endsWith(".") ? line.text.slice(0, -1) : `${line.text}.`;
    setModels(() => fakeModels({ judgeRejects: [text] }));
    const id = await begin(user, applicationId, resumeId, resume.version, line.id, text);
    expect(await done(user, id)).toMatchObject({ state: "failed", error: "invalid" });
    expect((await user.json<ResumeView>(`/api/resumes/${resumeId}`)).body).toEqual(resume.body);
    expect((await user.json<ResumeView>(`/api/resumes/${resumeId}`)).version).toBe(resume.version);
  });

  it("does not overwrite a newer version while the judge is in flight", async () => {
    const { user, applicationId, resumeId, resume, line } = await readyResume();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    const model = fakeModels();
    setModels(() => ({
      ...model,
      async complete(route, messages, schema, options) {
        if (route === "judge") { entered = true; await hold; }
        return model.complete(route, messages, schema, options);
      },
    }));
    try {
      const id = await begin(user, applicationId, resumeId, resume.version, line.id, `${line.text}.`);
      await eventually(async () => entered || null, "judge to start");
      const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
      const session = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { vid: string };
      await runInDurableObject(vault(env, session.vid), (_instance, state) => {
        state.storage.sql.exec("UPDATE resumes SET version=version+1 WHERE id=?", resumeId);
      });
      release();
      expect(await done(user, id)).toMatchObject({ state: "failed", error: "conflict" });
      const version = await runInDurableObject(vault(env, session.vid), (_instance, state) =>
        state.storage.sql.exec<{ version: number }>("SELECT version FROM resumes WHERE id=?", resumeId).one().version,
      );
      expect(version).toBe(resume.version + 1);
    } finally { release(); }
  });

  it("rejects an edit when its cited fact changes while the judge is in flight", async () => {
    const { user, applicationId, resumeId, resume, line } = await readyResume();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    const model = fakeModels();
    setModels(() => ({
      ...model,
      async complete(route, messages, schema, options) {
        if (route === "judge") { entered = true; await hold; }
        return model.complete(route, messages, schema, options);
      },
    }));
    try {
      const id = await begin(user, applicationId, resumeId, resume.version, line.id, `${line.text}.`);
      await eventually(async () => entered || null, "judge to start");
      const changed = await user.send("PATCH", `/api/facts/${line.factIds[0]}`, { text: "A corrected claim" });
      expect(changed.status).toBe(204);
      release();
      expect(await done(user, id)).toMatchObject({ state: "failed", error: "conflict" });
      expect((await user.json<ResumeView>(`/api/resumes/${resumeId}`)).version).toBe(resume.version);
    } finally { release(); }
  });
});
