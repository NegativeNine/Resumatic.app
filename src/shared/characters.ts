// Characters that stand for other characters, or that are not seen at all. Splitting
// (src/pipeline/split.ts) and the grounding checks (src/grounding/claims.ts) read a line through
// these one definitions, so what counts as "didn't" cannot drift between them.
//
// Both patterns are global, for use with `replace` only.

/**
 * Whatever was typed or read where an apostrophe belongs: a quotation mark of either hand, an
 * accent standing alone, a prime, or a modifier letter that only looks like one. "Didn`t" and
 * "didn‘t" deny exactly what "didn't" denies.
 */
export const APOSTROPHES = /['′‵＇\p{Pi}\p{Pf}\p{Sk}\p{Lm}]/gu;

/** A character that is not shown: a soft hyphen, a zero-width space or joiner, a mark of direction. */
export const UNSEEN = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * The text without control characters (other than tab and newline), zero-width characters, or
 * marks of direction, which can show text in one order while it is read, and searched, in
 * another. A job posting is read through exactly this; pasted text also loses everything `UNSEEN`
 * matches (src/shared/paste.ts).
 */
export function withoutHiddenControls(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

// An apostrophe of any spelling between the "n" and the final "t" of a word: the "n't" of a denial.
const DENIAL_APOSTROPHE = new RegExp(`(?<=n)${APOSTROPHES.source}(?=t(?!\\p{L}))`, "giu");

/**
 * The text as a person reads it: without the characters that are not shown, and with "n't" written
 * with a straight apostrophe whichever one it was written with. Any other apostrophe is left as it
 * is, because there it is a possessive or a quotation mark and joins nothing.
 */
export function asRead(text: string): string {
  return text.replace(UNSEEN, "").replace(DENIAL_APOSTROPHE, "'");
}
