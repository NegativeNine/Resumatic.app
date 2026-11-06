import { expect, it } from "vitest";
import { exportJsonStream } from "../../src/vault/export-stream";

it("streams the same JSON values across multiple chunks, including Unicode and null array items", async () => {
  const input = {
    format: 2,
    title: "Résumé – 東京 😀",
    omitted: undefined,
    rows: Array.from({ length: 200 }, (_, i) => ({ id: i, text: `é😀${"x".repeat(500)}` })),
    optional: [undefined, null, { nested: [1, true, "x"] }],
  };
  const stream = exportJsonStream(input);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    chunks.push(item.value);
  }
  expect(chunks.length).toBeGreaterThan(1);
  const text = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(input)));
});
