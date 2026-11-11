// Reads the CSV files ESCO and O*NET publish. Quoted cells can hold commas, doubled quotes and
// line breaks (ESCO lists a concept's other labels one per line inside a single cell).
// No Node APIs here: the same code runs in the Worker's test runtime.

/** Rows of cells. A file's first row is its header. */
export function parseCsv(text) {
  if (typeof text !== "string") throw new TypeError("csv text must be a string");
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let cell = "";
  /** Inside a quoted cell. */
  let quoted = false;
  /** The current cell opened with a quote, so it is a cell even when empty. */
  let wasQuoted = false;
  /** Some cell of the current row was quoted, so the row is a row even when it looks blank. */
  let rowQuoted = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
    wasQuoted = false;
  };
  const endRow = () => {
    endCell();
    // A blank line is not a row. A line of one quoted empty cell is.
    if (row.length > 1 || row[0] !== "" || rowQuoted) rows.push(row);
    row = [];
    rowQuoted = false;
  };
  for (let at = 0; at < source.length; at++) {
    const char = source[at];
    if (quoted) {
      if (char === '"') {
        if (source[at + 1] === '"') {
          cell += '"';
          at += 1;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"' && cell === "" && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
      rowQuoted = true;
    } else if (char === ",") endCell();
    else if (char === "\n") endRow();
    else if (char === "\r") {
      if (source[at + 1] === "\n") at += 1;
      endRow();
    } else cell += char;
  }
  if (quoted) throw new Error("csv ends inside a quoted cell");
  if (cell !== "" || row.length > 0 || wasQuoted) endRow();
  return rows;
}

const key = (name) => name.trim().toLowerCase();

/**
 * A file as records keyed by column name. `required` names must all be present; `optional` ones
 * are read when they are. A missing required column stops the build and says which columns the
 * file does have, because that is how a changed layout shows itself.
 */
export function readTable(text, file, required, optional = []) {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error(`${file}: the file is empty`);
  const header = rows[0].map((name) => name.trim());
  const index = new Map(header.map((name, at) => [key(name), at]));
  const missing = required.filter((name) => !index.has(key(name)));
  if (missing.length)
    throw new Error(`${file}: missing column${missing.length === 1 ? "" : "s"} ${missing.join(", ")}. It has: ${header.join(", ")}`);
  const wanted = [...required, ...optional].filter((name) => index.has(key(name)));
  const records = [];
  for (let line = 1; line < rows.length; line++) {
    const cells = rows[line];
    const record = {};
    for (const name of wanted) record[name] = (cells[index.get(key(name))] ?? "").trim();
    records.push(record);
  }
  return { header, records };
}

/** The first column whose name matches one of the patterns, or null. For files with no fixed header. */
export function findColumn(header, patterns) {
  for (const pattern of patterns) {
    const found = header.find((name) => pattern.test(name.trim()));
    if (found !== undefined) return found.trim();
  }
  return null;
}
