import { strFromU8, unzipSync, UnzipInflate } from "fflate";
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
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

/** Reject ambiguous ZIP32 directory pointers before inspecting any members. */
function checkDirectory(bytes: Uint8Array): { crc: number; data: number }[] {
  const bad = (): never => { throw new AppError("invalid", "the ZIP export could not be read"); };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bounds = (pos: number, length: number): void => {
    if (!Number.isSafeInteger(pos) || !Number.isSafeInteger(length) || pos < 0 || length < 0 ||
        pos > bytes.length || length > bytes.length - pos) bad();
  };
  const u16 = (pos: number): number => { bounds(pos, 2); return view.getUint16(pos, true); };
  const u32 = (pos: number): number => { bounds(pos, 4); return view.getUint32(pos, true); };
  let end = -1;
  for (let pos = bytes.length - 22; pos >= Math.max(0, bytes.length - 65557); pos--) {
    if (u32(pos) === 0x06054b50 && pos + 22 + u16(pos + 20) === bytes.length) {
      end = pos;
      break;
    }
  }
  if (end < 0 || u16(end + 4) !== 0 || u16(end + 6) !== 0) bad();
  const count = u16(end + 10), size = u32(end + 12), start = u32(end + 16);
  // The uploaded archive is bounded to 10 MiB. ZIP64 and multi-disk layouts
  // need separate validation rather than trusting truncated 32-bit pointers.
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff ||
      count !== u16(end + 8) || start + size !== end) bad();
  if (count > 200) throw new AppError("too_large", "the archive has too many entries");
  const records: { crc: number; data: number }[] = [];
  let at = start;
  for (let i = 0; i < count; i++) {
    bounds(at, 46);
    if (u32(at) !== 0x02014b50) bad();
    const flags = u16(at + 8), method = u16(at + 10);
    const checksum = u32(at + 16);
    const compressed = u32(at + 20), original = u32(at + 24);
    const nameLength = u16(at + 28), extraLength = u16(at + 30), commentLength = u16(at + 32);
    const disk = u16(at + 34), local = u32(at + 42);
    bounds(at + 46, nameLength + extraLength + commentLength);
    if (disk !== 0 || local === 0xffffffff || compressed === 0xffffffff || original === 0xffffffff) bad();
    bounds(local, 30);
    if (u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method ||
        u16(local + 26) !== nameLength || (flags & 1) !== 0) bad();
    const localExtra = u16(local + 28);
    bounds(local + 30, nameLength + localExtra);
    for (let j = 0; j < nameLength; j++)
      if (bytes[local + 30 + j] !== bytes[at + 46 + j]) bad();
    if (!(flags & 8) && (u32(local + 14) !== checksum || u32(local + 18) !== compressed || u32(local + 22) !== original)) bad();
    const data = local + 30 + nameLength + localExtra;
    if (data > start || compressed > start - data) bad();
    if (flags & 8) {
      const descriptor = data + compressed;
      const matches = (pos: number): boolean => pos >= 0 && pos + 12 <= start &&
        u32(pos) === checksum && u32(pos + 4) === compressed && u32(pos + 8) === original;
      const unsigned = matches(descriptor);
      const signed = descriptor + 4 <= start && u32(descriptor) === 0x08074b50 && matches(descriptor + 4);
      if (unsigned === signed) bad();
    }
    records.push({ crc: checksum, data });
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (at !== end) bad();
  return records;
}

/**
 * unzipSync allocates output using the ZIP directory's untrusted size; a
 * deflate stream that exceeds it is silently truncated. Only use unzipSync to
 * inspect the directory, then decode the selected local members once through
 * a streaming inflater. Small compressed chunks bound transient allocations;
 * abort as soon as actual output exceeds the declared or permitted size.
 * It also checks the decoded member's CRC, which detects corruption but is
 * not an authenticity check against an adversarially rewritten archive.
 */
function readCareerMembers(
  bytes: Uint8Array,
  selected: Map<string, { size: number; compressed: number; method: number; crc: number; data: number }>,
): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  let expanded = 0;
  for (const [name, expected] of selected) {
    let offset = 0, crc = 0xffffffff, finished = false;
    const chunks: Uint8Array[] = [];
    const ondata = (error: Error | null, chunk: Uint8Array | null, final: boolean): void => {
      if (error) throw error;
      if (!chunk || finished || chunk.length > expected.size - offset || chunk.length > MAX_EXPANDED - expanded)
        throw new AppError("invalid", "the ZIP export could not be read");
      chunks.push(chunk);
      for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
      offset += chunk.length;
      expanded += chunk.length;
      if (final) {
        if (offset !== expected.size || ((crc ^ 0xffffffff) >>> 0) !== expected.crc)
          throw new AppError("invalid", "the ZIP export could not be read");
        finished = true;
      }
    };
    if (expected.method === 0) {
      // Stored entries have no inflater or transient output allocation.
      ondata(null, bytes.subarray(expected.data, expected.data + expected.compressed), true);
    } else if (expected.method === 8 && expected.compressed > 0) {
      const inflater = new UnzipInflate();
      inflater.ondata = ondata;
      for (let pos = 0; pos < expected.compressed; pos += 1024)
        inflater.push(bytes.subarray(expected.data + pos, expected.data + Math.min(pos + 1024, expected.compressed)), pos + 1024 >= expected.compressed);
    } else throw new AppError("invalid", "the ZIP export could not be read");
    if (!finished) throw new AppError("invalid", "the ZIP export could not be read");
    const result = new Uint8Array(offset);
    let at = 0;
    for (const part of chunks) { result.set(part, at); at += part.length; }
    files[name] = result;
  }
  return files;
}

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
  const selected = new Map<string, { size: number; compressed: number; method: number; crc: number; data: number }>();
  let files: Record<string, Uint8Array>;
  try {
    const records = checkDirectory(bytes);
    unzipSync(bytes, {
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
        selected.set(entry.name, { size: entry.originalSize, compressed: entry.size, method: entry.compression, crc: records[entries - 1]!.crc, data: records[entries - 1]!.data });
        return false; // Inspection only: never inflate using the untrusted directory size.
      },
    });
    files = readCareerMembers(bytes, selected);
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
