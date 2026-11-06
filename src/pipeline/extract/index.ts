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
  // Registry keys are configuration data; never resolve inherited object properties.
  if (Object.hasOwn(EXTRACTORS, id)) return EXTRACTORS[id]!;
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

export const EXTRACT_FORMATS = ["pdf", "docx", "linkedin", "ocr"] as const;
export type ExtractFormat = (typeof EXTRACT_FORMATS)[number];

/** Classify accepted upload metadata; OCR is a distinct derived source. */
export function sourceFormat(
  origin: "upload" | "ocr" | undefined,
  filename: string,
): ExtractFormat | undefined {
  if (origin === "ocr") return "ocr";
  if (origin !== undefined && origin !== "upload") return undefined;
  if (/\.pdf$/i.test(filename)) return "pdf";
  if (/\.docx$/i.test(filename)) return "docx";
  if (/\.zip$/i.test(filename)) return "linkedin";
  return undefined;
}

/** Validates every configured route, including routes not used by this upload. */
function formatRoutes(
  raw: string | undefined,
): Partial<Record<ExtractFormat, Extractor>> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    const routes: Partial<Record<ExtractFormat, Extractor>> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        !EXTRACT_FORMATS.includes(key as ExtractFormat) ||
        typeof value !== "string" ||
        !value
      )
        throw new Error();
      routes[key as ExtractFormat] = extractorById(value);
    }
    return routes;
  } catch {
    // Do not log the deployment configuration, which could contain arbitrary text.
    throw new Error("extractor_format_routes_invalid");
  }
}

export function extractorFor(
  env: {
    EXTRACTOR?: string;
    EXTRACTOR_EXPERIMENT?: string;
    EXTRACTOR_BY_FORMAT?: string;
  },
  vaultId: string,
  format?: ExtractFormat,
): Extractor {
  if (format !== undefined && !EXTRACT_FORMATS.includes(format))
    throw new Error("extractor_format_invalid");
  const fallback = extractorById(env.EXTRACTOR || "llm:default");
  const routes = formatRoutes(env.EXTRACTOR_BY_FORMAT);
  const primary = (format && routes[format]) || fallback;
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
