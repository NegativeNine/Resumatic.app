import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels, type Models } from "../../src/ai/models";
import type { DocumentView, NewDocument } from "../../src/shared/documents";
import {
  eventually,
  fakeModels,
  JOB_DESCRIPTION,
  signIn,
  type User,
  waitForResume,
} from "./support";

const FACT = "Built a Go service that processes 2 million events per day";
let rewrite: "same" | "shorter";

beforeEach(() => {
  rewrite = "same";
  setModels(() => documentModels());
});
afterEach(() => setModels(null));

function documentModels(): Models {
  const base = fakeModels();
  return {
    ...base,
    async complete(route, messages, schema, options) {
      const user =
        messages.filter((message) => message.role === "user").at(-1)?.content ??
        "";
      if (route === "write" && user.startsWith("{")) {
        const data = JSON.parse(user) as {
          facts?: { id: string; roleId: string | null; text: string }[];
          lines?: { lineId: string; text: string }[];
        };
        if (data.lines)
          return schema.parse({
            edits: data.lines.map((line) => ({
              lineId: line.lineId,
              text: rewrite === "shorter" ? "Built a Go service" : line.text,
            })),
          });
        const first =
          data.facts?.find((fact) => fact.text === FACT) ?? data.facts?.[0];
        return schema.parse({
          units: first
            ? [
                {
                  roleId: first.roleId,
                  text: first.text,
                  factIds: [first.id],
                  group: 0,
                },
              ]
            : [],
        });
      }
      return base.complete(route, messages, schema, options);
    },
  };
}

async function application() {
  const user = await signIn();
  const role = await user.send("POST", "/api/roles", {
    kind: "job",
    org: "Acme",
    title: "Engineer",
    startDate: "2021",
    endDate: null,
  });
  expect(role.status).toBe(201);
  const { roleId } = (await role.json()) as { roleId: string };
  const fact = await user.send("POST", "/api/facts", {
    roleId,
    kind: "accomplishment",
    text: FACT,
    level: "implemented",
  });
  expect(fact.status).toBe(201);
  const { factId } = (await fact.json()) as { factId: string };
  const app = await user.send("POST", "/api/applications", {
    jdText: JOB_DESCRIPTION,
  });
  expect(app.status).toBe(201);
  const { applicationId } = (await app.json()) as { applicationId: string };
  return { user, applicationId, factId };
}

async function start(
  user: User,
  applicationId: string,
  options: NewDocument,
  key = crypto.randomUUID(),
) {
  const response = await user.fetch(
    `/api/applications/${applicationId}/documents`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(options),
    },
  );
  expect(response.status, await response.clone().text()).toBe(202);
  return response.json() as Promise<{ documentId: string; runId: string }>;
}

async function finished(user: User, documentId: string): Promise<DocumentView> {
  const result = await eventually(async () => {
    const doc = await user.json<DocumentView>(`/api/documents/${documentId}`);
    return doc.state !== "running" ? doc : null;
  }, "document publication");
  expect(result.state, result.error ?? "document failed").toBe("ready");
  return result;
}

describe("document workflows", () => {
  it("publishes a cited cover letter once and preserves its evidence after later fact edits", async () => {
    const { user, applicationId, factId } = await application();
    const key = crypto.randomUUID();
    const original = await start(user, applicationId, { kind: "letter" }, key);
    const doc = await finished(user, original.documentId);
    expect(doc.result?.units[0]).toMatchObject({
      text: FACT,
      factIds: [factId],
      status: "kept",
    });
    expect((await user.json("/api/me")).quota).toMatchObject({
      used: 1,
      reserved: 0,
    });
    const replay = await start(user, applicationId, { kind: "letter" }, key);
    expect(replay.documentId).toBe(original.documentId);
    expect((await user.json("/api/me")).quota.used).toBe(1);
    const edit = await user.send("PATCH", `/api/facts/${factId}`, {
      text: "Built a Go service for internal tools",
    });
    expect(edit.status).toBe(204);
    const saved = await user.json<DocumentView>(`/api/documents/${doc.id}`);
    expect(saved.facts[factId]!.text).toBe(FACT);
    expect(saved.result?.units[0]?.text).toBe(FACT);
  });

  it("generates gap questions without consuming an output unit", async () => {
    const { user, applicationId } = await application();
    const { documentId } = await start(user, applicationId, {
      kind: "questions",
    });
    const doc = await finished(user, documentId);
    expect(
      doc.result?.questions.some((question) =>
        /Rust/.test(question.requirement),
      ),
    ).toBe(true);
    expect(doc.result?.units).toEqual([]);
    expect((await user.json("/api/me")).quota).toMatchObject({
      used: 0,
      reserved: 0,
    });
  });

  it("publishes interview questions with evidence-backed answer outlines", async () => {
    const { user, applicationId, factId } = await application();
    const { documentId } = await start(user, applicationId, { kind: "prep" });
    const doc = await finished(user, documentId);
    expect(doc.result?.questions.length).toBeGreaterThan(0);
    expect(doc.result?.units[0]?.factIds).toEqual([factId]);
    expect((await user.json("/api/me")).quota).toMatchObject({
      used: 1,
      reserved: 0,
    });
  });

  it("releases no-op refinement credit and publishes a changed refinement as a new saved version", async () => {
    const { user, applicationId } = await application();
    const created = await user.send(
      "POST",
      `/api/applications/${applicationId}/resumes`,
    );
    expect(created.status).toBe(202);
    const { resumeId } = (await created.json()) as { resumeId: string };
    const original = await waitForResume(user, resumeId);
    expect(original.state).toBe("ready");
    expect((await user.json("/api/me")).quota.used).toBe(1);
    const noop = await start(user, applicationId, {
      kind: "refine",
      resumeId,
      expectedVersion: original.version,
      instruction: "Keep the wording",
    });
    await finished(user, noop.documentId);
    expect((await user.json(`/api/resumes/${resumeId}`)).version).toBe(
      original.version,
    );
    expect((await user.json("/api/me")).quota).toMatchObject({
      used: 1,
      reserved: 0,
    });
    rewrite = "shorter";
    const changed = await start(user, applicationId, {
      kind: "refine",
      resumeId,
      expectedVersion: original.version,
      instruction: "Make it shorter",
    });
    await finished(user, changed.documentId);
    const current = await user.json(`/api/resumes/${resumeId}`);
    expect(current.version).toBe(original.version + 1);
    expect(current.body.sections[0].lines[0].text).toBe("Built a Go service");
    expect(
      (await user.json(`/api/resumes/${resumeId}?version=${original.version}`))
        .body,
    ).toEqual(original.body);
    expect((await user.json("/api/me")).quota).toMatchObject({
      used: 2,
      reserved: 0,
    });
  });
});
