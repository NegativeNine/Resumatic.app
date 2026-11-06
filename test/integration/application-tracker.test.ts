import { describe, expect, it } from "vitest";
import { JOB_DESCRIPTION, signIn } from "./support";

async function createApplication() {
  const user = await signIn();
  const response = await user.send("POST", "/api/applications", { jdText: JOB_DESCRIPTION });
  expect(response.status).toBe(201);
  const { applicationId } = await response.json() as { applicationId: string };
  return { user, applicationId };
}

describe("application tracker", () => {
  it("persists valid dates and protects other edits with the application revision", async () => {
    const { user, applicationId } = await createApplication();
    const list = () => user.json<{ applications: { id: string; revision: number; status: string; appliedAt: string | null; notes: string }[] }>("/api/applications");
    const initial = (await list()).applications.find((item) => item.id === applicationId)!;
    expect(initial).toMatchObject({ status: "saved", appliedAt: null, notes: "" });
    const update = await user.send("PATCH", `/api/applications/${applicationId}`, {
      status: "applied", appliedAt: "2024-02-29", notes: "Call next week", expectedRevision: initial.revision,
    });
    expect(update.status).toBe(204);
    const saved = (await list()).applications.find((item) => item.id === applicationId)!;
    expect(saved).toMatchObject({ revision: initial.revision + 1, status: "applied", appliedAt: "2024-02-29", notes: "Call next week" });
    const stale = await user.send("PATCH", `/api/applications/${applicationId}`, { notes: "stale", expectedRevision: initial.revision });
    expect(stale.status).toBe(409);
    expect((await list()).applications.find((item) => item.id === applicationId)).toEqual(saved);
    const other = await signIn();
    expect((await other.send("PATCH", `/api/applications/${applicationId}`, { notes: "other user" })).status).toBe(404);
  });

  it.each(["2026-02-29", "2026-02-30", "2026-13-01", "0000-01-01"])("rejects an impossible applied date (%s) without saving other fields", async (appliedAt) => {
    const { user, applicationId } = await createApplication();
    const { applications } = await user.json<{ applications: { id: string; revision: number }[] }>("/api/applications");
    const before = applications.find((item) => item.id === applicationId)!;
    expect((await user.send("PATCH", `/api/applications/${applicationId}`, { appliedAt, notes: "should not persist", expectedRevision: before.revision })).status).toBe(422);
    const after = (await user.json<{ applications: { id: string; revision: number }[] }>("/api/applications")).applications.find((item) => item.id === applicationId);
    expect(after).toEqual(before);
  });
});
