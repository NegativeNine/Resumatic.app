import type { Models } from "../../src/ai/models";
import type { JudgeItem } from "../../src/ai/prompts";
import { TAG_JUDGE_METHOD, TAG_RULE_METHOD, skillAsWritten, tagUpload, type ProposedTag, type TagMethod, type TagReport, type TagSubjects } from "../../src/pipeline/tag";
import { MemoryStore, Taxonomy } from "../../src/taxonomy";
import type { LabelledCandidate, TagExample } from "../fixtures/tag-lines";
import { TAXONOMY_FIXTURE } from "../support/taxonomy-fixture";

// Puts labelled examples through the tagger over the made-up taxonomy, and says of every concept
// what was found and what was tagged. The unit test runs it with stand-in models and the live
// eval with the real judge, so both measure the same thing.

/** What became of one concept for one example. */
export interface TagOutcome {
  /** The example's fact text or job title. */
  subject: string;
  concept: string;
  /** The concept's label, where a tag carried it. */
  label: string | null;
  /** What the labels say of it. Null when it was found and the labels don't list it. */
  listed: LabelledCandidate | null;
  /** The method the labels expect a tag from, or null when they expect none. */
  expected: TagMethod | null;
  /** True when it is a candidate at all: a judge that says yes to everything tags it. */
  found: boolean;
  /** The method that tagged it with the models given, or null when nothing did. */
  tagged: TagMethod | null;
}

export interface TaggingRun {
  /** What the run with the models given did. */
  report: TagReport;
  /** What a cap left out while the candidates were being found. All zero when every example was read whole. */
  left: TagReport["left"];
  outcomes: TagOutcome[];
}

/** A judge that says yes to everything it is asked, and so tags every candidate there is. */
const agreeing: Models = {
  judge: async (items: JudgeItem[]) => ({ verdicts: items.map((item) => ({ id: item.alias, verdict: "supported" as const, reason: "" })) }),
  complete: async () => Promise.reject(new Error("the stand-in judge takes typed questions only")),
  embed: async () => [],
  rerank: async () => [],
  toMarkdown: async () => "",
};

/** The examples as an upload's rows: a job for each title and a fact for each line, none of them tagged before. */
function asSubjects(examples: readonly TagExample[]): TagSubjects {
  const subjects: TagSubjects = { roles: [], facts: [], total: { roles: 0, facts: 0 } };
  examples.forEach((example, index) => {
    if ("title" in example) subjects.roles.push({ id: `row-${index}`, title: example.title, held: [] });
    else {
      const { kind, text, quote } = example.fact;
      // As the vault works it out: only a skill can be an item of a list as the upload wrote it.
      subjects.facts.push({ id: `row-${index}`, roleId: null, kind, text, asWritten: kind === "skill" && skillAsWritten(quote, text), held: [] });
    }
  });
  subjects.total = { roles: subjects.roles.length, facts: subjects.facts.length };
  return subjects;
}

export async function runTagging(models: Models, examples: readonly TagExample[], judgeModel = "stand-in/judge"): Promise<TaggingRun> {
  const taxonomy = new Taxonomy(new MemoryStore(TAXONOMY_FIXTURE));
  const made = { model: judgeModel, taxonomyVersion: TAXONOMY_FIXTURE.info.version };
  const tagging = async (asked: Models) => {
    const tags: ProposedTag[] = [];
    const report = await tagUpload(
      asked,
      taxonomy,
      asSubjects(examples),
      made,
      async (proposed) => {
        tags.push(...proposed);
        return { stored: proposed.length, refused: 0 };
      },
      // The examples are made up, and no owner marks any of them.
      async () => [],
    );
    return { report, tags };
  };
  const candidates = await tagging(agreeing);
  const run = await tagging(models);
  const key = (index: number, concept: string) => `row-${index} ${concept}`;
  const found = new Map(candidates.tags.map((tag) => [`${tag.subject.id} ${tag.conceptId}`, tag]));
  const tagged = new Map(run.tags.map((tag) => [`${tag.subject.id} ${tag.conceptId}`, tag]));
  const outcomes: TagOutcome[] = [];
  examples.forEach((example, index) => {
    const prefix = `row-${index} `;
    const concepts = new Set([...example.candidates.map((candidate) => candidate.concept), ...[...found.keys()].filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length))]);
    for (const concept of concepts) {
      const listed = example.candidates.find((candidate) => candidate.concept === concept) ?? null;
      outcomes.push({
        subject: "title" in example ? example.title : example.fact.text,
        concept,
        label: (tagged.get(key(index, concept)) ?? found.get(key(index, concept)))?.label ?? null,
        listed,
        expected: listed?.expect !== "tag" || listed.decidedBy === "check" ? null : listed.decidedBy === "rule" ? TAG_RULE_METHOD : TAG_JUDGE_METHOD,
        found: found.has(key(index, concept)),
        tagged: tagged.get(key(index, concept))?.method ?? null,
      });
    }
  });
  return { report: run.report, left: candidates.report.left, outcomes };
}

/** For each method: how many tags it proposed, how many of them a careful reader expects, and the share. */
export function precision(outcomes: readonly TagOutcome[]): Record<TagMethod, { tagged: number; right: number; precision: number | null }> {
  const of = (method: TagMethod) => {
    const tagged = outcomes.filter((outcome) => outcome.tagged === method);
    const right = tagged.filter((outcome) => outcome.listed?.expect === "tag").length;
    return { tagged: tagged.length, right, precision: tagged.length ? right / tagged.length : null };
  };
  return { [TAG_RULE_METHOD]: of(TAG_RULE_METHOD), [TAG_JUDGE_METHOD]: of(TAG_JUDGE_METHOD) };
}
