import { afterEach, beforeEach, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import { fakeModels, signIn, waitForSource } from "./support";

beforeEach(() => setModels(() => fakeModels()));
afterEach(() => setModels(null));

it("warns when a PDF conversion has little readable text without exposing source text in the list", async () => {
  const user = await signIn();
  const response = await user.upload("scan.pdf", "Jane Doe");
  expect(response.status).toBe(201);
  const { sourceId } = (await response.json()) as { sourceId: string };
  await waitForSource(user, sourceId);
  const { sources } = await user.json("/api/sources");
  const source = sources.find((item: { id: string }) => item.id === sourceId);
  expect(source.conversionWarnings).toContain("little-text");
  expect(source).not.toHaveProperty("markdown");
});
