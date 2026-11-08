import type { RenderData } from "../shared/types";
import { sheetModel, type SheetRole } from "../shared/sheet";

export { formatSheetDate as formatDate, formatRoleDates } from "../shared/sheet";

function esc(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

function section(r: SheetRole): string {
  const lines = r.lines.map((l) => `<li>${esc(l.text)}</li>`).join("");
  return `<section class="role"><div class="role-head"><h3>${esc(r.heading)}</h3><span class="dates">${esc(r.dates)}</span></div>${
    lines ? `<ul>${lines}</ul>` : ""
  }</section>`;
}

/**
 * A single-column layout intended for text extraction. Validate it with ATS parsers before release. Headers come from the
 * vault's role rows and lines only from the verified body, so the PDF can say nothing the resume view does not.
 */
export function renderResumeHtml(data: RenderData): string {
  // The in-app preview renders the same model (src/web/components/ResumePaper.tsx).
  const sheet = sheetModel(data.profile, data.body);
  const contact = sheet.contact.map(esc).join(" · ");
  const experience = sheet.sections.find((s) => s.heading === "Experience")?.roles ?? [];
  const education = sheet.sections.find((s) => s.heading === "Education")?.roles ?? [];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(sheet.name || "Resume")}</title>
<style>
  @page { size: Letter; margin: 0.6in 0.7in; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 10.5pt; line-height: 1.35; color: #111; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 2pt; }
  .contact { color: #333; margin-bottom: 10pt; }
  h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid #999; padding-bottom: 2pt; margin: 12pt 0 6pt; }
  .role { margin-bottom: 8pt; break-inside: avoid; }
  .role-head { display: flex; justify-content: space-between; gap: 12pt; }
  h3 { font-size: 10.5pt; margin: 0; }
  .dates { color: #333; white-space: nowrap; }
  ul { margin: 3pt 0 0 14pt; padding: 0; }
  li { margin: 0 0 2pt; }
  .summary { margin: 0 0 4pt; }
</style></head><body>
<h1>${esc(sheet.name || "")}</h1>
${contact ? `<div class="contact">${contact}</div>` : ""}
${sheet.summary ? `<p class="summary">${esc(sheet.summary.text)}</p>` : ""}
${experience.length ? `<h2>Experience</h2>${experience.map(section).join("")}` : ""}
${education.length ? `<h2>Education</h2>${education.map(section).join("")}` : ""}
${sheet.skills.length ? `<h2>Skills</h2><p>${sheet.skills.map(esc).join(" · ")}</p>` : ""}
</body></html>`;
}
