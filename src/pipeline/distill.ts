import type { Models } from "../ai/models";
import { AppError } from "../shared/errors";
import { llmExtractor } from "./extract/llm";
import {
  MAX_MARKDOWN_CHARS,
  type ExtractInput,
  type Extractor,
  type VerifiedExtraction,
} from "./extract/types";
import { verifyExtraction } from "./extract/verify";

export { MAX_MARKDOWN_CHARS } from "./extract/types";
export interface ExtractResult {
  extraction: VerifiedExtraction;
  dropped: number;
}

/** Compatibility entrypoint; all strategies use the same verification. */
export async function extractFacts(
  models: Models,
  markdown: string,
  opts: {
    extractor?: Extractor;
    filename?: string;
    referenceDate?: string;
  } = {},
): Promise<ExtractResult> {
  if (markdown.length > MAX_MARKDOWN_CHARS)
    throw new AppError(
      "invalid",
      "this document is too long to read; upload a resume of a few pages",
    );
  const input: ExtractInput = {
    markdown,
    filename: opts.filename ?? "resume",
    referenceDate: opts.referenceDate ?? "1970-01-01",
  };
  const raw = await (opts.extractor ?? llmExtractor()).extract(input, models);
  const { extraction, dropped } = verifyExtraction(markdown, raw);
  return { extraction, dropped: dropped.length };
}
