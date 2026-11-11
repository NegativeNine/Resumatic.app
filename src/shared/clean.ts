/** What a list puts before an item of text read from a document: a bullet, a number or a heading mark. */
const LIST_MARKERS = /^(?:(?:[-*+•▪●–‣◦]|\d+[.)]|#{1,6})\s+)+/u;

/**
 * Remove presentation syntax from extracted display text without changing its evidence.
 * `markers` is what counts as a list marker at the start. A caller comparing lines a person may
 * have typed passes a narrower one, because there a leading number can be what the line says.
 */
export function cleanExtractedText(value: string, markers: RegExp = LIST_MARKERS): string {
  return value
    .trim()
    .replace(markers, "")
    // Only paired Markdown delimiters at word boundaries are formatting.
    // In particular, keep identifiers such as __init__ and C++ intact.
    // As in Markdown, an opening mark is followed by a non-space and a closing mark preceded by
    // one, so the marks in "2 * 3 * 4" or "a ` b ` c" are what the line says and stay.
    .replace(/(?<![\p{L}\p{N}_*])\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*(?![\p{L}\p{N}_*])/gu, "$1")
    .replace(/(?<![\p{L}\p{N}_*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\p{L}\p{N}_*])/gu, "$1")
    .replace(/(?<![\p{L}\p{N}`])`(?!\s)([^`\n]+?)(?<!\s)`(?![\p{L}\p{N}`])/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}
