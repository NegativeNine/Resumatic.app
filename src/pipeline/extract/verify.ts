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
import { supportedRoleAssignment } from "./role-assignment";

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

/** A name or title must not be an empty string or the middle of another word. */
function supportsRoleField(quote: string, field: string): boolean {
  const source = normalizeForQuote(quote);
  const value = normalizeForQuote(field);
  if (!value) return false;
  const word = (character: string | undefined) =>
    character !== undefined && /[\p{L}\p{M}\p{N}]/u.test(character);
  const first = Array.from(value)[0];
  const last = Array.from(value).at(-1);
  let from = 0;
  for (;;) {
    const at = source.indexOf(value, from);
    if (at < 0) return false;
    const before = Array.from(source.slice(0, at)).at(-1);
    const after = Array.from(source.slice(at + value.length))[0];
    if (!(word(first) && word(before)) && !(word(last) && word(after)))
      return true;
    from = at + 1;
  }
}

/** A missing end renders as "Present", so it must be stated as the end of this role. */
function supportsCurrent(quote: string, startDate: string): boolean {
  // More than one distinct year in the header may identify an ended role or
  // another role; do not infer that this start belongs to the current range.
  const years = new Set(quote.match(/\b(?:19|20)\d{2}\b/g) ?? []);
  if ([...years].some((year) => year !== startDate.slice(0, 4))) return false;
  const ranges = quote.matchAll(
    /\b((?:[A-Za-zÀ-ž]{3,12}\.?\s+)?(?:19|20)\d{2}(?:[-/.](?:0?[1-9]|1[0-2]))?)\s*(?:[-–—]|to|bis|hasta)\s*(?:present|current|now|heute|actualidad)\b/gi,
  );
  for (const range of ranges) {
    const date = sourceDate(range[1]!);
    if (date === startDate || (startDate.length === 4 && date?.startsWith(startDate)))
      return true;
  }
  // Structured exports put these fields on separate labeled lines. Match
  // the labeled start to the proposed start rather than any year in the quote.
  const labeledStart = quote.match(
    /(?:^|\n)[ \t]*(?:started on|start date)[ \t]*:[ \t]*([^\r\n]+)/i,
  );
  const parsedStart = sourceDate(labeledStart?.[1] ?? null);
  return Boolean(
    (parsedStart === startDate ||
      (startDate.length === 4 && parsedStart?.startsWith(startDate))) &&
      /(?:^|\n)[ \t]*(?:finished on|end date)[ \t]*:[ \t]*(?:present|current|now|heute|actualidad)[ \t]*(?:\r?\n|$)/i.test(quote),
  );
}

function reversedDates(start: string | null, end: string | null): boolean {
  if (!start || !end) return false;
  if (start.slice(0, 4) !== end.slice(0, 4)) return start.slice(0, 4) > end.slice(0, 4);
  return start.length === 7 && end.length === 7 && start > end;
}

function dateMatches(source: string | null, expected: string): boolean {
  const parsed = sourceDate(source);
  return parsed === expected || Boolean(expected.length === 4 && parsed?.startsWith(expected));
}

function writtenRanges(quote: string): RegExpMatchArray[] {
  return [...quote.matchAll(
    /\b((?:[A-Za-zÀ-ž]{3,12}\.?\s+)?(?:19|20)\d{2}(?:[-/.](?:0?[1-9]|1[0-2]))?)\s*(?:[-–—]|to|bis|hasta)\s*((?:[A-Za-zÀ-ž]{3,12}\.?\s+)?(?:19|20)\d{2}(?:[-/.](?:0?[1-9]|1[0-2]))?)\b/gi,
  )];
}

/** Both endpoints must belong to one range, not two unrelated years. */
function supportsRange(quote: string, start: string, end: string): boolean {
  const ranges = writtenRanges(quote);
  if (ranges.length > 0)
    return ranges.length === 1 && dateMatches(ranges[0]![1]!, start) && dateMatches(ranges[0]![2]!, end);
  // Parser-generated LinkedIn rows use labeled fields rather than a range.
  const labeledStart = quote.match(/(?:^|\n)[ \t]*(?:started on|start date)[ \t]*:[ \t]*([^\r\n]+)/i);
  const labeledEnd = quote.match(/(?:^|\n)[ \t]*(?:finished on|end date)[ \t]*:[ \t]*([^\r\n]+)/i);
  return Boolean(labeledStart && labeledEnd && dateMatches(labeledStart[1]!, start) && dateMatches(labeledEnd[1]!, end));
}

/** With no start date, a year can be printed as an end only when its role is explicit. */
function supportsEndOnly(quote: string, end: string): boolean {
  const ranges = writtenRanges(quote);
  if (ranges.length > 0)
    return ranges.length === 1 && dateMatches(ranges[0]![2]!, end);
  const labeledEnds = [...quote.matchAll(/(?:^|\n)[ \t]*(?:finished on|end date)[ \t]*:[ \t]*([^\r\n]+)/gi)];
  return labeledEnds.length === 1 && dateMatches(labeledEnds[0]![1]!, end);
}

/** Semicolons may separate several roles on one converted source line. */
function ambiguousRoleDateLine(quote: string): boolean {
  return quote.split(/\r?\n/u).some((line) =>
    /[;；]/u.test(line) && /\b(?:19|20)\d{2}\b/u.test(line),
  );
}

const SKILL_QUALIFIER =
  /\b(?:no|not|never|without|lack(?:s|ed|ing)?|unfamiliar|inexperienced|learning|beginner|novice|limited)\b/i;

/** A skill must appear as a complete item in a structured skills line. */
function literalSkill(
  quote: string,
  skill: string,
  precedingLine: string,
  beforeHeading: string,
): boolean {
  // A qualifier can apply to a whole list, even if a particular item is a
  // literal match (e.g. "No experience with Python, Java"). Be conservative.
  if (SKILL_QUALIFIER.test(quote) || SKILL_QUALIFIER.test(precedingLine))
    return false;
  const normalize = (s: string) =>
    s.trim().replace(/^[\s#*`_•-]+|[\s*`_]+$/gu, "").toLocaleLowerCase();
  const text = quote.trim().replace(/^\s*(?:[-*+•]\s+|#{1,6}\s+)/u, "");
  // An isolated item may belong to a preceding negative heading. Require a
  // positive heading on the same line; other formats need user confirmation.
  const list = text.match(/^(?:technical\s+)?skills?\s*:\s*(.+)$/iu);
  const hasHeading = /^\s*#{0,6}\s*(?:technical\s+)?skills?\s*:?\s*$/iu.test(precedingLine);
  if (!list && (!hasHeading || SKILL_QUALIFIER.test(beforeHeading))) return false;
  const items = (list?.[1] ?? text).split(/[,;|\t•]/u);
  return items.some((item) => normalize(item) === normalize(skill));
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
  opts: { structuredSkillSpans?: ReadonlySet<string> } = {},
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
    const matchedSpan = evidence(markdown, role);
    if (!matchedSpan) {
      drop("role", role.span ? "invalid_span" : "invalid_quote");
      continue;
    }
    const matchedQuote = markdown.slice(...matchedSpan);
    // Include the whole line: a model may quote only a current-looking prefix
    // while the rest of that same header says the role ended.
    const span = lineContext(markdown, matchedSpan);
    const quote = markdown.slice(...span);
    if (quote.length > 800) {
      drop("role", "invalid_quote");
      continue;
    }
    if (isInstruction(quote)) {
      drop("role", "instruction");
      continue;
    }
    const unsupported =
      !supportsRoleField(matchedQuote, role.org) ||
      (role.title !== null &&
        !supportsRoleField(matchedQuote, role.title)) ||
      !supportsDate(matchedQuote, role.startDate) ||
      !supportsDate(matchedQuote, role.endDate);
    if (unsupported) {
      drop("role", "unsupported_role");
      continue;
    }
    // A single range may belong to another role in the same line; range count
    // alone cannot establish its owner. Keep the role but clear ambiguous dates.
    const invalidRange = ambiguousRoleDateLine(quote) || reversedDates(role.startDate, role.endDate) ||
      Boolean(role.startDate && role.endDate && !supportsRange(quote, role.startDate, role.endDate)) ||
      Boolean(!role.startDate && role.endDate && !supportsEndOnly(quote, role.endDate));
    result.extraction.roles.push({
      ...role,
      org: role.org.trim(),
      title: role.title?.trim() || null,
      // A start without an end is rendered as ongoing. Do not turn an omitted
      // or missed end date into a claim of current employment.
      startDate:
        invalidRange || (role.startDate && !role.endDate && !supportsCurrent(quote, role.startDate))
          ? null
          : role.startDate,
      endDate: invalidRange ? null : role.endDate,
      quote,
      span,
    });
  }
  const seenFactLines = new Set<string>();
  for (const fact of raw.facts) {
    const matchedSpan = evidence(markdown, fact, fact.kind === "skill");
    if (!matchedSpan) {
      drop("fact", fact.span ? "invalid_span" : "invalid_quote");
      continue;
    }
    // A model can quote only the start or end of a line, omitting a qualifier
    // or negation. Keep its complete line as source evidence and text.
    const span = lineContext(markdown, matchedSpan);
    const quote = markdown.slice(...span);
    if (quote.length > 800) {
      drop("fact", "invalid_quote");
      continue;
    }
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
    // entire source line rather than a prefix that may omit a qualifier.
    // Skills are individual literal items from a sometimes wider evidence line.
    const before = markdown.slice(0, span[0]).split("\n").filter((s) => s.trim());
    const precedingLine = before.at(-1) ?? "";
    const beforeHeading = before.at(-2) ?? "";
    // LinkedIn skill cells are chosen by the CSV parser, not by the model.
    // Require the exact cell value and still reject obvious qualifiers.
    const structuredSkill = fact.span && opts.structuredSkillSpans?.has(JSON.stringify(fact.span)) &&
      markdown.slice(...fact.span).trim() === fact.text.trim() &&
      !SKILL_QUALIFIER.test(fact.text);
    if (
      fact.kind === "skill" &&
      !structuredSkill &&
      !literalSkill(quote, fact.text.trim(), precedingLine, beforeHeading)
    ) {
      drop("fact", "unsupported_claim");
      continue;
    }
    const proposed = fact.text.trim();
    const text = fact.kind === "skill" ? proposed : quote.trim().replace(/^(?:[-*+•▪●–]\s+|\d+[.)]\s+)/u, "");
    if (text.length > MAX_FACT_CHARS) {
      drop("fact", "unsupported_claim");
      continue;
    }
    const resolvedRoleKey = supportedRoleAssignment(
      markdown,
      span,
      fact.roleKey,
      result.extraction.roles,
    );
    const factLineKey = JSON.stringify([resolvedRoleKey, ...span]);
    if (fact.kind !== "skill" && seenFactLines.has(factLineKey)) continue;
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
      roleKey: resolvedRoleKey,
    });
    if (fact.kind !== "skill") seenFactLines.add(factLineKey);
  }
  return result;
}
