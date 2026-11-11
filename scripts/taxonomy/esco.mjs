// Reads an ESCO classification package (the CSV download for one language) into the combined
// taxonomy's records. Nothing is reworded: a label is kept as ESCO writes it, and the one label the
// builder adds is marked as derived.
//
// Layout: the 19 files of the "classification" package, named <file>_<language>.csv. Checked
// against ESCO v1.2.1; a missing column stops the build and lists the columns the file has.

import { escoId } from "../../src/taxonomy/ids.mjs";
import { normalizeLabel } from "../../src/taxonomy/normalize.mjs";
import { readTable } from "./csv.mjs";
import { clean, lines } from "./text.mjs";

/** The files this reader needs. The rest of the package is read when present. */
export const ESCO_REQUIRED = ["skills", "occupations", "occupationSkillRelations", "broaderRelationsSkillPillar"];

const COLLECTIONS = {
  digitalSkillsCollection: "digital",
  greenSkillsCollection: "green",
  languageSkillsCollection: "language",
  transversalSkillsCollection: "transversal",
  researchSkillsCollection: "research",
  digCompSkillsCollection: "digcomp",
  researchOccupationsCollection: "research",
};

/** The package's file for `base`, whatever its case, with or without the language in its name. */
function pick(files, base, language) {
  const wanted = [`${base}_${language}.csv`, `${base}.csv`].map((name) => name.toLowerCase());
  for (const name of Object.keys(files)) if (wanted.includes(name.toLowerCase())) return name;
  return null;
}

/** "Python (computer programming)" is also written "Python". Null when there is no such ending. */
export function withoutQualifier(label) {
  const match = /^(.+?)\s*\(([^()]+)\)$/u.exec(label);
  const short = match ? match[1].trim() : "";
  // A one-letter name ("C", "R") is left to the labels ESCO itself lists: alone it matches too much.
  return normalizeLabel(short).length >= 2 ? short : null;
}

/**
 * `files` maps each file's name to its text. Returns records and a tally, and never throws for a
 * single bad row: those are counted in `issues` so the build can say how many and of what kind.
 */
export function readEsco(files, { language = "en" } = {}) {
  const concepts = [];
  const labels = [];
  const edges = [];
  const read = [];
  const issues = new Map();
  const issue = (kind) => issues.set(kind, (issues.get(kind) ?? 0) + 1);
  // A concept's first row is the one read. What it said is kept, to tell an exact repeat from a
  // later row that says something else.
  const known = new Map();
  const said = (row, kind) =>
    JSON.stringify([kind, clean(row.preferredLabel), clean(row.code ?? ""), clean(row.description ?? "") || clean(row.definition ?? ""), lines(row.altLabels ?? "").sort(), lines(row.hiddenLabels ?? "").sort()]);

  const table = (base, required, optional = []) => {
    const name = pick(files, base, language);
    if (!name) {
      if (ESCO_REQUIRED.includes(base)) throw new Error(`ESCO package: ${base}_${language}.csv is missing`);
      return null;
    }
    const { records } = readTable(files[name], name, required, optional);
    read.push({ name, rows: records.length });
    return records;
  };

  const addConcept = (row, kind, extra = {}) => {
    const id = escoId(row.conceptUri);
    const label = clean(row.preferredLabel);
    if (!id || !label) {
      issue(id ? "esco_concept_without_label" : "esco_uri_not_recognised");
      return null;
    }
    if (known.has(id)) {
      issue("esco_concept_repeated");
      if (known.get(id) !== said(row, kind)) issue("esco_concept_repeated_differs");
      return null;
    }
    known.set(id, said(row, kind));
    const status = clean(row.status ?? "");
    concepts.push({
      id,
      kind,
      scheme: "esco",
      code: clean(row.code ?? "") || null,
      label,
      description: clean(row.description ?? "") || clean(row.definition ?? "") || null,
      meta: { ...extra, ...(status && status !== "released" ? { status } : {}) },
    });
    labels.push({ conceptId: id, kind, type: "preferred", text: label });
    for (const text of lines(row.altLabels ?? "")) labels.push({ conceptId: id, kind, type: "alternative", text });
    for (const text of lines(row.hiddenLabels ?? "")) labels.push({ conceptId: id, kind, type: "hidden", text });
    return id;
  };

  const TEXT = ["altLabels", "hiddenLabels", "description", "definition", "status"];

  for (const row of table("skills", ["conceptUri", "preferredLabel"], [...TEXT, "skillType", "reuseLevel"])) {
    const kind = /knowledge/i.test(row.skillType ?? "") ? "knowledge" : "skill";
    const reuse = clean(row.reuseLevel ?? "");
    const id = addConcept(row, kind, reuse ? { reuse } : {});
    if (!id) continue;
    const short = withoutQualifier(clean(row.preferredLabel));
    if (short) labels.push({ conceptId: id, kind, type: "derived", text: short });
  }
  for (const row of table("skillGroups", ["conceptUri", "preferredLabel"], [...TEXT, "code"]) ?? [])
    addConcept(row, "skill-group");
  for (const row of table("occupations", ["conceptUri", "preferredLabel"], [...TEXT, "code", "iscoGroup"])) {
    const iscoGroup = clean(row.iscoGroup ?? "");
    addConcept(row, "occupation", iscoGroup ? { iscoGroup } : {});
  }
  for (const row of table("ISCOGroups", ["conceptUri", "preferredLabel"], [...TEXT, "code"]) ?? [])
    addConcept(row, "occupation-group");

  const edge = (srcUri, rel, dstUri) => {
    const src = escoId(srcUri);
    const dst = escoId(dstUri);
    if (!src || !dst) return issue("esco_relation_uri_not_recognised");
    edges.push({ src, rel, dst, meta: null });
  };
  for (const row of table("occupationSkillRelations", ["occupationUri", "relationType", "skillUri"])) {
    const need = /essential/i.test(row.relationType) ? "essential" : /optional/i.test(row.relationType) ? "optional" : null;
    if (!need) issue("esco_relation_type_not_recognised");
    else edge(row.occupationUri, need, row.skillUri);
  }
  for (const row of table("skillSkillRelations", ["originalSkillUri", "relationType", "relatedSkillUri"]) ?? []) {
    const need = /essential/i.test(row.relationType) ? "skill-essential" : /optional/i.test(row.relationType) ? "skill-optional" : null;
    if (!need) issue("esco_relation_type_not_recognised");
    else edge(row.originalSkillUri, need, row.relatedSkillUri);
  }
  for (const base of ["broaderRelationsSkillPillar", "broaderRelationsOccPillar"])
    for (const row of table(base, ["conceptUri", "broaderUri"]) ?? []) edge(row.conceptUri, "broader", row.broaderUri);

  const collections = new Map();
  for (const [base, name] of Object.entries(COLLECTIONS))
    for (const row of table(base, ["conceptUri"]) ?? []) {
      const id = escoId(row.conceptUri);
      if (!id) issue("esco_uri_not_recognised");
      else collections.set(id, [...new Set([...(collections.get(id) ?? []), name])].sort());
    }
  for (const concept of concepts) {
    const names = collections.get(concept.id);
    if (names) concept.meta.collections = names;
  }

  return { concepts, labels, edges, files: read, issues: Object.fromEntries([...issues].sort()) };
}
