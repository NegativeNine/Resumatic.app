import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import type { FactView } from "../../src/shared/api";
import {
  eventually,
  fakeModels,
  JOB_DESCRIPTION,
  RESUME,
  signIn,
  waitForResume,
  waitForSource,
  type FakeModelOptions,
  type User,
} from "./support";

let options: FakeModelOptions;
beforeEach(() => {
  options = { calls: {} };
  setModels(() => fakeModels(options));
});
afterEach(() => {
  setModels(null);
});

async function readyUser(): Promise<{ user: User; facts: FactView[] }> {
  const user = await signIn();
  const { sourceId } = (await (
    await user.upload("synthetic.pdf", RESUME)
  ).json()) as { sourceId: string };
  expect((await waitForSource(user, sourceId)).state).toBe("ready");
  const { facts } = await user.json<{ facts: FactView[] }>("/api/facts");
  const { roles } = await user.json("/api/roles");
  expect(
    (
      await user.send("POST", "/api/review", {
        confirm: [...facts, ...roles].map((item) => item.id),
        reject: [],
      })
    ).status,
  ).toBe(204);
  return {
    user,
    facts: (await user.json<{ facts: FactView[] }>("/api/facts")).facts,
  };
}
async function start(user: User): Promise<string> {
  const { applicationId } = (await (
    await user.send("POST", "/api/applications", { jdText: JOB_DESCRIPTION })
  ).json()) as { applicationId: string };
  const response = await user.send(
    "POST",
    `/api/applications/${applicationId}/resumes`,
  );
  expect(response.status).toBe(202);
  return ((await response.json()) as { resumeId: string }).resumeId;
}

describe("generation snapshots and concurrent review", () => {
  it("refuses to publish a draft whose cited fact changed during generation and releases its credit", async () => {
    let release!: () => void;
    options.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user, facts } = await readyUser();
    const id = await start(user);
    await eventually(
      async () => options.calls?.analyze === 1,
      "the analysis call after snapshot capture",
    );
    const fact = facts.find(
      (item) => item.text === "Led the migration of 40 services to Kubernetes, cutting deploy time by 60%",
    )!;
    try {
      expect(
        (
          await user.send("PATCH", `/api/facts/${fact.id}`, {
            text: "Helped migrate 40 services to Kubernetes",
            expectedRevision: fact.revision,
          })
        ).status,
      ).toBe(204);
    } finally {
      release();
    }
    const result = await eventually(
      async () => {
        const current = await user.json(`/api/resumes/${id}`);
        return current.state !== "running" ? current : null;
      },
      "stale generation to stop",
      25_000,
    );
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/Your facts changed while this draft was being made/);
    expect(result.body).toBeNull();
    expect((await user.json("/api/me")).quota.used).toBe(0);
    expect((await user.json(`/api/resumes/${id}/versions`)).versions).toEqual(
      [],
    );
  }, 30_000);

  it("rejects a stale review without reverting a newer fact edit", async () => {
    const { user, facts } = await readyUser();
    const fact = facts[0]!;
    expect(
      (
        await user.send("PATCH", `/api/facts/${fact.id}`, {
          text: "Worked on internal tooling",
          expectedRevision: fact.revision,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await user.send("POST", "/api/review", {
          confirm: [],
          reject: [fact.id],
          expectedRevisions: { [fact.id]: fact.revision },
        })
      ).status,
    ).toBe(409);
    expect(
      (await user.json<{ facts: FactView[] }>("/api/facts")).facts.find(
        (item) => item.id === fact.id,
      ),
    ).toMatchObject({
      text: "Worked on internal tooling",
      state: "confirmed",
      origin: "user",
    });
  });

  it("keeps a published resume, its evidence, and its DOCX stable after profile and fact edits", async () => {
    const { user, facts } = await readyUser();
    await user.send("PUT", "/api/profile", { name: "Synthetic Original" });
    const id = await start(user);
    const original = await waitForResume(user, id);
    expect(original.state).toBe("ready");
    const before = await user.fetch(`/api/resumes/${id}/docx?version=1`);
    expect(before.status).toBe(200);
    const originalBytes = new Uint8Array(await before.arrayBuffer());
    const factId = original.body.sections[0].lines[0].factIds[0] as string;
    const fact = facts.find((item) => item.id === factId)!;
    await user.send("PUT", "/api/profile", { name: "Synthetic Updated" });
    expect(
      (
        await user.send("PATCH", `/api/facts/${fact.id}`, {
          text: "Worked on internal tooling",
          expectedRevision: fact.revision,
        })
      ).status,
    ).toBe(204);
    const saved = await user.json(`/api/resumes/${id}?version=1`);
    expect(saved.body).toEqual(original.body);
    expect(saved.facts).toEqual(original.facts);
    const after = await user.fetch(`/api/resumes/${id}/docx?version=1`);
    expect(new Uint8Array(await after.arrayBuffer())).toEqual(originalBytes);
    const preview = await user.fetch(`/api/resumes/${id}/preview?version=1`);
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain("Synthetic Original");
    expect(html).not.toContain("Synthetic Updated");
  });
});
