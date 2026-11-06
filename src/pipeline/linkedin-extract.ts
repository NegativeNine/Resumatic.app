import type { Models } from "../ai/models";
import type { ExtractedFact, ExtractedRole } from "../shared/types";
import { MAX_FACT_CHARS } from "../shared/api";
import { sourceDate } from "./extract/dates";
import { verifyExtraction } from "./extract/verify";
import type { Extractor, VerifiedExtraction } from "./extract/types";
import type { LinkedInCell, LinkedInDocument, LinkedInRow } from "./linkedin";

const ROLES = new Set(["positions.csv", "education.csv"]);
const own = (row: LinkedInRow, names: string[]) => {
  const cells = names.flatMap((name) =>
    row.cells.filter((cell) => cell.name === name),
  );
  // Ambiguous aliases must not silently select one of two contradictory claims.
  if (new Set(cells.map((cell) => cell.value.trim())).size > 1)
    return undefined;
  return cells[0];
};
const trimSpan = (cell: LinkedInCell): [number, number] => [
  cell.span[0] + cell.value.length - cell.value.trimStart().length,
  cell.span[1] - (cell.value.length - cell.value.trimEnd().length),
];
const safeLabel = (cell?: LinkedInCell) => {
  const value = cell?.value.trim() ?? "";
  return value && value.length <= 200 && !/[\r\n\u0000-\u001f]/.test(value)
    ? value
    : null;
};

/** Construct only information explicitly present in one structured row. */
function roleFromRow(
  document: LinkedInDocument,
  row: LinkedInRow,
  key: string,
): ExtractedRole | null {
  const job = row.file === "positions.csv";
  const org = own(
    row,
    job
      ? ["company name", "company", "organization name"]
      : ["school name", "school"],
  );
  const orgName = safeLabel(org);
  if (!org || !orgName) return null;
  let start = org.line[0],
    end = org.line[1];
  if (end - start > 800) return null;
  const include = (cell?: LinkedInCell) => {
    if (!cell) return false;
    const a = Math.min(start, cell.line[0]),
      b = Math.max(end, cell.line[1]);
    if (b - a > 800) return false;
    start = a;
    end = b;
    return true;
  };
  const title = own(
    row,
    job ? ["title", "position"] : ["degree name", "degree"],
  );
  const titleName = safeLabel(title);
  const acceptedTitle = titleName && include(title) ? titleName : null;
  const begin = own(row, ["started on", "start date"]);
  const finish = own(row, ["finished on", "end date"]);
  const parsedEnd = finish ? sourceDate(finish.value) : null;
  const explicitlyCurrent =
    finish &&
    /^(?:present|current|now|heute|actualidad)$/i.test(finish.value.trim()) &&
    include(finish);
  const endDate = parsedEnd && include(finish) ? parsedEnd : null;
  // In the current data model a start without an end prints “Present”. Do not
  // invent current employment when an end is absent or cannot fit the quote.
  const startDate =
    begin &&
    sourceDate(begin.value) &&
    (endDate || explicitlyCurrent) &&
    include(begin)
      ? sourceDate(begin.value)
      : null;
  return {
    key,
    kind: job ? "job" : "education",
    org: orgName,
    title: acceptedTitle,
    startDate,
    endDate,
    quote: document.markdown.slice(start, end),
    span: [start, end],
  };
}

type RowTask = { role: ExtractedRole; cell: LinkedInCell };
/**
 * Each description is independently extracted and verified against its own cell, then assigned
 * to that cell's deterministic row. This prevents the model from choosing a different employer.
 * Each group makes at most three concurrent model calls; retries remain charged by Models.
 */
export async function extractLinkedIn(
  document: LinkedInDocument,
  extractor: Extractor,
  models: Models,
  referenceDate: string,
  filename = "LinkedIn export.zip",
): Promise<{ extraction: VerifiedExtraction; dropped: number }> {
  const rawRoles: ExtractedRole[] = [];
  const directFacts: ExtractedFact[] = [];
  const tasks: RowTask[] = [];
  let dropped = 0;
  for (const [index, row] of document.rows.entries()) {
    if (ROLES.has(row.file)) {
      if (rawRoles.length >= 40) {
        dropped++;
        continue;
      }
      const role = roleFromRow(document, row, `linkedin-${index}`);
      if (!role) {
        dropped++;
        continue;
      }
      rawRoles.push(role);
      for (const cell of row.cells.filter((cell) =>
        row.file === "positions.csv"
          ? cell.name === "description"
          : ["notes", "activities"].includes(cell.name),
      ))
        tasks.push({ role, cell });
    } else if (row.file === "skills.csv" || row.file === "certifications.csv") {
      const cell = own(row, ["name", "skill", "certification name"]);
      if (
        !cell ||
        !cell.value.trim() ||
        /[\r\n]/.test(cell.value) ||
        cell.value.trim().length > MAX_FACT_CHARS
      ) {
        dropped++;
        continue;
      }
      const span = trimSpan(cell);
      const text = document.markdown.slice(...span);
      directFacts.push({
        roleKey: null,
        kind: row.file === "skills.csv" ? "skill" : "credential",
        text,
        level: null,
        quote: text,
        span,
      });
    }
  }
  // Role metadata and direct cell claims use exactly the same checks as every other strategy.
  const checked = verifyExtraction(
    document.markdown,
    { roles: rawRoles, facts: directFacts.slice(0, 300) },
    { structuredSkillSpans: new Set(directFacts.filter((f) => f.kind === "skill").map((f) => JSON.stringify(f.span))) },
  );
  dropped += checked.dropped.length + Math.max(0, directFacts.length - 300);
  const acceptedRoles = new Set(
    checked.extraction.roles.map((role) => role.key),
  );
  const facts = checked.extraction.facts.map((fact) => {
    // The source line includes the CSV column label (for example "Name:").
    // It is not part of the cell value, which the parser selected directly.
    const cell = fact.kind === "credential" && directFacts.find((item) =>
      item.kind === "credential" && item.span &&
      item.span[0] >= fact.span[0] && item.span[1] <= fact.span[1],
    );
    return cell ? { ...fact, text: cell.text } : fact;
  });
  const pending = tasks.filter((task) => acceptedRoles.has(task.role.key));
  for (let i = 0; i < pending.length; i += 3) {
    const results = await Promise.all(
      pending.slice(i, i + 3).map(async ({ role, cell }) => {
        const text = cell.value;
        if (!text.trim()) return { facts: [], dropped: 0 };
        const proposed = await extractor.extract(
          { markdown: text, filename, referenceDate },
          models,
        );
        const verified = verifyExtraction(text, proposed);
        return {
          facts: verified.extraction.facts.map((fact) => ({
            ...fact,
            roleKey: role.key,
            span: [
              cell.span[0] + fact.span[0],
              cell.span[0] + fact.span[1],
            ] as [number, number],
          })),
          dropped: verified.dropped.length,
        };
      }),
    );
    for (const result of results) {
      dropped += result.dropped;
      for (const fact of result.facts) {
        if (facts.length >= 300) {
          dropped++;
          continue;
        }
        // A broad quote may be proposed more than once for a compound bullet.
        if (
          facts.some(
            (other) =>
              other.roleKey === fact.roleKey &&
              other.kind === fact.kind &&
              other.span[0] === fact.span[0] &&
              other.span[1] === fact.span[1] &&
              other.text === fact.text,
          )
        )
          continue;
        facts.push(fact);
      }
    }
  }
  return { extraction: { roles: checked.extraction.roles, facts }, dropped };
}
