export type QualityReason = "little-text" | "short-lines" | "no-structure";
/** Heuristics for review/routing, not proof that a conversion is accurate. */
export function conversionQuality(
  markdown: string,
  pages = 1,
): { ok: boolean; reasons: QualityReason[] } {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const reasons: QualityReason[] = [];
  const pageCount = Number.isFinite(pages) && pages > 0 ? pages : 1;
  if (markdown.replace(/\s/g, "").length / pageCount < 200)
    reasons.push("little-text");
  if (
    lines.length >= 12 &&
    lines.filter((line) => line.split(/\s+/).length < 3).length / lines.length >
      0.7
  )
    reasons.push("short-lines");
  if (markdown.length > 1500 && lines.length < 3) reasons.push("no-structure");
  return { ok: reasons.length === 0, reasons };
}
