import { afterEach, describe, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import {
  fakeModels,
  JOB_DESCRIPTION,
  RESUME,
  signIn,
  waitForResume,
  waitForSource,
  type FakeModelOptions,
} from "./support";

afterEach(() => setModels(null));

describe("unattached fact attribution", () => {
  it("allows an unattached confirmed fact in the summary but never under an employer", async () => {
    const loose = "Built Kubernetes deployment tooling";
    const options: FakeModelOptions = {
      summary: { text: loose, cites: [loose] },
      extraLines: [{
        under: "Led the migration of 40 services to Kubernetes, cutting deploy time by 60%",
        text: loose,
        cites: [loose],
      }],
      repairs: { [loose]: loose },
    };
    setModels(() => fakeModels(options));
    const user = await signIn();
    const upload = await user.upload("resume.pdf", RESUME);
    const { sourceId } = (await upload.json()) as { sourceId: string };
    await waitForSource(user, sourceId);
    const { facts } = await user.json("/api/facts");
    const { roles } = await user.json("/api/roles");
    const confirm = [...facts, ...roles].map((item: { id: string }) => item.id);
    expect((await user.send("POST", "/api/review", { confirm, reject: [] })).status).toBe(204);
    const created = await user.send("POST", "/api/facts", {
      roleId: null,
      kind: "accomplishment",
      text: loose,
      level: "implemented",
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { factId } = (await created.json()) as { factId: string };
    const application = await user.send("POST", "/api/applications", { jdText: JOB_DESCRIPTION });
    const { applicationId } = (await application.json()) as { applicationId: string };
    const started = await user.send("POST", `/api/applications/${applicationId}/resumes`);
    expect(started.status, await started.clone().text()).toBe(202);
    const { resumeId } = (await started.json()) as { resumeId: string };
    const resume = await waitForResume(user, resumeId);
    expect(resume.state, resume.error).toBe("ready");
    expect(resume.body.summary).toMatchObject({ text: loose, factIds: [factId] });
    expect(resume.report.dropped).toBeGreaterThanOrEqual(1);
    expect(resume.body.sections.flatMap((section: { lines: { factIds: string[] }[] }) => section.lines)
      .some((line: { factIds: string[] }) => line.factIds.includes(factId))).toBe(false);
  });
});
