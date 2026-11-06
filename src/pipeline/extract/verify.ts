import { ExtractOut } from "../../ai/prompts";
import { z } from "zod";
import {
  DEFAULT_RANK,
  checkClaim,
  levelOfRank,
  rankOf,
  scopeRank,
} from "../../grounding/claims";
import {
  lineContext,
  locateQuote,
  validSpan,
  type Span,
} from "../../grounding/offsets";
import { MIN_QUOTE_CHARS, normalizeForQuote } from "../../grounding/quote";
import { AppError } from "../../shared/errors";
import { MAX_FACT_CHARS } from "../../shared/api";
import {
  MAX_MARKDOWN_CHARS,
  type ExtractionVerification,
  type Provenance,
  type RawExtraction,
} from "./types";
import { sourceDate } from "./dates";

/** Known injection patterns; eval and human gates still test semantic leakage. */
export function isInstruction(text: string): boolean {
  if (
    /\b(?:before|after|when|while)\s+(?:you\s+)?(?:generat(?:e|ing)|writ(?:e|ing)|creat(?:e|ing)|tailor(?:ing)?|draft(?:ing)?)\b[^.!?\n]{0,120}\b(?:claim|say|state|write|include|add|list|assert|pretend)\b/i.test(
      text,
    ) ||
    /\b(?:claim|assert|pretend|say|state)\s+(?:that\s+)?(?:I|we)\s+(?:am|was|were|have|had|led|founded|owned|worked)\b/i.test(
      text,
    )
  )
    return true;
  return /(?:ignore|disregard|override)\s+(?:(?:all|any|the|your|previous|prior|above|system)\s+){0,4}(?:instructions?|rules?|prompts?)|(?:system|assistant)\s*:\s|note\s+to\s+(?:AI|language models?|LLMs?)|(?:add|invent|fabricate)\s+(?:every|any|all|fake|false)\s+(?:skills?|claims?|experience|achievements?)/i.test(
    text,
  );
}

function evidence(
  markdown: string,
  item: { quote: string } & Provenance,
  skill = false,
): Span | null {
  let span = item.span;
  if (span) {
    if (!validSpan(markdown, span) || markdown.slice(...span) !== item.quote)
      return null;
  } else
    span =
      locateQuote(markdown, item.quote, { allowShort: skill }) ?? undefined;
  if (!span) return null;
  if (normalizeForQuote(markdown.slice(...span)).length < MIN_QUOTE_CHARS) {
    if (!skill) return null;
    span = lineContext(markdown, span);
  }
  const quote = markdown.slice(...span);
  return quote.length <= 800 &&
    normalizeForQuote(quote).length >= MIN_QUOTE_CHARS
    ? span
    : null;
}

function supportsDate(quote: string, date: string | null): boolean {
  if (!date) return true;
  if (date.length === 4) return new RegExp(`\\b${date}\\b`).test(quote);
  const writtenDates =
    quote.match(
      /\b(?:19|20)\d{2}[-/.](?:0?[1-9]|1[0-2])\b|\b[A-Za-zÀ-ž]{3,12}\.?\s+(?:19|20)\d{2}\b/g,
    ) ?? [];
  return writtenDates.some((written) => sourceDate(written) === date);
}

/** A skill must be a complete literal item, never a fragment inside another word. */
function literalSkill(quote: string, skill: string): boolean {
  const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
    "iu",
  ).test(quote);
}

/** Keep a literal prefix only; a later substring could omit an earlier negation. */
function literalPrefix(quote: string, text: string): boolean {
  const source = quote.trimStart().replace(/^(?:[-*+•]\s+)/u, "");
  if (!source.startsWith(text)) return false;
  const next = source.slice(text.length, text.length + 2);
  return !next || !/^[\p{L}\p{N}]/u.test(next);
}

const ProvenanceSchema = z.object({
  span: z
    .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
    .optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  reviewReasons: z
    .array(z.enum(["low_confidence", "strategy_disagreement"]))
    .optional(),
});

export function verifyExtraction(
  markdown: string,
  raw: RawExtraction,
): ExtractionVerification {
  if (markdown.length > MAX_MARKDOWN_CHARS)
    throw new AppError(
      "invalid",
      "this document is too long to read; upload a resume of a few pages",
    );
  const result: ExtractionVerification = {
    extraction: { roles: [], facts: [] },
    dropped: [],
  };
  const drop = (
    kind: "role" | "fact",
    reason: ExtractionVerification["dropped"][number]["reason"],
  ) => result.dropped.push({ kind, reason });
  if (!ExtractOut.safeParse(raw).success) throw new Error("extraction_shape");
  if (
    [...raw.roles, ...raw.facts].some(
      (item) => !ProvenanceSchema.safeParse(item).success,
    )
  )
    throw new Error("extraction_metadata_shape");
  const duplicateKeys = new Set(
    raw.roles
      .filter(
        (r, i) => raw.roles.findIndex((other) => other.key === r.key) !== i,
      )
      .map((r) => r.key),
  );
  for (const role of raw.roles) {
    if (duplicateKeys.has(role.key)) {
      drop("role", "duplicate_key");
      continue;
    }
    const span = evidence(markdown, role);
    if (!span) {
      drop("role", role.span ? "invalid_span" : "invalid_quote");
      continue;
    }
    const quote = markdown.slice(...span);
    if (isInstruction(quote)) {
      drop("role", "instruction");
      continue;
    }
    const normalizedQuote = normalizeForQuote(quote);
    const unsupported =
      !normalizedQuote.includes(normalizeForQuote(role.org)) ||
      (role.title !== null &&
        !normalizedQuote.includes(normalizeForQuote(role.title))) ||
      !supportsDate(quote, role.startDate) ||
      !supportsDate(quote, role.endDate);
    if (unsupported) {
      drop("role", "unsupported_role");
      continue;
    }
    result.extraction.roles.push({
      ...role,
      org: role.org.trim(),
      title: role.title?.trim() || null,
      quote,
      span,
    });
  }
  const roleKeys = new Set(result.extraction.roles.map((r) => r.key));
  for (const fact of raw.facts) {
    const span = evidence(markdown, fact, fact.kind === "skill");
    if (!span) {
      drop("fact", fact.span ? "invalid_span" : "invalid_quote");
      continue;
    }
    const quote = markdown.slice(...span);
    if (isInstruction(quote) || isInstruction(fact.text)) {
      drop("fact", "instruction");
      continue;
    }
    if (!checkClaim(fact.text, [{ text: quote }]).ok) {
      drop("fact", "unsupported_claim");
      continue;
    }
    // Deterministic number/name/scope checks do not prove semantic entailment:
    // e.g. "increased churn" passes against "reduced churn". Retain the user's
    // original wording, or a literal prefix that retains preceding context.
    // Skills are individual literal items from a sometimes wider evidence line.
    if (fact.kind === "skill" && !literalSkill(quote, fact.text.trim())) {
      drop("fact", "unsupported_claim");
      continue;
    }
    const proposed = fact.text.trim();
    const text =
      fact.kind === "skill" || literalPrefix(quote, proposed)
        ? proposed
        : quote.trim();
    if (text.length > MAX_FACT_CHARS) {
      drop("fact", "unsupported_claim");
      continue;
    }
    const supportedRank = scopeRank(quote) || DEFAULT_RANK;
    const level =
      fact.level && rankOf(fact.level) > supportedRank
        ? levelOfRank(supportedRank)
        : fact.level;
    result.extraction.facts.push({
      ...fact,
      text,
      quote,
      span,
      level: fact.kind === "accomplishment" ? level : null,
      roleKey: fact.roleKey && roleKeys.has(fact.roleKey) ? fact.roleKey : null,
    });
  }
  return result;
}
