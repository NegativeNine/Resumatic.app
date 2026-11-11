import type { Concept, ConceptKind, Edge, Label, Relation, TaxonomyInfo } from "./types";

/**
 * Where a built taxonomy is read from. The Worker reads D1 (d1.ts); tests and the builder's own
 * checks read the records in memory. Every method returns records exactly as the builder wrote them.
 */
export interface TaxonomyStore {
  /** What the stored taxonomy says about itself, or null when nothing is loaded. */
  info(): Promise<TaxonomyInfo | null>;
  /** The concepts with these IDs, in no particular order. Unknown IDs are simply absent. */
  concepts(ids: readonly string[]): Promise<Concept[]>;
  /** Every label whose comparison form is one of `norms`, for concepts of `kinds` when given. */
  labels(norms: readonly string[], kinds?: readonly ConceptKind[]): Promise<Label[]>;
  /** Relations that start at `src`. */
  from(src: string, rels?: readonly Relation[]): Promise<Edge[]>;
  /** Relations that start at any of `srcs`, read together however many concepts are asked about. */
  fromAny(srcs: readonly string[], rels?: readonly Relation[]): Promise<Edge[]>;
  /** Relations that end at `dst`. */
  to(dst: string, rels?: readonly Relation[]): Promise<Edge[]>;
  /** Up to `limit` concepts of `kinds` whose IDs come after `after`, in ID order. For building the vector index. */
  conceptPage(after: string, kinds: readonly ConceptKind[], limit: number): Promise<Concept[]>;
  /** How many concepts of `kinds` there are, or how many of them have an ID up to and including `upTo`. */
  conceptCount(kinds: readonly ConceptKind[], upTo?: string): Promise<number>;
}

/** The records of a built taxonomy, as the builder's files hold them. */
export interface TaxonomyRecords {
  info: TaxonomyInfo;
  concepts: readonly Concept[];
  labels: readonly Label[];
  edges: readonly Edge[];
}

/** A taxonomy held in memory. For tests and small tools; the whole set is far too large for a Worker. */
export class MemoryStore implements TaxonomyStore {
  private readonly byId: Map<string, Concept>;
  private readonly byNorm = new Map<string, Label[]>();
  private readonly bySrc = new Map<string, Edge[]>();
  private readonly byDst = new Map<string, Edge[]>();

  constructor(private readonly records: TaxonomyRecords) {
    this.byId = new Map(records.concepts.map((concept) => [concept.id, concept]));
    const push = <T>(map: Map<string, T[]>, key: string, value: T) => {
      const list = map.get(key);
      if (list) list.push(value);
      else map.set(key, [value]);
    };
    for (const label of records.labels) push(this.byNorm, label.norm, label);
    for (const edge of records.edges) {
      push(this.bySrc, edge.src, edge);
      push(this.byDst, edge.dst, edge);
    }
  }

  async info(): Promise<TaxonomyInfo | null> {
    return this.records.info;
  }

  async concepts(ids: readonly string[]): Promise<Concept[]> {
    return [...new Set(ids)].map((id) => this.byId.get(id)).filter((concept): concept is Concept => concept !== undefined);
  }

  async labels(norms: readonly string[], kinds?: readonly ConceptKind[]): Promise<Label[]> {
    return [...new Set(norms)].flatMap((norm) => this.byNorm.get(norm) ?? []).filter((label) => !kinds || kinds.includes(label.kind));
  }

  async from(src: string, rels?: readonly Relation[]): Promise<Edge[]> {
    return (this.bySrc.get(src) ?? []).filter((edge) => !rels || rels.includes(edge.rel));
  }

  async fromAny(srcs: readonly string[], rels?: readonly Relation[]): Promise<Edge[]> {
    return [...new Set(srcs)].flatMap((src) => this.bySrc.get(src) ?? []).filter((edge) => !rels || rels.includes(edge.rel));
  }

  async to(dst: string, rels?: readonly Relation[]): Promise<Edge[]> {
    return (this.byDst.get(dst) ?? []).filter((edge) => !rels || rels.includes(edge.rel));
  }

  async conceptPage(after: string, kinds: readonly ConceptKind[], limit: number): Promise<Concept[]> {
    // IDs are ASCII, so comparing code units orders them as SQLite's binary collation does.
    return this.ordered()
      .filter((concept) => concept.id > after && kinds.includes(concept.kind))
      .slice(0, limit);
  }

  async conceptCount(kinds: readonly ConceptKind[], upTo?: string): Promise<number> {
    return this.records.concepts.filter((concept) => kinds.includes(concept.kind) && (upTo === undefined || concept.id <= upTo)).length;
  }

  private ordered(): Concept[] {
    return [...this.records.concepts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}
