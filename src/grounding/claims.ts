import type { Level } from "../shared/api";

// Deterministic checks that a claim says nothing its evidence does not: numbers, names and scope.
// They are deliberately strict; the judge model catches what they cannot see.

export interface NumberToken {
  value: number;
  percent: boolean;
  multiplier: boolean;
  /** Ordinal rank or sequence (e.g. fifth), distinct from a count of five. */
  ordinal: boolean;
  currency: "dollar" | "euro" | "sterling" | "conflicting" | null;
  raw: string;
  /** A number in an explicit date context, not an achievement count. */
  date: boolean;
  /** Date position where recognizable; first/second retain ambiguous numeric order. */
  datePart: "year" | "month" | "day" | "first" | "second" | null;
  /** Canonical recognized date, so parts from separate dates cannot be combined. */
  dateKey: string | null;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  dozen: 12,
  twenty: 20,
  hundred: 100,
};

const SCALES: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mm: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
};

const ORDINAL_UNITS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
  seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11,
  twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15,
  sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19,
  twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50,
  sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90,
};
const ORDINAL_TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};
const ORDINAL_UNIT_PATTERN = Object.keys(ORDINAL_UNITS).join("|");
const ORDINAL_TENS_PATTERN = Object.keys(ORDINAL_TENS).join("|");
const ORDINAL_WORD_PATTERN = `(?:(?:${ORDINAL_TENS_PATTERN})[\\s-]+(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|${ORDINAL_UNIT_PATTERN})`;
const ORDINAL = new RegExp(`(?<![\\p{L}\\p{N}_])(?:\\d+(?:st|nd|rd|th)|${ORDINAL_WORD_PATTERN})(?![\\p{L}\\p{N}_])`, "giu");

function ordinalValue(text: string): number {
  const lower = text.toLowerCase();
  if (/^\d/.test(lower)) return Number.parseInt(lower, 10);
  const parts = lower.split(/[\s-]+/);
  return parts.length === 1
    ? ORDINAL_UNITS[parts[0]!]!
    : ORDINAL_TENS[parts[0]!]! + ORDINAL_UNITS[parts[1]!]!;
}

const NUMBER = /(?<![\w.])(?:([+\-−])\s*)?(?:([$€£]|USD\b|EUR\b|GBP\b)\s*)?([+\-−])?((?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?|\.\d+)(?:e[+\-]?\d+)?)(?:\s?(%|percent\b|per cent\b|x\b|×|times\b|-?fold\b|k\b|thousand\b|mm\b|m\b|million\b|bn\b|b\b|billion\b))?(?:\s?(dollars?|euros?|pounds?\s+sterling|USD|EUR|GBP)\b)?(?![\w])/gi;
const WORD_NUMBER = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|twenty|hundred)(?=\b|fold\b)(?:\s*(%|percent\b|per cent\b|x\b|×|times\b|-?fold\b))?(?:\s*(dollars?|euros?|pounds?\s+sterling|USD|EUR|GBP)\b)?/gi;

function currencyOf(unit: string | undefined): NumberToken["currency"] {
  const normalized = unit?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "$" || normalized === "usd" || /^dollars?$/.test(normalized)) return "dollar";
  if (normalized === "€" || normalized === "eur" || /^euros?$/.test(normalized)) return "euro";
  if (normalized === "£" || normalized === "gbp" || /^pounds?\s+sterling$/.test(normalized)) return "sterling";
  return null;
}

function isMultiplier(unit: string): boolean {
  return /^(?:x|×|times|-?fold)$/.test(unit);
}

/** Identify common explicit year contexts; ambiguous cases still need the model judge. */
function isDateYear(text: string, index: number, digits: string): boolean {
  if (!/^(?:19|20)\d{2}$/.test(digits)) return false;
  const before = text.slice(Math.max(0, index - 32), index);
  const after = text.slice(index + digits.length, index + digits.length + 32);
  return /\b(?:in|during|since|from|to|until|through|by|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+$/i.test(before) ||
    /\b(?:19|20)\d{2}\s*(?:[-–—]|to|through)\s*$/i.test(before) ||
    /^\s*(?:[-–—]|to|through)\s*(?:(?:19|20)\d{2}|present|current|now)\b/i.test(after) ||
    /^[-/]\d{1,2}(?:[-/]\d{1,2})?\b/.test(after);
}

type DatePart = NonNullable<NumberToken["datePart"]>;
type DateComponent = { start: number; end: number; part: DatePart; key: string };

/** Recognize common numeric and written dates without guessing an ambiguous locale. */
function dateComponents(text: string): { components: DateComponent[]; numericRanges: [number, number][]; ordinalRanges: [number, number][] } {
  const components: DateComponent[] = [];
  const numericRanges: [number, number][] = [];
  const ordinalRanges: [number, number][] = [];
  const pad = (value: string) => value.padStart(2, "0");
  const mark = (start: number, value: string, part: DatePart, key: string) => components.push({ start, end: start + value.length, part, key });
  for (const match of text.matchAll(/\b((?:19|20)\d{2})([-/.])(0?[1-9]|1[0-2])(?:\2(0?[1-9]|[12]\d|3[01]))?\b/g)) {
    const start = match.index;
    const month = start + match[1]!.length + 1;
    const key = `iso:${match[1]}:${pad(match[3]!)}${match[4] ? `:${pad(match[4])}` : ""}`;
    mark(start, match[1]!, "year", key);
    mark(month, match[3]!, "month", key);
    if (match[4]) mark(month + match[3]!.length + 1, match[4], "day", key);
    numericRanges.push([start, start + match[0].length]);
  }
  // Retain the two positions rather than guessing whether the user wrote
  // month/day or day/month. The year remains comparable to a standalone year.
  for (const match of text.matchAll(/\b(0?[1-9]|[12]\d|3[01])([-/\.])(0?[1-9]|[12]\d|3[01])\2((?:19|20)\d{2})\b/g)) {
    const start = match.index;
    const second = start + match[1]!.length + 1;
    const key = `ambiguous:${match[4]}:${pad(match[1]!)}:${pad(match[3]!)}`;
    mark(start, match[1]!, "first", key);
    mark(second, match[3]!, "second", key);
    mark(second + match[3]!.length + 1, match[4]!, "year", key);
    numericRanges.push([start, start + match[0].length]);
  }
  const month = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const monthNumber = (name: string) => pad(String(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(name.slice(0, 3).toLowerCase()) + 1));
  // Written ordinal days must remain dates, not evidence for an unrelated rank.
  for (const match of text.matchAll(new RegExp(`\\b(${month})\\.?\\s+(${ORDINAL_WORD_PATTERN})(?:,\\s*|\\s+)((?:19|20)\\d{2})\\b`, "gi"))) {
    const day = ordinalValue(match[2]!);
    if (day < 1 || day > 31) continue;
    const key = `iso:${match[3]}:${monthNumber(match[1]!)}:${pad(String(day))}`;
    mark(match.index + match[0].indexOf(match[2]!), match[2]!, "day", key);
    mark(match.index + match[0].lastIndexOf(match[3]!), match[3]!, "year", key);
  }
  for (const match of text.matchAll(new RegExp(`\\b(${ORDINAL_WORD_PATTERN})\\s+(${month})\\.?\\s+((?:19|20)\\d{2})\\b`, "gi"))) {
    const day = ordinalValue(match[1]!);
    if (day < 1 || day > 31) continue;
    const key = `iso:${match[3]}:${monthNumber(match[2]!)}:${pad(String(day))}`;
    mark(match.index, match[1]!, "day", key);
    mark(match.index + match[0].lastIndexOf(match[3]!), match[3]!, "year", key);
  }
  for (const match of text.matchAll(new RegExp(`\\b(${month})\\.?\\s+(\\d{1,2})(st|nd|rd|th)?(?:,\\s*|\\s+)((?:19|20)\\d{2})\\b`, "gi"))) {
    const day = match.index + match[0].indexOf(match[2]!);
    const year = match.index + match[0].lastIndexOf(match[4]!);
    const key = `iso:${match[4]}:${monthNumber(match[1]!)}:${pad(match[2]!)}`;
    mark(day, match[2]!, "day", key);
    mark(year, match[4]!, "year", key);
    if (match[3]) ordinalRanges.push([day + match[2]!.length, day + match[2]!.length + match[3].length]);
  }
  for (const match of text.matchAll(new RegExp(`\\b(\\d{1,2})(st|nd|rd|th)?\\s+(${month})\\.?\\s+((?:19|20)\\d{2})\\b`, "gi"))) {
    const key = `iso:${match[4]}:${monthNumber(match[3]!)}:${pad(match[1]!)}`;
    mark(match.index, match[1]!, "day", key);
    mark(match.index + match[0].lastIndexOf(match[4]!), match[4]!, "year", key);
    if (match[2]) ordinalRanges.push([match.index + match[1]!.length, match.index + match[1]!.length + match[2].length]);
  }
  for (const match of text.matchAll(new RegExp(`\\b(${month})\\.?\\s+((?:19|20)\\d{2})\\b`, "gi"))) {
    const year = match.index + match[0].lastIndexOf(match[2]!);
    if (components.some((item) => item.start === year)) continue;
    mark(year, match[2]!, "year", `iso:${match[2]}:${monthNumber(match[1]!)}`);
  }
  return { components, numericRanges, ordinalRanges };
}

/** Every number in the text, with scale words applied and percentages flagged. */
export function numbersIn(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  // Mark every component of an explicit ISO-style date, including its month
  // and day. Otherwise those values can be reused as unrelated counts.
  const dates = dateComponents(text);
  const ordinals = [...text.matchAll(ORDINAL)].filter((match) => {
    const following = text.slice(match.index + match[0].length);
    // Common idioms do not assert a literal position in a sequence.
    if (match[0].toLowerCase() === "first" && /^(?:\s+aid\b|[-\s]+(?:class|hand)\b)/i.test(following)) return false;
    if (match[0].toLowerCase() === "second" && /^\s+to\s+none\b/i.test(following)) return false;
    // "one second" is a duration, while "a second award" is ordinal.
    // Restrict the latter exception to common duration contexts.
    if (match[0].toLowerCase() !== "second") return true;
    const before = text.slice(0, match.index);
    if (/(?:\bone\s+|\d+\s+)$/i.test(before)) return false;
    if (/\b(?:a|per|each|every)\s+$/i.test(before) &&
        /^(?:\s*$|\s*[,.;:!?]|\s+(?:of|before|after|later|earlier|long|faster|slower|delay|latency|wait)\b)/i.test(following)) return false;
    return true;
  });
  // In a dotted date a period separates components; the number scanner
  // otherwise interprets the year and month as a decimal. Preserve offsets.
  const scan = text.split("");
  for (const [start, end] of dates.numericRanges)
    for (let i = start; i < end; i++) if (scan[i] === ".") scan[i] = "/";
  // Do not let an ordinal suffix hide a written day from the number scanner.
  for (const [start, end] of dates.ordinalRanges)
    for (let i = start; i < end; i++) scan[i] = " ";
  for (const match of scan.join("").matchAll(NUMBER)) {
    const digits = (match[4] ?? "").replace(/,/g, "");
    const unit = (match[5] ?? "").toLowerCase().replace(/\s+/g, " ");
    let value = Number(digits);
    // Keep an unrepresentable number as a token that cannot match; dropping
    // it would allow an unsupported quantity to evade the numeric check.
    if (!Number.isFinite(value) || (value === 0 && /[1-9]/.test(digits.split(/e/i)[0]!))) value = Infinity;
    const prefix = text.slice(0, match.index);
    // A spaced hyphen between two years is a date range, not a negative year.
    const digitIndex = match.index + match[0].indexOf(match[4]!);
    const component = dates.components.find((item) => digitIndex >= item.start && digitIndex < item.end);
    const yearRange = match[1] === "-" && !match[2] && !match[3] && /\b(?:19|20)\d{2}\s*$/.test(prefix) && /^(?:19|20)\d{2}$/.test(digits);
    if (!component && !yearRange && ([match[1], match[3]].some((sign) => sign === "-" || sign === "−") || /\b(?:minus|negative)\s+$/i.test(prefix))) value = -value;
    const percent = unit === "%" || unit === "percent" || unit === "per cent";
    if (!percent && unit) value *= SCALES[unit] ?? 1;
    const prefixCurrency = currencyOf(match[2]);
    const suffixCurrency = currencyOf(match[6]);
    // Conflicting units cannot be treated as any supported quantity.
    const currency = prefixCurrency && suffixCurrency && prefixCurrency !== suffixCurrency ? "conflicting" : prefixCurrency ?? suffixCurrency;
    const datePart = component?.part ?? (isDateYear(text, digitIndex, digits) ? "year" : null);
    out.push({ value, percent, multiplier: isMultiplier(unit), ordinal: false, currency, raw: text.slice(match.index, match.index + match[0].length).trim(), date: datePart !== null, datePart, dateKey: component?.key ?? null });
  }
  // Prevent the cardinal part of "twenty-first" being counted separately.
  const wordScan = text.split("");
  for (const match of ordinals)
    for (let i = match.index; i < match.index + match[0].length; i++) wordScan[i] = " ";
  for (const match of wordScan.join("").matchAll(WORD_NUMBER)) {
    const magnitude = NUMBER_WORDS[match[1]!.toLowerCase()];
    if (magnitude === undefined) continue;
    const value = /\b(?:minus|negative)\s+(?:(?:[$€£]|USD|EUR|GBP)\s*)?$/i.test(text.slice(0, match.index)) ? -magnitude : magnitude;
    const unit = (match[2] ?? "").toLowerCase().replace(/\s+/g, " ");
    const prefix = text.slice(0, match.index).match(/(?:[$€£]|\b(?:USD|EUR|GBP))\s*$/i)?.[0];
    const prefixCurrency = currencyOf(prefix);
    const suffixCurrency = currencyOf(match[3]);
    const currency = prefixCurrency && suffixCurrency && prefixCurrency !== suffixCurrency ? "conflicting" : prefixCurrency ?? suffixCurrency;
    out.push({ value, percent: unit === "%" || unit === "percent" || unit === "per cent", multiplier: isMultiplier(unit), ordinal: false, currency, raw: match[0].trim(), date: false, datePart: null, dateKey: null });
  }
  for (const match of ordinals) {
    const component = dates.components.find((item) => item.start === match.index && item.part === "day");
    // Numeric ordinal date days were already included in the numeric scan.
    if (component && /^\d/.test(match[0])) continue;
    out.push({ value: ordinalValue(match[0]), percent: false, multiplier: false,
      ordinal: !component, currency: null, raw: match[0], date: !!component,
      datePart: component ? "day" : null, dateKey: component?.key ?? null });
  }
  return out;
}

function sameNumber(a: NumberToken, b: NumberToken): boolean {
  if (!Number.isFinite(a.value) || !Number.isFinite(b.value)) return false;
  if ((Number.isInteger(a.value) && !Number.isSafeInteger(a.value)) ||
      (Number.isInteger(b.value) && !Number.isSafeInteger(b.value))) return false;
  const dateSupported = a.dateKey === null || b.dateKey === a.dateKey || (b.dateKey !== null && b.dateKey.startsWith(`${a.dateKey}:`));
  return a.currency !== "conflicting" && b.currency !== "conflicting" && a.percent === b.percent && a.multiplier === b.multiplier && a.ordinal === b.ordinal && a.currency === b.currency && a.date === b.date && a.datePart === b.datePart && dateSupported && Math.abs(a.value - b.value) <= 2 * Number.EPSILON * Math.max(1, Math.abs(a.value), Math.abs(b.value));
}

/** Numbers in the claim that no evidence number matches. */
export function unsupportedNumbers(claim: string, evidence: string): string[] {
  const known = numbersIn(evidence);
  return numbersIn(claim)
    .filter((n) => !known.some((k) => sameNumber(n, k)))
    .map((n) => n.raw);
}

const NOT_NAMES = new Set(["i", "a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "for", "with", "by", "via"]);

/**
 * Proper names and technical terms: words with digits or symbols inside (C++, Node.js, S3, GPT-4),
 * acronyms, and capitalised words that do not start a sentence.
 */
export function namesIn(text: string): string[] {
  const names: string[] = [];
  const words = text.split(/\s+/).filter(Boolean);
  let sentenceStart = true;
  for (const rawWord of words) {
    const word = rawWord.replace(/^[("'\[{]+/, "").replace(/[)"'\]},.;:!?]+$/, "");
    const startsSentence = sentenceStart;
    sentenceStart = /[.!?:;]$/.test(rawWord);
    if (!word || NOT_NAMES.has(word.toLowerCase())) continue;
    if (/^[$€£]?[\d.,]+(%|k|m|mm|b|bn|st|nd|rd|th)?$/i.test(word)) continue;
    const technical = /[A-Za-z]/.test(word) && (/\d/.test(word) || /[+#]/.test(word) || /\w\.\w/.test(word));
    const acronym = /^[A-Z][A-Z0-9&]{1,}s?$/.test(word);
    const capitalised = /^[A-Z]/.test(word) && !startsSentence;
    if (technical || acronym || capitalised) names.push(word);
  }
  return names;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Names in the claim that do not appear in the evidence. */
export function unsupportedNames(claim: string, evidence: string): string[] {
  const haystack = evidence.toLowerCase();
  return namesIn(claim).filter((name) => {
    const pattern = new RegExp(`(?<![a-z0-9])${escapeRegExp(name.toLowerCase())}(?![a-z0-9])`);
    return !pattern.test(haystack);
  });
}

// ---- scope ----

const LEVEL_RANK: Record<Level, number> = { contributed: 1, implemented: 2, led: 3, owned: 4, founded: 5 };
const RANK_LEVEL: Level[] = ["contributed", "contributed", "implemented", "led", "owned", "founded"];

/** Scope a claim asserts when it has no scope verb at all. */
export const DEFAULT_RANK = 2;

const VERBS: Record<number, string[]> = {
  1: ["help", "assist", "support", "contribute", "participate", "collaborate"],
  2: [
    "build", "implement", "develop", "design", "create", "write", "deliver", "ship", "engineer", "migrate",
    "improve", "optimize", "optimise", "reduce", "increase", "automate", "analyze", "analyse", "maintain",
    "configure", "deploy", "test", "integrate", "refactor", "launch", "prototype", "research", "document",
    "debug", "fix", "model", "train", "scale", "streamline", "cut", "grow", "boost", "achieve", "produce",
    "prepare", "conduct", "perform", "execute", "introduce", "redesign", "rebuild",
  ],
  3: ["lead", "manage", "coordinate", "mentor", "supervise", "oversee", "drive", "spearhead", "guide", "coach", "chair", "organize", "organise"],
  4: ["architect", "direct", "head", "establish", "define", "champion", "pioneer"],
  5: ["co-found", "cofound"],
};

const IRREGULAR: Record<string, number> = {
  led: 3, leading: 3, leads: 3, lead: 3,
  built: 2, wrote: 2, written: 2, grew: 2, grown: 2, ran: 2,
  drove: 3, driven: 3, oversaw: 3, overseen: 3,
  owned: 4, owning: 4, owner: 4, ownership: 4,
  founded: 5, founding: 5, founder: 5, "co-founder": 5, cofounder: 5,
  shipped: 2, shipping: 2, cutting: 2, scoped: 2,
  manager: 3, mentored: 3, mentoring: 3,
};

const CONTRIBUTION = new Set([
  "help", "helped", "helping", "helps", "assist", "assisted", "assisting", "assists",
  "support", "supported", "supporting", "supports", "contribute", "contributed", "contributing", "contributes",
]);

function formsOf(base: string): string[] {
  const forms = [base, `${base}s`];
  if (base.endsWith("e")) forms.push(`${base}d`, `${base.slice(0, -1)}ing`);
  else if (/[^aeiou]y$/.test(base)) forms.push(`${base.slice(0, -1)}ies`, `${base.slice(0, -1)}ied`, `${base}ing`);
  else forms.push(`${base}ed`, `${base}ing`, `${base}es`);
  return forms;
}

const VERB_RANK = new Map<string, number>();
for (const [rank, bases] of Object.entries(VERBS)) {
  for (const base of bases) for (const form of formsOf(base)) VERB_RANK.set(form, Number(rank));
}
for (const [form, rank] of Object.entries(IRREGULAR)) VERB_RANK.set(form, rank);

/** The highest scope the text asserts, 0 if it has no scope verb. "Helped lead" counts as contributed. */
export function scopeRank(text: string): number {
  const tokens = text.toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) ?? [];
  let best = 0;
  tokens.forEach((token, i) => {
    let rank = VERB_RANK.get(token) ?? 0;
    if (rank >= 2 && (CONTRIBUTION.has(tokens[i - 1] ?? "") || CONTRIBUTION.has(tokens[i - 2] ?? ""))) rank = 1;
    if (rank > best) best = rank;
  });
  return best;
}

export function rankOf(level: Level | null | undefined): number {
  return level ? LEVEL_RANK[level] : 0;
}

export function levelOfRank(rank: number): Level {
  return RANK_LEVEL[Math.max(1, Math.min(5, rank))] ?? "implemented";
}

export interface Evidence {
  text: string;
  quote?: string | null;
  level?: Level | null;
}

export interface CheckResult {
  ok: boolean;
  problems: string[];
}

/** Checks one claim against its evidence: numbers, names and scope. */
export function checkClaim(claim: string, evidence: Evidence[]): CheckResult {
  const corpus = evidence.map((e) => [e.text, e.quote ?? ""].join("\n")).join("\n");
  const problems: string[] = [];
  const numbers = unsupportedNumbers(claim, corpus);
  if (numbers.length) problems.push(`numbers not in the evidence: ${numbers.join(", ")}`);
  const names = unsupportedNames(claim, corpus);
  if (names.length) problems.push(`names not in the evidence: ${names.join(", ")}`);
  const claimed = scopeRank(claim);
  const supported = Math.max(
    ...evidence.map((e) => Math.max(rankOf(e.level), scopeRank(e.text), scopeRank(e.quote ?? ""))),
    0,
  );
  const allowed = supported > 0 ? supported : DEFAULT_RANK;
  if (claimed > allowed) problems.push(`claims more scope (${levelOfRank(claimed)}) than the evidence (${levelOfRank(allowed)})`);
  return { ok: problems.length === 0, problems };
}
