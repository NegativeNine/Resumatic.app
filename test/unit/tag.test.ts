import { describe, expect, it, vi } from "vitest";
import { CLEF_MODEL, decisionJudge } from "../../src/ai/decision-judge";
import type { Models } from "../../src/ai/models";
import type { JudgeItem } from "../../src/ai/prompts";
import type { ModelObservers } from "../../src/ai/usage";
import { verifyExtraction } from "../../src/pipeline/extract/verify";
import {
  FACT_TAG_KINDS,
  MAX_FACT_CANDIDATES,
  MAX_ROLE_CANDIDATES,
  MAX_TAGS_PER_SAVE,
  MAX_TAG_FACTS,
  MAX_TAG_PROFILES,
  MAX_TAG_QUESTIONS,
  MAX_TAG_ROLES,
  MAX_TAG_WORDS,
  TAG_JUDGE_METHOD,
  TAG_RULE_METHOD,
  emptyTagReport,
  sameLetters,
  skillAsWritten,
  skillRule,
  tagQuestion,
  tagStamp,
  tagUpload,
  type HeldTag,
  type ProposedTag,
  type TagMade,
  type TagMethod,
  type TagReads,
  type TagSubjects,
} from "../../src/pipeline/tag";
import { AppError } from "../../src/shared/errors";
import { stampProblem, tagProblem } from "../../src/shared/record";
import { MemoryStore, Taxonomy, normalizeLabel, type Concept, type Label } from "../../src/taxonomy";
import { precision, runTagging } from "../evals/tagging";
import { TAG_LINES } from "../fixtures/tag-lines";
import { TAXONOMY_FIXTURE } from "../support/taxonomy-fixture";

// Tagging facts and job roles, over the made-up taxonomy and stand-in models. Nothing here calls a
// model or stores anything: `keep` is the test's own, and says what it was handed.

const S = (n: number) => `esco:skill:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const O = (n: number) => `esco:occupation:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DEV = "onet:occ:99-1001.00";
const PM = "onet:occ:99-1002.00";
const KUBERNETES = "onet:tool:kubernetes";

const MADE: TagMade = { model: "test/judge", taxonomyVersion: TAXONOMY_FIXTURE.info.version };

/** The made-up taxonomy, with more concepts and labels where a test needs them. Labels are stored as the builder would store them. */
const fixture = (extra: { concepts?: Concept[]; labels?: Omit<Label, "norm">[] } = {}) =>
  new Taxonomy(
    new MemoryStore({
      ...TAXONOMY_FIXTURE,
      concepts: [...TAXONOMY_FIXTURE.concepts, ...(extra.concepts ?? [])],
      labels: [...TAXONOMY_FIXTURE.labels, ...(extra.labels ?? []).map((label) => ({ ...label, norm: normalizeLabel(label.text) }))],
    }),
  );

/** A taxonomy that says which reads were made of it, in order, and can fail one kind of read. */
function reading(options: { failing?: keyof TagReads; taxonomy?: Taxonomy; events?: string[] } = {}) {
  const taxonomy = options.taxonomy ?? fixture();
  const reads: [name: keyof TagReads, of: unknown, options?: unknown][] = [];
  const read = <K extends keyof TagReads>(name: K) =>
    (async (...args: unknown[]) => {
      reads.push(args.length > 1 ? [name, args[0], args[1]] : [name, args[0]]);
      options.events?.push("read");
      if (name === options.failing) throw new Error("D1_ERROR: no such table: concepts: SQLITE_ERROR");
      return (taxonomy[name] as (...given: unknown[]) => unknown).apply(taxonomy, args);
    }) as TagReads[K];
  const reader: TagReads = { mentions: read("mentions"), lookup: read("lookup"), get: read("get"), profile: read("profile") };
  return { taxonomy: reader, reads };
}

type Verdict = "supported" | "unsupported" | "overstated" | "missing" | "twice";
type Answer = { id: string; verdict: "supported" | "unsupported" | "overstated"; reason: string };

interface Script {
  /** The judge's answer to one question. It says yes to every question this leaves alone. */
  verdict?: (item: JudgeItem) => Verdict;
  /** Answer through the typed-decision judge, as staging does. */
  typed?: boolean;
  /** Rewrites a whole reply. `call` counts the judge's calls from 0. */
  reply?: (answers: Answer[], call: number) => unknown;
}

/** A stand-in judge. `asked` is what each call was asked, as the judge itself was given it. */
function judge(script: Script = {}) {
  const asked: JudgeItem[][] = [];
  const prompts: string[] = [];
  const answer = (items: JudgeItem[]) => {
    asked.push(items);
    const answers = items.flatMap((item): Answer[] => {
      const verdict = script.verdict?.(item) ?? "supported";
      if (verdict === "missing") return [];
      const one = { id: item.alias, verdict: verdict === "twice" ? ("supported" as const) : verdict, reason: "" };
      return verdict === "twice" ? [one, one] : [one];
    });
    return script.reply ? script.reply(answers, asked.length - 1) : { verdicts: answers };
  };
  const models: Models = {
    async complete(route, messages, schema) {
      if (route !== "judge") throw new Error(`unexpected route ${route}`);
      prompts.push(JSON.stringify(messages));
      // The chat judge is sent JSON. What it is asked is read back from that, so these tests see
      // what a model would see and nothing the pipeline kept to itself.
      const { lines } = JSON.parse(messages.at(-1)!.content) as { lines: { id: string; text: string; facts: JudgeItem["facts"] }[] };
      return schema.parse(answer(lines.map((line) => ({ alias: line.id, text: line.text, facts: line.facts }))));
    },
    embed: async () => [],
    rerank: async () => [],
    toMarkdown: async () => "",
    ...(script.typed ? { judge: async (items: JudgeItem[]) => answer(items) as { verdicts: Answer[] } } : {}),
  };
  return { models, asked, prompts };
}

const says = (verdict: Verdict, ...containing: string[]) => (item: JudgeItem): Verdict => (containing.length === 0 || containing.some((part) => item.text.includes(part)) ? verdict : "supported");

const role = (id: string, title: string, held: HeldTag[] = []): TagSubjects["roles"][number] => ({ id, title, held });
const fact = (id: string, text: string, more: Partial<TagSubjects["facts"][number]> = {}): TagSubjects["facts"][number] => ({ id, roleId: null, kind: "accomplishment", text, asWritten: false, held: [], ...more });
/** A skill as the vault gives it: as written only when its text is one item of the line it was read from. */
const skill = (id: string, text: string, quote: string = text, more: Partial<TagSubjects["facts"][number]> = {}) => fact(id, text, { kind: "skill", asWritten: skillAsWritten(quote, text), ...more });
const upload = (roles: TagSubjects["roles"], facts: TagSubjects["facts"], total?: TagSubjects["total"]): TagSubjects => ({ roles, facts, total: total ?? { roles: roles.length, facts: facts.length } });
const holding = (conceptId: string, own: boolean, method: TagMethod = TAG_JUDGE_METHOD, more: Partial<HeldTag> = {}): HeldTag => ({
  conceptId,
  method,
  model: method === TAG_RULE_METHOD ? null : MADE.model,
  taxonomyVersion: MADE.taxonomyVersion,
  own,
  ...more,
});

/** The vault's answer to which facts are marked sensitive now: none, unless a test says otherwise. */
const NONE_MARKED = async (): Promise<string[]> => [];

async function run(subjects: TagSubjects, script: Script = {}, taxonomy: TagReads = fixture(), models?: Models, marked: (factIds: string[]) => Promise<string[]> = NONE_MARKED) {
  const stand = judge(script);
  const kept: ProposedTag[][] = [];
  const report = await tagUpload(
    models ?? stand.models,
    taxonomy,
    subjects,
    MADE,
    async (tags) => {
      kept.push(tags);
      return { stored: tags.length, refused: 0 };
    },
    marked,
  );
  return { report, asked: stand.asked, prompts: stand.prompts, kept, tags: kept.flat() };
}

const lines = (asked: JudgeItem[][]) => asked.map((call) => call.map((item) => item.text));
const brief = (tags: ProposedTag[]) => tags.map((tag) => [tag.subject.id, tag.conceptId, tag.method]);

// ---------------------------------------------------------------- candidates

describe("a job's candidates", () => {
  it("are the occupations whose labels stand in its title, each asked about by its own label", async () => {
    const { asked, tags, report } = await run(upload([role("job", "Senior Software Engineer")], []));
    expect(asked).toEqual([
      [
        { alias: "T1", text: "Worked in the occupation: software developer (also called software engineer)", facts: [{ text: "Job title: Senior Software Engineer", quote: null }] },
        { alias: "T2", text: "Worked in the occupation: Example Software Developers (also called Software Engineer)", facts: [{ text: "Job title: Senior Software Engineer", quote: null }] },
      ],
    ]);
    // ID, kind and label are the taxonomy's own record of the concept.
    expect(tags).toEqual([
      { subject: { kind: "role", id: "job" }, words: "Senior Software Engineer", conceptId: O(1), conceptKind: "occupation", label: "software developer", method: TAG_JUDGE_METHOD },
      { subject: { kind: "role", id: "job" }, words: "Senior Software Engineer", conceptId: DEV, conceptKind: "occupation", label: "Example Software Developers", method: TAG_JUDGE_METHOD },
    ]);
    expect(report).toEqual({ ...emptyTagReport(), roles: 1, candidates: 2, asked: 2, yes: 2, stored: 2 });
  });

  it("are never a tool, a skill or a group of occupations that the title happens to name", async () => {
    // Software, a skill's other name, and an ISCO group: each is a label, and none is an occupation.
    const titles = ["Kubernetes Platform Lead", "Head of Budget Management", "Software Developers"];
    const { asked, tags, report } = await run(upload(titles.map((title, index) => role(`job-${index}`, title)), []));
    expect(asked).toEqual([]);
    expect(tags).toEqual([]);
    expect(report).toEqual({ ...emptyTagReport(), roles: 3 });
  });

  it("come strongest first, and a title keeps four", async () => {
    // Five occupations are named: one by its preferred label, four by other labels.
    const title = "Software Engineer / Programmer / IT Project Manager / Budget Analyst / Tech PM";
    const { asked, tags, report } = await run(upload([role("job", title)], []));
    expect(lines(asked)).toEqual([
      [
        // The preferred label first, though it comes fourth in the title.
        "Worked in the occupation: budget analyst",
        // Then other labels where they stand, and by ID where two stand in one place. The
        // occupation named twice is asked about once, from the label that comes first.
        "Worked in the occupation: software developer (also called software engineer)",
        "Worked in the occupation: Example Software Developers (also called Software Engineer)",
        "Worked in the occupation: ICT project manager (also called IT project manager)",
      ],
    ]);
    expect(tags.map((tag) => tag.conceptId)).toEqual([O(3), O(1), DEV, O(2)]);
    expect(tags.map((tag) => tag.conceptId)).not.toContain(PM);
    expect(report.candidates).toBe(MAX_ROLE_CANDIDATES);
    expect(report.left).toEqual({ ...emptyTagReport().left, per_role: 1 });
  });
});

describe("a fact's candidates", () => {
  it("are labels found word for word, of the kinds that can tag a fact, one for each concept", async () => {
    const { asked, tags, report } = await run(
      upload(
        [],
        [
          // An occupation named in a line is usually someone else's.
          fact("boss", "Reported to the IT project manager"),
          // The skill said in other words: "manage budgets" is the label, and it is not here.
          fact("budgets", "Managed budgets for three departments"),
          // A group of occupations.
          fact("hired", "Hired software developers for the platform team"),
          // One concept by two of its labels, and one of those labels is another concept's too.
          fact("ran", "Ran Kubernetes (K8s) clusters"),
        ],
      ),
    );
    expect(asked).toEqual([
      [
        { alias: "T1", text: "Used the software: Kubernetes", facts: [{ text: "Ran Kubernetes (K8s) clusters", quote: null }] },
        { alias: "T2", text: "Knows: container orchestration (also called Kubernetes)", facts: [{ text: "Ran Kubernetes (K8s) clusters", quote: null }] },
      ],
    ]);
    expect(tags).toEqual([
      { subject: { kind: "fact", id: "ran" }, words: "Ran Kubernetes (K8s) clusters", conceptId: KUBERNETES, conceptKind: "tool", label: "Kubernetes", method: TAG_JUDGE_METHOD },
      { subject: { kind: "fact", id: "ran" }, words: "Ran Kubernetes (K8s) clusters", conceptId: S(4), conceptKind: "knowledge", label: "container orchestration", method: TAG_JUDGE_METHOD },
    ]);
    expect(report).toEqual({ ...emptyTagReport(), facts: 4, candidates: 2, asked: 2, yes: 2, stored: 2 });
  });

  it("are asked of the taxonomy by the kinds each row can be tagged with", async () => {
    const { taxonomy, reads } = reading();
    await run(upload([role("job", "Programmer")], [fact("line", "Ran Kubernetes clusters"), skill("listed", "SQL")]), {}, taxonomy);
    expect(reads).toEqual([
      // A title is read for occupations only, and a fact for everything but occupations and tasks.
      ["mentions", "Programmer", { kinds: ["occupation"] }],
      ["mentions", "Ran Kubernetes clusters", { kinds: ["skill", "knowledge", "skill-group", "activity", "tool", "tool-category"] }],
      ["mentions", "SQL", { kinds: ["skill", "knowledge", "skill-group", "activity", "tool", "tool-category"] }],
      // The rule's last condition looks its text up among every kind there is.
      ["lookup", "SQL"],
      ["get", [O(1), KUBERNETES, S(4), S(8)]],
      ["profile", O(1)],
    ]);
  });

  it("are only concepts the taxonomy has a record of, of a kind its record says can tag the row", async () => {
    // A taxonomy that is not whole: a label whose concept has no record, a label filed as
    // software for a concept that is an occupation, and one filed as an occupation for software.
    const broken = fixture({
      concepts: [
        { id: O(98), kind: "occupation", scheme: "esco", code: null, label: "widget maker", description: null, meta: {} },
        { id: "onet:tool:gadgetry", kind: "tool", scheme: "onet", code: null, label: "Gadgetry", description: null, meta: {} },
      ],
      labels: [
        { conceptId: "onet:tool:ghostware", kind: "tool", type: "preferred", text: "Ghostware" },
        { conceptId: O(98), kind: "tool", type: "preferred", text: "Widgetry" },
        { conceptId: "onet:tool:gadgetry", kind: "occupation", type: "preferred", text: "Gadgetry" },
      ],
    });
    const { asked, tags, report } = await run(upload([role("job", "Gadgetry")], [fact("line", "Used Ghostware, Widgetry and Kubernetes daily"), skill("listed", "Ghostware")]), {}, broken);
    // Only the concept that is whole is asked about. The skill is one firm label of the source's
    // own, and still no tag: there is no record to take a kind and a label from.
    expect(lines(asked)).toEqual([["Used the software: Kubernetes", "Knows: container orchestration (also called Kubernetes)"]]);
    expect(tags.map((tag) => tag.conceptId)).toEqual([KUBERNETES, S(4)]);
    expect(report).toEqual({ ...emptyTagReport(), roles: 1, facts: 2, candidates: 2, asked: 2, yes: 2, stored: 2 });
  });

  it("come firm before weak, whatever the order of the line", async () => {
    const { asked } = await run(upload([], [fact("built", "Built a Go service on Kubernetes")]));
    expect(lines(asked)).toEqual([
      ["Used the software: Kubernetes", "Knows: container orchestration (also called Kubernetes)", "Used the software: Go", "Knows: Go (computer programming) (also called Go)"],
    ]);
  });

  it("are six at most for one fact", async () => {
    // Nine concepts: five by their preferred labels and four by other labels.
    const line = "Python, Kubernetes, SQL, C++, Microsoft Excel, Golang, data migration";
    const { asked, tags, report } = await run(upload([], [fact("many", line)]));
    expect(lines(asked)).toEqual([
      ["Used the software: Python", "Used the software: Kubernetes", "Knows: SQL", "Used the software: C++", "Used the software: Microsoft Excel", "Knows: Python (computer programming) (also called Python)"],
    ]);
    expect(tags).toHaveLength(MAX_FACT_CANDIDATES);
    expect(report.candidates).toBe(MAX_FACT_CANDIDATES);
    expect(report.left).toEqual({ ...emptyTagReport().left, per_fact: 3 });
  });

  describe("in a job whose occupation was decided", () => {
    const LINE = "Used Microsoft Excel, SQL and Kubernetes daily";
    const inJob = () => upload([role("job", "Software Engineer")], [fact("used", LINE, { roleId: "job" })]);
    const aboutFacts = (asked: JudgeItem[][]) => lines(asked).flat().filter((text) => !text.startsWith("Worked in the occupation"));
    const AS_READ = ["Used the software: Microsoft Excel", "Knows: SQL", "Used the software: Kubernetes", "Knows: container orchestration (also called Kubernetes)"];
    const USUAL_FIRST = ["Used the software: Kubernetes", "Knows: container orchestration (also called Kubernetes)", "Used the software: Microsoft Excel", "Knows: SQL"];

    it("put first what that occupation usually involves, and gain nothing from it", async () => {
      // A software developer's record names Kubernetes, and container orchestration as knowledge.
      // It also names Python, Go, C++ and two work activities, and none of those is asked about:
      // the line does not say them.
      const decided = await run(inJob());
      expect(aboutFacts(decided.asked)).toEqual(USUAL_FIRST);
      expect(decided.tags.filter((tag) => tag.subject.kind === "fact").map((tag) => tag.conceptId)).toEqual([KUBERNETES, S(4), "onet:tool:microsoft-excel", S(8)]);
    });

    it("stay as the line has them when the judge declines the occupation, or the fact is in no job", async () => {
      const declined = await run(inJob(), { verdict: says("unsupported", "Worked in the occupation") });
      expect(aboutFacts(declined.asked)).toEqual(AS_READ);
      const loose = await run(upload([role("job", "Software Engineer")], [fact("used", LINE)]));
      expect(aboutFacts(loose.asked)).toEqual(AS_READ);
    });

    it("are ordered by an occupation stored for the job before, with no question about the job", async () => {
      for (const own of [true, false]) {
        const before = await run(upload([role("job", "Software Engineer", [holding(O(1), own), holding(DEV, own)])], [fact("used", LINE, { roleId: "job" })]));
        expect(lines(before.asked), String(own)).toEqual([USUAL_FIRST]);
      }
    });

    it("are cut to six after they are ordered, so the usual ones are the ones kept", async () => {
      const line = "Python, Kubernetes, SQL, C++, Microsoft Excel, Golang, data migration";
      const { asked, report } = await run(upload([role("job", "Software Engineer")], [fact("many", line, { roleId: "job" })]));
      expect(aboutFacts(asked)).toEqual([
        "Used the software: Python",
        "Used the software: Kubernetes",
        "Used the software: C++",
        "Knows: Python (computer programming) (also called Python)",
        "Knows: container orchestration (also called Kubernetes)",
        "Did or can do: migrate existing data (also called data migration)",
      ]);
      // SQL, Excel and Golang are what the cap left: a software developer's record names none of them.
      expect(report.left.per_fact).toBe(3);
    });
  });
});

describe("what is over a cap", () => {
  it("is left and counted: jobs and facts beyond the first", async () => {
    const jobs = Array.from({ length: MAX_TAG_ROLES + 2 }, (_, index) => role(`job-${index}`, "Budget Analyst"));
    const facts = Array.from({ length: MAX_TAG_FACTS + 5 }, (_, index) => fact(`fact-${index}`, "Mentored junior engineers"));
    // The vault gives the first rows and says how many there are in all.
    const { report, tags, asked } = await run(upload(jobs, facts, { roles: 30, facts: 130 }));
    expect(report.roles).toBe(MAX_TAG_ROLES);
    expect(report.facts).toBe(MAX_TAG_FACTS);
    expect(report.left).toEqual({ ...emptyTagReport().left, subjects: 30 - MAX_TAG_ROLES + (130 - MAX_TAG_FACTS) });
    // One wording, asked once, and only the first twenty jobs take the answer.
    expect(asked.flat()).toHaveLength(1);
    expect(tags.map((tag) => tag.subject.id)).toEqual(jobs.slice(0, MAX_TAG_ROLES).map((job) => job.id));
  });

  it("is left and counted: the row that would take the words past the cap, and every row after it", async () => {
    const long = (first: string, count: number) => [first, ...Array.from({ length: count - 1 }, () => "word")].join(" ");
    const { reads, taxonomy } = reading();
    const { report, tags } = await run(
      upload(
        [role("job", "Programmer")],
        [
          fact("first", long("word", 1000)),
          fact("second", long("word", 1000)),
          // With the title's one word, one word short of the cap.
          fact("third", long("Kubernetes", MAX_TAG_WORDS - 2002)),
          // Two words, where there is room for one. The rule would tag it without asking anyone.
          skill("fourth", "Microsoft Excel"),
          // One word, which there is still room for. A row after a row that was left is left too:
          // which rows are read does not depend on how short a later one happens to be.
          skill("fifth", "SQL"),
          skill("sixth", "C++"),
        ],
      ),
      {},
      taxonomy,
    );
    expect(report.roles).toBe(1);
    expect(report.facts).toBe(3);
    expect(report.left).toEqual({ ...emptyTagReport().left, words: 3 });
    expect(reads.filter(([name]) => name === "mentions")).toHaveLength(4);
    expect(reads.filter(([name]) => name === "lookup")).toEqual([]);
    expect(brief(tags)).toEqual([
      ["job", O(1), TAG_JUDGE_METHOD],
      ["third", KUBERNETES, TAG_JUDGE_METHOD],
      ["third", S(4), TAG_JUDGE_METHOD],
    ]);
  });

  it("is left and counted: the questions one upload may ask, roles first", async () => {
    // One question about the job, then two about each of sixty-one lines.
    const facts = Array.from({ length: 61 }, (_, index) => fact(`fact-${index}`, `Ran Kubernetes cluster ${index + 1}`));
    const { report, asked, tags } = await run(upload([role("job", "Programmer")], facts));
    // Roles and facts are asked apart, twenty questions to a call: seven calls at the very most.
    expect(asked.map((call) => call.length)).toEqual([1, 20, 20, 20, 20, 20, 19]);
    expect(asked.flat().map((item) => item.alias)).toEqual(Array.from({ length: MAX_TAG_QUESTIONS }, (_, index) => `T${index + 1}`));
    expect(report.asked).toBe(MAX_TAG_QUESTIONS);
    expect(report.candidates).toBe(1 + 122);
    expect(report.left).toEqual({ ...emptyTagReport().left, per_upload: 3 });
    expect(tags).toHaveLength(MAX_TAG_QUESTIONS);
    // What was left has no tag, which means unknown: the last line's software and knowledge, and the knowledge of the line before.
    expect(tags.filter((tag) => tag.subject.id === "fact-60")).toEqual([]);
    expect(tags.filter((tag) => tag.subject.id === "fact-59").map((tag) => tag.conceptId)).toEqual([KUBERNETES]);
  });

  it("is not read: an occupation's record, beyond the first eight a title put forward", async () => {
    const makers = Array.from({ length: 10 }, (_, index) => ({ id: O(100 + index), label: `widget maker ${index + 1}` }));
    const taxonomy = fixture({
      concepts: makers.map(({ id, label }): Concept => ({ id, kind: "occupation", scheme: "esco", code: null, label, description: null, meta: {} })),
      labels: makers.map(({ id, label }) => ({ conceptId: id, kind: "occupation" as const, type: "preferred" as const, text: label })),
    });
    const { reads, taxonomy: counted } = reading({ taxonomy });
    const { report } = await run(upload(makers.map((_, index) => role(`job-${index}`, `Widget Maker ${index + 1}`)), []), {}, counted);
    expect(report.candidates).toBe(10);
    expect(reads.filter(([name]) => name === "profile").map(([, id]) => id)).toEqual(makers.slice(0, MAX_TAG_PROFILES).map(({ id }) => id));
  });

  it("is sized so that one call to keep never holds more than the vault takes", () => {
    expect(MAX_TAGS_PER_SAVE).toBe(MAX_TAG_ROLES * MAX_ROLE_CANDIDATES + MAX_TAG_FACTS * MAX_FACT_CANDIDATES);
    expect(MAX_TAGS_PER_SAVE).toBe(800);
    expect(MAX_TAG_ROLES * MAX_ROLE_CANDIDATES).toBeLessThanOrEqual(MAX_TAG_QUESTIONS);
  });
});

// ---------------------------------------------------------------- the rule

describe("the rule that needs no model", () => {
  /** A judge that must never be reached. */
  const unreachable: Models = {
    complete: () => Promise.reject(new Error("a model was asked")),
    judge: () => Promise.reject(new Error("a model was asked")),
    embed: async () => [],
    rerank: async () => [],
    toMarkdown: async () => "",
  };
  const ITEMS = ["SQL", "C++", "Microsoft Excel", "Golang", "Python (computer programming)", "Container Orchestration"];

  it("tags a listed skill that is one label and nothing else, without a model call", async () => {
    const list = ITEMS.join(", ");
    const { report, kept } = await run(upload([], ITEMS.map((item, index) => skill(`skill-${index}`, item, list))), {}, fixture(), unreachable);
    expect(report).toEqual({ ...emptyTagReport(), facts: 6, candidates: 6, byRule: 6, stored: 6 });
    expect(kept).toHaveLength(1);
    expect(kept[0]!.map((tag) => [tag.words, tag.conceptId, tag.conceptKind, tag.label, tag.method])).toEqual([
      ["SQL", S(8), "knowledge", "SQL", TAG_RULE_METHOD],
      ["C++", "onet:tool:c++", "tool", "C++", TAG_RULE_METHOD],
      ["Microsoft Excel", "onet:tool:microsoft-excel", "tool", "Microsoft Excel", TAG_RULE_METHOD],
      // Another name the source lists for the concept.
      ["Golang", S(6), "knowledge", "Go (computer programming)", TAG_RULE_METHOD],
      // The exact preferred label, though the label found in it stops before the bracket.
      ["Python (computer programming)", S(3), "knowledge", "Python (computer programming)", TAG_RULE_METHOD],
      // Letter case is the one thing set aside.
      ["Container Orchestration", S(4), "knowledge", "container orchestration", TAG_RULE_METHOD],
    ]);
  });

  /** An occupation that carries the name "SQL" too: nothing a fact is tagged with, and a second meaning all the same. */
  const sharedWithAnOccupation = () =>
    fixture({
      concepts: [{ id: O(99), kind: "occupation", scheme: "esco", code: null, label: "SQL developer", description: null, meta: {} }],
      labels: [{ conceptId: O(99), kind: "occupation", type: "alternative", text: "SQL" }],
    });
  const written = (text: string, more: Partial<TagSubjects["facts"][number]> = {}) => fact("skill", text, { kind: "skill", asWritten: true, ...more });
  const declined: [why: string, row: TagSubjects["facts"][number], questions: string[], taxonomy?: () => Taxonomy][] = [
    ["other words beside the label", written("Python (advanced)"), ["Used the software: Python", "Knows: Python (computer programming) (also called Python)"]],
    ["two labels", written("SQL, C++"), ["Knows: SQL", "Used the software: C++"]],
    ["a label two concepts share", written("Kubernetes"), ["Used the software: Kubernetes", "Knows: container orchestration (also called Kubernetes)"]],
    ["a label an occupation shares", written("SQL"), ["Knows: SQL"], sharedWithAnOccupation],
    ["a weak word: two letters", written("Go"), ["Used the software: Go", "Knows: Go (computer programming) (also called Go)"]],
    ["a weak word: written as none of its labels is", written("sql"), ["Knows: SQL"]],
    ["a weak word: all capitals", written("PYTHON"), ["Used the software: Python", "Knows: Python (computer programming) (also called Python)"]],
    ["a label the builder made", written("Amazon Web Services AWS"), ["Used the software: Amazon Web Services AWS software (also called Amazon Web Services AWS)"]],
    ["a hidden term", written("python3"), ["Knows: Python (computer programming) (also called python3)"]],
    ["a credential", written("SQL", { kind: "credential" }), ["Knows: SQL"]],
    ["an item the reading model re-cased", skill("skill", "SQL", "Skills: sql, Go"), ["Knows: SQL"]],
    ["a mark beside the label: a cross", written("SQL ✗"), ["Knows: SQL"]],
    ["a mark beside the label: a question mark", written("SQL?"), ["Knows: SQL"]],
    ["a mark beside the label: struck through", written("~~SQL~~"), ["Knows: SQL"]],
    ["a mark between the label's words: a cross", written("Microsoft ✗ Excel"), ["Used the software: Microsoft Excel"]],
    ["a mark between the label's words: a hyphen", written("Microsoft-Excel"), ["Used the software: Microsoft Excel"]],
  ];

  it.each(declined)("declines %s, and the judge is asked", async (_why, row, questions, taxonomy = fixture) => {
    const agreed = await run(upload([], [row]), {}, taxonomy());
    expect(lines(agreed.asked)).toEqual([questions]);
    expect(agreed.report.byRule).toBe(0);
    expect(agreed.tags.map((tag) => tag.method)).toEqual(questions.map(() => TAG_JUDGE_METHOD));
    // So nothing but the judge's yes makes the tag.
    const refused = await run(upload([], [row]), { verdict: says("unsupported") }, taxonomy());
    expect(refused.tags).toEqual([]);
    expect(refused.report.asked).toBe(questions.length);
  });

  it("is the same on its own: one firm label of one concept, the source's own, and the same letters", async () => {
    const taxonomy = fixture();
    const ruled = async (row: TagSubjects["facts"][number], from: Taxonomy = taxonomy) => skillRule(row, await from.mentions(row.text, { kinds: FACT_TAG_KINDS }))?.id ?? null;
    expect(await Promise.all(ITEMS.map((item) => ruled(written(item))))).toEqual([S(8), "onet:tool:c++", "onet:tool:microsoft-excel", S(6), S(3), S(4)]);
    for (const [why, row, , from] of declined) {
      // A label an occupation shares passes this far: the labels found here are only of the
      // kinds that tag a fact. Looking the text up among every kind is what declines it.
      const expected = why === "a label an occupation shares" ? S(8) : null;
      expect(await ruled(row, from?.()), why).toBe(expected);
    }
    expect((await sharedWithAnOccupation().lookup("SQL")).map((concept) => concept.id)).toEqual([S(8), O(99)]);
    // Not as the upload wrote it: nothing else about the row matters.
    expect(await ruled(written("SQL", { asWritten: false }))).toBeNull();
    // More than one label found is never one concept beyond doubt, whichever comes first.
    const [sql] = await taxonomy.mentions("SQL", { kinds: FACT_TAG_KINDS });
    const [excel] = await taxonomy.mentions("Microsoft Excel", { kinds: FACT_TAG_KINDS });
    expect(skillRule(written("SQL"), [sql!])?.id).toBe(S(8));
    expect(skillRule(written("SQL"), [sql!, excel!])).toBeNull();
    expect(skillRule(written("SQL"), [excel!, sql!])).toBeNull();
    expect(skillRule(written("SQL"), [])).toBeNull();
  });

  it("compares letters and nothing else", () => {
    expect(sameLetters("Container Orchestration", "container orchestration")).toBe(true);
    expect(sameLetters("C++", "c++")).toBe(true);
    // How an accent is encoded is not a different letter.
    expect(sameLetters("Café", "Café")).toBe(true);
    for (const [text, label] of [["SQL ✗", "SQL"], ["SQL?", "SQL"], ["~~SQL~~", "SQL"], [" SQL", "SQL"], ["Microsoft-Excel", "Microsoft Excel"], ["Microsoft  Excel", "Microsoft Excel"], ["Cafe", "Café"]] as const)
      expect(sameLetters(text, label), text).toBe(false);
  });
});

describe("a skill as the upload wrote it", () => {
  it("is one whole item of its line, character for character", () => {
    // A labelled list, a bare one, a bulleted one, and the line a LinkedIn export gives a skill.
    expect(skillAsWritten("Skills: Go, SQL, C++", "SQL")).toBe(true);
    expect(skillAsWritten("Go, SQL, Kubernetes, C++", "C++")).toBe(true);
    expect(skillAsWritten("- Go; SQL; Microsoft Excel", "Microsoft Excel")).toBe(true);
    expect(skillAsWritten("• SQL • Go", "SQL")).toBe(true);
    expect(skillAsWritten("### Go | SQL", "Go")).toBe(true);
    expect(skillAsWritten("Name: SQL", "SQL")).toBe(true);
  });

  it("is not an item in another case, inside marks, a part of an item, or one with no line at all", () => {
    expect(skillAsWritten("Skills: sql, Go", "SQL")).toBe(false);
    expect(skillAsWritten("Skills: **SQL**, Go", "SQL")).toBe(false);
    expect(skillAsWritten("Skills: SQL Server, Go", "SQL")).toBe(false);
    expect(skillAsWritten("Skills: PostgreSQL", "SQL")).toBe(false);
    expect(skillAsWritten(null, "SQL")).toBe(false);
    expect(skillAsWritten("", "SQL")).toBe(false);
    expect(skillAsWritten("Skills: Go, SQL", "")).toBe(false);
  });

  it("tells a skill the reading kept in the item's own spelling from one it re-cased or unmarked", () => {
    const list = "sql, Go, **Kubernetes**";
    const markdown = `# Sam Example\n\n## Skills\n\n${list}\n`;
    const { extraction } = verifyExtraction(markdown, { roles: [], facts: ["SQL", "Go", "Kubernetes"].map((text) => ({ roleKey: null, kind: "skill" as const, text, level: null, quote: list })) });
    // The reading accepts all three: it compares an item without its case or its marks, and keeps the model's string.
    expect(extraction.facts.map((found) => [found.text, found.quote])).toEqual([["SQL", list], ["Go", list], ["Kubernetes", list]]);
    expect(extraction.facts.map((found) => skillAsWritten(found.quote, found.text))).toEqual([false, true, false]);
  });
});

// ---------------------------------------------------------------- the question

describe("the question put to the judge", () => {
  it("is a fixed sentence for each kind of concept", () => {
    const sentences = FACT_TAG_KINDS.map((kind) => tagQuestion("T1", { kind: "fact", factKind: "accomplishment", text: "A line" }, { kind, label: "Label", matched: "Label" }).text);
    expect(sentences).toEqual(["Did or can do: Label", "Knows: Label", "Has skills or knowledge in: Label", "Did this work: Label", "Used the software: Label", "Used this kind of software: Label"]);
    expect(tagQuestion("T1", { kind: "role", title: "A title" }, { kind: "occupation", label: "Label", matched: "Label" }).text).toBe("Worked in the occupation: Label");
  });

  it("names the label that was found beside the preferred one, when they are not the same label", () => {
    const about = (label: string, matched: string) => tagQuestion("T1", { kind: "fact", factKind: "accomplishment", text: "A line" }, { kind: "knowledge", label, matched }).text;
    expect(about("container orchestration", "K8s")).toBe("Knows: container orchestration (also called K8s)");
    expect(about("Python (computer programming)", "Python")).toBe("Knows: Python (computer programming) (also called Python)");
    // The same label in other case or punctuation is not another name.
    expect(about("Manage project teams.", "manage project teams")).toBe("Knows: Manage project teams.");
    expect(about("SQL", "SQL")).toBe("Knows: SQL");
  });

  it("gives the subject's own words as its one fact, and says what they are where that isn't plain", () => {
    const concept = { kind: "tool" as const, label: "Go", matched: "Go" };
    expect(tagQuestion("T7", { kind: "fact", factKind: "accomplishment", text: "Built a Go service" }, concept)).toEqual({ alias: "T7", text: "Used the software: Go", facts: [{ text: "Built a Go service", quote: null }] });
    expect(tagQuestion("T7", { kind: "fact", factKind: "skill", text: "Go" }, concept).facts).toEqual([{ text: "Skill: Go", quote: null }]);
    expect(tagQuestion("T7", { kind: "fact", factKind: "credential", text: "Go certificate" }, concept).facts).toEqual([{ text: "Credential: Go certificate", quote: null }]);
    expect(tagQuestion("T7", { kind: "role", title: "Go Developer" }, { kind: "occupation", label: "software developer", matched: "software developer" }).facts).toEqual([{ text: "Job title: Go Developer", quote: null }]);
  });

  it("shows the judge no ID of a fact, a role or a concept", async () => {
    const { prompts, tags } = await run(upload([role("role-id-91c2", "Software Engineer")], [fact("fact-id-7f3a", "Ran Kubernetes clusters", { roleId: "role-id-91c2" }), skill("skill-id-55d0", "Go")]));
    expect(prompts).toHaveLength(2);
    expect(tags).toHaveLength(6);
    for (const prompt of prompts) {
      for (const id of ["role-id-91c2", "fact-id-7f3a", "skill-id-55d0", ...tags.map((tag) => tag.conceptId)]) expect(prompt, id).not.toContain(id);
      for (const part of ["esco:", "onet:", MADE.model, MADE.taxonomyVersion, TAG_JUDGE_METHOD]) expect(prompt, part).not.toContain(part);
    }
    // What it is shown: an alias, the sentence, and the words asked about.
    expect(JSON.parse((JSON.parse(prompts[1]!) as { role: string; content: string }[]).at(-1)!.content)).toEqual({
      lines: [
        { id: "T3", text: "Used the software: Kubernetes", facts: [{ text: "Ran Kubernetes clusters", quote: null }] },
        { id: "T4", text: "Knows: container orchestration (also called Kubernetes)", facts: [{ text: "Ran Kubernetes clusters", quote: null }] },
        { id: "T5", text: "Used the software: Go", facts: [{ text: "Skill: Go", quote: null }] },
        { id: "T6", text: "Knows: Go (computer programming) (also called Go)", facts: [{ text: "Skill: Go", quote: null }] },
      ],
    });
  });

  it("is asked once for one wording, and every row with that wording takes the answer", async () => {
    const { asked, tags, report } = await run(
      upload(
        [role("first-job", "Programmer"), role("second-job", "Programmer")],
        [
          skill("listed", "Kubernetes"),
          skill("listed-again", "Kubernetes"),
          // The same words as a line of experience are another wording: the judge is told what kind of thing it reads.
          fact("line", "Kubernetes"),
        ],
      ),
      { verdict: says("unsupported", "Used the software") },
    );
    expect(asked.map((call) => call.map((item) => [item.text, item.facts[0]!.text]))).toEqual([
      [["Worked in the occupation: software developer (also called programmer)", "Job title: Programmer"]],
      [
        ["Used the software: Kubernetes", "Skill: Kubernetes"],
        ["Knows: container orchestration (also called Kubernetes)", "Skill: Kubernetes"],
        ["Used the software: Kubernetes", "Kubernetes"],
        ["Knows: container orchestration (also called Kubernetes)", "Kubernetes"],
      ],
    ]);
    expect(brief(tags)).toEqual([
      ["first-job", O(1), TAG_JUDGE_METHOD],
      ["second-job", O(1), TAG_JUDGE_METHOD],
      ["listed", S(4), TAG_JUDGE_METHOD],
      ["listed-again", S(4), TAG_JUDGE_METHOD],
      ["line", S(4), TAG_JUDGE_METHOD],
    ]);
    // Candidates are counted by row, questions and answers by wording.
    expect(report).toMatchObject({ candidates: 8, asked: 5, yes: 3, stored: 5 });
  });
});

// ---------------------------------------------------------------- answers

describe("an answer", () => {
  /** A firm label and a weak one, in two facts. */
  const firmAndWeak = () => upload([], [fact("firm", "Ran Kubernetes clusters"), fact("weak", "Built a Go service")]);

  it("makes a tag only when it is one plain yes, for a weak label and a firm one alike", async () => {
    for (const typed of [false, true]) {
      const agreed = await run(firmAndWeak(), { typed });
      expect(brief(agreed.tags), String(typed)).toEqual([
        ["firm", KUBERNETES, TAG_JUDGE_METHOD],
        ["firm", S(4), TAG_JUDGE_METHOD],
        ["weak", "onet:tool:go", TAG_JUDGE_METHOD],
        ["weak", S(6), TAG_JUDGE_METHOD],
      ]);
      for (const verdict of ["unsupported", "overstated", "missing", "twice"] as const) {
        const refused = await run(firmAndWeak(), { typed, verdict: says(verdict) });
        expect(refused.tags, `${verdict} ${typed}`).toEqual([]);
        expect(refused.report, `${verdict} ${typed}`).toEqual({ ...emptyTagReport(), facts: 2, candidates: 4, asked: 4 });
        // Each question is decided by itself: a no about one concept leaves the others as they were.
        const one = await run(firmAndWeak(), { typed, verdict: says(verdict, "Used the software: Kubernetes") });
        expect(brief(one.tags).map(([, concept]) => concept), `${verdict} ${typed}`).toEqual([S(4), "onet:tool:go", S(6)]);
      }
    }
  });

  it("from a typed decision is no yes below the judge's own bar", async () => {
    const decision = (supported: number) => ({ answers: { verdict: { type: "choice", choice: "supported", probabilities: { supported, unsupported: (1 - supported) * 0.75, overstated: (1 - supported) * 0.25 } } }, usage: { input_tokens: 40, output_tokens: 0 } });
    const typed = (supported: number) => {
      const ask = vi.fn(async (..._args: unknown[]) => decision(supported));
      const env = { AI: { run: ask }, AI_GATEWAY_ID: "gw", MODEL_JUDGE: CLEF_MODEL } as unknown as Env;
      return { ask, models: { ...judge().models, judge: (items: JudgeItem[]) => decisionJudge(env, items) } satisfies Models };
    };
    const unsure = typed(0.6);
    const doubted = await run(firmAndWeak(), {}, fixture(), unsure.models);
    // Four typed decisions were made, each chose "supported", and none was sure enough.
    expect(unsure.ask).toHaveBeenCalledTimes(4);
    expect(doubted.tags).toEqual([]);
    expect(doubted.report).toEqual({ ...emptyTagReport(), facts: 2, candidates: 4, asked: 4 });
    // What the typed judge is sent: the sentence as the line, the subject's words as its one fact.
    expect((unsure.ask.mock.calls[0]![1] as { state: unknown }).state).toEqual({ line: "Used the software: Kubernetes", facts: [{ text: "Ran Kubernetes clusters", quote: null }] });
    const sure = typed(0.98);
    expect((await run(firmAndWeak(), {}, fixture(), sure.models)).tags).toHaveLength(4);
  });

  it("counts only in the call that asked the question", async () => {
    // One question about the job (T1) in the first call, two about the line (T2, T3) in the second.
    const subjects = () => upload([role("job", "Programmer")], [fact("line", "Ran Kubernetes clusters")]);
    const yes = (id: string): Answer => ({ id, verdict: "supported", reason: "" });
    const tagged = async (reply: (answers: Answer[], call: number) => Answer[], typed: boolean) => {
      const { asked, tags } = await run(subjects(), { typed, reply: (answers, call) => ({ verdicts: reply(answers, call) }) });
      expect(asked.map((call) => call.map((item) => item.alias))).toEqual([["T1"], ["T2", "T3"]]);
      return tags.map((tag) => tag.conceptId);
    };
    for (const typed of [false, true]) {
      expect(await tagged((answers) => answers, typed)).toEqual([O(1), KUBERNETES, S(4)]);
      // The first reply volunteers a yes about the line, and the call that asked gets no answer.
      expect(await tagged((answers, call) => (call === 0 ? [...answers, yes("T2")] : answers.filter((answer) => answer.id !== "T2")), typed), String(typed)).toEqual([O(1), S(4)]);
      // The other way round: no answer from the call that asked, and one volunteered by the next.
      expect(await tagged((answers, call) => (call === 0 ? [] : [...answers, yes("T1")]), typed), String(typed)).toEqual([KUBERNETES, S(4)]);
      // An answer nobody asked for decides nothing, and takes nothing from the answer that was asked for.
      expect(await tagged((answers, call) => (call === 0 ? [...answers, { ...yes("T2"), verdict: "unsupported" }, yes("T9")] : answers), typed), String(typed)).toEqual([O(1), KUBERNETES, S(4)]);
    }
  });

  it("counts only in the call that asked it, between two calls about facts too", async () => {
    // Eleven lines are twenty-two questions, asked in calls of twenty and two. The last line's are T21 and T22.
    const subjects = () => upload([], Array.from({ length: 11 }, (_, index) => fact(`line-${index}`, `Ran Kubernetes cluster ${index + 1}`)));
    const yes = (id: string): Answer => ({ id, verdict: "supported", reason: "" });
    const untagged = async (reply: (answers: Answer[], call: number) => Answer[], typed: boolean) => {
      const { asked, tags } = await run(subjects(), { typed, reply: (answers, call) => ({ verdicts: reply(answers, call) }) });
      expect(asked.map((call) => call.map((item) => item.alias))).toEqual([Array.from({ length: 20 }, (_, index) => `T${index + 1}`), ["T21", "T22"]]);
      const made = new Set(tags.map((tag) => `${tag.subject.id} ${tag.conceptId}`));
      return subjects().facts.flatMap((row) => [KUBERNETES, S(4)].flatMap((concept) => (made.has(`${row.id} ${concept}`) ? [] : [`${row.id} ${concept}`])));
    };
    for (const typed of [false, true]) {
      expect(await untagged((answers) => answers, typed)).toEqual([]);
      // A yes for T21 volunteered by the first call, and none from the call that asked.
      expect(await untagged((answers, call) => (call === 0 ? [...answers, yes("T21")] : answers.filter((answer) => answer.id !== "T21")), typed), String(typed)).toEqual([`line-10 ${KUBERNETES}`]);
      // No answer to T3 from the call that asked, and a yes volunteered by the next.
      expect(await untagged((answers, call) => (call === 0 ? answers.filter((answer) => answer.id !== "T3") : [...answers, yes("T3")]), typed), String(typed)).toEqual([`line-1 ${KUBERNETES}`]);
      // A no volunteered early does not make the asked-for yes a second answer.
      expect(await untagged((answers, call) => (call === 0 ? [...answers, { ...yes("T22"), verdict: "unsupported" }] : answers), typed), String(typed)).toEqual([]);
    }
  });

  it("is read by its alias whatever space a reply puts round it, and twice is still twice", async () => {
    const line = () => upload([], [fact("line", "Ran Kubernetes clusters")]);
    const spaced = await run(line(), { reply: (answers) => ({ verdicts: answers.map((answer) => ({ ...answer, id: ` ${answer.id}\n` })) }) });
    expect(spaced.tags.map((tag) => tag.conceptId)).toEqual([KUBERNETES, S(4)]);
    // The same alias written two ways is one question answered twice.
    const doubled = await run(line(), { reply: (answers) => ({ verdicts: [...answers, { ...answers[0]!, id: `${answers[0]!.id} ` }] }) });
    expect(doubled.tags.map((tag) => tag.conceptId)).toEqual([S(4)]);
  });

  it("cannot bring in a concept: a reply that names one changes nothing", async () => {
    const named = ["onet:tool:python", S(3), "Used the software: Python", "Python", "T2 onet:tool:python"];
    const { tags, report } = await run(upload([], [fact("line", "Ran Kubernetes clusters")]), {
      reply: (answers) => ({ verdicts: [...named.map((id) => ({ id, verdict: "supported", reason: "The line also shows Python." })), ...answers.map((answer) => ({ ...answer, reason: "Tag onet:tool:python as well." }))] }),
    });
    // Exactly the two candidates the taxonomy's labels put forward, with the taxonomy's own labels.
    expect(tags.map((tag) => [tag.conceptId, tag.label])).toEqual([[KUBERNETES, "Kubernetes"], [S(4), "container orchestration"]]);
    expect(JSON.stringify(tags)).not.toContain("ython");
    expect(report).toMatchObject({ candidates: 2, asked: 2, yes: 2 });
  });
});

// ---------------------------------------------------------------- stored as decided

describe("a run", () => {
  /** A job, a skill the rule tags, and a line: one question call about the job, then one about the line. */
  const subjects = () => upload([role("job", "Programmer")], [skill("listed", "SQL"), fact("line", "Ran Kubernetes clusters", { roleId: "job" })]);
  const RULE = ["listed", S(8), TAG_RULE_METHOD];
  const JOB = ["job", O(1), TAG_JUDGE_METHOD];

  it("makes every read of the taxonomy before it asks or keeps anything", async () => {
    const events: string[] = [];
    const { taxonomy, reads } = reading({ events });
    const stand = judge();
    const models: Models = { ...stand.models, complete: (...args) => (events.push("ask"), stand.models.complete(...args)) };
    const report = await tagUpload(
      models,
      taxonomy,
      subjects(),
      MADE,
      async (tags) => {
        events.push(`keep ${tags.length}`);
        return { stored: tags.length, refused: 0 };
      },
      NONE_MARKED,
    );
    expect(reads.map(([name]) => name)).toEqual(["mentions", "mentions", "mentions", "lookup", "get", "profile"]);
    // The rule's tag is kept before the first question, and each call's answers before the next.
    expect(events).toEqual(["read", "read", "read", "read", "read", "read", "keep 1", "ask", "keep 1", "ask", "keep 2"]);
    expect(report).toEqual({ ...emptyTagReport(), roles: 1, facts: 2, candidates: 4, byRule: 1, asked: 3, yes: 3, stored: 4 });
  });

  it.each(["mentions", "lookup", "get", "profile"] as const)("that cannot make a %s read asks no model and keeps nothing", async (failing) => {
    const { taxonomy } = reading({ failing });
    const { report, asked, kept } = await run(subjects(), {}, taxonomy);
    expect(report.failed).toBe("error");
    expect(asked).toEqual([]);
    expect(kept).toEqual([]);
    expect(report).toMatchObject({ candidates: 0, byRule: 0, asked: 0, yes: 0, stored: 0 });
  });

  it("ends with the taxonomy's own code when a read is refused", async () => {
    // One word of more characters than a text may have: it passes the count of words, and the lookup refuses it.
    const { report, kept, asked } = await run(upload([], [skill("listed", "SQL"), fact("long", "x".repeat(20_001))]));
    expect(report.failed).toBe("invalid");
    expect(kept).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("keeps the rule's tags and earlier answers when a call is rejected", async () => {
    const stand = judge();
    let calls = 0;
    const models: Models = { ...stand.models, complete: (...args) => (++calls === 2 ? Promise.reject(new Error("unavailable: model provider network failure")) : stand.models.complete(...args)) };
    const { report, kept } = await run(subjects(), {}, fixture(), models);
    expect(kept.map(brief)).toEqual([[RULE], [JOB]]);
    // The questions of the call that failed were sent, so they are counted as asked.
    expect(report).toEqual({ ...emptyTagReport(), roles: 1, facts: 2, candidates: 4, byRule: 1, asked: 3, yes: 1, stored: 2, failed: "unavailable" });
  });

  it("keeps them when a typed reply is not an answer", async () => {
    const good = { answers: { verdict: { type: "choice", choice: "supported", probabilities: { supported: 0.98, unsupported: 0.01, overstated: 0.01 } } }, usage: { input_tokens: 40, output_tokens: 0 } };
    let decisions = 0;
    // The one decision about the job is answered. The two about the line come back as something else.
    const ask = vi.fn(async (..._args: unknown[]): Promise<unknown> => (++decisions === 1 ? good : { answers: {} }));
    const env = { AI: { run: ask }, AI_GATEWAY_ID: "gw", MODEL_JUDGE: CLEF_MODEL } as unknown as Env;
    const { report, kept } = await run(subjects(), {}, fixture(), { ...judge().models, judge: (items) => decisionJudge(env, items) });
    expect(kept.map(brief)).toEqual([[RULE], [JOB]]);
    expect(report).toMatchObject({ asked: 3, yes: 1, stored: 2, failed: "unavailable" });
  });

  it("keeps them when a chat reply fails its schema", async () => {
    const { report, kept } = await run(subjects(), { reply: (answers, call) => (call === 0 ? { verdicts: answers } : { verdicts: answers.map((answer) => ({ ...answer, verdict: "probably" })) }) });
    expect(kept.map(brief)).toEqual([[RULE], [JOB]]);
    expect(report).toMatchObject({ asked: 3, yes: 1, stored: 2, failed: "error" });
    // A reply with no list of answers at all is no better.
    const shapeless = await run(subjects(), { reply: () => ({ answers: "all of them" }) });
    expect(shapeless.kept.map(brief)).toEqual([[RULE]]);
    expect(shapeless.report).toMatchObject({ asked: 1, yes: 0, stored: 1, failed: "error" });
  });

  it("ends with the refusal's code when a reservation is refused, and the provider is never called", async () => {
    const ask = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({}));
    const env = { AI: { run: ask }, AI_GATEWAY_ID: "gw", MODEL_JUDGE: CLEF_MODEL } as unknown as Env;
    // What the Worker's own models do before each attempt: reserve its cost, or refuse.
    const observers: ModelObservers = {
      onAttemptStart: () => {
        throw new AppError("quota", "the configured model spend budget is exhausted");
      },
    };
    const { report, kept } = await run(subjects(), {}, fixture(), { ...judge().models, judge: (items) => decisionJudge(env, items, observers) });
    expect(ask).not.toHaveBeenCalled();
    expect(kept.map(brief)).toEqual([[RULE]]);
    expect(report).toEqual({ ...emptyTagReport(), roles: 1, facts: 2, candidates: 2, byRule: 1, asked: 1, stored: 1, failed: "quota" });
  });

  it("ends when what it decided cannot be kept, and asks nothing more", async () => {
    for (const failAt of [1, 2]) {
      const stand = judge();
      let keeps = 0;
      const kept: ProposedTag[][] = [];
      const report = await tagUpload(
        stand.models,
        fixture(),
        subjects(),
        MADE,
        async (tags) => {
          if (++keeps === failAt) throw new AppError("conflict", "this attempt was superseded");
          kept.push(tags);
          return { stored: tags.length, refused: 0 };
        },
        NONE_MARKED,
      );
      expect(report.failed, String(failAt)).toBe("conflict");
      // The first keep comes before any question; the second after the one call about the job.
      expect(stand.asked, String(failAt)).toHaveLength(failAt - 1);
      expect(kept.map(brief), String(failAt)).toEqual(failAt === 1 ? [] : [[RULE]]);
    }
  });

  describe("beside a line its owner marks sensitive while it is at work", () => {
    // Twelve lines with two candidates each: twenty questions go in the first call, four in the next.
    const twelve = () => upload([], Array.from({ length: 12 }, (_, n) => fact(`line-${n}`, `Ran Kubernetes clusters, number ${n}`)));
    /** The vault's mark as a set a test changes, and every list of facts the stage asked about. */
    const marking = () => {
      const marks = new Set<string>();
      const checked: string[][] = [];
      const marked = async (ids: string[]) => {
        checked.push([...ids]);
        return ids.filter((id) => marks.has(id));
      };
      return { marks, checked, marked };
    };

    it("reads the mark again before every call about facts, and asks no more about a line marked since", async () => {
      const { marks, checked, marked } = marking();
      // While the first call is open, its owner marks a line it holds and a line the next call would hold.
      const { report, asked, kept } = await run(twelve(), { reply: (answers, call) => (call === 0 && marks.add("line-0").add("line-10"), { verdicts: answers }) }, fixture(), undefined, marked);
      expect(asked.map((call) => call.length)).toEqual([20, 2]);
      expect(asked[1]!.map((item) => [item.alias, item.facts[0]!.text])).toEqual([
        ["T21", "Ran Kubernetes clusters, number 11"],
        ["T22", "Ran Kubernetes clusters, number 11"],
      ]);
      expect(JSON.stringify(asked.slice(1))).not.toContain("number 10");
      // Checked before each call, about the facts that call was to ask about and nothing else.
      expect(checked).toEqual([Array.from({ length: 10 }, (_, n) => `line-${n}`), ["line-10", "line-11"]]);
      // The line marked while the call about it was open was already asked about. Its answers are
      // handed on: the vault reads the mark again as it stores them, and leaves them out.
      expect(kept.flat().filter((tag) => tag.subject.id === "line-10")).toEqual([]);
      expect(report).toEqual({ ...emptyTagReport(), facts: 12, candidates: 24, asked: 22, yes: 22, stored: 22, withheld: 2 });
    });

    it("sends no call that would hold nothing but marked lines, and asks about a line's other rows", async () => {
      const { marks, checked, marked } = marking();
      // Two rows say the same words. The mark is on one of them, as far as the stage is told.
      const subjects = upload([role("job", "Programmer")], [fact("line", "Ran Kubernetes clusters"), fact("again", "Ran Kubernetes clusters"), fact("other", "Ran Kubernetes clusters, number 1")]);
      marks.add("line").add("other");
      const { report, asked, tags } = await run(subjects, {}, fixture(), undefined, marked);
      // The call about the job is made without asking the vault: a job's title cannot be marked.
      expect(checked).toEqual([["line", "again", "other"]]);
      expect(asked.map((call) => call.length)).toEqual([1, 2]);
      expect(asked[1]!.map((item) => item.facts[0]!.text)).toEqual(Array(2).fill("Ran Kubernetes clusters"));
      expect([...new Set(tags.filter((tag) => tag.subject.kind === "fact").map((tag) => tag.subject.id))]).toEqual(["again"]);
      expect(report).toMatchObject({ asked: 3, withheld: 4 });
      // Every line marked: the one call about facts is never made.
      marks.add("again");
      const none = await run(subjects, {}, fixture(), undefined, marked);
      expect(none.asked).toHaveLength(1);
      expect(none.report).toMatchObject({ asked: 1, yes: 1, stored: 1, withheld: 6 });
      expect(none.report.failed).toBeUndefined();
    });

    it("ends when the mark cannot be read, and asks nothing more", async () => {
      const refused = async (): Promise<string[]> => {
        throw new AppError("conflict", "this attempt was superseded");
      };
      const { report, asked, kept } = await run(subjects(), {}, fixture(), undefined, refused);
      expect(asked).toHaveLength(1);
      expect(kept.map(brief)).toEqual([[RULE], [JOB]]);
      expect(report).toMatchObject({ asked: 1, stored: 2, failed: "conflict" });
      // An answer that is not a list of facts is no answer: nothing is taken as unmarked.
      for (const answer of [undefined, {}, "line", [7]]) {
        const odd = await run(subjects(), {}, fixture(), undefined, async () => answer as unknown as string[]);
        expect(odd.asked, JSON.stringify(answer)).toHaveLength(1);
        expect(odd.report.failed, JSON.stringify(answer)).toBe("error");
      }
    });
  });

  it("adds up what the caller kept and what it refused, and never keeps an empty list", async () => {
    const lists: number[] = [];
    const report = await tagUpload(
      judge({ verdict: says("unsupported", "Worked in the occupation") }).models,
      fixture(),
      subjects(),
      MADE,
      async (tags) => {
        lists.push(tags.length);
        return { stored: tags.length - 1, refused: 1 };
      },
      NONE_MARKED,
    );
    // The rule's tag, nothing for the job the judge declined, then the line's two.
    expect(lists).toEqual([1, 2]);
    expect(report).toMatchObject({ yes: 2, stored: 1, refused: 2 });
    expect(report.failed).toBeUndefined();
  });

  it("never rejects, whatever it is given", async () => {
    const report = await tagUpload(judge().models, fixture(), null as unknown as TagSubjects, MADE, async () => ({ stored: 0, refused: 0 }), NONE_MARKED);
    expect(report).toEqual({ ...emptyTagReport(), failed: "error" });
    // Nothing to tag is not a failure.
    expect(await tagUpload(judge().models, reading({ failing: "mentions" }).taxonomy, upload([], []), MADE, async () => ({ stored: 0, refused: 0 }), NONE_MARKED)).toEqual(emptyTagReport());
  });

  it("stamps a tag with what decided it", () => {
    expect(tagStamp(TAG_JUDGE_METHOD, MADE)).toEqual({ proposedBy: "model", model: "test/judge", method: "mention-judge/1", taxonomyVersion: MADE.taxonomyVersion, confidence: null, shadow: true });
    expect(tagStamp(TAG_RULE_METHOD, MADE)).toEqual({ proposedBy: "rule", model: null, method: "mention-label/1", taxonomyVersion: MADE.taxonomyVersion, confidence: null, shadow: true });
    // Both are stamps the record stores, on a tag it stores.
    for (const method of [TAG_JUDGE_METHOD, TAG_RULE_METHOD] as const) {
      expect(stampProblem(tagStamp(method, MADE))).toBeNull();
      expect(tagProblem({ subject: { kind: "fact", id: "fact-1" }, conceptId: KUBERNETES, conceptKind: "tool", label: "Kubernetes", stamp: tagStamp(method, MADE) })).toBeNull();
    }
    // The model that could not be named is refused by the record, not stored under another name.
    expect(stampProblem(tagStamp(TAG_JUDGE_METHOD, { ...MADE, model: "" }))).toBe("a model's judgement names the model");
  });
});

// ---------------------------------------------------------------- decided before

describe("what was decided before", () => {
  const LINE = "Ran Kubernetes clusters";
  const subjects = (held: { job?: HeldTag[]; listed?: HeldTag[]; line?: HeldTag[] }) =>
    upload([role("job", "Programmer", held.job)], [skill("listed", "SQL", "SQL", { held: held.listed ?? [] }), fact("line", LINE, { held: held.line ?? [] })]);

  it("is neither asked about nor proposed again when the row itself holds the tag", async () => {
    const { report, asked, kept } = await run(subjects({ job: [holding(O(1), true)], listed: [holding(S(8), true, TAG_RULE_METHOD)], line: [holding(KUBERNETES, true), holding(S(4), true)] }));
    expect(asked).toEqual([]);
    expect(kept).toEqual([]);
    expect(report).toEqual({ ...emptyTagReport(), roles: 1, facts: 2, candidates: 4, known: 4 });
  });

  it("is proposed without asking when another row with the same words holds the judge's yes", async () => {
    const { report, asked, kept } = await run(subjects({ job: [holding(O(1), false)], listed: [holding(S(8), false, TAG_RULE_METHOD)], line: [holding(KUBERNETES, false), holding(S(4), false)] }));
    expect(asked).toEqual([]);
    // The rule decides its own again, for nothing. The judge's answers are carried: the job's first, then the line's.
    expect(kept.map(brief)).toEqual([
      [["listed", S(8), TAG_RULE_METHOD], ["job", O(1), TAG_JUDGE_METHOD]],
      [["line", KUBERNETES, TAG_JUDGE_METHOD], ["line", S(4), TAG_JUDGE_METHOD]],
    ]);
    expect(kept.flat().map((tag) => tag.words)).toEqual(["SQL", "Programmer", LINE, LINE]);
    expect(report).toEqual({ ...emptyTagReport(), roles: 1, facts: 2, candidates: 4, byRule: 1, carried: 3, stored: 4 });
  });

  it("is asked about again when it was decided with another taxonomy, another model or another method", async () => {
    const others: [what: string, change: Partial<HeldTag>][] = [
      ["another taxonomy", { taxonomyVersion: "esco-0.0.1+onet-0.0+00000000" }],
      ["another model", { model: "other/judge" }],
      ["an earlier form of the question", { method: "mention-judge/0" }],
      ["the rule", { method: TAG_RULE_METHOD, model: null }],
      ["no taxonomy at all", { taxonomyVersion: null }],
    ];
    for (const own of [true, false])
      for (const [what, change] of others) {
        const { asked, tags, report } = await run(subjects({ job: [holding(O(1), own, TAG_JUDGE_METHOD, change)], line: [holding(KUBERNETES, own, TAG_JUDGE_METHOD, change), holding(S(4), own, TAG_JUDGE_METHOD, change)] }));
        expect(asked.map((call) => call.length), `${what} ${own}`).toEqual([1, 2]);
        expect(brief(tags), `${what} ${own}`).toEqual([["listed", S(8), TAG_RULE_METHOD], ["job", O(1), TAG_JUDGE_METHOD], ["line", KUBERNETES, TAG_JUDGE_METHOD], ["line", S(4), TAG_JUDGE_METHOD]]);
        expect(report, `${what} ${own}`).toMatchObject({ known: 0, carried: 0, byRule: 1, asked: 3 });
      }
    // The rule's own tag is known only as the rule's: the judge's yes for it, or the rule's under another taxonomy, is not.
    for (const stale of [holding(S(8), true), holding(S(8), true, TAG_RULE_METHOD, { taxonomyVersion: "esco-0.0.1+onet-0.0+00000000" }), holding(S(8), true, TAG_RULE_METHOD, { model: MADE.model })])
      expect((await run(subjects({ listed: [stale] }))).report).toMatchObject({ known: 0, byRule: 1 });
  });

  it("is asked about again when the judge declined it: a decline leaves nothing behind", async () => {
    // What a vault would hold after a run: every tag that was kept, on the row it was kept for.
    const held = (tags: ProposedTag[], id: string) => tags.filter((tag) => tag.subject.id === id).map((tag) => holding(tag.conceptId, true, tag.method));
    const first = await run(subjects({}), { verdict: says("unsupported", "Knows: container orchestration") });
    expect(lines(first.asked)).toEqual([["Worked in the occupation: software developer (also called programmer)"], ["Used the software: Kubernetes", "Knows: container orchestration (also called Kubernetes)"]]);
    expect(brief(first.tags)).toEqual([["listed", S(8), TAG_RULE_METHOD], ["job", O(1), TAG_JUDGE_METHOD], ["line", KUBERNETES, TAG_JUDGE_METHOD]]);
    // The same upload read again: only the candidate that was declined is put to the judge.
    const again = await run(subjects({ job: held(first.tags, "job"), listed: held(first.tags, "listed"), line: held(first.tags, "line") }));
    expect(lines(again.asked)).toEqual([["Knows: container orchestration (also called Kubernetes)"]]);
    expect(brief(again.tags)).toEqual([["line", S(4), TAG_JUDGE_METHOD]]);
    expect(again.report).toEqual({ ...emptyTagReport(), roles: 1, facts: 2, candidates: 4, known: 3, asked: 1, yes: 1, stored: 1 });
  });
});

// ---------------------------------------------------------------- labelled examples

describe("labelled examples", () => {
  /** A judge that fails whenever it is asked. */
  const throwing: Models = { ...judge().models, complete: () => Promise.reject(new Error("unavailable: model provider network failure")) };
  const named = (outcome: { subject: string; concept: string }) => `${outcome.subject} / ${outcome.concept}`;

  it("list every candidate that is found, and nothing is found that they do not list", async () => {
    const { outcomes, left } = await runTagging(judge().models, TAG_LINES);
    // Every example was read whole: no cap left anything out.
    expect(left).toEqual(emptyTagReport().left);
    expect(outcomes.filter((outcome) => outcome.found && !outcome.listed).map(named)).toEqual([]);
    expect(outcomes.filter((outcome) => !outcome.found && outcome.listed?.decidedBy !== "check").map(named)).toEqual([]);
    // What a check stops is never a candidate, so no judge is ever asked about it.
    const stopped = outcomes.filter((outcome) => outcome.listed?.decidedBy === "check");
    expect(stopped.length).toBeGreaterThan(0);
    expect(stopped.filter((outcome) => outcome.found || outcome.tagged).map(named)).toEqual([]);
  });

  it("say for every candidate what a reader expects and what settles it", () => {
    for (const example of TAG_LINES)
      for (const candidate of example.candidates) {
        // The rule never tags what a careful reader would not, and what must not be tagged names what stops it.
        if (candidate.decidedBy === "rule") expect(candidate.expect, candidate.why).toBe("tag");
        if (candidate.decidedBy === "check") expect(candidate.expect, candidate.why).toBe("none");
        expect(candidate.why.length, candidate.concept).toBeGreaterThan(0);
      }
    const skills = TAG_LINES.flatMap((example) => ("fact" in example && example.fact.kind === "skill" ? [example.fact] : []));
    // An item the reading model re-cased, a mark beside a label, and a mark between a label's words.
    expect(skills.some((found) => !skillAsWritten(found.quote, found.text) && skillAsWritten(found.quote, found.text.toLowerCase()))).toBe(true);
    expect(skills.some((found) => /^SQL\s*[✗?]$/u.test(found.text))).toBe(true);
    expect(skills.some((found) => /^Microsoft\s*[✗-]\s*Excel$/u.test(found.text))).toBe(true);
  });

  it("are tagged by the rule under a judge that fails, and by nothing else", async () => {
    const { outcomes, report } = await runTagging(throwing, TAG_LINES);
    expect(report.failed).toBe("unavailable");
    const byRule = outcomes.filter((outcome) => outcome.listed?.decidedBy === "rule");
    expect(byRule.length).toBeGreaterThan(0);
    expect(outcomes.filter((outcome) => outcome.tagged).map(named)).toEqual(byRule.map(named));
    expect(byRule.every((outcome) => outcome.tagged === TAG_RULE_METHOD)).toBe(true);
  });

  it("are scored as the share of each method's tags that a reader expects", async () => {
    const listed = TAG_LINES.flatMap((example) => example.candidates);
    const byJudge = listed.filter((candidate) => candidate.decidedBy === "judge");
    const byRule = listed.filter((candidate) => candidate.decidedBy === "rule");
    // A judge that says yes to everything tags every wrong candidate too, and its precision says so.
    const agreed = precision((await runTagging(judge().models, TAG_LINES)).outcomes);
    const right = byJudge.filter((candidate) => candidate.expect === "tag").length;
    expect(right).toBeLessThan(byJudge.length);
    expect(agreed).toEqual({
      [TAG_RULE_METHOD]: { tagged: byRule.length, right: byRule.length, precision: 1 },
      [TAG_JUDGE_METHOD]: { tagged: byJudge.length, right, precision: right / byJudge.length },
    });
    // A judge that answers as the labels do is right every time. In these examples a subject's
    // candidates are all right or all wrong, so it is enough to know the subject it is asked of.
    const shown = (example: (typeof TAG_LINES)[number]) =>
      "title" in example ? `Job title: ${example.title}` : example.fact.kind === "skill" ? `Skill: ${example.fact.text}` : example.fact.kind === "credential" ? `Credential: ${example.fact.text}` : example.fact.text;
    const declined = new Set(TAG_LINES.filter((example) => example.candidates.some((candidate) => candidate.expect === "none" && candidate.decidedBy === "judge")).map(shown));
    const careful = precision((await runTagging(judge({ verdict: (item) => (declined.has(item.facts[0]!.text) ? "unsupported" : "supported") }).models, TAG_LINES)).outcomes);
    expect(careful[TAG_JUDGE_METHOD]).toEqual({ tagged: right, right, precision: 1 });
    // A method that proposed nothing has no precision to report.
    expect(precision((await runTagging(throwing, TAG_LINES)).outcomes)[TAG_JUDGE_METHOD]).toEqual({ tagged: 0, right: 0, precision: null });
  });

  it("include wrong candidates that nothing but the judge's answer stops", async () => {
    const wrong = (outcomes: Awaited<ReturnType<typeof runTagging>>["outcomes"]) => outcomes.filter((outcome) => outcome.listed?.expect === "none" && outcome.listed.decidedBy === "judge");
    // With a judge that says yes to everything, each is tagged: no check stops it.
    const agreed = await runTagging(judge().models, TAG_LINES);
    expect(wrong(agreed.outcomes).length).toBeGreaterThan(0);
    expect(wrong(agreed.outcomes).filter((outcome) => outcome.tagged !== TAG_JUDGE_METHOD).map(named)).toEqual([]);
    // With a judge that says no, or one that fails, none is.
    for (const models of [judge({ verdict: says("unsupported") }).models, throwing]) expect(wrong((await runTagging(models, TAG_LINES)).outcomes).filter((outcome) => outcome.tagged).map(named)).toEqual([]);
  });
});
