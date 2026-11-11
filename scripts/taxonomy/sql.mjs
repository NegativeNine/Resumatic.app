// The taxonomy as SQL for a D1 database: its tables, then its rows. Every statement is one line,
// because D1 runs a file of statements a line at a time. A taxonomy is loaded once into a database
// of its own and never changed; a new version is a new database.

/** The tables the Worker reads (src/taxonomy/d1.ts). */
export const SCHEMA = [
  `CREATE TABLE taxonomy_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`,
  `CREATE TABLE concepts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, scheme TEXT NOT NULL, code TEXT, label TEXT NOT NULL, description TEXT, meta TEXT NOT NULL DEFAULT '{}') WITHOUT ROWID`,
  `CREATE INDEX concepts_by_code ON concepts (scheme, code) WHERE code IS NOT NULL`,
  `CREATE TABLE labels (norm TEXT NOT NULL, concept_id TEXT NOT NULL, kind TEXT NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (norm, concept_id)) WITHOUT ROWID`,
  `CREATE INDEX labels_by_concept ON labels (concept_id)`,
  `CREATE TABLE relations (src TEXT NOT NULL, rel TEXT NOT NULL, dst TEXT NOT NULL, meta TEXT, PRIMARY KEY (src, rel, dst)) WITHOUT ROWID`,
  `CREATE INDEX relations_by_dst ON relations (dst, rel)`,
];

function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("a number that can't be stored");
    return String(value);
  }
  const text = String(value);
  if (/[\r\n\u0000]/.test(text)) throw new Error("a value with a line break can't be written as one statement");
  return `'${text.replaceAll("'", "''")}'`;
}

/** INSERT statements for `rows`, each kept under `maxBytes` so no statement outgrows D1's limit. */
function* inserts(table, columns, rows, maxBytes) {
  const head = `INSERT INTO ${table} (${columns.join(", ")}) VALUES `;
  let values = [];
  let size = head.length;
  for (const row of rows) {
    const tuple = `(${row.map(literal).join(", ")})`;
    const bytes = new TextEncoder().encode(tuple).length + 2;
    if (values.length && size + bytes > maxBytes) {
      yield `${head}${values.join(", ")};`;
      values = [];
      size = head.length;
    }
    values.push(tuple);
    size += bytes;
  }
  if (values.length) yield `${head}${values.join(", ")};`;
}

/** Every statement that loads a built taxonomy, in order: tables, what it is, then its records. */
export function* statements(bundle, { maxBytes = 60_000 } = {}) {
  for (const statement of SCHEMA) yield `${statement};`;
  yield* inserts(
    "taxonomy_meta",
    ["key", "value"],
    [
      ["format", String(bundle.info.format)],
      ["version", bundle.info.version],
      ["contentHash", bundle.info.contentHash],
      ["sources", JSON.stringify(bundle.info.sources)],
    ],
    maxBytes,
  );
  yield* inserts(
    "concepts",
    ["id", "kind", "scheme", "code", "label", "description", "meta"],
    bundle.concepts.map((concept) => [concept.id, concept.kind, concept.scheme, concept.code, concept.label, concept.description, JSON.stringify(concept.meta ?? {})]),
    maxBytes,
  );
  yield* inserts(
    "labels",
    ["norm", "concept_id", "kind", "type", "text"],
    bundle.labels.map((label) => [label.norm, label.conceptId, label.kind, label.type, label.text]),
    maxBytes,
  );
  yield* inserts(
    "relations",
    ["src", "rel", "dst", "meta"],
    bundle.edges.map((edge) => [edge.src, edge.rel, edge.dst, edge.meta ? JSON.stringify(edge.meta) : null]),
    maxBytes,
  );
}

/** The statements gathered into files of at most `maxFileBytes`, in the order they must be run. */
export function sqlFiles(bundle, { maxBytes = 60_000, maxFileBytes = 4_000_000 } = {}) {
  const files = [];
  let lines = [];
  let size = 0;
  for (const statement of statements(bundle, { maxBytes })) {
    const bytes = new TextEncoder().encode(statement).length + 1;
    if (lines.length && size + bytes > maxFileBytes) {
      files.push(`${lines.join("\n")}\n`);
      lines = [];
      size = 0;
    }
    lines.push(statement);
    size += bytes;
  }
  if (lines.length) files.push(`${lines.join("\n")}\n`);
  return files;
}
