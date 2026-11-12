import { describe, expect, it, vi } from "vitest";
import { D1Store, MemoryStore, Taxonomy, MAX_MENTION_TEXT_CHARS, normalizeLabel, taxonomyFor, words, type Concept, type Edge, type Label, type Mention, type TaxonomyStore } from "../../src/taxonomy";
import { TAXONOMY_FIXTURE } from "../support/taxonomy-fixture";

const S = (n: number) => `esco:skill:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const O = (n: number) => `esco:occupation:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DEV = "onet:occ:99-1001.00";
const PM = "onet:occ:99-1002.00";
const BA = "onet:occ:99-1003.00";

const taxonomy = () => new Taxonomy(new MemoryStore(TAXONOMY_FIXTURE));
const brief = (mentions: Mention[]) => mentions.map((mention) => [mention.text, mention.concepts.map((concept) => concept.id), mention.weak]);
/** The test taxonomy with more labels, each stored in the form the builder would store it in. */
const withLabels = (...labels: Omit<Label, "norm">[]) =>
  new Taxonomy(new MemoryStore({ ...TAXONOMY_FIXTURE, labels: [...TAXONOMY_FIXTURE.labels, ...labels.map((label) => ({ ...label, norm: normalizeLabel(label.text) }))] }));
/** An accent written as its letter and then a combining mark, as some editors and PDF text layers write it. */
const decomposed = (text: string) => text.normalize("NFD");
/** A text with every character that is not plain ASCII written as its code, to name a case whose point is a character nobody sees. */
const coded = (text: string) => text.replace(/[^\x20-\x7e]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
/**
 * A run of combining marks of five classes, the highest class first. Normalising a text puts each
 * run of marks in canonical order, and here every mark has to pass all the marks of a higher class
 * before it, so the time grows with the square of the run.
 */
const pile = (marks: number) => ["\u0315", "\u0301", "\u0323", "\u0327", "\u0334"].map((mark) => mark.repeat(marks / 5)).join("");
/**
 * Does a read, and says how long the longest run of marks was in anything normalised on the way.
 * That run is what the time to read a word someone else wrote hangs on. It is counted, not timed.
 */
async function marksNormalised<T>(read: () => T | Promise<T>): Promise<[T, number]> {
  const normalize = vi.spyOn(String.prototype, "normalize");
  try {
    const result = await read();
    const runs = normalize.mock.contexts.flatMap((text) => [...String(text).matchAll(/\p{M}+/gu)].map((run) => run[0].length));
    return [result, Math.max(0, ...runs)];
  } finally {
    normalize.mockRestore();
  }
}

describe("the combined taxonomy", () => {
  it("says which taxonomy it is, and that none is loaded when none is", async () => {
    expect(await taxonomy().info()).toEqual(TAXONOMY_FIXTURE.info);
    const empty: TaxonomyStore = { info: async () => null, concepts: async () => [], labels: async () => [], from: async () => [], fromAny: async () => [], to: async () => [], conceptPage: async () => [], conceptCount: async () => 0 };
    await expect(new Taxonomy(empty).info()).rejects.toThrow("unavailable: the taxonomy is not loaded");
    // Without the binding there is no taxonomy, and nothing that depends on one runs.
    expect(taxonomyFor({})).toBeNull();
  });

  it("takes a database with no tables for nothing loaded, and no other failed read", async () => {
    const failing = (message: string) =>
      new D1Store({
        prepare: () => ({
          all: async () => {
            throw new Error(message);
          },
        }),
      } as unknown as D1Database);
    // What D1 says of a database that nothing has been loaded into.
    const unloaded = failing("D1_ERROR: no such table: taxonomy_meta: SQLITE_ERROR");
    expect(await unloaded.info()).toBeNull();
    await expect(new Taxonomy(unloaded).info()).rejects.toThrow("unavailable: the taxonomy is not loaded");
    // A read that failed for another reason says nothing about what is loaded. It is D1's failure to report.
    for (const message of ["D1_ERROR: Network connection lost.", "D1_ERROR: no such table: concepts: SQLITE_ERROR", "D1_ERROR: D1 DB is overloaded. Too many requests queued."])
      await expect(failing(message).info(), message).rejects.toThrow(message);
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
    // A text longer than any that is looked through for mentions is no label, and is not read.
    const spaced = (length: number) => `budget${" ".repeat(length - 16)}management`;
    expect(await t.lookup(spaced(MAX_MENTION_TEXT_CHARS))).toEqual([{ id: S(1), kind: "skill", type: "alternative", matched: "budget management" }]);
    expect(await marksNormalised(() => t.lookup(spaced(MAX_MENTION_TEXT_CHARS + 1)))).toEqual([[], 0]);
    expect(await marksNormalised(() => t.lookup(`Python${pile(3 * MAX_MENTION_TEXT_CHARS)}`))).toEqual([[], 0]);
  });
});

describe("the concepts of given kinds", () => {
  it("pages through concepts of given kinds in ID order and counts them", async () => {
    const t = taxonomy();
    const kinds = ["skill", "tool", "occupation"] as const;
    const all = TAXONOMY_FIXTURE.concepts.filter((concept) => (kinds as readonly string[]).includes(concept.kind)).map((concept) => concept.id).sort();
    expect(all.length).toBeGreaterThan(5);
    // Three at a time, each page after the last ID of the one before, until a page comes back empty.
    const seen: string[] = [];
    let after = "";
    for (;;) {
      const page = await t.conceptPage(after, kinds, 3);
      expect(page.length).toBeLessThanOrEqual(3);
      if (page.length === 0) break;
      seen.push(...page.map((concept) => concept.id));
      after = page.at(-1)!.id;
    }
    expect(seen).toEqual(all);
    // Whole records, as the builder wrote them.
    expect((await t.conceptPage("", ["skill"], 1))[0]).toEqual(TAXONOMY_FIXTURE.concepts.find((concept) => concept.id === S(1)));
    expect(await t.conceptCount(kinds)).toBe(all.length);
    expect(await t.conceptCount(kinds, all[2])).toBe(3);
    expect(await t.conceptCount(kinds, "")).toBe(0);
    expect(await t.conceptPage("", [], 10)).toEqual([]);
    expect(await t.conceptCount([])).toBe(0);
    for (const limit of [0, 101, 1.5]) await expect(t.conceptPage("", kinds, limit), String(limit)).rejects.toThrow("invalid");
    expect(await t.conceptPage("", kinds, 100)).toHaveLength(all.length);
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

  it("read an accent the same however the text encodes it", async () => {
    expect(decomposed("r\u00e9sum\u00e9")).toHaveLength(8);
    expect(words(decomposed("Wrote a r\u00e9sum\u00e9 for the caf\u00e9")).map((word) => word.norm)).toEqual(["wrote", "a", "resume", "for", "the", "cafe"]);
    expect(normalizeLabel(decomposed("ma\u00eetre d'h\u00f4tel"))).toBe("maitre d'hotel");
    expect(normalizeLabel("ma\u00eetre d'h\u00f4tel")).toBe("maitre d'hotel");
    // A label written with combining marks is stored in the form its composed twin is.
    expect(normalizeLabel(decomposed("comprehend spoken Proven\u00e7al"))).toBe("comprehend spoken provencal");

    const t = withLabels(
      { conceptId: O(4), kind: "occupation", type: "alternative", text: "ma\u00eetre d'h\u00f4tel" },
      { conceptId: O(5), kind: "occupation", type: "alternative", text: "SEN" },
      { conceptId: S(9), kind: "skill", type: "alternative", text: "RE" },
    );
    for (const line of ["Ma\u00eetre d'h\u00f4tel at a 120-cover restaurant", decomposed("Ma\u00eetre d\u2019h\u00f4tel at a 120-cover restaurant")]) {
      const found = await t.mentions(line);
      expect(found.map((mention) => mention.concepts.map((concept) => concept.id)), line).toEqual([[O(4)]]);
      // The mention is where the label is in the text as given, with every mark of its last letter.
      expect(found[0]!.start).toBe(0);
      expect(line.slice(found[0]!.start, found[0]!.end)).toBe(found[0]!.text);
      expect(found[0]!.text.normalize("NFC")).toMatch(/^Ma\u00eetre d['\u2019]h\u00f4tel$/);
    }
    // The letters before an accent are not a word of their own: no "Sen" in the first line, no "Re" in the second.
    for (const line of ["Se\u00f1or engineer", "R\u00e9sum\u00e9 screening"]) {
      expect(await t.mentions(line), line).toEqual([]);
      expect(await t.mentions(decomposed(line)), line).toEqual([]);
    }
    expect(brief(await t.mentions("SEN support"))).toEqual([["SEN", [O(5)], false]]);
  });

  it("read a word through the characters in it that are not seen", async () => {
    const t = taxonomy();
    // A soft hyphen, a zero-width space and a zero-width joiner: none is something a person reads.
    expect(words("manage\u00adment, Py\u200bthon and Kuber\u200dnetes").map((word) => word.norm)).toEqual(["management", "python", "and", "kubernetes"]);
    const line = "strong budget manage\u00adment in Py\u200bthon";
    const found = await t.mentions(line);
    expect(found.map((mention) => [mention.text, mention.norm, mention.concepts.map((concept) => concept.id)])).toEqual([
      ["budget manage\u00adment", "budget management", [S(1)]],
      ["Py\u200bthon", "python", ["onet:tool:python", S(3)]],
    ]);
    for (const mention of found) expect(line.slice(mention.start, mention.end)).toBe(mention.text);
    // Such a character between two words still leaves two words, and one before a word starts nothing.
    expect(words("\ufeffPython \u200bSQL").map((word) => word.norm)).toEqual(["python", "sql"]);
    expect(normalizeLabel("\u200bpublic relations consultant")).toBe("public relations consultant");
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

  it("do not take a capital for evidence unless a label a source wrote is written that way", async () => {
    const t = withLabels(
      // Two O*NET software examples, each also under the name the builder makes by dropping "software".
      { conceptId: "onet:tool:testing-software", kind: "tool", type: "preferred", text: "Testing software" },
      { conceptId: "onet:tool:testing-software", kind: "tool", type: "derived", text: "Testing" },
      { conceptId: "onet:tool:sales-software", kind: "tool", type: "preferred", text: "Sales software" },
      { conceptId: "onet:tool:sales-software", kind: "tool", type: "derived", text: "Sales" },
      { conceptId: S(60), kind: "knowledge", type: "alternative", text: "DID" },
      { conceptId: "onet:tool:act", kind: "tool", type: "preferred", text: "Act!" },
      { conceptId: "onet:tool:ansible-software", kind: "tool", type: "derived", text: "Ansible" },
      { conceptId: S(61), kind: "knowledge", type: "preferred", text: "Ansible" },
      { conceptId: S(62), kind: "knowledge", type: "preferred", text: "Proven\u00e7al" },
      { conceptId: S(63), kind: "skill", type: "preferred", text: "communication" },
    );
    // Every line starts with a capital. A first word that only a label the builder made carries is thin.
    expect(brief(await t.mentions("Testing and debugging of embedded firmware"))).toEqual([["Testing", ["onet:tool:testing-software"], true]]);
    expect(brief(await t.mentions("Sales grew 40% year over year"))).toEqual([["Sales", ["onet:tool:sales-software"], true]]);
    // So is one that no label is written like: "Did" is not DID, and "Act" is not Act!.
    expect(brief(await t.mentions("Did not use SAP"))).toEqual([["Did", [S(60)], true]]);
    expect(brief(await t.mentions("Act as the primary contact for vendors"))).toEqual([["Act", ["onet:tool:act"], true]]);
    expect(brief(await t.mentions("PYTHON, SQL"))).toEqual([
      ["PYTHON", ["onet:tool:python", S(3)], true],
      ["SQL", [S(8)], false],
    ]);
    // Written as a label a source wrote, a word is firm wherever it stands. A skills-list item is the whole text.
    expect(brief(await t.mentions("Routed calls over DID trunks"))).toEqual([["DID", [S(60)], false]]);
    expect(brief(await t.mentions("Python"))).toEqual([["Python", ["onet:tool:python", S(3)], false]]);
    // A label the builder made beside one a source wrote: the source's label decides.
    expect(brief(await t.mentions("Ansible"))).toEqual([["Ansible", [S(61), "onet:tool:ansible-software"], false]]);
    expect(brief(await t.mentions("wrote ansible playbooks"))).toEqual([["ansible", [S(61), "onet:tool:ansible-software"], true]]);
    // A label that is itself an everyday word is that word, capital or not.
    expect(brief(await t.mentions("Communication with clients"))).toEqual([["Communication", [S(63)], false]]);
    // How an accent is encoded is not a different spelling.
    for (const line of ["Proven\u00e7al", decomposed("Proven\u00e7al")]) expect(brief(await t.mentions(line)), line).toEqual([[line, [S(62)], false]]);
  });

  it("do not take a character nobody sees for a different spelling", async () => {
    const t = withLabels(
      { conceptId: S(60), kind: "knowledge", type: "alternative", text: "DID" },
      { conceptId: S(62), kind: "knowledge", type: "preferred", text: "Proven\u00e7al" },
      // A source's own label can carry such a character: two of ESCO's start with a zero-width space.
      { conceptId: S(64), kind: "knowledge", type: "preferred", text: "\u200bKanban" },
    );
    const python = ["onet:tool:python", S(3)];
    // A zero-width space, a soft hyphen or a direction mark, after the word or inside it. The word
    // found has the character in it, and is still the word its label writes.
    for (const line of ["Python\u200b", "Python\u00ad", "Python\u200e", "Py\u200bthon", "Py\u00adthon", "Python\u200b\u200b\u200b"])
      expect(brief(await t.mentions(line)), coded(line)).toEqual([[line, python, false]]);
    expect(brief(await t.mentions("Python\u200b, SQL\u00ad"))).toEqual([
      ["Python\u200b", python, false],
      ["SQL\u00ad", [S(8)], false],
    ]);
    // With the encoding of an accent as well, and in a label as much as in the text.
    for (const line of ["Proven\u00e7al\u200b", decomposed("Proven\u00e7\u200bal")]) expect(brief(await t.mentions(line)), coded(line)).toEqual([[line, [S(62)], false]]);
    expect(brief(await t.mentions("Kanban"))).toEqual([["Kanban", [S(64)], false]]);
    // It makes no word firm that is not written as its label is.
    for (const line of ["python\u200b", "PYTHON\u200b", "Pyth\u00adON"]) expect(brief(await t.mentions(line)), coded(line)).toEqual([[line, python, true]]);
    expect(brief(await t.mentions("Did\u200b not use SAP"))).toEqual([["Did\u200b", [S(60)], true]]);
    expect(brief(await t.mentions("kanban\u200b boards"))).toEqual([["kanban\u200b", [S(64)], true]]);
  });

  it("read a word with any number of marks piled on it without putting the pile in order", async () => {
    const t = withLabels({ conceptId: S(62), kind: "knowledge", type: "preferred", text: "Proven\u00e7al" });
    const python = ["onet:tool:python", S(3)];
    // One word nearly as long as a text may be: six letters, and marks on the last of them.
    const word = `Python${pile(MAX_MENTION_TEXT_CHARS - 15)}`;
    expect(`${word}, SQL`).toHaveLength(MAX_MENTION_TEXT_CHARS - 4);
    // It is read as the word it is, and none of its marks is ever normalised: not to compare it
    // with labels, not to look it up, and not to see whether it is written as its label is.
    expect(await marksNormalised(() => words(word))).toEqual([[{ start: 0, end: word.length, norm: "python" }], 0]);
    expect(await marksNormalised(() => normalizeLabel(`budget${pile(5000)} manage${pile(5000)}ment`))).toEqual(["budget management", 0]);
    const [found, inMentions] = await marksNormalised(() => t.mentions(`${word}, SQL`));
    expect(brief(found)).toEqual([
      [word, python, true],
      ["SQL", [S(8)], false],
    ]);
    expect(inMentions).toBe(0);
    const [carried, inLookup] = await marksNormalised(() => t.lookup(word));
    expect(carried.map((concept) => concept.id)).toEqual(python);
    expect(inLookup).toBe(0);
    // Dropping the marks first changes no form: a letter that comes with its accent is still parted from it.
    expect(words(`\u00e9${pile(40)}cole fran\u00e7aise, \u1ea4n`).map((word) => word.norm)).toEqual(["ecole", "francaise", "an"]);
    // A word that could be its label is compared with it, marks and all. With more on it than any
    // way of writing the label has, it is not the label, and is not put in order to find that out.
    const accented = decomposed("Proven\u00e7al");
    expect(await marksNormalised(async () => brief(await t.mentions(accented)))).toEqual([[[accented, [S(62)], false]], 1]);
    const twice = accented.replace("\u0327", "\u0327\u0301");
    expect(await marksNormalised(async () => brief(await t.mentions(twice)))).toEqual([[[twice, [S(62)], true]], 2]);
    const piled = accented.replace("\u0327", `\u0327${pile(20)}`);
    expect(await marksNormalised(async () => brief(await t.mentions(piled)))).toEqual([[[piled, [S(62)], true]], 0]);
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

  it("reads every occupation the crosswalk relates it to, however many there are", async () => {
    // Ten more ESCO occupations matched to one O*NET occupation just as its own counterpart is, each
    // with a skill no other names. Matches of one type come in ID order, which says nothing of them.
    const more = Array.from({ length: 10 }, (_, n) => ({ occupation: O(100 + n), skill: S(100 + n) }));
    const store = new MemoryStore({
      ...TAXONOMY_FIXTURE,
      concepts: [
        ...TAXONOMY_FIXTURE.concepts,
        ...more.flatMap(({ occupation, skill }, n): Concept[] => [
          { id: occupation, kind: "occupation", scheme: "esco", code: null, label: `budget specialist ${n}`, description: null, meta: {} },
          { id: skill, kind: "skill", scheme: "esco", code: null, label: `budget skill ${n}`, description: null, meta: {} },
        ]),
      ],
      edges: [
        ...TAXONOMY_FIXTURE.edges,
        ...more.flatMap(({ occupation, skill }): Edge[] => [
          { src: BA, rel: "matches", dst: occupation, meta: { type: "broad" } },
          { src: occupation, rel: "essential", dst: skill, meta: null },
        ]),
      ],
    });
    const reads: string[] = [];
    const counted: TaxonomyStore = {
      info: () => store.info(),
      concepts: (ids) => store.concepts(ids),
      labels: (norms, kinds) => store.labels(norms, kinds),
      from: (src, rels) => (reads.push("from"), store.from(src, rels)),
      fromAny: (srcs, rels) => (reads.push("fromAny"), store.fromAny(srcs, rels)),
      to: (dst, rels) => (reads.push("to"), store.to(dst, rels)),
      conceptPage: (after, kinds, limit) => store.conceptPage(after, kinds, limit),
      conceptCount: (kinds, upTo) => store.conceptCount(kinds, upTo),
    };
    const profile = (await new Taxonomy(counted).profile(BA))!;
    expect(profile.counterparts.map((counterpart) => [counterpart.concept.id, counterpart.match])).toEqual([
      [O(3), "broad"],
      ...more.map(({ occupation }) => [occupation, "broad"]),
    ]);
    // Each one's skill is in the profile, and says whose record it is from.
    expect(profile.skills.map((item) => [item.concept.id, item.need, item.via])).toEqual([
      ...more.map(({ occupation, skill }) => [skill, "essential", { occupation, match: "broad" }]),
      [S(1), "essential", { occupation: O(3), match: "broad" }],
      [S(7), "optional", { occupation: O(3), match: "broad" }],
    ]);
    // The crosswalk is read once and then each source's relations together: three reads of
    // relations, not one for every occupation.
    expect(reads).toEqual(["from", "fromAny", "fromAny"]);
    reads.length = 0;
    expect((await new Taxonomy(counted).profile(O(2)))!.counterparts).toHaveLength(1);
    expect(reads).toEqual(["to", "fromAny", "fromAny"]);
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
