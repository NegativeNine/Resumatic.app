import { strFromU8, unzipSync } from "fflate";
import { AppError } from "../shared/errors";

const SUPPORTED = new Set([
  "positions.csv",
  "education.csv",
  "skills.csv",
  "certifications.csv",
]);
const MAX_EXPANDED = 20 * 1024 * 1024;
const MAX_CSV_COLUMNS = 256;
const MAX_CSV_CELLS = 100_000;
const MAX_CSV_ROWS = 10_000;

/** Parse RFC4180 cells without interpreting formulas or markup. */
export function parseCsv(text: string): string[][] {
  text = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closed = false;
  let cells = 0;
  const pushCell = () => {
    if (row.length >= MAX_CSV_COLUMNS || ++cells > MAX_CSV_CELLS)
      throw new AppError("too_large", "the data export contains too many cells");
    row.push(cell);
    cell = "";
  };
  const pushRow = () => {
    if (row.some(Boolean)) {
      if (rows.length >= MAX_CSV_ROWS)
        throw new AppError("too_large", "the data export contains too many rows");
      rows.push(row);
    }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (quoted) {
        quoted = false;
        closed = true;
      } else if (cell.length === 0) quoted = true;
      else throw new AppError("invalid", "invalid CSV quotation");
    } else if (c === "," && !quoted) {
      pushCell();
      closed = false;
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      pushCell();
      pushRow();
      closed = false;
    } else {
      if (closed)
        throw new AppError(
          "invalid",
          "unexpected text after a quoted CSV cell",
        );
      cell += c;
    }
    if (cell.length > 60_000)
      throw new AppError("too_large", "the data export contains too much text");
  }
  if (quoted) throw new AppError("invalid", "incomplete CSV quotation");
  if (row.length || cell.length || closed) {
    pushCell();
    pushRow();
  }
  if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
  return rows;
}

export interface LinkedInCell {
  name: string;
  value: string;
  span: [number, number];
  line: [number, number];
}
export interface LinkedInRow {
  file: string;
  cells: LinkedInCell[];
}
export interface LinkedInDocument {
  markdown: string;
  rows: LinkedInRow[];
}

/** Convert supported career files to one immutable source and retain each original cell's offsets. */
export function linkedInDocument(
  bytes: Uint8Array,
  order: "metadata-first" | "legacy" = "metadata-first",
): LinkedInDocument {
  let expanded = 0;
  let entries = 0;
  const names = new Set<string>();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter(entry) {
        if (++entries > 200)
          throw new AppError("too_large", "the archive has too many entries");
        if (
          entry.name.startsWith("/") ||
          entry.name.split(/[\\/]/).includes("..")
        )
          throw new AppError("invalid", "unsafe archive path");
        const name = entry.name.split("/").at(-1)!.toLowerCase();
        if (!SUPPORTED.has(name)) return false;
        expanded += entry.originalSize;
        if (expanded > MAX_EXPANDED || entry.originalSize > 5 * 1024 * 1024)
          throw new AppError("too_large", "the expanded archive is too large");
        if (names.has(name))
          throw new AppError(
            "invalid",
            "the archive contains duplicate career files",
          );
        names.add(name);
        return true;
      },
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("invalid", "the ZIP export could not be read");
  }
  let markdown = "";
  const mapped: LinkedInRow[] = [];
  const append = (text: string): [number, number] => {
    if (markdown.length + (markdown ? 2 : 0) + text.length > 60_000)
      throw new AppError("too_large", "the career export is too long; import fewer records");
    if (markdown) markdown += "\n\n";
    const start = markdown.length;
    markdown += text;
    return [start, markdown.length];
  };
  append("# LinkedIn data export");
  const preferred: Record<string, string[]> = {
    "positions.csv": [
      "company name",
      "company",
      "organization name",
      "title",
      "position",
      "started on",
      "start date",
      "finished on",
      "end date",
    ],
    "education.csv": [
      "school name",
      "school",
      "degree name",
      "degree",
      "start date",
      "started on",
      "end date",
      "finished on",
    ],
  };
  for (const [path, data] of Object.entries(files)) {
    if (data.length > 5 * 1024 * 1024)
      throw new AppError("too_large", "the expanded archive is too large");
    const rows = parseCsv(strFromU8(data));
    const header = rows.shift();
    if (!header) continue;
    const normalized = header.map((name) => name.trim().toLowerCase());
    if (new Set(normalized).size !== normalized.length)
      throw new AppError("invalid", "CSV headings must be unique");
    const file = path.split("/").at(-1)!.toLowerCase();
    append(`## ${path.split("/").at(-1)}`);
    rows.forEach((row, index) => {
      if (row.length !== header.length)
        throw new AppError("invalid", "CSV row does not match its headings");
      append(`### Row ${index + 1}`);
      const indexes = row.map((_, i) => i);
      const keys = preferred[file] ?? [];
      if (order === "metadata-first")
        indexes.sort((a, b) => {
          const rank = (i: number) => {
            const n = keys.indexOf(normalized[i]!);
            return n < 0 ? keys.length + i : n;
          };
          return rank(a) - rank(b);
        });
      const cells: LinkedInCell[] = [];
      for (const i of indexes) {
        const name = header[i]!;
        const value = row[i]!;
        if (!value.trim()) continue;
        const line = append(`${name}: ${value}`);
        const start = line[0] + name.length + 2;
        cells.push({
          name: normalized[i]!,
          value,
          line,
          span: [start, start + value.length],
        });
      }
      mapped.push({ file, cells });
    });
  }
  if (!names.size)
    throw new AppError(
      "invalid",
      "no supported LinkedIn career CSV files were found",
    );
  if (markdown.length > 60_000)
    throw new AppError(
      "too_large",
      "the career export is too long; import fewer records",
    );
  return { markdown, rows: mapped };
}

/** Only the four career-data CSVs are accepted; unrelated archive entries are ignored. */
export function linkedInMarkdown(bytes: Uint8Array): string {
  return linkedInDocument(bytes).markdown;
}
