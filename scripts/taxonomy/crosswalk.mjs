// Reads the official O*NET - ESCO crosswalk for occupations, published by the European Commission
// with the U.S. Department of Labor. It is the one thing that joins the two sources: nothing else
// in the combined taxonomy claims that an O*NET concept and an ESCO concept are related.
//
// The file's header is found by what its columns are called, not by position, and the build stops
// with the header it found when a column it needs is not there.

import { escoId, onetOccupationId } from "../../src/taxonomy/ids.mjs";
import { findColumn, parseCsv } from "./csv.mjs";

const TYPES = [
  [/exact/i, "exact"],
  [/close/i, "close"],
  [/narrow/i, "narrow"],
  [/broad/i, "broad"],
  [/related/i, "related"],
];

export function readCrosswalk(text, file = "crosswalk.csv") {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error(`${file}: the file is empty`);
  const header = rows[0].map((name) => name.trim());
  const columns = {
    onet: findColumn(header, [/^o\*?net.*\b(id|code)\b/i, /^o\*?net-soc/i]),
    esco: findColumn(header, [/\besco\b.*\buri\b/i, /\buri\b/i]),
    type: findColumn(header, [/type of match/i, /match type/i, /\bmatch\b/i, /relation/i]),
  };
  const missing = Object.entries(columns).filter(([, name]) => name === null).map(([name]) => name);
  if (missing.length)
    throw new Error(`${file}: no column found for ${missing.join(", ")}. It has: ${header.join(", ")}`);
  const at = Object.fromEntries(Object.entries(columns).map(([name, column]) => [name, header.indexOf(column)]));

  const edges = [];
  const issues = new Map();
  const issue = (kind) => issues.set(kind, (issues.get(kind) ?? 0) + 1);
  const seen = new Set();
  for (const cells of rows.slice(1)) {
    const src = onetOccupationId((cells[at.onet] ?? "").trim());
    const dst = escoId(cells[at.esco] ?? "");
    const stated = (cells[at.type] ?? "").trim();
    const type = TYPES.find(([pattern]) => pattern.test(stated))?.[1] ?? null;
    if (!src) { issue("crosswalk_onet_code_not_recognised"); continue; }
    if (!dst) { issue("crosswalk_esco_uri_not_recognised"); continue; }
    if (!type) { issue("crosswalk_match_type_not_recognised"); continue; }
    const key = `${src} ${dst}`;
    if (seen.has(key)) { issue("crosswalk_pair_repeated"); continue; }
    seen.add(key);
    edges.push({ src, rel: "matches", dst, meta: { type } });
  }
  return { edges, files: [{ name: file, rows: rows.length - 1 }], columns, issues: Object.fromEntries([...issues].sort()) };
}
