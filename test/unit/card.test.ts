import { describe, expect, it, vi } from "vitest";
import { buildCard, cardPreviewFor, experienceOf, groupsOf, occupationOrder, type CardReads } from "../../src/pipeline/card";
import { CARD_PREVIEW_OFF, MAX_CARD_SKILLS, MAX_CARD_SKILL_READS, MAX_CARD_WALK_IDS, type CardMaterial, type CardPreview } from "../../src/shared/card";
import { MemoryStore, type Concept, type ConceptKind, type Edge, type TaxonomyStore } from "../../src/taxonomy";
import { TAXONOMY_FIXTURE } from "../support/taxonomy-fixture";

// The private card as the Worker builds it from a vault's material and the taxonomy. The made-up
// taxonomy is read in memory; so is a generated one with 30 groups, deep chains and concepts with
// several parents. Reads are counted as D1Store makes them: one statement per 80 concepts, and one
// per 79 sources of relations (80 bound values, less one for the relation).

const S = (n: number) => `esco:skill:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const O = (n: number) => `esco:occupation:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DEV = "onet:occ:99-1001.00";
const VERSION = TAXONOMY_FIXTURE.info.version;
const fixture = () => new MemoryStore(TAXONOMY_FIXTURE);
/** 11 November 2026, UTC. */
const NOW = Date.UTC(2026, 10, 11, 12);

const concept = (id: string, kind: ConceptKind, label = `label of ${id}`): Concept => ({
  id,
  kind,
  scheme: id.startsWith("onet:") ? "onet" : "esco",
  code: null,
  label,
  description: null,
  meta: {},
});
const broader = (src: string, dst: string): Edge => ({ src, rel: "broader", dst, meta: null });
const generated = (concepts: Concept[], edges: Edge[]) => new MemoryStore({ info: TAXONOMY_FIXTURE.info, concepts, labels: [], edges });

/** A store that counts what it is asked, call by call and in D1 statements. */
function counted(store: TaxonomyStore) {
  const calls = { info: 0, concepts: [] as string[][], fromAny: [] as string[][] };
  const reads: CardReads = {
    info: () => {
      calls.info++;
      return store.info();
    },
    concepts: (ids) => {
      calls.concepts.push([...ids]);
      return store.concepts(ids);
    },
    fromAny: (srcs, rels) => {
      expect(rels).toEqual(["broader"]);
      calls.fromAny.push([...srcs]);
      return store.fromAny(srcs, rels);
    },
  };
  const batches = (lists: string[][], size: number) => lists.reduce((sum, ids) => sum + Math.ceil(new Set(ids).size / size), 0);
  return { reads, calls, statements: () => calls.info + batches(calls.concepts, 80) + batches(calls.fromAny, 79) };
}

const job = (startDate: string | null, endDate: string | null, occupations: string[] = [], unknownEndStartDate: string | null = null) => ({
  startDate,
  endDate,
  unknownEndStartDate,
  occupations,
});
const material = (skills: string[], jobs: CardMaterial["jobs"] = [], barred: string[] = []): CardMaterial => ({
  jobs,
  skills: skills.map((conceptId, index) => ({ conceptId, facts: skills.length - index })),
  barred,
});
async function cardOf(given: CardMaterial, reads: CardReads = fixture()) {
  const preview = await buildCard(given, reads, VERSION, NOW);
  if (preview.state !== "ready") throw new Error("expected a card");
  return preview.card;
}

/** 30 skill groups, each with one skill under it. */
function thirtyGroups() {
  const concepts: Concept[] = [];
  const edges: Edge[] = [];
  for (let n = 0; n < 30; n++) {
    const group = `esco:skill:G.${String(n).padStart(2, "0")}`;
    const skill = `esco:skill:k-${String(n).padStart(2, "0")}`;
    concepts.push(concept(group, "skill-group", `group ${n}`), concept(skill, "skill", `skill ${n}`));
    edges.push(broader(skill, group));
  }
  return { store: generated(concepts, edges), skills: concepts.filter((c) => c.kind === "skill").map((c) => c.id) };
}

/** A skill with a chain of `length` skills above it and a group at the top: the group is `length + 1` steps away. */
function chain(name: string, length: number) {
  const nodes = [`esco:skill:${name}`, ...Array.from({ length }, (_, n) => `esco:skill:${name}-up-${n + 1}`)];
  const group = `esco:skill:${name}-group`;
  return {
    id: nodes[0]!,
    group,
    concepts: [...nodes.map((id) => concept(id, "skill")), concept(group, "skill-group", `${name} group`)],
    edges: [...nodes.slice(1).map((id, n) => broader(nodes[n]!, id)), broader(nodes.at(-1)!, group)],
  };
}

describe("the skills on a card", () => {
  it("holds at most 12 skills however many confirmed concepts there are", async () => {
    const { store, skills } = thirtyGroups();
    const card = await cardOf(material(skills), store);
    expect(card.skills).toHaveLength(MAX_CARD_SKILLS);
    expect(card.skills.map((skill) => skill.label)).toEqual(Array.from({ length: 12 }, (_, n) => `group ${n}`));
  });

  it("ranks skills by how many facts show them, then by ID, and shows each group once", async () => {
    // The Vault ranks (test/unit/card-material.test.ts); the card keeps that order and shows a group the first time it comes.
    const card = await cardOf(material([S(4), "onet:tool:go", S(3), "onet:tool:python", S(1), "onet:tool:kubernetes"]));
    expect(card.skills).toEqual([
      { id: "esco:isced-f:061", label: "information and communication technologies" },
      { id: "onet:toolcat:5.A.1.01", label: "Object or component oriented development software" },
      { id: "esco:skill:S1.1", label: "allocating and controlling resources" },
      { id: "onet:toolcat:5.A.1.02", label: "Container orchestration software" },
    ]);
  });

  it("shows a skill or knowledge at its nearest skill group and a tool at its category, and a group as itself", async () => {
    const groups = await groupsOf(await fixture().concepts([S(1), S(3), "onet:tool:kubernetes", "esco:skill:S1", "onet:toolcat:5.A.2.01"]), fixture());
    expect(Object.fromEntries([...groups].map(([id, group]) => [id, group.id]))).toEqual({
      // A skill, at the group directly above it and not the one above that.
      [S(1)]: "esco:skill:S1.1",
      // Knowledge, at its group.
      [S(3)]: "esco:isced-f:061",
      "onet:tool:kubernetes": "onet:toolcat:5.A.1.02",
      "esco:skill:S1": "esco:skill:S1",
      "onet:toolcat:5.A.2.01": "onet:toolcat:5.A.2.01",
    });
    // A tool goes on past a skill group to its category, and a skill past a category to its group.
    const tool = "onet:tool:odd";
    const skill = "esco:skill:odd";
    const store = generated(
      [concept(tool, "tool"), concept(skill, "skill"), concept("esco:skill:G.near", "skill-group"), concept("onet:toolcat:near", "tool-category"), concept("onet:toolcat:far", "tool-category"), concept("esco:skill:G.far", "skill-group")],
      [broader(tool, "esco:skill:G.near"), broader("esco:skill:G.near", "onet:toolcat:far"), broader(skill, "onet:toolcat:near"), broader("onet:toolcat:near", "esco:skill:G.far")],
    );
    const odd = await groupsOf(await store.concepts([tool, skill]), store);
    expect(odd.get(tool)?.id).toBe("onet:toolcat:far");
    expect(odd.get(skill)?.id).toBe("esco:skill:G.far");
    // An activity, a task or an occupation has no group on a card.
    const none = await groupsOf(await fixture().concepts(["onet:activity:4.A.3.b.1.I01.D01", "onet:task:9001", O(1), "esco:isco:C2512"]), fixture());
    expect(none.size).toBe(0);
  });

  it("breaks a tie between two groups one level up by ID", async () => {
    const skill = "esco:skill:twin";
    const store = generated(
      [concept(skill, "skill"), concept("esco:skill:G.b", "skill-group"), concept("esco:skill:G.a", "skill-group"), concept("esco:skill:G.0", "skill-group"), concept("esco:skill:mid", "skill")],
      // Two groups one step up, and a lower ID two steps up through another skill. Nearest wins, then the lower ID.
      [broader(skill, "esco:skill:G.b"), broader(skill, "esco:skill:G.a"), broader(skill, "esco:skill:mid"), broader("esco:skill:mid", "esco:skill:G.0")],
    );
    expect((await groupsOf(await store.concepts([skill]), store)).get(skill)?.id).toBe("esco:skill:G.a");
  });

  it("drops a concept the taxonomy doesn't hold, or one with no group within 12 levels", async () => {
    const reach = chain("reach", 11);
    const beyond = chain("beyond", 12);
    const dangling = "esco:skill:dangling";
    const store = generated(
      [...reach.concepts, ...beyond.concepts, concept(dangling, "skill")],
      // A relation to a concept that isn't there is not followed.
      [...reach.edges, ...beyond.edges, broader(dangling, "esco:skill:not-there"), broader("esco:skill:not-there", reach.group)],
    );
    expect(reach.edges).toHaveLength(12);
    const groups = await groupsOf(await store.concepts([reach.id, beyond.id, dangling, "esco:skill:unknown"]), store);
    expect([...groups.keys()]).toEqual([reach.id]);
    expect(groups.get(reach.id)?.id).toBe(reach.group);
    // In the made-up taxonomy, a skill with nothing above it.
    expect(await cardOf(material([S(2), S(5), "esco:skill:unknown"]))).toMatchObject({ skills: [] });
  });

  it("never shows a concept a marked fact names, as a skill or as the group another fact's skill belongs to", async () => {
    // S(1) is under the skill group S1.1, Kubernetes under the tool category 5.A.1.02, and S(3) under 061.
    const open = await cardOf(material([S(1), "onet:tool:kubernetes", S(3)]));
    expect(open.skills.map((skill) => skill.id)).toEqual(["esco:skill:S1.1", "onet:toolcat:5.A.1.02", "esco:isced-f:061"]);
    // A marked fact names the group and the category themselves. Unmarked facts' skills reach both, and neither is shown.
    const marked = await cardOf(material([S(1), "onet:tool:kubernetes", S(3)], [], ["esco:skill:S1.1", "onet:toolcat:5.A.1.02"]));
    expect(marked.skills).toEqual([{ id: "esco:isced-f:061", label: "information and communication technologies" }]);
    // A barred skill that reaches the Worker is not shown either, and isn't read.
    const { reads, calls } = counted(fixture());
    expect((await cardOf(material([S(1), S(3)], [], [S(1)]), reads)).skills.map((skill) => skill.id)).toEqual(["esco:isced-f:061"]);
    expect(calls.concepts[0]).toEqual([S(3)]);
  });

  it("walks every skill together: one fromAny and one concepts per level, at most 37 statements in all", async () => {
    // 24 skills, each at the bottom of a chain of 12 with one more parent at every level: 576 concepts the walk could read.
    const concepts: Concept[] = [];
    const edges: Edge[] = [];
    const skills: string[] = [];
    for (let s = 0; s < 24; s++) {
      const root = `esco:skill:w${s}`;
      skills.push(root);
      concepts.push(concept(root, "skill"));
      let level = [root];
      for (let depth = 1; depth <= 12; depth++) {
        const next = [`esco:skill:w${s}-${depth}`, `esco:skill:w${s}-${depth}b`];
        for (const id of next) concepts.push(concept(id, depth === 12 ? "skill-group" : "skill"));
        for (const from of level) for (const to of next) edges.push(broader(from, to));
        level = next;
      }
    }
    const { reads, calls, statements } = counted(generated(concepts, edges));
    const card = await cardOf(material(skills, [job("2020-01", null, [O(1)])]), reads);
    // One read of the occupations, one of the skills, then the walk: one of each per level, and no more.
    expect(calls.concepts.length - 2).toBeLessThanOrEqual(12);
    expect(calls.fromAny.length).toBeLessThanOrEqual(12);
    expect(calls.fromAny[0]).toEqual([...skills].sort());
    expect(statements()).toBeLessThanOrEqual(37);
    // Past 400 concepts it stopped, so these deep groups are not shown.
    expect(card.skills).toEqual([]);

    // The same bound holds however the taxonomy is shaped: random graphs with many parents and shared nodes.
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let round = 0; round < 25; round++) {
      const ids = Array.from({ length: 900 }, (_, n) => `esco:skill:r${n}`);
      const kinds = ids.map((): ConceptKind => (random(40) === 0 ? "skill-group" : random(30) === 0 ? "tool-category" : random(9) === 0 ? "tool" : "skill"));
      const graph = ids.flatMap((id, n) => Array.from({ length: random(4) }, () => broader(id, ids[Math.min(899, n + 1 + random(60))]!)));
      const store = counted(generated(ids.map((id, n) => concept(id, kinds[n]!)), graph));
      await cardOf(material(ids.slice(0, 40), [job("2019", null, [O(1), DEV])]), store.reads);
      expect(store.statements(), `round ${round}`).toBeLessThanOrEqual(37);
      expect(store.calls.concepts.slice(2).flat().length, `round ${round}`).toBeLessThanOrEqual(MAX_CARD_WALK_IDS);
    }
  });

  it("stops at 400 concepts and drops the skills still unresolved", async () => {
    const near = "esco:skill:near";
    const wide = "esco:skill:wide";
    const fan = Array.from({ length: 300 }, (_, n) => `esco:skill:fan-${n}`);
    const above = fan.map((id) => `${id}-up`);
    const store = generated(
      [concept(near, "skill"), concept("esco:skill:G.near", "skill-group"), concept(wide, "skill"), ...fan.map((id) => concept(id, "skill")), ...above.map((id, n) => concept(id, n === 0 ? "skill-group" : "skill"))],
      // One level up: one group for `near`, 300 skills for `wide` (301 read). Two up, 300 more, one a group: 601 would pass 400.
      [broader(near, "esco:skill:G.near"), ...fan.map((id) => broader(wide, id)), ...fan.map((id, n) => broader(id, above[n]!))],
    );
    const { reads, calls } = counted(store);
    const groups = await groupsOf(await store.concepts([near, wide]), reads);
    expect(Object.fromEntries([...groups].map(([id, group]) => [id, group.id]))).toEqual({ [near]: "esco:skill:G.near" });
    expect(calls.concepts.flat()).toHaveLength(301);
    expect(calls.fromAny).toHaveLength(2);
  });

  it("reads at most 24 skill concepts and one batch of occupations", async () => {
    const { store, skills } = thirtyGroups();
    const { reads, calls } = counted(store);
    const jobs = Array.from({ length: 12 }, (_, n) => job(`20${10 + n}`, `20${11 + n}`, [`esco:occupation:job-${n}`, `onet:occ:99-10${String(n).padStart(2, "0")}.00`]));
    await cardOf(material(skills, jobs), reads);
    expect(calls.info).toBe(0);
    // The occupations come first, in one batch of at most eight; then the first 24 skills, in rank order.
    expect(calls.concepts[0]).toHaveLength(8);
    expect(calls.concepts[1]).toEqual(skills.slice(0, MAX_CARD_SKILL_READS));
    expect(calls.fromAny[0]).toEqual(skills.slice(0, MAX_CARD_SKILL_READS));
    // No occupations and no skills: nothing to read.
    const empty = counted(store);
    await cardOf(material([]), empty.reads);
    expect(empty.statements()).toBe(0);
  });
});

describe("the occupation on a card", () => {
  it("takes the occupation of the latest confirmed job, ESCO first", async () => {
    const jobs = [
      job("2015", "2018", [O(3)]),
      // The current job: O*NET's occupation, ESCO's and an ISCO group, in the order they were confirmed.
      job("2021-05", null, [DEV, "esco:isco:C2512", O(1)]),
      job("2018", "2021-04", [O(2)]),
    ];
    expect(occupationOrder(jobs)).toEqual([O(1), DEV, "esco:isco:C2512", O(2), O(3)]);
    // The occupation itself, as the taxonomy labels it: not its ISCO group, not the label a tag kept.
    expect((await cardOf(material([], jobs))).occupation).toEqual({ id: O(1), label: "software developer" });
    // Without a current job, the latest end, then the latest start.
    expect(occupationOrder([job("2010", "2019", [O(3)]), job("2012", "2020-06", [O(2)]), job("2014", "2020-06", [DEV])])).toEqual([DEV, O(2), O(3)]);
    // A year alone ends as late as it can: "2020" ends after "2020-06".
    expect(occupationOrder([job("2012", "2020-06", [O(2)]), job("2010", "2020", [O(3)])])).toEqual([O(3), O(2)]);
    // An ID the taxonomy doesn't hold, or one that isn't an occupation, is passed over.
    expect((await cardOf(material([], [job("2021", null, ["esco:occupation:gone", S(1)]), job("2010", "2012", [O(2)])]))).occupation).toEqual({
      id: O(2),
      label: "ICT project manager",
    });
    // A job with no confirmed occupation leaves the card without one.
    expect((await cardOf(material([], [job("2021", null)]))).occupation).toBeNull();
    // At most eight are read, and one is read once.
    expect(occupationOrder(Array.from({ length: 6 }, (_, n) => job(`20${10 + n}`, null, [O(n + 1), O(n + 2)])))).toHaveLength(7);
    expect(occupationOrder(Array.from({ length: 6 }, (_, n) => job(`20${10 + n}`, null, [O(n * 2 + 1), O(n * 2 + 2)])))).toHaveLength(8);
  });
});

describe("the experience on a card", () => {
  it("counts overlapping jobs once", () => {
    // Two years and two years, overlapping by a year: three years.
    expect(experienceOf([job("2018-01", "2019-12"), job("2019-01", "2020-12")], NOW)).toBe("2-5");
    // Each alone is under two; together, with no overlap, two to five.
    expect(experienceOf([job("2018-01", "2018-12"), job("2018-06", "2019-03")], NOW)).toBe("under-2");
    expect(experienceOf([job("2018-01", "2018-12"), job("2019-01", "2019-12")], NOW)).toBe("2-5");
    // One inside another adds nothing.
    expect(experienceOf([job("2015-01", "2019-11"), job("2016-01", "2016-12")], NOW)).toBe("2-5");
    expect(experienceOf([job("2015-01", "2020-01")], NOW)).toBe("5-10");
    expect(experienceOf([job("2010-01", "2015-12"), job("2016-01", "2020-12")], NOW)).toBe("10-plus");
    // The band edges are 24, 60 and 120 months.
    expect(experienceOf([job("2020-01", "2021-11")], NOW)).toBe("under-2");
    expect(experienceOf([job("2020-01", "2021-12")], NOW)).toBe("2-5");
    expect(experienceOf([job("2010-01", "2019-11")], NOW)).toBe("5-10");
    expect(experienceOf([job("2010-01", "2019-12")], NOW)).toBe("10-plus");
  });

  it("gives a band from year-only dates only when every reading agrees", () => {
    // 2015 to 2017 is at least 13 months (December to December) and at most 36: under two or more.
    expect(experienceOf([job("2015", "2017")], NOW)).toBe("unknown");
    // 2010 to 2014 is 49 to 60 months: under five, or exactly five.
    expect(experienceOf([job("2010", "2014")], NOW)).toBe("unknown");
    // 2010 to 2013 is 37 to 48 months: two to five either way.
    expect(experienceOf([job("2010", "2013")], NOW)).toBe("2-5");
    // 2000 to 2015 is ten years or more however it is read.
    expect(experienceOf([job("2000", "2015")], NOW)).toBe("10-plus");
    // A year beside a month: 2019-06 to 2020 is 7 to 19 months.
    expect(experienceOf([job("2019-06", "2020")], NOW)).toBe("under-2");
    // Two year-only jobs whose overlap depends on the reading.
    expect(experienceOf([job("2018", "2019"), job("2019", "2020")], NOW)).toBe("unknown");
  });

  it("is unknown when a confirmed job has no start or an unknown end", () => {
    expect(experienceOf([job("2010-01", "2020-12"), job(null, null)], NOW)).toBe("unknown");
    // An unknown end keeps its start apart, and the start is null.
    expect(experienceOf([job("2010-01", "2020-12"), job(null, null, [], "2021")], NOW)).toBe("unknown");
    expect(experienceOf([job(null, "2019-01")], NOW)).toBe("unknown");
  });

  it("runs a current job to now, and clamps future dates", () => {
    // From November 2024 to November 2026 is 25 months.
    expect(experienceOf([job("2024-11", null)], NOW)).toBe("2-5");
    expect(experienceOf([job("2024-12", null)], NOW)).toBe("2-5");
    expect(experienceOf([job("2025-01", null)], NOW)).toBe("under-2");
    // An end after now counts to now; a job that hasn't started counts nothing.
    expect(experienceOf([job("2024-11", "2030-01")], NOW)).toBe("2-5");
    expect(experienceOf([job("2025-01", "2030-01")], NOW)).toBe("under-2");
    expect(experienceOf([job("2016-01", "2019-12"), job("2027-01", null)], NOW)).toBe("2-5");
    // The month is now's in UTC.
    expect(experienceOf([job("2024-12", null)], Date.UTC(2026, 11, 1, 0, 30))).toBe("2-5");
    expect(experienceOf([job("2025-01", null)], Date.UTC(2026, 11, 31, 23, 59))).toBe("2-5");
  });

  it("has no experience without a confirmed job", async () => {
    expect(experienceOf([], NOW)).toBeNull();
    expect((await cardOf(material([S(1)]))).experience).toBeNull();
  });
});

describe("the card as a whole", () => {
  it("carries only taxonomy labels and IDs and a band", async () => {
    const given = material([S(1), "onet:tool:kubernetes"], [job("2016-03", "2019-08", [DEV]), job("2019-09", null, [O(1)])]);
    const preview = await buildCard(given, fixture(), VERSION, NOW);
    expect(preview).toEqual({
      state: "ready",
      taxonomyVersion: VERSION,
      card: {
        occupation: { id: O(1), label: "software developer" },
        experience: "10-plus",
        skills: [
          { id: "esco:skill:S1.1", label: "allocating and controlling resources" },
          { id: "onet:toolcat:5.A.1.02", label: "Container orchestration software" },
        ],
      },
    });
    /** Every path to a key, with array positions left out. */
    const keys = (value: unknown, at = ""): string[] =>
      Array.isArray(value)
        ? [...new Set(value.flatMap((item) => keys(item, `${at}[]`)))]
        : value && typeof value === "object"
          ? Object.entries(value).flatMap(([key, inner]) => [`${at}${key}`, ...keys(inner, `${at}${key}.`)])
          : [];
    expect(keys(preview).sort()).toEqual(
      ["state", "taxonomyVersion", "card", "card.occupation", "card.occupation.id", "card.occupation.label", "card.experience", "card.skills", "card.skills.[]id", "card.skills.[]label"].sort(),
    );
    const values = (value: unknown): unknown[] => (value && typeof value === "object" ? Object.values(value).flatMap(values) : [value]);
    const dates = given.jobs.flatMap((one) => [one.startDate, one.endDate]).filter((date): date is string => date !== null);
    for (const value of values(preview)) for (const date of dates) expect(String(value)).not.toContain(date);
  });

  it("is refused when switched off, unavailable when the taxonomy is unbound or not loaded, and reads no material in either case", async () => {
    const readMaterial = vi.fn(async () => material([S(1)]));
    for (const value of [undefined, "false", "TRUE", "1", ""])
      await expect(cardPreviewFor({ CARD_PREVIEW_ENABLED: value }, readMaterial, NOW, fixture())).rejects.toThrow(`unavailable: ${CARD_PREVIEW_OFF}`);
    // No taxonomy bound: the default reads nothing.
    expect(await cardPreviewFor({ CARD_PREVIEW_ENABLED: "true" }, readMaterial, NOW)).toEqual({ state: "unavailable" });
    // A taxonomy that says it is not loaded, as one with nothing in it or only part of a load does.
    const notLoaded = counted(fixture());
    notLoaded.reads.info = vi.fn(async () => null);
    expect(await cardPreviewFor({ CARD_PREVIEW_ENABLED: "true" }, readMaterial, NOW, notLoaded.reads)).toEqual({ state: "unavailable" });
    expect(notLoaded.calls.concepts).toEqual([]);
    expect(readMaterial).not.toHaveBeenCalled();
    // A fault in the taxonomy's database is not read as "unavailable": it reaches the fixed 500.
    const failing = counted(fixture());
    failing.reads.info = async () => {
      throw new Error("D1_ERROR: something");
    };
    await expect(cardPreviewFor({ CARD_PREVIEW_ENABLED: "true" }, readMaterial, NOW, failing.reads)).rejects.toThrow("D1_ERROR");
    expect(readMaterial).not.toHaveBeenCalled();
    // Switched on and loaded: the material is read once, and the card is made.
    const ready: CardPreview = await cardPreviewFor({ CARD_PREVIEW_ENABLED: "true" }, readMaterial, NOW, fixture());
    expect(readMaterial).toHaveBeenCalledTimes(1);
    expect(ready).toEqual({ state: "ready", taxonomyVersion: VERSION, card: { occupation: null, experience: null, skills: [{ id: "esco:skill:S1.1", label: "allocating and controlling resources" }] } });
  });
});
