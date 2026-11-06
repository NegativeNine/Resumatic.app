import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels, type Models } from "../../src/ai/models";
import { vault } from "../../src/shared/stubs";
import { readSession } from "../../src/worker/session";
import {
  eventually,
  fakeModels,
  JOB_DESCRIPTION,
  signIn,
  type User,
  waitForResume,
} from "./support";

const FACT = "Built a Go service that processes 2 million events per day";
let refinementCalls = 0;
let judgeCalls = 0;
beforeEach(() => {
  refinementCalls = 0;
  judgeCalls = 0;
  setModels(() => model());
});
afterEach(() => setModels(null));
function model(): Models {
  const base = fakeModels();
  return {
    ...base,
    async complete(route, messages, schema, options) {
      const user =
        messages.filter((message) => message.role === "user").at(-1)?.content ??
        "";
      if (route === "judge") judgeCalls++;
      if (route === "write" && user.startsWith("{")) {
        const input = JSON.parse(user) as {
          lines?: { lineId: string; text: string }[];
        };
        if (input.lines) {
          refinementCalls++;
          return schema.parse({
            edits: input.lines.map((line) => ({
              lineId: line.lineId,
              text: "Built a Go service",
            })),
          });
        }
      }
      return base.complete(route, messages, schema, options);
    },
  };
}
async function done(user: User, id: string) {
  const doc = await eventually(async () => {
    const d = await user.json(`/api/documents/${id}`);
    return d.state !== "running" ? d : null;
  }, "refinement to finish");
  expect(doc.state, doc.error).toBe("ready");
}
async function tailor(user: User, applicationId: string) {
  const response = await user.send(
    "POST",
    `/api/applications/${applicationId}/resumes`,
  );
  expect(response.status).toBe(202);
  const { resumeId } = (await response.json()) as { resumeId: string };
  const resume = await waitForResume(user, resumeId);
  expect(resume.state).toBe("ready");
  return resumeId;
}
async function refine(user: User, applicationId: string, resumeId: string) {
  const response = await user.send(
    "POST",
    `/api/applications/${applicationId}/documents`,
    { kind: "refine", resumeId, instruction: "Make it shorter" },
  );
  expect(response.status, await response.clone().text()).toBe(202);
  const { documentId } = (await response.json()) as { documentId: string };
  await done(user, documentId);
}

describe("refinement cache", () => {
  it("reuses verified text across equivalent resumes, rechecks it, and charges each new output", async () => {
    const user = await signIn();
    const session = await readSession(
      env.SESSION_KEY,
      user.cookie.slice(user.cookie.indexOf("=") + 1),
    );
    expect(session).not.toBeNull();
    const periodStart = Math.floor(Date.now() / 1000) - 10;
    await vault(env, session!.vid).setPlan(1, {
      planId: "pro",
      generationLimit: 10,
      bucket: `paid:sub_test:${periodStart}`,
      validUntil: (periodStart + 86400) * 1000,
      subscriptionId: "sub_test",
      status: "active",
      cancelAtPeriodEnd: false,
    });
    const roleResponse = await user.send("POST", "/api/roles", {
      kind: "job",
      org: "Acme",
      title: "Engineer",
      startDate: "2021",
      endDate: null,
    });
    const { roleId } = (await roleResponse.json()) as { roleId: string };
    const factResponse = await user.send("POST", "/api/facts", {
      roleId,
      kind: "accomplishment",
      text: FACT,
      level: "implemented",
    });
    const { factId } = (await factResponse.json()) as { factId: string };
    const appResponse = await user.send("POST", "/api/applications", {
      jdText: JOB_DESCRIPTION,
    });
    const { applicationId } = (await appResponse.json()) as {
      applicationId: string;
    };
    const first = await tailor(user, applicationId);
    const second = await tailor(user, applicationId);
    await refine(user, applicationId, first);
    const afterFirstJudge = judgeCalls;
    await refine(user, applicationId, second);
    expect(refinementCalls).toBe(1);
    expect(judgeCalls).toBeGreaterThan(afterFirstJudge);
    expect(
      (await user.json(`/api/resumes/${first}`)).body.sections[0].lines[0].text,
    ).toBe("Built a Go service");
    expect(
      (await user.json(`/api/resumes/${second}`)).body.sections[0].lines[0]
        .text,
    ).toBe("Built a Go service");
    expect((await user.json("/api/me")).quota).toMatchObject({
      used: 4,
      reserved: 0,
    });
    // A same-worded edit still advances the revision, so a stale variant is not reused.
    expect(
      (await user.send("PATCH", `/api/facts/${factId}`, { text: FACT })).status,
    ).toBe(204);
    const third = await tailor(user, applicationId);
    await refine(user, applicationId, third);
    expect(refinementCalls).toBe(2);
    expect((await user.json("/api/me")).quota).toMatchObject({
      used: 6,
      reserved: 0,
    });
    const stub = vault(env, session!.vid);
    const before = await runInDurableObject(stub, (_instance, state) => {
      const count = state.storage.sql
        .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM refine_cache`)
        .one().count;
      state.storage.sql.exec(
        `UPDATE refine_cache SET created_at = ?`,
        Date.now() - 31 * 86400000,
      );
      return count;
    });
    expect(before).toBeGreaterThan(0);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(
      await runInDurableObject(
        stub,
        (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              `SELECT COUNT(*) AS count FROM refine_cache`,
            )
            .one().count,
      ),
    ).toBe(0);
  }, 30000);
});
