import { describe, expect, it } from "vitest";
import { MemoryStore, Taxonomy, MAX_MENTION_TEXT_CHARS, taxonomyFor, type Mention, type TaxonomyStore } from "../../src/taxonomy";
import { TAXONOMY_FIXTURE } from "../support/taxonomy-fixture";

const S = (n: number) => `esco:skill:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const O = (n: number) => `esco:occupation:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DEV = "onet:occ:99-1001.00";
const PM = "onet:occ:99-1002.00";
const BA = "onet:occ:99-1003.00";

const taxonomy = () => new Taxonomy(new MemoryStore(TAXONOMY_FIXTURE));
const brief = (mentions: Mention[]) => mentions.map((mention) => [mention.text, mention.concepts.map((concept) => concept.id), mention.weak]);

describe("the combined taxonomy", () => {
  it("says which taxonomy it is, and that none is loaded when none is", async () => {
    expect(await taxonomy().info()).toEqual(TAXONOMY_FIXTURE.info);
    const empty: TaxonomyStore = { info: async () => null, concepts: async () => [], labels: async () => [], from: async () => [], to: async () => [] };
    await expect(new Taxonomy(empty).info()).rejects.toThrow("unavailable: the taxonomy is not loaded");
    // Without the binding there is no taxonomy, and nothing that depends on one runs.
    expect(taxonomyFor({})).toBeNull();
  });

  it("gives concepts by ID and leaves out what isn't one", async () => {
    const found = await taxonomy().get([S(3), DEV, DEV, "esco:skill:not-there", "'; DROP TABLE concepts; --", ""]);
    expect([...found.keys()].sort()).toEqual([S(3), DEV].sort());
    expect(found.get(S(3))).toMatchObject({ kind: "knowledge", scheme: "esco", label: "Python (computer programming)", meta: { collections: ["digital"], reuse: "sector-specific" } });
    expect(found.get(DEV)).toMatchObject({ kind: "occupation", scheme: "onet", code: "99-1001.00" });
  });

  it("finds the concepts that carry a label, however it is typed", async () => {
    const t = taxonomy();
    expect(await t.lookup("  BUDGET   management ")).toEqual([{ id: S(1), kind: "skill", type: "alternative", matched: "budget management" }]);
    // One name, two sources: ESCO's concept and O*NET's software example. The source's own label comes before a derived one.
    expect(await t.lookup("go")).toEqual([
      { id: "onet:tool:go", kind: "tool", type: "preferred", matched: "Go" },
      { id: S(6), kind: "knowledge", type: "derived", matched: "Go" },
    ]);
    expect(await t.lookup("go", { kinds: ["knowledge"] })).toEqual([{ id: S(6), kind: "knowledge", type: "derived", matched: "Go" }]);
    expect(await t.lookup("Senior Backend Engineer", { kinds: ["occupation"] })).toEqual([{ id: DEV, kind: "occupation", type: "alternative", matched: "Senior Backend Engineer" }]);
    expect(await t.lookup("no such label")).toEqual([]);
    expect(await t.lookup("!!!")).toEqual([]);
  });
});

describe("labels found in a line of text", () => {
  it("are given with where they are and whose they are, the longest wording winning", async () => {
    const line = "Led data migration of 40 services to Kubernetes (K8s), using Python and Microsoft Excel.";
    const found = await taxonomy().mentions(line);
    expect(brief(found)).toEqual([
      ["data migration", [S(5)], false],
      ["Kubernetes", ["onet:tool:kubernetes", S(4)], false],
      ["K8s", [S(4)], false],
      ["Python", ["onet:tool:python", S(3)], false],
      ["Microsoft Excel", ["onet:tool:microsoft-excel"], false],
    ]);
    for (const mention of found) expect(line.slice(mention.start, mention.end)).toBe(mention.text);
    expect(found[1]!.concepts).toEqual([
      { id: "onet:tool:kubernetes", kind: "tool", type: "preferred", matched: "Kubernetes" },
      { id: S(4), kind: "knowledge", type: "alternative", matched: "Kubernetes" },
    ]);
  });

  it("leave out a label inside a longer one unless asked, and can be limited to kinds", async () => {
    const t = taxonomy();
    const line = "Selected container orchestration software for the team";
    expect(brief(await t.mentions(line))).toEqual([["container orchestration software", ["onet:toolcat:5.A.1.02"], false]]);
    expect(brief(await t.mentions(line, { keepContained: true }))).toEqual([
      ["container orchestration software", ["onet:toolcat:5.A.1.02"], false],
      ["container orchestration", [S(4)], false],
    ]);
    expect(brief(await t.mentions(line, { kinds: ["knowledge", "skill"] }))).toEqual([["container orchestration", [S(4)], false]]);
    // A label longer than the words looked at together is not found.
    expect(await t.mentions("Amazon Web Services AWS software", { maxWords: 3 })).toEqual([]);
    expect(brief(await t.mentions("Amazon Web Services AWS software"))).toEqual([["Amazon Web Services AWS software", ["onet:tool:amazon-web-services-aws-software"], false]]);
    expect(brief(await t.mentions("ran it on Amazon Web Services (AWS)"))).toEqual([["Amazon Web Services (AWS", ["onet:tool:amazon-web-services-aws-software"], false]]);
  });

  it("match across typography, and never inside another word", async () => {
    const t = taxonomy();
    expect(brief(await t.mentions("TEAM-LEADERSHIP; budget\u2014management"))).toEqual([
      ["TEAM-LEADERSHIP", [S(2)], false],
      ["budget\u2014management", [S(1)], false],
    ]);
    expect(brief(await t.mentions("C++ and SQL"))).toEqual([
      ["C++", ["onet:tool:c++"], false],
      ["SQL", [S(8)], false],
    ]);
    for (const line of ["Pythonic code", "NoSQL stores", "gopher", "MySQL", "Excellent results"]) expect(await t.mentions(line), line).toEqual([]);
  });

  it("mark a short or everyday word as thin evidence", async () => {
    const t = taxonomy();
    // Two letters are always thin, however they are written.
    expect(brief(await t.mentions("Wrote services in Go"))).toEqual([["Go", ["onet:tool:go", S(6)], true]]);
    expect(brief(await t.mentions("ready to go to market"))).toEqual([["go", ["onet:tool:go", S(6)], true]]);
    // Lower case where every label has a capital is thin; the same word as its label writes it is not.
    expect(brief(await t.mentions("scripting in python"))).toEqual([["python", ["onet:tool:python", S(3)], true]]);
    expect(brief(await t.mentions("scripting in Python"))).toEqual([["Python", ["onet:tool:python", S(3)], false]]);
    // A label that is itself lower case is matched as written.
    expect(brief(await t.mentions("kubernetes, k8s"))).toEqual([
      ["kubernetes", ["onet:tool:kubernetes", S(4)], true],
      ["k8s", [S(4)], true],
    ]);
    expect(brief(await t.mentions("strong budget management"))).toEqual([["budget management", [S(1)], false]]);
  });

  it("refuse a text too long to be a line, and find nothing in nothing", async () => {
    const t = taxonomy();
    expect(await t.mentions("")).toEqual([]);
    expect(await t.mentions("\u2026 !!! \u2014")).toEqual([]);
    await expect(t.mentions("a ".repeat(MAX_MENTION_TEXT_CHARS))).rejects.toThrow("invalid: this text is too long to look through");
    expect(await t.mentions("Python ".repeat(2000).trim())).toHaveLength(2000);
  });
});

describe("a concept's place in its own hierarchy", () => {
  it("is given nearest first, to the top", async () => {
    const t = taxonomy();
    expect((await t.broader(S(1))).map((concept) => concept.id)).toEqual(["esco:skill:S1.1", "esco:skill:S1"]);
    expect((await t.broader(O(1))).map((concept) => concept.id)).toEqual(["esco:isco:C2512", "esco:isco:C251"]);
    expect((await t.broader("onet:activity:4.A.3.b.1.I01.D02")).map((concept) => [concept.id, concept.meta.level])).toEqual([
      ["onet:activity:4.A.3.b.1.I01", "intermediate"],
      ["onet:activity:4.A.3.b.1", "general"],
    ]);
    expect((await t.broader("onet:tool:kubernetes")).map((concept) => concept.label)).toEqual(["Container orchestration software"]);
    expect(await t.broader("esco:skill:S1")).toEqual([]);
    expect(await t.broader("not an id")).toEqual([]);
  });

  it("ends even if the records loop", async () => {
    const looped = new Taxonomy(
      new MemoryStore({
        ...TAXONOMY_FIXTURE,
        edges: [...TAXONOMY_FIXTURE.edges, { src: "esco:skill:S1", rel: "broader", dst: S(1), meta: null }],
      }),
    );
    expect((await looped.broader(S(1))).map((concept) => concept.id)).toEqual(["esco:skill:S1.1", "esco:skill:S1"]);
  });
});

describe("an occupation seen through both sources", () => {
  it("joins O*NET's activities and software to ESCO's skills through the official crosswalk", async () => {
    const profile = (await taxonomy().profile(DEV))!;
    expect(profile.occupation.id).toBe(DEV);
    // The crosswalk also relates it to an ISCO group. A group is not an occupation and brings nothing.
    expect(profile.counterparts.map((counterpart) => [counterpart.concept.id, counterpart.match])).toEqual([[O(1), "exact"]]);
    expect(profile.activities.map((item) => [item.concept.label, item.tasks, item.via])).toEqual([
      ["Write computer programming code.", 2, { occupation: DEV, match: null }],
      ["Migrate software systems to new platforms.", 1, { occupation: DEV, match: null }],
    ]);
    expect(profile.tools.map((item) => [item.concept.label, item.inDemand, item.hot])).toEqual([
      ["Amazon Web Services AWS software", true, true],
      ["Python", true, true],
      ["Kubernetes", false, true],
      ["C++", false, false],
      ["Go", false, false],
    ]);
    // ESCO's skills come from the matched occupation, and say so.
    expect(profile.skills.map((item) => [item.concept.id, item.need, item.via])).toEqual([
      [S(3), "essential", { occupation: O(1), match: "exact" }],
      [S(4), "optional", { occupation: O(1), match: "exact" }],
      [S(5), "optional", { occupation: O(1), match: "exact" }],
    ]);
  });

  it("works the same from the ESCO side", async () => {
    const profile = (await taxonomy().profile(O(2)))!;
    expect(profile.counterparts.map((counterpart) => [counterpart.concept.id, counterpart.match])).toEqual([[PM, "close"]]);
    expect(profile.skills.map((item) => [item.concept.label, item.need, item.via.match])).toEqual([
      ["lead a team", "essential", null],
      ["manage budgets", "essential", null],
    ]);
    expect(profile.activities.map((item) => [item.concept.label, item.via])).toEqual([
      ["Manage project teams.", { occupation: PM, match: "close" }],
      ["Prepare operational budgets.", { occupation: PM, match: "close" }],
    ]);
    expect(profile.tools.map((item) => [item.concept.label, item.inDemand, item.hot])).toEqual([
      ["Python", false, true],
      ["Microsoft Excel", false, false],
    ]);
  });

  it("puts what a source says of the occupation itself before what it says of a matched one", async () => {
    // Two O*NET occupations matched to one ESCO occupation, the closer one first. Each names the
    // same activity; the closer occupation's record is the one kept.
    const store = new MemoryStore({
      ...TAXONOMY_FIXTURE,
      edges: [...TAXONOMY_FIXTURE.edges, { src: PM, rel: "matches", dst: O(3), meta: { type: "exact" } }],
    });
    const profile = (await new Taxonomy(store).profile(O(3)))!;
    expect(profile.counterparts.map((counterpart) => [counterpart.concept.id, counterpart.match])).toEqual([
      [PM, "exact"],
      [BA, "broad"],
    ]);
    const budgets = profile.activities.find((item) => item.concept.label === "Prepare operational budgets.")!;
    expect(budgets.via).toEqual({ occupation: PM, match: "exact" });
    expect(profile.tools.map((item) => [item.concept.label, item.via.occupation, item.inDemand])).toEqual([
      ["Python", PM, false],
      ["Microsoft Excel", PM, false],
    ]);
    expect(profile.skills.map((item) => [item.concept.id, item.need, item.via.match])).toEqual([
      [S(1), "essential", null],
      [S(7), "optional", null],
    ]);
  });

  it("is nothing for a concept that isn't an occupation, and ignores a match it can't read", async () => {
    const t = taxonomy();
    expect(await t.profile(S(1))).toBeNull();
    expect(await t.profile("esco:isco:C2512")).toBeNull();
    expect(await t.profile("onet:occ:00-0000.00")).toBeNull();
    const odd = new Taxonomy(
      new MemoryStore({
        ...TAXONOMY_FIXTURE,
        edges: TAXONOMY_FIXTURE.edges.map((edge) => (edge.rel === "matches" && edge.src === BA ? { ...edge, meta: { type: "sideways" as never } } : edge)),
      }),
    );
    const profile = (await odd.profile(BA))!;
    expect(profile.counterparts).toEqual([]);
    expect(profile.skills).toEqual([]);
    expect(profile.activities).toHaveLength(1);
  });
});
