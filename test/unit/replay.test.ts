import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Models } from "../../src/ai/models";
import {
  recordingKey,
  recordingModels,
  replayModels,
  type RecordingOptions,
} from "../support/replay";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "resumatic-recording-"));
  temporary.push(path);
  return path;
};
const options: RecordingOptions = {
  dataClass: "synthetic",
  modelIds: { extract: "test/model" },
  transcriptionModel: "test/vision",
};

describe("model recording and replay", () => {
  it("round-trips every Models method without retaining request text in fixture metadata", async () => {
    const dir = directory();
    const real: Models = {
      complete: async (_route, _messages, schema) =>
        schema.parse({ answer: 7 }),
      embed: async (texts) => texts.map(() => [1, 0]),
      rerank: async (_query, texts) => texts.map(() => 0.7),
      toMarkdown: async () => "Synthetic converted text",
      extractFields: async () => ({
        answers: { skill: { value: "Go", span: [8, 10] } },
        truncated: false,
      }),
      transcribePages: async () => ({ markdown: "Synthetic image text" }),
    };
    const record = recordingModels(real, dir, options);
    const replay = replayModels(dir, options);
    for (const models of [record, replay]) {
      expect(
        await models.complete(
          "extract",
          [{ role: "user", content: "private-request-marker" }],
          z.object({ answer: z.number() }),
        ),
      ).toEqual({ answer: 7 });
      expect(await models.embed(["Synthetic text"])).toEqual([[1, 0]]);
      expect(await models.rerank("query", ["Synthetic text"])).toEqual([0.7]);
      expect(
        await models.toMarkdown("synthetic.pdf", new Blob(["Synthetic file"])),
      ).toBe("Synthetic converted text");
      expect(
        (
          await models.extractFields!(
            "Skills: Go",
            { skill: { type: "text" } },
            "2026-11-06",
          )
        ).answers.skill?.value,
      ).toBe("Go");
      expect(
        await models.transcribePages!({
          images: [{ mimeType: "image/png", base64: "synthetic" }],
          referenceDate: "2026-11-06",
        }),
      ).toEqual({ markdown: "Synthetic image text" });
    }
    const file = join(dir, "extract", readdirSync(join(dir, "extract"))[0]!);
    expect(readFileSync(file, "utf8")).not.toContain("private-request-marker");
  });
  it("keys include model, schema and exact inputs while ignoring object key order", () => {
    expect(recordingKey("extract", "a", { x: 1, y: 2 })).toBe(
      recordingKey("extract", "a", { y: 2, x: 1 }),
    );
    expect(recordingKey("extract", "a", {})).not.toBe(
      recordingKey("extract", "b", {}),
    );
    expect(recordingKey("extract", "a", { schema: 1 })).not.toBe(
      recordingKey("extract", "a", { schema: 2 }),
    );
  });
  it("fails on missing fixtures, missing model identity and undeclared data class", async () => {
    const replay = replayModels(directory(), options);
    await expect(replay.embed(["missing"])).rejects.toThrow(
      "model_recording_missing_or_invalid",
    );
    expect(() => replay.complete("judge", [], z.object({}))).toThrow(
      "model_recording_model_required",
    );
    expect(() =>
      replayModels(directory(), {
        ...options,
        dataClass: "real",
      } as unknown as RecordingOptions),
    ).toThrow("requires_synthetic");
  });
  it("keeps embedding fixtures distinct across an atomic model migration", async () => {
    const dir = directory();
    const real: Models = {
      complete: async (_route, _messages, schema) => schema.parse({}),
      embed: async (_texts, opts) =>
        opts?.model === "new-model" ? [[1, 0, 0]] : [[1, 0]],
      rerank: async () => [],
      toMarkdown: async () => "",
    };
    const record = recordingModels(real, dir, options);
    await record.embed(["Synthetic fact"]);
    await record.embed(["Synthetic fact"], { model: "new-model" });
    const replay = replayModels(dir, options);
    expect(await replay.embed(["Synthetic fact"])).toEqual([[1, 0]]);
    expect(
      await replay.embed(["Synthetic fact"], { model: "new-model" }),
    ).toEqual([[1, 0, 0]]);
    expect(readdirSync(join(dir, "embed"))).toHaveLength(2);
  });
});
