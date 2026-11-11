import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { D1Store, MemoryStore, Taxonomy, taxonomyFor, type Concept, type ConceptKind, type Edge, type Relation, type TaxonomyStore } from "../../src/taxonomy";
import { TAXONOMY_FIXTURE, TAXONOMY_FIXTURE_SQL } from "../support/taxonomy-fixture";

// The same synthetic taxonomy two ways: the records in memory, and the SQL the builder writes for
// them loaded into D1. Whatever one answers, the other must.

const S = (n: number) => `esco:skill:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const O = (n: number) => `esco:occupation:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DEV = "onet:occ:99-1001.00";
const BA = "onet:occ:99-1003.00";

const db = () => env.TAXONOMY!;
const memory = new MemoryStore(TAXONOMY_FIXTURE);
const sorted = <T>(values: T[]) => values.map((value) => JSON.stringify(value)).sort();

beforeAll(async () => {
  for (const statement of TAXONOMY_FIXTURE_SQL) await db().prepare(statement).run();
});

describe("the taxonomy in D1", () => {
  it("holds every record the builder wrote, and says which taxonomy it is", async () => {
    const count = async (table: string) => (await db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
    expect(await count("concepts")).toBe(TAXONOMY_FIXTURE.concepts.length);
    expect(await count("labels")).toBe(TAXONOMY_FIXTURE.labels.length);
    expect(await count("relations")).toBe(TAXONOMY_FIXTURE.edges.length);
    expect(await new D1Store(db()).info()).toEqual(TAXONOMY_FIXTURE.info);
  });

  it("answers every kind of read as the records in memory do", async () => {
    const d1: TaxonomyStore = new D1Store(db());
    const ids = TAXONOMY_FIXTURE.concepts.map((concept) => concept.id);
    expect(sorted(await d1.concepts(ids))).toEqual(sorted(await memory.concepts(ids)));
    expect(sorted(await d1.concepts([S(3), S(3), "esco:skill:not-there"]))).toEqual(sorted(await memory.concepts([S(3)])));

    const norms = [...new Set(TAXONOMY_FIXTURE.labels.map((label) => label.norm))];
    expect(sorted(await d1.labels(norms))).toEqual(sorted(await memory.labels(norms)));
    for (const kinds of [["tool"], ["skill", "knowledge"], ["occupation", "occupation-group", "activity"]] as ConceptKind[][])
      expect(sorted(await d1.labels(norms, kinds)), kinds.join()).toEqual(sorted(await memory.labels(norms, kinds)));
    expect(await d1.labels(norms, [])).toEqual([]);

    const rels: (Relation[] | undefined)[] = [undefined, ["broader"], ["essential", "optional"], ["performs", "uses"], ["matches"], ["same-label", "task-of", "task-activity"]];
    for (const id of ids)
      for (const only of rels) {
        expect(sorted(await d1.from(id, only)), `${id} from ${only}`).toEqual(sorted(await memory.from(id, only)));
        expect(sorted(await d1.to(id, only)), `${id} to ${only}`).toEqual(sorted(await memory.to(id, only)));
      }
    expect(await d1.from(DEV, [])).toEqual([]);
    // Relations from several concepts at once are the relations from each.
    for (const only of rels) {
      expect(sorted(await d1.fromAny(ids, only)), `from any ${only}`).toEqual(sorted(await memory.fromAny(ids, only)));
      expect(sorted(await d1.fromAny([DEV, O(1), DEV], only)), `from two ${only}`).toEqual(sorted([...(await memory.from(DEV, only)), ...(await memory.from(O(1), only))]));
    }
    expect((await d1.fromAny(ids)).length).toBe(TAXONOMY_FIXTURE.edges.length);
    expect(await d1.fromAny(ids, [])).toEqual([]);
    expect(await d1.fromAny([])).toEqual([]);
  });

  it("reads more values than one statement may bind, and is not moved by hostile ones", async () => {
    const d1 = new D1Store(db());
    // D1 binds at most 100 values a statement. Three hundred are asked for at once.
    const many = [...Array.from({ length: 300 }, (_, n) => `no such label ${n}`), "python", "kubernetes", "budget management"];
    expect(sorted(await d1.labels(many))).toEqual(sorted(await memory.labels(many)));
    expect(sorted(await d1.labels(many, ["tool"]))).toEqual(sorted(await memory.labels(many, ["tool"])));
    const manyIds = [...Array.from({ length: 300 }, (_, n) => S(1000 + n)), S(1), DEV];
    expect((await d1.concepts(manyIds)).map((concept) => concept.id).sort()).toEqual([S(1), DEV].sort());
    expect(sorted(await d1.fromAny(manyIds))).toEqual(sorted(await memory.fromAny(manyIds)));
    expect(sorted(await d1.fromAny(manyIds, ["matches", "uses", "broader"]))).toEqual(sorted(await memory.fromAny(manyIds, ["matches", "uses", "broader"])));
    expect((await d1.fromAny(manyIds, ["matches"])).map((edge) => edge.dst).sort()).toEqual(["esco:isco:C2512", O(1)].sort());

    const hostile = ["' OR 1=1 --", "python'; DROP TABLE labels; --", "", "x".repeat(500)];
    expect(await d1.labels(hostile)).toEqual([]);
    expect(await d1.concepts(hostile)).toEqual([]);
    expect(await d1.from("' OR 1=1 --")).toEqual([]);
    expect(await d1.fromAny(hostile)).toEqual([]);
    expect(await d1.fromAny([DEV], ["'; DROP TABLE relations; --" as Relation])).toEqual([]);
    expect(await d1.to(DEV, ["matches", "'; DROP TABLE relations; --" as Relation])).toEqual([]);
    expect((await d1.labels(["python"])).length).toBe(2);
  });

  it("gives the pipelines the same answers through the binding", async () => {
    const bound = taxonomyFor(env)!;
    const inMemory = new Taxonomy(memory);
    expect(bound).toBeInstanceOf(Taxonomy);
    const line = "Led data migration of 40 services to Kubernetes (K8s), using Python and Microsoft Excel.";
    expect(await bound.mentions(line)).toEqual(await inMemory.mentions(line));
    expect((await bound.mentions(line)).map((mention) => mention.text)).toEqual(["data migration", "Kubernetes", "K8s", "Python", "Microsoft Excel"]);
    expect(await bound.lookup("go")).toEqual(await inMemory.lookup("go"));
    expect(await bound.broader(S(1))).toEqual(await inMemory.broader(S(1)));
    for (const id of [DEV, O(2), O(3), S(1)]) expect(await bound.profile(id), id).toEqual(await inMemory.profile(id));
    expect((await bound.info()).version).toBe(TAXONOMY_FIXTURE.info.version);
  });

  it("gives an occupation every occupation the crosswalk relates it to, read in more than one statement", async () => {
    // Ninety ESCO occupations matched to one O*NET occupation, each with a skill of its own: more
    // occupations than one statement may bind.
    const more = Array.from({ length: 90 }, (_, n) => ({ occupation: O(100 + n), skill: S(100 + n) }));
    const concepts = more.flatMap(({ occupation, skill }, n): Concept[] => [
      { id: occupation, kind: "occupation", scheme: "esco", code: null, label: `budget specialist ${n}`, description: null, meta: {} },
      { id: skill, kind: "skill", scheme: "esco", code: null, label: `budget skill ${n}`, description: null, meta: {} },
    ]);
    const edges = more.flatMap(({ occupation, skill }): Edge[] => [
      { src: BA, rel: "matches", dst: occupation, meta: { type: "broad" } },
      { src: occupation, rel: "essential", dst: skill, meta: null },
    ]);
    await db().batch([
      ...concepts.map((concept) => db().prepare(`INSERT INTO concepts (id, kind, scheme, label) VALUES (?, ?, ?, ?)`).bind(concept.id, concept.kind, concept.scheme, concept.label)),
      ...edges.map((edge) => db().prepare(`INSERT INTO relations (src, rel, dst, meta) VALUES (?, ?, ?, ?)`).bind(edge.src, edge.rel, edge.dst, edge.meta ? JSON.stringify(edge.meta) : null)),
    ]);
    try {
      const inMemory = new Taxonomy(new MemoryStore({ ...TAXONOMY_FIXTURE, concepts: [...TAXONOMY_FIXTURE.concepts, ...concepts], edges: [...TAXONOMY_FIXTURE.edges, ...edges] }));
      const profile = (await taxonomyFor(env)!.profile(BA))!;
      // Its own counterpart and the ninety, and the two skills of the first with one from each of the rest.
      expect(profile.counterparts.map((counterpart) => counterpart.concept.id)).toEqual([O(3), ...more.map(({ occupation }) => occupation)]);
      expect(profile.skills).toHaveLength(92);
      expect(profile).toEqual(await inMemory.profile(BA));
    } finally {
      await db().batch([
        ...concepts.map((concept) => db().prepare(`DELETE FROM concepts WHERE id = ?`).bind(concept.id)),
        ...edges.map((edge) => db().prepare(`DELETE FROM relations WHERE src = ? AND rel = ? AND dst = ?`).bind(edge.src, edge.rel, edge.dst)),
      ]);
    }
  });

  it("says nothing is loaded for a database without a taxonomy in it", async () => {
    await db().prepare(`DELETE FROM taxonomy_meta WHERE key = 'version'`).run();
    expect(await new D1Store(db()).info()).toBeNull();
    await expect(taxonomyFor(env)!.info()).rejects.toThrow("unavailable: the taxonomy is not loaded");
  });
});
