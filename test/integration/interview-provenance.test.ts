import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import { eventually, fakeModels, JOB_DESCRIPTION, signIn } from "./support";

beforeEach(() => setModels(() => fakeModels()));
afterEach(() => setModels(null));

describe("interview answer provenance", () => {
  it("saves a user-authored answer with its actual question, idempotently and without consuming output quota", async () => {
    const user = await signIn();
    const app = await user.send("POST", "/api/applications", {
      jdText: JOB_DESCRIPTION,
    });
    const { applicationId } = (await app.json()) as { applicationId: string };
    const start = await user.send(
      "POST",
      `/api/applications/${applicationId}/documents`,
      { kind: "questions" },
    );
    expect(start.status).toBe(202);
    const { documentId } = (await start.json()) as { documentId: string };
    const doc = await eventually(async () => {
      const result = await user.json(`/api/documents/${documentId}`);
      return result.state === "ready" ? result : null;
    }, "gap questions");
    const question = doc.result.questions[0] as {
      id: string;
      question: string;
    };
    const path = `/api/documents/${documentId}/questions/${question.id}/answer`;
    const requestKey = crypto.randomUUID();
    const post = (answer: string) =>
      user.fetch(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": requestKey,
        },
        body: JSON.stringify({ roleId: null, answer }),
      });
    const [response, duplicate] = await Promise.all([
      post("I evaluated Go deployments for an internal service."),
      post("I evaluated Go deployments for an internal service."),
    ]);
    expect(response.status, await response.clone().text()).toBe(201);
    expect(duplicate.status, await duplicate.clone().text()).toBe(201);
    const { factId } = (await response.json()) as { factId: string };
    expect(((await duplicate.json()) as { factId: string }).factId).toBe(
      factId,
    );
    const replay = (await (
      await post("I evaluated Go deployments for an internal service.")
    ).json()) as { factId: string };
    expect(replay.factId).toBe(factId);
    expect((await post("I founded the company.")).status).toBe(409);
    const facts = (await user.json("/api/facts")).facts;
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      id: factId,
      origin: "user",
      state: "confirmed",
      quote: null,
      interview: {
        documentId,
        questionId: question.id,
        question: question.question,
        quote: "I evaluated Go deployments for an internal service.",
      },
    });
    expect((await user.json("/api/me")).quota).toMatchObject({
      used: 0,
      reserved: 0,
    });
    const exported = await user.json("/api/export");
    expect(exported.interviewAnswers).toMatchObject([
      {
        fact_id: factId,
        document_id: documentId,
        question_id: question.id,
        quote: "I evaluated Go deployments for an internal service.",
      },
    ]);
    expect(
      (
        await user.send("PATCH", `/api/facts/${factId}`, {
          text: "I assisted with internal service deployments.",
        })
      ).status,
    ).toBe(204);
    const edited = (await user.json("/api/facts")).facts[0];
    expect(edited.text).toBe("I assisted with internal service deployments.");
    expect(edited.quote).toBeNull();
    expect(edited.interview.quote).toBe(
      "I evaluated Go deployments for an internal service.",
    );
    const other = await signIn();
    expect(
      (await other.send("POST", path, { roleId: null, answer: "I tried it." }))
        .status,
    ).toBe(404);
  });
});
