import { expect, it } from "vitest";
import { reviewViewStream, type ReviewView } from "../../src/vault/review-stream";

it("streams valid JSON in multiple chunks with exact Unicode and escaped content", async () => {
  const view = {
    sources: [{ id: "source", filename: "résumé\n🙂.pdf" }],
    roles: [{ id: "role", org: "Example \"Company\"" }],
    facts: Array.from({ length: 150 }, (_, i) => ({ id: `fact-${i}`, text: `Line ${i} ${"€🙂".repeat(150)}` })),
  } as unknown as ReviewView;
  const reader = reviewViewStream(view).getReader();
  const decoder = new TextDecoder();
  let text = "", chunks = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks++;
    text += decoder.decode(next.value, { stream: true });
  }
  text += decoder.decode();
  expect(chunks).toBeGreaterThan(1);
  expect(JSON.parse(text)).toEqual(view);
});
