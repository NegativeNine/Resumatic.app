import { describe, expect, it } from "vitest";
import { embedTexts } from "../../src/ai/vectors";

describe("embedding model selection", () => {
  it("uses the per-call snapshot model before the current deployment default and meters that identity", async () => {
    const requested: string[] = [];
    const metered: string[] = [];
    const env = {
      EMBEDDING_MODEL: "embedding-new",
      AI_GATEWAY_ID: "test",
      AI: {
        run: async (model: string, input: { text: string[] }) => {
          requested.push(model);
          return {
            data: input.text.map(() => [1, 0]),
            usage: { input_tokens: input.text.length, output_tokens: 0 },
          };
        },
      },
    } as unknown as Env;
    await embedTexts(
      env,
      ["Synthetic fact"],
      {
        onUsage: (usage) => {
          metered.push(usage.model);
        },
      },
      { model: "embedding-snapshot" },
    );
    await embedTexts(env, ["Synthetic fact"]);
    expect(requested).toEqual(["embedding-snapshot", "embedding-new"]);
    expect(metered).toEqual(["embedding-snapshot"]);
  });
  it("rejects invalid vectors and dimension drift between batches", async () => {
    let batch = 0;
    const env = {
      AI: {
        run: async (_model: string, input: { text: string[] }) => ({
          data: input.text.map(() => (batch++ < 50 ? [1, 0] : [1, 0, 0])),
        }),
      },
    } as unknown as Env;
    await expect(
      embedTexts(env, Array(51).fill("Synthetic fact")),
    ).rejects.toThrow("wrong shape");
    for (const vector of [[], [NaN], [Infinity]]) {
      const malformed = {
        AI: { run: async () => ({ data: [vector] }) },
      } as unknown as Env;
      await expect(embedTexts(malformed, ["Synthetic fact"])).rejects.toThrow(
        "wrong shape",
      );
    }
  });
});
