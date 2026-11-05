import type { ResumeSection } from "../shared/api";
import type { RenderData } from "../shared/types";

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2021-03" becomes "Mar 2021"; other values print as given. */
export function formatDate(value: string | null): string {
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})/.exec(value);
  if (m) return `${MONTHS[Number(m[2]) - 1] ?? ""} ${m[1]}`.trim();
  return value;
}

function dates(s: ResumeSection): string {
  const start = formatDate(s.startDate);
  const end = s.endDate ? formatDate(s.endDate) : start ? "Present" : "";
  return [start, end].filter(Boolean).join(" – ");
}

function section(s: ResumeSection): string {
  const heading = [s.title, s.org].filter(Boolean).map((t) => esc(t!)).join(", ");
  const lines = s.lines.map((l) => `<li>${esc(l.text)}</li>`).join("");
  return `<section class="role"><div class="role-head"><h3>${heading}</h3><span class="dates">${esc(dates(s))}</span></div>${
    lines ? `<ul>${lines}</ul>` : ""
  }</section>`;
}

/**
 * One single-column layout that applicant tracking systems parse cleanly. Headers come from the
 * vault's role rows and lines only from the verified body, so the PDF can say nothing the resume view does not.
 */
export function renderResumeHtml(data: RenderData): string {
  const { profile, body } = data;
  const contact = [profile.email, profile.phone, profile.location, ...profile.links].filter(Boolean).map(esc).join(" · ");
  const experience = body.sections.filter((s) => s.kind !== "education");
  const education = body.sections.filter((s) => s.kind === "education");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(profile.name || "Resume")}</title>
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
<h1>${esc(profile.name || "")}</h1>
${contact ? `<div class="contact">${contact}</div>` : ""}
${body.summary ? `<p class="summary">${esc(body.summary.text)}</p>` : ""}
${experience.length ? `<h2>Experience</h2>${experience.map(section).join("")}` : ""}
${education.length ? `<h2>Education</h2>${education.map(section).join("")}` : ""}
${body.skills.length ? `<h2>Skills</h2><p>${body.skills.map(esc).join(" · ")}</p>` : ""}
</body></html>`;
}
