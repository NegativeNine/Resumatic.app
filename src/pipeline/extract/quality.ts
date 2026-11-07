export type QualityReason = "little-text" | "short-lines" | "no-structure";
/** Heuristics for review, not proof that conversion is accurate.
 * A page count is accepted only from a trustworthy source; unknown stays null.
 * When it is unknown, under 200 characters total is still sparse regardless of
 * how many pages the document had, without pretending the document has one page.
 */
export function conversionQuality(
  markdown: string,
  pages?: number | null,
): { ok: boolean; reasons: QualityReason[]; pageCount: number | null } {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const reasons: QualityReason[] = [];
  const pageCount =
    typeof pages === "number" && Number.isSafeInteger(pages) && pages > 0
      ? pages
      : null;
  const characters = markdown.replace(/\s/g, "").length;
  if (pageCount === null ? characters < 200 : characters / pageCount < 200)
    reasons.push("little-text");
  if (
    lines.length >= 12 &&
    lines.filter((line) => line.split(/\s+/).length < 3).length / lines.length >
      0.7
  )
    reasons.push("short-lines");
  if (markdown.length > 1500 && lines.length < 3) reasons.push("no-structure");
  return { ok: reasons.length === 0, reasons, pageCount };
}
