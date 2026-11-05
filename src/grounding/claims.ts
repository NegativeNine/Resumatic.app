import type { Level } from "../shared/api";

// Deterministic checks that a claim says nothing its evidence does not: numbers, names and scope.
// They are deliberately strict; the judge model catches what they cannot see.

export interface NumberToken {
  value: number;
  percent: boolean;
  raw: string;
}

const NUMBER_WORDS: Record<string, number> = {
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

const NUMBER = /(?<![\w.])[$€£]?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?:\s?(%|percent\b|per cent\b|x\b|k\b|thousand\b|mm\b|m\b|million\b|bn\b|b\b|billion\b))?(?![\w])/gi;

/** Every number in the text, with scale words applied and percentages flagged. */
export function numbersIn(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const match of text.matchAll(NUMBER)) {
    const digits = (match[1] ?? "").replace(/,/g, "");
    const unit = (match[2] ?? "").toLowerCase().replace(/\s+/g, " ");
    let value = Number(digits);
    if (!Number.isFinite(value)) continue;
    const percent = unit === "%" || unit === "percent" || unit === "per cent";
    if (!percent && unit) value *= SCALES[unit] ?? 1;
    out.push({ value, percent, raw: match[0].trim() });
  }
  for (const word of text.toLowerCase().match(/\b[a-z]+\b/g) ?? []) {
    const value = NUMBER_WORDS[word];
    if (value !== undefined) out.push({ value, percent: false, raw: word });
  }
  return out;
}

function sameNumber(a: NumberToken, b: NumberToken): boolean {
  return a.percent === b.percent && Math.abs(a.value - b.value) <= 1e-9 * Math.max(1, Math.abs(a.value));
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
    if (/^[$€£]?[\d.,]+(%|k|m|mm|b|bn)?$/i.test(word)) continue;
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
