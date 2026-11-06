import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { z } from "zod";
import type { ChatMessage } from "../../src/ai/llm";
import { setModels, type Models, type Route } from "../../src/ai/models";
import type { ResumeView } from "../../src/shared/api";
import { vault } from "../../src/shared/stubs";
import { fromBase64url } from "../../src/worker/crypto";
import { eventually, fakeModels, JOB_DESCRIPTION, RESUME, signIn, waitForResume, waitForSource, type User } from "./support";

const FIRST = "Led the migration of 40 services to Kubernetes, cutting deploy time by 60%";
const SECOND = "Built a Go service that processes 2 million events per day";

function model(shared = false): Models {
  const base = fakeModels(shared ? { summary: { text: FIRST, cites: [FIRST] } } : {});
  return { ...base, async complete<T>(route: Route, messages: ChatMessage[], schema: z.ZodType<T>, options?: { model?: string }): Promise<T> {
    const user = messages.filter((item) => item.role === "user").at(-1)?.content ?? "";
    if (route === "write" && user.startsWith("{")) {
      const parsed = JSON.parse(user) as { lines?: { lineId: string }[] };
      if (parsed.lines) return schema.parse({ edits: parsed.lines.map(({ lineId }) => ({ lineId, text: "Led the migration of 40 services to Kubernetes" })) });
    }
    return base.complete(route, messages, schema, options);
  } };
}
beforeEach(() => setModels(() => model()));
afterEach(() => setModels(null));

async function prepared(shared: boolean) {
  setModels(() => model());
  const user = await signIn();
  const upload = await user.upload("resume.pdf", RESUME);
  const { sourceId } = await upload.json() as { sourceId: string };
  await waitForSource(user, sourceId);
  const { facts } = await user.json<{ facts: { id: string; text: string }[] }>("/api/facts");
  const { roles } = await user.json<{ roles: { id: string }[] }>("/api/roles");
  await user.send("POST", "/api/review", { confirm: [...facts, ...roles].map((item) => item.id), reject: [] });
  const application = await user.send("POST", "/api/applications", { jdText: JOB_DESCRIPTION });
  const { applicationId } = await application.json() as { applicationId: string };
  const started = await user.send("POST", `/api/applications/${applicationId}/resumes`);
  const { resumeId } = await started.json() as { resumeId: string };
  let resume = await waitForResume(user, resumeId) as ResumeView;
  const line = resume.body!.sections.flatMap((s) => s.lines).find((item) => item.text === FIRST)!;
  expect(line).toBeDefined();
  if (shared) {
    // Simulate a previously verified summary and role line sharing one fact.
    // Real generation may deduplicate identical wording before storage.
    const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
    const session = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { vid: string };
    await runInDurableObject(vault(env, session.vid), (_instance, state) => {
      const row = state.storage.sql.exec<{ data: string }>(`SELECT data FROM resume_versions WHERE resume_id=? AND version=?`, resumeId, resume.version).one();
      const saved = JSON.parse(row.data);
      saved.render.body.summary = { ...line, id: "shared-summary" };
      state.storage.sql.exec(`UPDATE resume_versions SET data=? WHERE resume_id=? AND version=?`, JSON.stringify(saved), resumeId, resume.version);
      state.storage.sql.exec(`UPDATE resumes SET body=? WHERE id=?`, JSON.stringify(saved.render.body), resumeId);
    });
    resume = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
  }
  return { user, applicationId, resumeId, resume, line, facts };
}

async function refine(user: User, applicationId: string, resumeId: string, version: number, lineId: string) {
  const start = await user.send("POST", `/api/applications/${applicationId}/documents`, { kind: "refine", resumeId, expectedVersion: version, lineIds: [lineId], instruction: "Shorter" });
  expect(start.status, await start.clone().text()).toBe(202);
  const { documentId } = await start.json() as { documentId: string };
  return eventually(async () => {
    const document = await user.json<{ state: string; error: string | null }>(`/api/documents/${documentId}`);
    return document.state === "running" ? null : document;
  }, "refinement");
}

describe("refinement preserves prior evidence", () => {
  it("does not replace an unchanged line's saved evidence when its fact changed before refinement", async () => {
    const { user, applicationId, resumeId, resume, line, facts } = await prepared(false);
    const unchanged = facts.find((item) => item.text === SECOND)!;
    expect(unchanged).toBeDefined();
    expect((await user.send("PATCH", `/api/facts/${unchanged.id}`, { text: "Built a Go service processing events" })).status).toBe(204);
    expect(await refine(user, applicationId, resumeId, resume.version, line.id)).toMatchObject({ state: "ready" });
    const after = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    expect(after.facts[unchanged.id]?.text).toBe(SECOND);
    expect(after.body!.sections.flatMap((s) => s.lines).find((item) => item.factIds.includes(unchanged.id))?.text).toBe(SECOND);
  });
  it("refuses to rebind a fact shared by an unchanged line after its metadata changed", async () => {
    const { user, applicationId, resumeId, resume, line } = await prepared(true);
    expect(resume.body!.summary?.factIds).toContain(line.factIds[0]);
    expect((await user.send("PATCH", `/api/facts/${line.factIds[0]}`, { text: "Led the migration of 40 services to Kubernetes" })).status).toBe(204);
    expect(await refine(user, applicationId, resumeId, resume.version, line.id)).toMatchObject({ state: "failed", error: "conflict" });
    expect((await user.json<ResumeView>(`/api/resumes/${resumeId}`)).version).toBe(resume.version);
  });
  it("refuses to place a newly verified line under an outdated role header", async () => {
    const { user, applicationId, resumeId, resume, line } = await prepared(false);
    const roleId = resume.body!.sections.find((section) => section.lines.some((item) => item.id === line.id))!.roleId;
    expect((await user.send("PATCH", `/api/roles/${roleId}`, { org: "Different Employer" })).status).toBe(204);
    expect(await refine(user, applicationId, resumeId, resume.version, line.id)).toMatchObject({ state: "failed", error: "conflict" });
    expect((await user.json<ResumeView>(`/api/resumes/${resumeId}`)).version).toBe(resume.version);
  });
});
