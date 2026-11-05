/** Quotes shorter than this, once normalised, are too weak to count as evidence. */
export const MIN_QUOTE_CHARS = 8;

/**
 * Normalises text for verbatim comparison: case, curly quotes, dashes, Markdown emphasis,
 * bullet markers and runs of whitespace. Words, numbers and their order are left alone.
 */
export function normalizeForQuote(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ | | /g, " ")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, "$1")
    .replace(/^\s*(?:[-*+•▪●–]|\d+[.)])\s+/gm, " ")
    .replace(/^\s*#{1,6}\s+/gm, " ")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the quote appears in the source, word for word, after normalisation. */
export function quoteIsVerbatim(source: string, quote: string): boolean {
  const q = normalizeForQuote(quote);
  if (q.length < MIN_QUOTE_CHARS) return false;
  return normalizeForQuote(source).includes(q);
}
