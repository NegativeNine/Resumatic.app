import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { D1Store, MemoryStore, Taxonomy, taxonomyFor, type ConceptKind, type Relation, type TaxonomyStore } from "../../src/taxonomy";
import { TAXONOMY_FIXTURE, TAXONOMY_FIXTURE_SQL } from "../support/taxonomy-fixture";

// The same synthetic taxonomy two ways: the records in memory, and the SQL the builder writes for
// them loaded into D1. Whatever one answers, the other must.

const S = (n: number) => `esco:skill:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const O = (n: number) => `esco:occupation:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DEV = "onet:occ:99-1001.00";

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
  });

  it("reads more values than one statement may bind, and is not moved by hostile ones", async () => {
    const d1 = new D1Store(db());
    // D1 binds at most 100 values a statement. Three hundred are asked for at once.
    const many = [...Array.from({ length: 300 }, (_, n) => `no such label ${n}`), "python", "kubernetes", "budget management"];
    expect(sorted(await d1.labels(many))).toEqual(sorted(await memory.labels(many)));
    expect(sorted(await d1.labels(many, ["tool"]))).toEqual(sorted(await memory.labels(many, ["tool"])));
    const manyIds = [...Array.from({ length: 300 }, (_, n) => S(1000 + n)), S(1), DEV];
    expect((await d1.concepts(manyIds)).map((concept) => concept.id).sort()).toEqual([S(1), DEV].sort());

    const hostile = ["' OR 1=1 --", "python'; DROP TABLE labels; --", "", "x".repeat(500)];
    expect(await d1.labels(hostile)).toEqual([]);
    expect(await d1.concepts(hostile)).toEqual([]);
    expect(await d1.from("' OR 1=1 --")).toEqual([]);
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

  it("says nothing is loaded for a database without a taxonomy in it", async () => {
    await db().prepare(`DELETE FROM taxonomy_meta WHERE key = 'version'`).run();
    expect(await new D1Store(db()).info()).toBeNull();
    await expect(taxonomyFor(env)!.info()).rejects.toThrow("unavailable: the taxonomy is not loaded");
  });
});
