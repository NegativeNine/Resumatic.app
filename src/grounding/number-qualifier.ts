/** Preserve the meaning of a bound or approximation when comparing quantities. */
export function numberQualifier(text: string, start: number, end: number): string | null {
  const before = text.slice(Math.max(0, start - 48), start).replace(/(?:[$€£]|\bUSD|\bEUR|\bGBP)\s*[-−]?\s*$/i, "");
  const after = text.slice(end, end + 24);
  if (/(?:≤|<=|\b(?:at most|no more than|up to))\s*$/i.test(before)) return "at-most";
  if (/(?:≥|>=|\b(?:at least|no less than))\s*$/i.test(before)) return "at-least";
  if (/(?:<|\b(?:less than|under|below|fewer than))\s*$/i.test(before)) return "less-than";
  if (/(?:>|\b(?:more than|over|above|greater than))\s*$/i.test(before)) return "more-than";
  if (/\b(?:nearly|almost)\s*$/i.test(before)) return "nearly";
  if (/(?:~|≈|\b(?:about|around|approximately|roughly))\s*$/i.test(before) || /^-?ish\b/i.test(after) || /^\s*and\s+something\b/i.test(after)) return "approximate";
  if (/^\s*(?:\+|-plus\b|or\s+more\b)/i.test(after)) return "at-least";
  return null;
}
