import { z } from "zod";
import type { Models } from "../ai/models";
import { usableEmbedding } from "../shared/embedding";
import { AppError } from "../shared/errors";
import { validConceptId } from "./ids.mjs";
import { MAX_MENTION_TEXT_CHARS, type Taxonomy } from "./taxonomy";
import type { Concept, ConceptKind } from "./types";

// The taxonomy's concepts as vectors, in a Vectorize index of their own (docs/taxonomy.md, "The
// vector index"). An operator builds one index for one taxonomy version
// (src/workflows/taxonomy-index.ts); tagging looks a line up in it to find concepts the line
// describes in other words (src/pipeline/tag.ts). The index holds public reference data only: a
// line is looked up with an embedding of it that is stored nowhere.
//
// The index says what it holds in a record of its own, the manifest, so a binding can never be
// read as another build than the one it points at. What a match is, its kind and its label, is
// always taken from the taxonomy's own record of the concept and never from the index's metadata.
//
//   MAX_NEAREST            20     the most concepts one lookup asks for
//   MAX_DESCRIPTION_CHARS  500    of a concept's description, in its document
//   SELF_MATCH_MIN / _MAX  0.99 / 1.01   a concept's score against itself under cosine

/** The model every concept and every lookup is embedded with. Changing it changes the index and `vector-judge/1`. */
export const TAXONOMY_VECTOR_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
export const TAXONOMY_VECTOR_DIMENSIONS = 1024;
/** What is embedded for each concept (`conceptDocument`). Raise the number when its form changes. */
export const TAXONOMY_VECTOR_DOCUMENT = "label-kind-description/1";
/** The manifest's own record. It is no concept ID, so a lookup can never return it. */
export const MANIFEST_ID = "manifest";
export const MAX_NEAREST = 20;
export const MAX_DESCRIPTION_CHARS = 500;
/** A concept looked up by its own vector scores about 1 under cosine. Euclidean gives 0, so the metric is proven by this. */
export const SELF_MATCH_MIN = 0.99;
export const SELF_MATCH_MAX = 1.01;
/** Vectorize takes IDs of up to 64 bytes. A longer concept ID is stored under its digest. */
const MAX_VECTOR_ID_BYTES = 64;

/** What tagging and the build use of a Vectorize index. */
export type VectorIndex = Pick<Vectorize, "describe" | "query" | "queryById" | "upsert" | "getByIds">;

/** What each kind of concept is called in its document. Only these kinds are indexed. */
export const KIND_NOUN: Readonly<Partial<Record<ConceptKind, string>>> = {
  skill: "Skill",
  knowledge: "Knowledge",
  "skill-group": "Group of skills or knowledge",
  activity: "Work activity",
  tool: "Software",
  "tool-category": "Category of software",
  occupation: "Occupation",
};
const indexed = (kind: unknown): kind is ConceptKind => typeof kind === "string" && Object.hasOwn(KIND_NOUN, kind);

/** What the index says about itself, in the metadata of its manifest record. */
export interface IndexManifest {
  kind: "manifest";
  format: 1;
  taxonomyVersion: string;
  model: string;
  dimensions: number;
  document: string;
  /** The kinds of concept it holds, sorted and joined by commas. */
  kinds: string;
  /** How many concepts it holds when it is complete. */
  count: number;
  state: "building" | "complete";
  /** The ID of the last concept whose page is in. "" before the first. */
  after: string;
  /** The build that wrote it last. A label, not an authority: concurrent builds are stopped by their instance IDs. */
  runId: string;
  startedAt: number;
  /** When it became complete, or 0 while it is building. Vectorize metadata holds no null. */
  completedAt: number;
}

const Manifest = z
  .object({
    kind: z.literal("manifest"),
    format: z.literal(1),
    taxonomyVersion: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    dimensions: z.number().int().positive(),
    document: z.string().min(1).max(100),
    kinds: z.string().min(1).max(300),
    count: z.number().int().nonnegative(),
    state: z.enum(["building", "complete"]),
    after: z.string().max(200),
    runId: z.string().max(100),
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative(),
  })
  .strict();

/** A concept a lookup found, with its kind and preferred label as the taxonomy's own record has them. */
export interface NearConcept {
  id: string;
  kind: ConceptKind;
  label: string;
  score: number;
}

/** The kinds an index holds, in the one form a manifest records them. */
export function kindsKey(kinds: readonly string[]): string {
  return [...new Set(kinds)].sort().join(",");
}

/**
 * What is embedded for a concept: its preferred label, what kind of thing it is, and the start of
 * its description. Alternative labels are left out: a lookup by words already finds them, and
 * O*NET's long lists of job titles would outweigh an occupation's own name.
 */
export function conceptDocument(concept: Pick<Concept, "kind" | "label" | "description">): string {
  const noun = KIND_NOUN[concept.kind];
  if (!noun) throw new AppError("invalid", "this kind of concept is not indexed");
  return concept.description ? `${concept.label}\n${noun}\n${concept.description.slice(0, MAX_DESCRIPTION_CHARS)}` : `${concept.label}\n${noun}`;
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

function base64url(data: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(data)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The ID a concept's vector is stored under: its own ID, or "h:" and its digest when that is over 64 bytes. */
export async function vectorIdFor(conceptId: string): Promise<string> {
  if (bytes(conceptId) <= MAX_VECTOR_ID_BYTES) return conceptId;
  return `h:${base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(conceptId)))}`;
}

/**
 * The concept a stored vector stands for, or null. A vector under a hashed ID names its concept
 * in its metadata, and is believed only when that is a concept ID whose digest is the vector's ID.
 */
export async function conceptOfVector(id: unknown, metadata: unknown): Promise<string | null> {
  if (typeof id !== "string" || id === MANIFEST_ID) return null;
  if (id.startsWith("h:")) {
    const named = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).concept : undefined;
    if (typeof named !== "string" || !validConceptId(named) || bytes(named) <= MAX_VECTOR_ID_BYTES) return null;
    return (await vectorIdFor(named)) === id ? named : null;
  }
  return validConceptId(id) && bytes(id) <= MAX_VECTOR_ID_BYTES ? id : null;
}

/** The manifest record's vector. Every record needs one, and this one is no concept's. */
export function manifestValues(): number[] {
  return Array.from({ length: TAXONOMY_VECTOR_DIMENSIONS }, (_, at) => (at === 0 ? 1 : 0));
}

/** The index's manifest, or null when it has none or what it has is not one. */
export async function readManifest(index: Pick<VectorIndex, "getByIds">): Promise<IndexManifest | null> {
  const records = await index.getByIds([MANIFEST_ID]);
  const record = Array.isArray(records) ? records.find((found) => found?.id === MANIFEST_ID) : undefined;
  const parsed = Manifest.safeParse(record?.metadata);
  return parsed.success ? parsed.data : null;
}

/** True when the manifest says the index is a complete build of this taxonomy version, for these kinds, as this code builds it. */
export function manifestMatches(m: IndexManifest, wanted: { taxonomyVersion: string; kinds: readonly string[] }): boolean {
  return (
    m.state === "complete" &&
    m.format === 1 &&
    m.model === TAXONOMY_VECTOR_MODEL &&
    m.dimensions === TAXONOMY_VECTOR_DIMENSIONS &&
    m.document === TAXONOMY_VECTOR_DOCUMENT &&
    m.taxonomyVersion === wanted.taxonomyVersion &&
    m.kinds === kindsKey(wanted.kinds) &&
    m.count > 0
  );
}

/** True for a vector of the index's size whose values can be searched. */
function ofIndexSize(vector: unknown): vector is number[] {
  return Array.isArray(vector) && vector.length === TAXONOMY_VECTOR_DIMENSIONS && usableEmbedding(vector);
}

/** Lookups in the vector index. Nothing here stores anything. */
export class TaxonomyVectors {
  constructor(
    private readonly index: VectorIndex,
    private readonly taxonomy: Pick<Taxonomy, "get">,
    private readonly models: Pick<Models, "embed">,
  ) {}

  /** Each text embedded once as a concept query, with the index's model. */
  async queries(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.some((text) => typeof text !== "string" || text.length > MAX_MENTION_TEXT_CHARS)) throw new AppError("invalid", "this text is too long to look through");
    const vectors: unknown = await this.models.embed([...texts], { model: TAXONOMY_VECTOR_MODEL, purpose: "concept-query" });
    if (!Array.isArray(vectors) || vectors.length !== texts.length || !vectors.every(ofIndexSize))
      throw new AppError("unavailable", "a lookup's embedding is not of the index's size");
    return vectors;
  }

  /**
   * The concepts of these kinds nearest a text or a vector, best first. Each is a concept the
   * taxonomy has a record of, of one of these kinds by that record, with its kind and label from it.
   */
  async nearest(query: string | number[], kinds: readonly ConceptKind[], k: number): Promise<NearConcept[]> {
    const wanted = [...new Set(kinds)].filter(indexed);
    if (wanted.length === 0) return [];
    if (!Number.isInteger(k) || k < 1 || k > MAX_NEAREST) throw new AppError("invalid", "ask for one to twenty concepts");
    let vector: unknown = query;
    if (typeof query === "string") {
      if (query.length > MAX_MENTION_TEXT_CHARS) throw new AppError("invalid", "this text is too long to look through");
      vector = (await this.queries([query]))[0];
    }
    if (!Array.isArray(vector) || vector.length !== TAXONOMY_VECTOR_DIMENSIONS || !vector.every((value) => typeof value === "number" && Number.isFinite(value)))
      throw new AppError("invalid", "a lookup needs a vector of the index's size");
    const found = await this.index.query(vector, { topK: k, filter: { kind: { $in: wanted } }, returnMetadata: "all", returnValues: false });
    const scored: { id: string; score: number }[] = [];
    for (const match of Array.isArray(found?.matches) ? found.matches : []) {
      if (typeof match?.score !== "number" || !Number.isFinite(match.score)) continue;
      const id = await conceptOfVector(match.id, match.metadata);
      if (id) scored.push({ id, score: match.score });
    }
    if (scored.length === 0) return [];
    // What a match is comes from the taxonomy's record of it, never from what the index says.
    const records = await this.taxonomy.get(scored.map((match) => match.id));
    const best = new Map<string, NearConcept>();
    for (const { id, score } of scored) {
      const record = records.get(id);
      if (!record || !wanted.includes(record.kind)) continue;
      const known = best.get(id);
      if (!known || score > known.score) best.set(id, { id, kind: record.kind, label: record.label, score });
    }
    return [...best.values()].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}

/**
 * The vector index for tagging, or why there is none: it is not bound, its manifest is not a
 * complete build of this taxonomy version for these kinds, or it cannot be read.
 */
export async function taxonomyVectorsFor(
  env: { TAXONOMY_VECTORS?: VectorIndex },
  taxonomy: Pick<Taxonomy, "get">,
  taxonomyVersion: string,
  kinds: readonly ConceptKind[],
  models: Pick<Models, "embed">,
): Promise<{ vectors: TaxonomyVectors } | { skipped: "unbound" | "not_ready" | "unreadable" }> {
  const index = env.TAXONOMY_VECTORS;
  if (!index) return { skipped: "unbound" };
  try {
    const manifest = await readManifest(index);
    if (!manifest || !manifestMatches(manifest, { taxonomyVersion, kinds })) return { skipped: "not_ready" };
    return { vectors: new TaxonomyVectors(index, taxonomy, models) };
  } catch {
    // A code and nothing else: the binding's own error is not kept.
    return { skipped: "unreadable" };
  }
}
