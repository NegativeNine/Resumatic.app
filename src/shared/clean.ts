/** Remove presentation syntax from extracted display text without changing its evidence. */
export function cleanExtractedText(value: string): string {
  return value
    .trim()
    .replace(/^(?:(?:[-*+•▪●–‣◦]|\d+[.)]|#{1,6})\s+)+/u, "")
    // Only paired Markdown delimiters at word boundaries are formatting.
    // In particular, keep identifiers such as __init__ and C++ intact.
    .replace(/(?<![\p{L}\p{N}_*])\*\*([^*\n]+?)\*\*(?![\p{L}\p{N}_*])/gu, "$1")
    .replace(/(?<![\p{L}\p{N}_*])\*([^*\n]+?)\*(?![\p{L}\p{N}_*])/gu, "$1")
    .replace(/(?<![\p{L}\p{N}`])`([^`\n]+?)`(?![\p{L}\p{N}`])/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}
