/** Preserve common bounds and explicit negation when comparing quantities. */
export function numberQualifier(text: string, start: number, end: number): string | null {
  const before = (text.slice(Math.max(0, start - 80), start).split(/[\r\n\u2028\u2029]/).at(-1) ?? "")
    .replace(/(?:[$€£]|\bUSD|\bEUR|\bGBP)\s*[-−]?\s*$/i, "")
    .replace(/[^\S\r\n\u2028\u2029]+/g, " ");
  const after = text.slice(end, end + 40).split(/[\r\n\u2028\u2029]/, 1)[0]!;

  // An additional negation can reverse even a recognized bound. Keep such
  // cases distinct instead of inferring its meaning. Restrict the context to
  // the current clause, and do not treat "not only" as a denial.
  const qualify = (kind: string | null, prefixEnd: number): string | null => {
    const prefix = before.slice(0, prefixEnd).split(/[.!?;,:\n]|\b(?:but|however|yet)\b/i).at(-1) ?? "";
    if (/\b(?:not(?!\s+(?:only|just|merely|simply)\b)|never|no|without|hardly|rarely|seldom)\b/i.test(prefix))
      return `uncertain:${kind ?? "exact"}`;
    return kind;
  };
  const bound = (pattern: RegExp, kind: string): string | null | undefined => {
    const match = pattern.exec(before);
    return match ? qualify(kind, match.index) : undefined;
  };

  const negatedBound = /\b(?:not|never)\s+(at\s+most|at\s+least|up\s+to|no\s+more\s+than|no\s+less\s+than)\s*$/i.exec(before);
  if (negatedBound) return qualify(`negated:${negatedBound[1]!.toLowerCase().replace(/\s+/g, " ")}`, negatedBound.index);

  // These negated comparisons are inclusive bounds, not their positive suffix.
  const upper = bound(/(?:≤|<=|\b(?:at most|no more than|up[ -]to|(?:a\s+)?maximum(?:\s+of|\s*:)|(?:no|not|never)\s+(?:(?:more|greater)\s+than|over|above)|(?:less|fewer)\s+than\s+or\s+equal\s+to))\s*$/i, "at-most");
  if (upper !== undefined) return upper;
  const lower = bound(/(?:≥|>=|\b(?:at least|no less than|(?:a\s+)?minimum(?:\s+of|\s*:)|(?:no|not|never)\s+(?:(?:less|fewer)\s+than|under|below)|(?:more|greater)\s+than\s+or\s+equal\s+to))\s*$/i, "at-least");
  if (lower !== undefined) return lower;
  const less = bound(/(?:<|\b(?:less than|under|below|fewer than))\s*$/i, "less-than");
  if (less !== undefined) return less;
  const more = bound(/(?:>|\b(?:more than|over|above|greater than))\s*$/i, "more-than");
  if (more !== undefined) return more;
  const nearly = bound(/\b(?:nearly|almost)\s*$/i, "nearly");
  if (nearly !== undefined) return nearly;
  const approximate = bound(/(?:~|≈|\b(?:about|around|approximately|roughly))\s*$/i, "approximate");
  if (approximate !== undefined) return approximate;
  if (/^-?ish\b/i.test(after) || /^\s*and\s+something\b/i.test(after)) return qualify("approximate", before.length);
  // A short unit phrase may sit between the number and its suffix, as in
  // "10 people or fewer". Do not cross punctuation or a line break.
  const suffixUnit = "(?:[\\p{L}\\p{N}_-]+[^\\S\\r\\n]+){0,4}";
  if (/^\s*(?:\+|-plus\b)/i.test(after) || new RegExp(`^[^\\S\\r\\n]*${suffixUnit}(?:or\\s+more|at\\s+least|minimum)\\b`, "iu").test(after))
    return qualify("at-least", before.length);
  if (new RegExp(`^[^\\S\\r\\n]*${suffixUnit}(?:or\\s+(?:fewer|less)|at\\s+most|maximum)\\b`, "iu").test(after))
    return qualify("at-most", before.length);
  return qualify(null, before.length);
}
