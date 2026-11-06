import { ExtractOut, extractPrompt } from "../../ai/prompts";
import type { Extractor } from "./types";
export const llmExtractor = (model?: string): Extractor => ({
  id: `llm:${model ?? "default"}`,
  extract: (input, models) =>
    models.complete("extract", extractPrompt(input.markdown), ExtractOut, {
      model,
    }),
});
