import { strFromU8, unzipSync } from "fflate";
import { AppError } from "../shared/errors";

const SUPPORTED = new Set([
  "positions.csv",
  "education.csv",
  "skills.csv",
  "certifications.csv",
]);
const MAX_EXPANDED = 20 * 1024 * 1024;

/** Parse RFC4180 cells without interpreting formulas or markup. */
export function parseCsv(text: string): string[][] {
  text = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closed = false;
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
      row.push(cell);
      cell = "";
      closed = false;
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
      closed = false;
    } else {
      if (closed)
        throw new AppError(
          "invalid",
          "unexpected text after a quoted CSV cell",
        );
      cell += c;
    }
    if (cell.length > 60_000 || rows.length > 10_000)
      throw new AppError("too_large", "the data export contains too much text");
  }
  if (quoted) throw new AppError("invalid", "incomplete CSV quotation");
  row.push(cell);
  if (row.some(Boolean)) rows.push(row);
  if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
  return rows;
}

/** Only the four career-data CSVs are accepted; private messages and unrelated archive entries are ignored. */
export function linkedInMarkdown(bytes: Uint8Array): string {
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
  const parts = ["# LinkedIn data export"];
  for (const [path, data] of Object.entries(files)) {
    if (data.length > 5 * 1024 * 1024)
      throw new AppError("too_large", "the expanded archive is too large");
    const rows = parseCsv(strFromU8(data));
    const header = rows.shift();
    if (!header) continue;
    parts.push(`## ${path.split("/").at(-1)}`);
    rows.forEach((row, index) => {
      if (row.length !== header.length)
        throw new AppError("invalid", "CSV row does not match its headings");
      parts.push(`### Row ${index + 1}`);
      row.forEach((cell, i) => {
        if (cell.trim()) parts.push(`${header[i]}: ${cell}`);
      });
    });
  }
  const markdown = parts.join("\n\n");
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
  return markdown;
}
