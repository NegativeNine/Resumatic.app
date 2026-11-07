import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import { vault } from "../../src/shared/stubs";
import { FEEDBACK_WINDOW_MS } from "../../src/vault/extraction-feedback";
import { fakeModels, RESUME, signIn, waitForSource } from "./support";

beforeEach(() => setModels(() => fakeModels()));
afterEach(() => setModels(null));

it("records counts and freezes the seven-day cohort without storing career text", async () => {
  const user = await signIn();
  const payload = user.cookie
    .slice("__Host-session=".length)
    .split(".")[0]!
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const { vid } = JSON.parse(
    atob(payload + "===".slice((payload.length + 3) % 4)),
  ) as { vid: string };
  const v = vault(env, vid);
  const uploaded = await user.upload("resume.pdf", RESUME);
  const { sourceId } = (await uploaded.json()) as { sourceId: string };
  await waitForSource(user, sourceId);
  const { facts } = await user.json("/api/facts?state=proposed");
  expect(facts.length).toBeGreaterThanOrEqual(3);
  expect(
    (
      await user.send("POST", "/api/review", {
        confirm: [facts[0].id],
        reject: [facts[1].id],
      })
    ).status,
  ).toBe(204);
  expect(
    (
      await user.send("PATCH", `/api/facts/${facts[2].id}`, {
        text: "Implemented a service",
      })
    ).status,
  ).toBe(204);
  expect(
    (
      await user.send("POST", "/api/facts", {
        roleId: null,
        kind: "skill",
        text: "Kotlin",
        level: null,
      })
    ).status,
  ).toBe(201);
  let rows = await v.extractionFeedback();
  let row = rows.find((r) => r.sourceId === sourceId)!;
  expect(row).toMatchObject({
    proposed: facts.length,
    confirmed: 1,
    rejected: 1,
    edited: 1,
    manualAdded: 1,
    windowComplete: false,
  });
  expect(JSON.stringify(rows)).not.toContain("Kotlin");
  expect(JSON.stringify(rows)).not.toContain("Implemented a service");
  await runInDurableObject(v, (_obj, state) => {
    state.storage.sql.exec(
      `INSERT INTO extraction_feedback_manual(fact_id,source_id,added_at) VALUES ('late',?,?)`,
      sourceId,
      row.startedAt + FEEDBACK_WINDOW_MS + 1,
    );
  });
  rows = await v.extractionFeedback();
  row = rows.find((r) => r.sourceId === sourceId)!;
  expect(row.manualAdded).toBe(1);
});
