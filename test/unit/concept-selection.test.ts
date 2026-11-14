import { describe, expect, it, vi } from "vitest";
import { selectFacts } from "../../src/pipeline/tailor";
import type { ConceptSelectionContext } from "../../src/pipeline/concept-selection";
import type { FactConceptEvidence } from "../../src/shared/concept-tailoring";
import type { FactRecord } from "../../src/shared/types";
import { MemoryStore, Taxonomy } from "../../src/taxonomy";
import { TAXONOMY_FIXTURE } from "../support/taxonomy-fixture";
import { fakeModels } from "../support/fixtures";

const PYTHON = "onet:tool:python";
const version = TAXONOMY_FIXTURE.info.version;
const fact = (id: string, text: string): FactRecord => ({ id, revision: 1, roleId: null, kind: "accomplishment", text, level: null, quote: null, origin: "user" });
const hint = (f: FactRecord, conceptId = PYTHON): FactConceptEvidence => ({ tagId: `tag-${f.id}`, factId: f.id, factRevision: 1, factText: f.text, conceptId, conceptKind: "tool", label: "Python", taxonomyVersion: version, decidedAt: 1 });
function context(text: string, evidence: FactConceptEvidence[], conceptId = PYTHON): ConceptSelectionContext {
  return { taxonomy: new Taxonomy(new MemoryStore(TAXONOMY_FIXTURE)), taxonomyVersion: version, model: "test-judge", evidence,
    requirements: [{ id: "R1", text, status: "tagged", concepts: [{ conceptId, conceptKind: "tool", label: "Python", method: "requirement-judge/1" }] }] };
}
const analysis = (text = "Python services") => ({ company: null, title: null, requirements: [text] });
function models(supported: (text: string) => boolean) {
  const judge = vi.fn(async (items: { alias: string; facts: { text: string }[] }[]) => ({ verdicts: items.map((item) => ({ id: item.alias, verdict: supported(item.facts[0]!.text) ? "supported" as const : "unsupported" as const, reason: "" })) }));
  return { ...fakeModels(), rerank: vi.fn(async (_query: string, texts: string[]) => texts.map(() => 0.5)), judge };
}

describe("concept selection through the application selector", () => {
  it("adds a low-cosine concept match and preserves ordinary embedding candidates and original citation ids", async () => {
    const tagged = fact("tagged", "Built services in Python"), fallback = fact("fallback", "Maintained Python services");
    const m = models(() => true);
    const coverage = new Map<string, string[]>();
    const selected = await selectFacts(m, async () => [{ factId: fallback.id, query: 0, score: 0.9 }], analysis(), [tagged, fallback], [], coverage, context("Python services", [hint(tagged)]));
    expect(selected.factIds).toEqual([tagged.id, fallback.id]);
    expect(coverage.get("Python services")).toEqual([tagged.id, fallback.id]);
    expect(m.rerank).toHaveBeenCalledWith("Python services", [fallback.text, tagged.text]);
    expect(selected.concepts!.coverage[0]).toMatchObject({ status: "supported", concepts: [{ id: PYTHON, factIds: [tagged.id] }] });
    expect(m.judge.mock.calls[0]![0].map((item) => item.facts[0]!.text)).toEqual([tagged.text, fallback.text]);
  });

  it("does not use a hierarchy edge as coverage", async () => {
    const f = fact("budget", "Managed budgets");
    const conceptId = "esco:skill:00000000-0000-4000-8000-000000000001";
    const selected = await selectFacts(models(() => false), async () => [], analysis("Budget management"), [f], [], undefined, context("Budget management", [hint(f, conceptId)], "esco:skill:S1.1"));
    expect(selected.factIds).toContain(f.id);
    expect(selected.concepts!.coverage[0]!.status).toBe("not_evidenced");
    expect(selected.concepts!.coverage[0]!.factIds).toEqual([]);
  });

  it("retains embedding fallback for unknown requirement concepts and ignores stale/different-version evidence", async () => {
    const f = fact("python", "Built Python services");
    const c = context("Python services", [{ ...hint(f), taxonomyVersion: "old" }]);
    c.requirements = [{ id: "R1", text: "Python services", status: "unknown", concepts: [], unknownReason: "declined" }];
    const selected = await selectFacts(models(() => true), async () => [{ factId: f.id, query: 0, score: 0.8 }], analysis(), [f], [], undefined, c);
    expect(selected.factIds).toEqual([f.id]);
    expect(selected.concepts!.coverage[0]).toMatchObject({ status: "supported", conceptStatus: "unknown", concepts: [] });
  });

  it("does not let a tag or role dates supply years or a stronger responsibility claim", async () => {
    for (const [text, requirement] of [["Built services in Python", "5 years of Python experience"], ["Helped lead the Python migration", "Led the Python migration"]]) {
      const f = fact("python", text!); f.roleId = "job";
      const m = models(() => true);
      const selected = await selectFacts(m, async () => [], analysis(requirement!), [f], [{ id: "job", kind: "job", org: "Example", title: "Engineer", startDate: "2010", endDate: "2020" }], undefined, context(requirement!, [hint(f)]));
      expect(selected.concepts!.coverage[0]!.status).toBe("not_evidenced");
      expect(m.judge).not.toHaveBeenCalled();
    }
  });

  it("leaves missing judge answers and missing retrieval evidence unknown, without declaring an experience gap", async () => {
    const f = fact("python", "Built Python services"), m = models(() => true);
    m.judge.mockResolvedValue({ verdicts: [] });
    const selected = await selectFacts(m, async () => [], analysis(), [f], [], undefined, context("Python services", [hint(f)]));
    expect(selected.concepts!.coverage[0]!.status).toBe("unknown");
    expect(selected.gaps).toEqual([]);
    const empty = await selectFacts(m, async () => [], analysis(), [f], [], undefined, context("Python services", []));
    expect(empty.concepts!.coverage[0]!.status).toBe("unknown");
  });

  it("caps coverage decisions and explicitly marks unhandled requirements unknown", async () => {
    const facts = Array.from({ length: 12 }, (_, index) => fact(`f${index}`, "Built Python services"));
    const a = { ...analysis(), requirements: Array.from({ length: 25 }, () => "Python services") };
    const c = context("Python services", facts.map((f) => hint(f)));
    c.requirements = a.requirements.map((text, index) => ({ ...c.requirements[0]!, id: `R${index}`, text }));
    const m = models(() => false);
    const selected = await selectFacts(m, async () => a.requirements.flatMap((_r, query) => facts.slice(0, 8).map((f) => ({ factId: f.id, query, score: 0.8 }))), a, facts, [], undefined, c);
    expect(m.judge.mock.calls.flatMap(([items]) => items)).toHaveLength(240);
    expect(selected.concepts!.coverage.slice(20).every((item) => item.status === "unknown")).toBe(true);
  });
});
