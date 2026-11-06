import { clairic } from "./clairic";
import { withJudge } from "./judge";
import { llmExtractor } from "./llm";
import { segmentExtractor } from "./segment";
import type { Extractor } from "./types";

export { verifyExtraction } from "./verify";
export type {
  ExtractInput,
  Extractor,
  RawExtraction,
  VerifiedExtraction,
} from "./types";
export const EXTRACTORS: Readonly<Record<string, Extractor>> =
  Object.fromEntries(
    [
      llmExtractor(),
      llmExtractor("@cf/openai/gpt-oss-120b"),
      llmExtractor("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
      clairic,
      segmentExtractor(),
    ].map((extractor) => [extractor.id, extractor]),
  );

export function extractorById(id: string): Extractor {
  if (EXTRACTORS[id]) return EXTRACTORS[id]!;
  if (id.startsWith("judge:") && !id.slice(6).startsWith("judge:"))
    return withJudge(extractorById(id.slice(6)));
  if (/^llm:(?:@cf\/|[a-z0-9_-]+\/)[a-zA-Z0-9/_.-]+$/.test(id))
    return llmExtractor(id.slice(4));
  if (/^segment:(?:@cf\/|[a-z0-9_-]+\/)[a-zA-Z0-9/_.-]+$/.test(id))
    return segmentExtractor(id.slice(8));
  throw new Error("extractor_unknown");
}

/** Stable cohorts across isolates and deploys. Experiment config is JSON {strategy,percent}. */
export function experimentBucket(vaultId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < vaultId.length; i++)
    hash = Math.imul(hash ^ vaultId.charCodeAt(i), 16777619) >>> 0;
  return hash % 10_000;
}

export function extractorFor(
  env: { EXTRACTOR?: string; EXTRACTOR_EXPERIMENT?: string },
  vaultId: string,
): Extractor {
  const primary = extractorById(env.EXTRACTOR || "llm:default");
  if (!env.EXTRACTOR_EXPERIMENT) return primary;
  let experiment: unknown;
  try {
    experiment = JSON.parse(env.EXTRACTOR_EXPERIMENT);
  } catch {
    throw new Error("extractor_experiment_invalid");
  }
  if (!experiment || typeof experiment !== "object")
    throw new Error("extractor_experiment_invalid");
  const { strategy, percent } = experiment as {
    strategy?: unknown;
    percent?: unknown;
  };
  if (
    typeof strategy !== "string" ||
    typeof percent !== "number" ||
    !Number.isFinite(percent) ||
    percent < 0 ||
    percent > 100
  )
    throw new Error("extractor_experiment_invalid");
  const challenger = extractorById(strategy);
  return experimentBucket(vaultId) < percent * 100 ? challenger : primary;
}
