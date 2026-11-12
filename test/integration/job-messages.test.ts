import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import type { ResumeView } from "../../src/shared/api";
import { vault } from "../../src/shared/stubs";
import { fromBase64url } from "../../src/worker/crypto";
import { fakeModels, JOB_DESCRIPTION, RESUME, signIn, waitForResume, waitForSource, type User } from "./support";

// What the Jobs room is told when the Vault refuses a request about a job, its resumes or its
// documents. Each is a fixed sentence in the interface's words, with straight apostrophes the web
// app curls. Every check, its order and its transaction are as they were: only the words changed.

beforeEach(() => setModels(() => fakeModels()));
afterEach(() => setModels(null));

const NOT_FOUND = { error: "not_found", message: "This job can't be found. It may have been deleted." };

function sessionOf(user: User) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  return JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { uid: string; vid: string; gen: number; epoch?: string };
}
const vaultOf = (user: User) => vault(env, sessionOf(user).vid);
const whoOf = (user: User) => ({ userId: sessionOf(user).uid, gen: sessionOf(user).gen, epoch: sessionOf(user).epoch });

async function saved(user: User): Promise<string> {
  const response = await user.fetch("/api/v2/applications", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ jdText: JOB_DESCRIPTION }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { applicationId: string }).applicationId;
}

/** A job with a resume tailored from confirmed facts, every line checked. */
async function tailored(): Promise<{ user: User; applicationId: string; resume: ResumeView }> {
  const user = await signIn();
  const upload = await user.upload("synthetic.pdf", RESUME);
  const { sourceId } = (await upload.json()) as { sourceId: string };
  await waitForSource(user, sourceId);
  const { facts } = await user.json<{ facts: { id: string }[] }>("/api/facts");
  const { roles } = await user.json<{ roles: { id: string }[] }>("/api/roles");
  await user.send("POST", "/api/review", { confirm: [...facts, ...roles].map((item) => item.id), reject: [] });
  const applicationId = await saved(user);
  const started = await user.send("POST", `/api/applications/${applicationId}/resumes`);
  const { resumeId } = (await started.json()) as { resumeId: string };
  const resume = (await waitForResume(user, resumeId)) as ResumeView;
  expect(resume.state).toBe("ready");
  return { user, applicationId, resume };
}

const refusal = async (response: Response) => [response.status, await response.json()];

describe("what the Jobs room is told", () => {
  it("says a job that isn't there can't be found, when it is read, changed or deleted", async () => {
    const user = await signIn();
    const missing = crypto.randomUUID();
    expect(await refusal(await user.fetch(`/api/applications/${missing}`))).toEqual([404, NOT_FOUND]);
    expect(await refusal(await user.send("PATCH", `/api/applications/${missing}`, { status: "applied" }))).toEqual([404, NOT_FOUND]);
    expect(await refusal(await user.send("DELETE", `/api/applications/${missing}`))).toEqual([404, NOT_FOUND]);
    // Another person's job is not there either, and says the same.
    const id = await saved(user);
    const other = await signIn();
    expect(await refusal(await other.fetch(`/api/applications/${id}`))).toEqual([404, NOT_FOUND]);
  });

  it("says a job changed when a save names an earlier revision", async () => {
    const user = await signIn();
    const id = await saved(user);
    expect((await user.send("PATCH", `/api/applications/${id}`, { notes: "First", expectedRevision: 1 })).status).toBe(204);
    expect(await refusal(await user.send("PATCH", `/api/applications/${id}`, { notes: "Second", expectedRevision: 1 }))).toEqual([
      409,
      { error: "conflict", message: "This job changed. Refresh the page, then try again." },
    ]);
  });

  it("won't change the job description while a resume is being tailored for it, and says so", async () => {
    const user = await signIn();
    const id = await saved(user);
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO resumes (id, application_id, state, created_at) VALUES ('resume-running', ?, 'running', 1)`, id);
    });
    expect(await refusal(await user.send("PATCH", `/api/applications/${id}`, { jdText: `${JOB_DESCRIPTION} More.` }))).toEqual([
      409,
      { error: "conflict", message: "Work on this job is still in progress. Wait for it to finish, then change the job description." },
    ]);
  });

  it("won't refine a resume that isn't ready, and says so", async () => {
    const user = await signIn();
    const id = await saved(user);
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO resumes (id, application_id, state, created_at) VALUES ('resume-running', ?, 'running', 1)`, id);
    });
    const response = await user.fetch(`/api/applications/${id}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ kind: "refine", resumeId: "resume-running", instruction: "Make it shorter." }),
    });
    expect(await refusal(response)).toEqual([422, { error: "invalid", message: "This resume isn't ready for this job yet." }]);
  });

  it("says a checked version needs no line-by-line check, and that only such a version can remove a line", async () => {
    const { user, resume } = await tailored();
    expect(resume.provenance).toBe("snapshot");
    expect(await refusal(await user.send("POST", `/api/resumes/${resume.id}/grounding-review`, { expectedVersion: resume.version }))).toEqual([
      409,
      { error: "conflict", message: "This resume doesn't need a line-by-line check." },
    ]);
    const line = resume.body!.sections.flatMap((section) => section.lines)[0]!;
    expect(await refusal(await user.send("POST", `/api/resumes/${resume.id}/legacy-remove-line`, { lineId: line.id, expectedVersion: resume.version }))).toEqual([
      409,
      { error: "conflict", message: "Only a version being checked line by line can remove a line." },
    ]);
    // Nothing changed.
    expect((await user.json<ResumeView>(`/api/resumes/${resume.id}`)).version).toBe(resume.version);
  }, 30_000);

  it("refuses a link that isn't a web address in the Vault itself, not only at the route", async () => {
    const user = await signIn();
    const id = await saved(user);
    const message = await runInDurableObject(vaultOf(user), async (instance) => {
      try {
        await instance.updateApplication(whoOf(user), id, { url: "javascript:alert(1)" });
        return "saved";
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(message).toBe("invalid: Enter the job's web address, starting with https://.");
    // And at the route, with the same words.
    const response = await user.send("PATCH", `/api/applications/${id}`, { url: "javascript:alert(1)" });
    expect(response.status).toBe(422);
  });
});
