import type { ResumeBody, ResumeLine, ResumeView } from "../shared/api";

// What a resume's check says, once, above the sheet: every line is backed by the person's record,
// and only what differs is named. Each line's own mark beside the page says which.

/** Every line of a body, the summary first, in the order the sheet prints them. */
export function bodyLines(body: ResumeBody): ResumeLine[] {
  return [...(body.summary ? [body.summary] : []), ...body.sections.flatMap((section) => section.lines)];
}

/**
 * True when a version holds wording or headings that haven't been checked against the record, so it
 * can't be downloaded or shared. The server applies the same guard to saved exports.
 */
export function needsEvidence(resume: ResumeView, body: ResumeBody): boolean {
  return resume.needsGroundingReview === true || resume.provenance !== "snapshot" || bodyLines(body).some(
    (item) => !["kept", "repaired", "replaced"].includes(item.status) || item.factIds.length === 0 ||
      item.factIds.some((id) => !resume.facts[id]?.text?.trim()),
  ) || body.skills.some((skill) => !Object.values(resume.facts).some((fact) => !!fact.text && fact.text === skill));
}

/** "a", "a and b", "a, b and c". */
function joined(parts: readonly string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * The one sentence about a version's check, or null for a version with unchecked wording, where the
 * notice about it speaks instead. It counts the lines the displayed body holds, so a line check that
 * changes one line is told truly. Only version 1, tailoring's own, says how many draft lines were
 * left out: every later version comes from a line check, a refine or a removal, none of which leaves
 * a draft line out.
 */
export function checkSentence(resume: ResumeView, body: ResumeBody): string | null {
  if (needsEvidence(resume, body)) return null;
  const lines = bodyLines(body);
  const corrected = lines.filter((line) => line.status === "repaired").length;
  const ownWords = lines.filter((line) => line.status === "replaced").length;
  const leftOut = resume.version === 1 ? (resume.report?.dropped ?? 0) : 0;
  const parts = [
    ...(corrected > 0 ? [`${corrected} ${corrected === 1 ? "was" : "were"} corrected`] : []),
    ...(ownWords > 0 ? [`${ownWords} ${ownWords === 1 ? "uses" : "use"} your record’s own words`] : []),
    ...(leftOut > 0 ? [leftOut === 1 ? "1 draft line was left out" : `${leftOut} draft lines were left out`] : []),
  ];
  return parts.length === 0 ? "Every line is backed by your record." : `Every line is backed by your record; ${joined(parts)}.`;
}
