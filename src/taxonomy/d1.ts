import { validConceptId } from "./ids.mjs";
import type { TaxonomyStore } from "./store";
import {
  CONCEPT_KINDS,
  LABEL_TYPES,
  RELATIONS,
  type Concept,
  type ConceptKind,
  type ConceptMeta,
  type Edge,
  type Label,
  type LabelType,
  type Relation,
  type RelationMeta,
  type TaxonomyInfo,
} from "./types";

// The taxonomy in its own D1 database, loaded once from the SQL the builder writes
// (scripts/taxonomy/sql.mjs) and read-only from then on. A query binds at most this many values:
// D1 allows 100 per statement.
const CHUNK = 80;

function chunks<T>(values: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < values.length; at += size) out.push(values.slice(at, at + size));
  return out;
}
const marks = (count: number) => Array.from({ length: count }, () => "?").join(",");

function object<T extends object>(text: string | null): T | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : null;
  } catch {
    return null;
  }
}

interface ConceptRow {
  id: string;
  kind: string;
  scheme: string;
  code: string | null;
  label: string;
  description: string | null;
  meta: string;
}
interface LabelRow {
  norm: string;
  concept_id: string;
  kind: string;
  type: string;
  text: string;
}
interface EdgeRow {
  src: string;
  rel: string;
  dst: string;
  meta: string | null;
}

const isKind = (value: string): value is ConceptKind => (CONCEPT_KINDS as readonly string[]).includes(value);
const isType = (value: string): value is LabelType => (LABEL_TYPES as readonly string[]).includes(value);
const isRel = (value: string): value is Relation => (RELATIONS as readonly string[]).includes(value);

export class D1Store implements TaxonomyStore {
  constructor(private readonly db: D1Database) {}

  async info(): Promise<TaxonomyInfo | null> {
    let rows: { key: string; value: string }[];
    try {
      rows = (await this.db.prepare(`SELECT key, value FROM taxonomy_meta`).all<{ key: string; value: string }>()).results;
    } catch (error) {
      // A database that nothing has been loaded into has no tables. That is nothing loaded, and
      // the only failure read as that: any other is D1's to report.
      if (error instanceof Error && error.message.includes("no such table: taxonomy_meta")) return null;
      throw error;
    }
    const meta = new Map(rows.map((row) => [row.key, row.value]));
    const version = meta.get("version");
    const contentHash = meta.get("contentHash");
    // How many records there are is written by the statement that ends a load, which writes
    // nothing unless the tables hold every one of them (scripts/taxonomy/sql.mjs). A database
    // without the counts is part of a taxonomy, or was loaded from SQL made before the builder
    // wrote them, and cannot be told from a part.
    const records = object<Record<string, unknown>>(meta.get("records") ?? null);
    const whole = records !== null && ["concepts", "labels", "relations"].every((table) => Number.isSafeInteger(records[table]));
    if (meta.get("format") !== "1" || !version || !contentHash || !whole) return null;
    let sources: TaxonomyInfo["sources"] = [];
    try {
      const parsed: unknown = JSON.parse(meta.get("sources") ?? "[]");
      if (Array.isArray(parsed))
        sources = parsed.filter(
          (item): item is TaxonomyInfo["sources"][number] =>
            !!item && typeof item.id === "string" && typeof item.name === "string" && typeof item.version === "string",
        );
    } catch {
      sources = [];
    }
    return { format: 1, version, contentHash, sources };
  }

  async concepts(ids: readonly string[]): Promise<Concept[]> {
    const wanted = [...new Set(ids)].filter(validConceptId);
    const out: Concept[] = [];
    for (const part of chunks(wanted)) {
      const { results } = await this.db
        .prepare(`SELECT id, kind, scheme, code, label, description, meta FROM concepts WHERE id IN (${marks(part.length)})`)
        .bind(...part)
        .all<ConceptRow>();
      for (const row of results) {
        if (!isKind(row.kind) || (row.scheme !== "esco" && row.scheme !== "onet")) continue;
        out.push({
          id: row.id,
          kind: row.kind,
          scheme: row.scheme,
          code: row.code,
          label: row.label,
          description: row.description,
          meta: object<ConceptMeta>(row.meta) ?? {},
        });
      }
    }
    return out;
  }

  async labels(norms: readonly string[], kinds?: readonly ConceptKind[]): Promise<Label[]> {
    const wanted = [...new Set(norms)].filter((norm) => norm.length > 0 && norm.length <= 200);
    const only = kinds ? [...new Set(kinds)].filter(isKind) : null;
    if (only && only.length === 0) return [];
    const out: Label[] = [];
    for (const part of chunks(wanted, CHUNK - (only?.length ?? 0))) {
      const { results } = await this.db
        .prepare(
          `SELECT norm, concept_id, kind, type, text FROM labels WHERE norm IN (${marks(part.length)})` +
            (only ? ` AND kind IN (${marks(only.length)})` : ""),
        )
        .bind(...part, ...(only ?? []))
        .all<LabelRow>();
      for (const row of results)
        if (isKind(row.kind) && isType(row.type))
          out.push({ conceptId: row.concept_id, kind: row.kind, type: row.type, text: row.text, norm: row.norm });
    }
    return out;
  }

  from(src: string, rels?: readonly Relation[]): Promise<Edge[]> {
    return this.edges("src", src, rels);
  }

  async fromAny(srcs: readonly string[], rels?: readonly Relation[]): Promise<Edge[]> {
    const wanted = [...new Set(srcs)].filter(validConceptId);
    const only = rels ? [...new Set(rels)].filter(isRel) : null;
    if (only && only.length === 0) return [];
    const out: Edge[] = [];
    for (const part of chunks(wanted, CHUNK - (only?.length ?? 0))) {
      const { results } = await this.db
        .prepare(`SELECT src, rel, dst, meta FROM relations WHERE src IN (${marks(part.length)})` + (only ? ` AND rel IN (${marks(only.length)})` : ""))
        .bind(...part, ...(only ?? []))
        .all<EdgeRow>();
      for (const row of results)
        if (isRel(row.rel)) out.push({ src: row.src, rel: row.rel, dst: row.dst, meta: object<RelationMeta>(row.meta) });
    }
    return out;
  }

  to(dst: string, rels?: readonly Relation[]): Promise<Edge[]> {
    return this.edges("dst", dst, rels);
  }

  private async edges(end: "src" | "dst", id: string, rels?: readonly Relation[]): Promise<Edge[]> {
    if (!validConceptId(id)) return [];
    const only = rels ? [...new Set(rels)].filter(isRel) : null;
    if (only && only.length === 0) return [];
    const { results } = await this.db
      .prepare(`SELECT src, rel, dst, meta FROM relations WHERE ${end} = ?` + (only ? ` AND rel IN (${marks(only.length)})` : ""))
      .bind(id, ...(only ?? []))
      .all<EdgeRow>();
    return results
      .filter((row) => isRel(row.rel))
      .map((row) => ({ src: row.src, rel: row.rel as Relation, dst: row.dst, meta: object<RelationMeta>(row.meta) }));
  }
}
