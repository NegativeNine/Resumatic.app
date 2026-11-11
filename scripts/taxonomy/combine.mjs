// Joins what the readers found into one taxonomy: one set of concepts, one index of labels, one set
// of relations, in a fixed order, with a hash of the whole. Two builds from the same files give the
// same bytes, so a version names its contents.
//
// The builder adds three things of its own, each marked so it can never pass for the source's:
//   - "derived" labels (a name without its bracketed qualifier, a tool without the word "software");
//   - "same-label" relations between an O*NET tool and an ESCO concept whose labels compare equal;
//   - "performs" relations, which count the tasks through which an occupation reaches an activity.
// Nothing else is inferred. In particular no skill is mapped to an activity and no occupation is
// matched to another except by the official crosswalk.

import { validConceptId } from "../../src/taxonomy/ids.mjs";
import { normalizeLabel } from "../../src/taxonomy/normalize.mjs";

export const FORMAT = 1;
const TYPE_ORDER = ["preferred", "alternative", "hidden", "derived"];
const KINDS = ["skill", "knowledge", "skill-group", "occupation", "occupation-group", "activity", "task", "tool", "tool-category"];
const RELS = ["broader", "essential", "optional", "skill-essential", "skill-optional", "performs", "uses", "task-of", "task-activity", "matches", "same-label"];
/** Share of crosswalk rows that may name an occupation one of the two releases no longer has. */
export const CROSSWALK_TOLERANCE = 0.1;
const MAX_LABEL_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 4000;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One record per line, keys in a fixed order, so the same records always give the same text. */
export function ndjson(records, keys) {
  return records.map((record) => JSON.stringify(Object.fromEntries(keys.map((name) => [name, record[name] ?? null])))).join("\n") + (records.length ? "\n" : "");
}

function sortedMeta(meta) {
  if (!meta) return null;
  const entries = Object.entries(meta).filter(([, value]) => value !== undefined && value !== null && value !== false);
  return entries.length ? Object.fromEntries(entries.sort(([a], [b]) => compare(a, b))) : null;
}

/**
 * `esco` and `onet` are what readEsco and readOnet return, `crosswalk` what readCrosswalk returns.
 * `versions` names the releases the files came from: the files themselves don't say.
 */
export async function combine({ esco, onet, crosswalk, versions }) {
  for (const [name, value] of Object.entries({ esco: versions?.esco, onet: versions?.onet }))
    if (typeof value !== "string" || !/^\d+(?:\.\d+){1,2}$/.test(value)) throw new Error(`give the ${name} release as a version number, such as 1.2.1`);

  const problems = {};
  const count = (kind, n = 1) => {
    problems[kind] = (problems[kind] ?? 0) + n;
  };
  for (const source of [esco, onet, crosswalk]) for (const [kind, n] of Object.entries(source.issues)) count(kind, n);

  // Concepts.
  const concepts = new Map();
  for (const concept of [...esco.concepts, ...onet.concepts]) {
    if (!validConceptId(concept.id) || !KINDS.includes(concept.kind)) throw new Error(`a reader produced a concept the taxonomy has no place for: ${JSON.stringify(concept.id)}`);
    if (concepts.has(concept.id)) throw new Error(`two sources produced the same concept: ${concept.id}`);
    concepts.set(concept.id, {
      id: concept.id,
      kind: concept.kind,
      scheme: concept.scheme,
      code: concept.code || null,
      label: concept.label.slice(0, 1000),
      description: concept.description ? concept.description.slice(0, MAX_DESCRIPTION_CHARS) : null,
      meta: sortedMeta(concept.meta) ?? {},
    });
  }

  // Labels: one per concept and comparison form, keeping the source's own wording over a derived one.
  const best = new Map();
  for (const label of [...esco.labels, ...onet.labels]) {
    const concept = concepts.get(label.conceptId);
    if (!concept) { count("label_for_unknown_concept"); continue; }
    const norm = normalizeLabel(label.text);
    if (!norm || label.text.length > MAX_LABEL_CHARS) { count("label_not_usable"); continue; }
    const key = `${norm}\n${label.conceptId}`;
    const before = best.get(key);
    if (!before || TYPE_ORDER.indexOf(label.type) < TYPE_ORDER.indexOf(before.type))
      best.set(key, { conceptId: label.conceptId, kind: concept.kind, type: label.type, text: label.text, norm });
  }
  const labels = [...best.values()].sort((a, b) => compare(a.norm, b.norm) || compare(a.conceptId, b.conceptId));

  // Relations: both ends must exist. The crosswalk may name occupations a newer release has
  // retired, within a tolerance; anything else left dangling is a fault in the files or the reader.
  const edges = new Map();
  const add = (edge) => {
    if (!RELS.includes(edge.rel)) throw new Error(`a reader produced an unknown relation: ${edge.rel}`);
    const key = `${edge.src} ${edge.rel} ${edge.dst}`;
    if (edge.src === edge.dst) count("relation_to_itself");
    else if (edges.has(key)) count("relation_repeated");
    else edges.set(key, { src: edge.src, rel: edge.rel, dst: edge.dst, meta: sortedMeta(edge.meta) });
  };
  let dangling = 0;
  for (const edge of [...esco.edges, ...onet.edges]) {
    if (!concepts.has(edge.src) || !concepts.has(edge.dst)) { dangling += 1; continue; }
    add(edge);
  }
  if (dangling) count("relation_to_unknown_concept", dangling);
  let unmatched = 0;
  for (const edge of crosswalk.edges) {
    const src = concepts.get(edge.src);
    const dst = concepts.get(edge.dst);
    if (src?.kind !== "occupation" || !dst || (dst.kind !== "occupation" && dst.kind !== "occupation-group")) { unmatched += 1; continue; }
    add(edge);
  }
  if (unmatched) count("crosswalk_occupation_not_in_release", unmatched);
  const crosswalkRows = crosswalk.edges.length;
  if (crosswalkRows > 0 && unmatched / crosswalkRows > CROSSWALK_TOLERANCE)
    throw new Error(`${unmatched} of ${crosswalkRows} crosswalk rows name an occupation that isn't in these releases. The files don't belong together, or a layout changed.`);

  // A tool and an ESCO concept are linked only when their labels compare equal and the label
  // belongs to exactly one concept on each side. Hidden terms are left out: they are loose. So is
  // a tool's name without "software": O*NET never wrote it, and what is left is as often what the
  // software is for as the software ("Migration software", and ESCO's "migration" of people).
  const escoByNorm = new Map();
  const toolByNorm = new Map();
  for (const label of labels) {
    if (label.type === "hidden" || (label.kind === "tool" && label.type === "derived")) continue;
    const side = label.kind === "tool" ? toolByNorm : label.kind === "skill" || label.kind === "knowledge" ? escoByNorm : null;
    if (side) side.set(label.norm, (side.get(label.norm) ?? new Set()).add(label.conceptId));
  }
  for (const [norm, tools] of toolByNorm) {
    const same = escoByNorm.get(norm);
    if (!same) continue;
    if (tools.size !== 1 || same.size !== 1) { count("same_label_ambiguous"); continue; }
    add({ src: [...tools][0], rel: "same-label", dst: [...same][0], meta: null });
  }

  const conceptList = [...concepts.values()].sort((a, b) => compare(a.id, b.id));
  const edgeList = [...edges.values()].sort((a, b) => compare(a.src, b.src) || compare(a.rel, b.rel) || compare(a.dst, b.dst));

  const text = {
    concepts: ndjson(conceptList, ["id", "kind", "scheme", "code", "label", "description", "meta"]),
    labels: ndjson(labels, ["conceptId", "kind", "type", "text", "norm"]),
    relations: ndjson(edgeList, ["src", "rel", "dst", "meta"]),
  };
  const contentHash = await sha256(`${text.concepts}\u0000${text.labels}\u0000${text.relations}`);
  const tally = (list, field) => {
    const totals = {};
    for (const item of list) totals[item[field]] = (totals[item[field]] ?? 0) + 1;
    return Object.fromEntries(Object.entries(totals).sort(([a], [b]) => compare(a, b)));
  };
  const info = {
    format: FORMAT,
    version: `esco-${versions.esco}+onet-${versions.onet}+${contentHash.slice(0, 8)}`,
    contentHash,
    sources: [
      { id: "esco", name: "ESCO classification", version: versions.esco },
      { id: "onet", name: `O*NET ${versions.onet} Database`, version: versions.onet },
      { id: "esco-onet-crosswalk", name: "O*NET - ESCO crosswalk (occupations)", version: versions.crosswalk ?? "unversioned" },
    ],
  };
  return {
    info,
    concepts: conceptList,
    labels,
    edges: edgeList,
    text,
    counts: {
      concepts: tally(conceptList, "kind"),
      conceptsBySource: tally(conceptList, "scheme"),
      labels: tally(labels, "type"),
      relations: tally(edgeList, "rel"),
    },
    problems: Object.fromEntries(Object.entries(problems).sort(([a], [b]) => compare(a, b))),
    files: { esco: esco.files, onet: onet.files, crosswalk: crosswalk.files },
  };
}

/** What a product that uses the taxonomy has to say about where it comes from. */
export function attribution(versions) {
  return {
    notices: [
      "This service uses the ESCO classification of the European Commission.",
      `This service includes information from the O*NET ${versions.onet} Database by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA). Used under the CC BY 4.0 license. O*NET\u00ae is a trademark of USDOL/ETA. Resumatic has modified all or some of this information. USDOL/ETA has not approved, endorsed, or tested these modifications.`,
    ],
    licences: [
      { source: "ESCO", terms: "Commission Decision 2011/833/EU on the reuse of Commission documents", url: "https://esco.ec.europa.eu/en/use-esco/download" },
      { source: `O*NET ${versions.onet} Database`, terms: "Creative Commons Attribution 4.0 International", url: "https://creativecommons.org/licenses/by/4.0/" },
    ],
    modifications: [
      "ESCO and O*NET records are held together in one set, each under an ID that names its source. No ESCO or O*NET label, description, code or relation is reworded.",
      "Labels are also stored in a comparison form (lower case, without accents or surrounding punctuation) so they can be found in text.",
      "A label marked \"derived\" is made by the builder: an ESCO label without its bracketed qualifier, or an O*NET software example without the final word \"software\".",
      "O*NET software examples have no IDs in the database, so each is given one made from its name. Examples whose names compare equal are held as one tool.",
      "A \"performs\" relation says an occupation has tasks that carry out a detailed work activity, and counts them. It is computed from O*NET's Tasks to DWAs file.",
      "A \"same-label\" relation links an O*NET software example to an ESCO concept when a name O*NET gives the example and a label of the concept, with or without its bracketed qualifier, compare equal and belong to one concept on each side. ESCO's hidden terms and software names without the final word \"software\" are not compared. It is not part of either source.",
      "O*NET occupations and ESCO occupations are related only by the official O*NET - ESCO crosswalk, with the match type it gives.",
    ],
  };
}
