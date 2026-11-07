import { describe, it } from "vitest";
import { ExtractOut, extractPrompt } from "../../src/ai/prompts";
import { credentials, restModels, wranglerVars } from "../evals/rest-models";
import { recordingModels } from "../support/replay";
import { CASES } from "./cases";

describe.skipIf(process.env.RECORD_MODE !== "1")(
  "record synthetic live model fixtures",
  () => {
    it("records one synthetic extraction and its retrieval calls", async () => {
      const creds = credentials();
      if (!creds || !process.env.RECORD_OUTPUT)
        throw new Error("recording_configuration_required");
      const vars = wranglerVars("staging");
      const models = recordingModels(
        restModels(creds, vars),
        process.env.RECORD_OUTPUT,
        {
          dataClass: "synthetic",
          embeddingModel: vars.EMBEDDING_MODEL,
          modelIds: {
            extract: vars.MODEL_EXTRACT,
            analyze: vars.MODEL_ANALYZE,
            write: vars.MODEL_WRITE,
            repair: vars.MODEL_WRITE,
            judge: vars.MODEL_JUDGE,
          },
        },
      );
      const testCase = CASES[0]!;
      const extraction = await models.complete(
        "extract",
        extractPrompt(testCase.markdown),
        ExtractOut,
      );
      const texts = extraction.facts.map((fact) => fact.text);
      await models.embed(texts);
      await models.rerank("software engineering", texts);
    });
  },
);
