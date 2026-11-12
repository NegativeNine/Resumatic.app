import { TAXONOMY_VECTOR_DIMENSIONS, type VectorIndex } from "../../src/taxonomy";

// A Vectorize index in memory, for tests: cosine by default, with `$in` and `$eq` filters on a
// metadata field, `describe`, `getByIds` and `queryById`. It holds whatever it is given and checks
// what Vectorize itself checks that matters here: a vector's size and an ID's length.
//
// `standInConceptVector` is a stand-in for an embedding model. It knows nothing of meaning
// beyond a short table of words that stand for one another, which is enough for a test to put a
// line said in other words near a concept, and far from the rest.

type Stored = { id: string; values: number[]; metadata: Record<string, VectorizeVectorMetadata> };
type Filter = Record<string, unknown>;

export interface MemoryIndexOptions {
  dimensions?: number;
  /** "euclidean" scores a match by its distance, as Vectorize does: a vector against itself scores 0. */
  metric?: "cosine" | "euclidean";
  /** False when no metadata index was made before the vectors went in: a filtered query then finds nothing. */
  filterable?: boolean;
}

export class MemoryVectorIndex implements VectorIndex {
  readonly vectors = new Map<string, Stored>();
  /** Every call made of it, by name, in order. */
  readonly calls: { name: string; args: unknown[] }[] = [];
  /** Upserts held back from counting until `settle()`, as Vectorize applies writes in its own time. */
  holding = false;
  private readonly held: Stored[][] = [];
  private mutations = 0;

  constructor(private readonly options: MemoryIndexOptions = {}) {}

  get dimensions(): number {
    return this.options.dimensions ?? TAXONOMY_VECTOR_DIMENSIONS;
  }

  async describe(): Promise<VectorizeIndexInfo> {
    this.calls.push({ name: "describe", args: [] });
    return { vectorCount: this.vectors.size, dimensions: this.dimensions, processedUpToDatetime: 0, processedUpToMutation: this.mutations };
  }

  async upsert(vectors: VectorizeVector[]): Promise<VectorizeAsyncMutation> {
    this.calls.push({ name: "upsert", args: [vectors.map((vector) => vector.id)] });
    const batch = vectors.map((vector): Stored => {
      if (new TextEncoder().encode(vector.id).length > 64) throw new Error("VECTOR_UPSERT_ERROR (code = 40003): id too long");
      if (vector.values.length !== this.dimensions) throw new Error("VECTOR_UPSERT_ERROR (code = 40002): wrong dimensions");
      return { id: vector.id, values: Array.from(vector.values), metadata: { ...(vector.metadata ?? {}) } };
    });
    if (this.holding) this.held.push(batch);
    else this.apply(batch);
    return { mutationId: String(++this.mutations) };
  }

  /** Applies every upsert that was held back. */
  settle(): void {
    for (const batch of this.held.splice(0)) this.apply(batch);
  }

  async getByIds(ids: string[]): Promise<VectorizeVector[]> {
    this.calls.push({ name: "getByIds", args: [ids] });
    return ids.flatMap((id) => {
      const found = this.vectors.get(id);
      return found ? [{ id: found.id, values: [...found.values], metadata: { ...found.metadata } }] : [];
    });
  }

  async query(vector: VectorFloatArray | number[], options: VectorizeQueryOptions = {}): Promise<VectorizeMatches> {
    this.calls.push({ name: "query", args: [options] });
    return this.search(Array.from(vector), options);
  }

  async queryById(id: string, options: VectorizeQueryOptions = {}): Promise<VectorizeMatches> {
    this.calls.push({ name: "queryById", args: [id, options] });
    const found = this.vectors.get(id);
    return found ? this.search(found.values, options) : { matches: [], count: 0 };
  }

  private apply(batch: Stored[]): void {
    for (const vector of batch) this.vectors.set(vector.id, vector);
  }

  private search(vector: number[], options: VectorizeQueryOptions): VectorizeMatches {
    if (vector.length !== this.dimensions) throw new Error("VECTOR_QUERY_ERROR (code = 40006): wrong dimensions");
    const topK = options.topK ?? 5;
    if (options.returnMetadata === "all" && topK > 20) throw new Error("VECTOR_QUERY_ERROR (code = 40025): topK too high");
    const filter = (options.filter ?? {}) as Filter;
    if (Object.keys(filter).length && this.options.filterable === false) return { matches: [], count: 0 };
    const euclidean = this.options.metric === "euclidean";
    const matches = [...this.vectors.values()]
      .filter((stored) => passes(stored.metadata, filter))
      .map((stored) => ({ stored, score: euclidean ? distance(vector, stored.values) : cosine(vector, stored.values) }))
      .sort((a, b) => (euclidean ? a.score - b.score : b.score - a.score) || (a.stored.id < b.stored.id ? -1 : 1))
      .slice(0, topK)
      .map(({ stored, score }): VectorizeMatch => ({
        id: stored.id,
        score,
        ...(options.returnMetadata && options.returnMetadata !== "none" ? { metadata: { ...stored.metadata } } : {}),
        ...(options.returnValues ? { values: [...stored.values] } : {}),
      }));
    return { matches, count: matches.length };
  }
}

function passes(metadata: Record<string, unknown>, filter: Filter): boolean {
  return Object.entries(filter).every(([field, condition]) => {
    const value = metadata[field];
    if (condition && typeof condition === "object") {
      const ops = condition as { $in?: unknown[]; $eq?: unknown };
      if (ops.$in !== undefined && !ops.$in.includes(value)) return false;
      if (ops.$eq !== undefined && ops.$eq !== value) return false;
      return true;
    }
    return value === condition;
  });
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let at = 0; at < a.length; at++) {
    dot += a[at]! * b[at]!;
    na += a[at]! * a[at]!;
    nb += b[at]! * b[at]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function distance(a: number[], b: number[]): number {
  let sum = 0;
  for (let at = 0; at < a.length; at++) sum += (a[at]! - b[at]!) ** 2;
  return Math.sqrt(sum);
}

// ---------------------------------------------------------------- a stand-in embedding

/** Words a stand-in takes as one sense. Everything else is its own sense. */
const SENSES: Record<string, string[]> = {
  oversaw: ["manag"],
  oversee: ["manag"],
  overseeing: ["manag"],
  spending: ["budget"],
  finances: ["budget"],
  headed: ["lead"],
  led: ["lead"],
  crew: ["team"],
  coder: ["software", "developer"],
};
const STOP = new Set(["a", "an", "and", "or", "the", "of", "for", "to", "in", "on", "with", "by", "who", "his", "her", "their", "next"]);

/** A word as the stand-in reads it: lower case, with a plural or a tense taken off. */
function stem(word: string): string {
  let out = word.toLowerCase();
  for (const suffix of ["ing", "ed", "es", "s"])
    if (out.length > suffix.length + 2 && out.endsWith(suffix) && !out.endsWith("ss")) {
      out = out.slice(0, -suffix.length);
      break;
    }
  return out.endsWith("e") && out.length > 3 ? out.slice(0, -1) : out;
}

function slot(sense: string, dimensions: number): number {
  let hash = 2166136261;
  for (const char of sense) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash % dimensions;
}

/**
 * A stand-in embedding of a text: the senses of the words of its first line, one dimension each.
 * A concept's document starts with its label, so a concept is placed by its label alone.
 */
export function standInConceptVector(text: string, dimensions = TAXONOMY_VECTOR_DIMENSIONS): number[] {
  const values: number[] = new Array<number>(dimensions).fill(0);
  const line = text.split("\n")[0] ?? "";
  for (const word of line.toLowerCase().match(/[a-z0-9+#]+/g) ?? []) {
    if (STOP.has(word)) continue;
    for (const sense of (SENSES[word] ?? [word]).map(stem)) values[slot(sense, dimensions)]! += 1;
  }
  // A text with no word in it still needs a vector something can be compared with.
  if (!values.some((value) => value !== 0)) values[dimensions - 1] = 1;
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}

/** Embeds as the stand-in does, for any number of texts. */
export const standInEmbed = async (texts: string[]): Promise<number[][]> => texts.map((text) => standInConceptVector(text));
