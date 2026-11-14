import { describe, expect, it, vi } from "vitest";
import type { Models } from "../../src/ai/models";
import type { JudgeItem } from "../../src/ai/prompts";
import { tagUpload, TAG_PART_JUDGE_METHOD, MAX_TAG_QUESTIONS, MAX_TAG_FACTS, TAG_RUN_DEADLINE_MS, type TagSubjects, type ProposedTag, type TagOptions } from "../../src/pipeline/tag";
import { MAX_REQUIREMENT_ROWS, tagRequirements } from "../../src/pipeline/requirement-tags";
import { MemoryStore, Taxonomy } from "../../src/taxonomy";
import { TAXONOMY_FIXTURE } from "../support/taxonomy-fixture";
const made = { model: "test/judge", taxonomyVersion: TAXONOMY_FIXTURE.info.version };
const taxonomy = () => new Taxonomy(new MemoryStore(TAXONOMY_FIXTURE));
function model(answer: (item: JudgeItem) => boolean = () => true) {
  const calls: JudgeItem[][] = [];
  const judge = vi.fn(async (items: JudgeItem[]) => {
    calls.push(items); return { verdicts: items.map((item) => ({ id: item.alias, verdict: answer(item) ? "supported" as const : "unsupported" as const, reason: "" })) };
  });
  return { calls, models: { judge, complete: vi.fn(async () => { throw new Error("unexpected chat call"); }), embed: async () => [], rerank: async () => [], toMarkdown: async () => "" } as Models };
}
const part = (id: string, text = "Used Python", kind: "clause" | "result" | "mention" = "clause"): NonNullable<TagSubjects["parts"]>[number] => ({
  id, text, roleId: null, kind: "accomplishment", asWritten: false, held: [],
  part: { factId: `parent-${id}`, revision: 3, splitId: `split-${id}`, line: `${text} and completed project ${id}`, kind },
});
async function run(parts: NonNullable<TagSubjects["parts"]>, options: TagOptions = {}, supplied = model(), facts: TagSubjects["facts"] = []) {
  const tags: ProposedTag[] = [];
  const marked = vi.fn(async (_ids: string[]) => [] as string[]);
  const report = await tagUpload(supplied.models, taxonomy(), { roles: [], facts, parts, total: { roles: 0, facts: facts.length, parts: parts.length } }, made,
    async (found) => { tags.push(...found); return { stored: found.length, refused: 0 }; }, marked, options);
  return { report, tags, marked, ...supplied };
}
describe("tagging verified parts within the upload's existing bounds", () => {
  it("tags clauses/results with their parent guards and never standalone mentions", async () => {
    const rows = [part("claim"), part("result", "Used Kubernetes", "result"), part("mention", "Python", "mention")];
    const { tags, calls, report, marked } = await run(rows);
    expect(report.parts).toBe(2); expect(report.byRule).toBe(0);
    expect(tags.length).toBeGreaterThan(0); expect(tags.every((tag) => tag.subject.kind === "part" && tag.method === TAG_PART_JUDGE_METHOD)).toBe(true);
    expect(tags.some((tag) => tag.subject.id === "mention")).toBe(false);
    expect(tags.find((tag) => tag.subject.id === "claim")!.parent).toEqual(rows[0]!.part);
    expect(marked.mock.calls.flatMap(([ids]) => ids)).toContain("parent-claim");
    expect(calls.flat().flatMap((item) => item.facts).every((fact) => !fact.text.includes("completed project"))).toBe(true);
  });
  it("cannot borrow a sibling clause's tool as evidence for a vector candidate", async () => {
    const row = part("runbooks", "Wrote the runbooks"); row.part!.line = "Wrote the runbooks and deployed Python services";
    const judge = model((item) => item.facts.some((fact) => fact.text.includes("Python")));
    const result = await run([row], { vectors: async () => ({ vectors: {
      queries: async (texts) => texts.map(() => [1, 0]), nearest: async () => [{ id: "onet:tool:python", kind: "tool", label: "Python", score: 0.9 }],
    } }) }, judge);
    expect(result.calls.flat()).toHaveLength(1);
    expect(result.calls[0]![0]!.facts).toEqual([{ text: "Wrote the runbooks", quote: null }]);
    expect(result.tags).toEqual([]); expect(result.report.vector.asked).toBe(1);
  });
  it("shares the whole upload's subject and question caps with parts", async () => {
    const first = await run([part("first"), part("second")], {}, model(), Array.from({ length: MAX_TAG_FACTS - 1 }, (_, i) => ({ id: `f${i}`, roleId: null, kind: "accomplishment", text: "Maintained systems", asWritten: false, held: [] })));
    expect(first.report.facts).toBe(MAX_TAG_FACTS - 1); expect(first.report.parts).toBe(1); expect(first.report.left.subjects).toBe(1);
    const many = await run(Array.from({ length: 80 }, (_, i) => part(String(i))));
    expect(many.report.asked).toBe(MAX_TAG_QUESTIONS); expect(many.report.left.per_upload).toBeGreaterThan(0);
    expect(many.tags.length).toBeLessThanOrEqual(MAX_TAG_QUESTIONS);
  });
  it("stops late judge answers and shares one deadline rather than restarting it per part", async () => {
    let now = 0; const judge = model(() => { now = TAG_RUN_DEADLINE_MS + 1; return true; });
    const result = await run([part("first"), part("second")], { now: () => now }, judge);
    expect(judge.calls).toHaveLength(1); expect(result.tags).toEqual([]); expect(result.report.failed).toBe("timeout");
  });
});
describe("job requirement concept snapshots", () => {
  it("preserves every exact id/text/order and asks about the posting, never applicant experience", async () => {
    const judge = model(); const inputs = [{ id: "same", text: "Python required" }, { id: "same", text: "Kubernetes preferred" }];
    const result = await tagRequirements(judge.models, taxonomy(), inputs, made);
    expect(result.requirements.map(({ id, text }) => ({ id, text }))).toEqual(inputs);
    expect(result.requirements.every((row) => row.status === "tagged" && row.concepts.length)).toBe(true);
    expect(result.report.byRule).toBe(0); expect(result.report.requirements).toBe(2); expect(result.report.facts).toBe(0);
    for (const item of judge.calls.flat()) {
      expect(item.text).toMatch(/^The job posting asks the applicant to demonstrate:/);
      expect(item.facts[0]!.text).toMatch(/^Job requirement, not an applicant's experience:/);
    }
    expect(result.requirements.flatMap((row) => row.concepts).every((concept) => concept.method === "requirement-judge/1")).toBe(true);
    expect(result.model).toBe(made.model); expect(result.taxonomyVersion).toBe(made.taxonomyVersion);
  });
  it("keeps declines, no candidates and capped rows unknown rather than inventing a requirement or experience", async () => {
    const judge = model(() => false);
    const result = await tagRequirements(judge.models, taxonomy(), [{ id: "decline", text: "No Python experience is required" }, { id: "none", text: "Something unnamed" }], made);
    expect(result.requirements).toMatchObject([{ id: "decline", status: "unknown", concepts: [], unknownReason: "declined" }, { id: "none", status: "unknown", concepts: [], unknownReason: "no_candidate" }]);
    const capped = await tagRequirements(model().models, taxonomy(), Array.from({ length: MAX_REQUIREMENT_ROWS + 1 }, (_, i) => ({ id: String(i), text: "SQL" })), made);
    expect(capped.requirements).toHaveLength(MAX_REQUIREMENT_ROWS + 1);
    expect(capped.requirements.at(-1)).toMatchObject({ status: "unknown", concepts: [], unknownReason: "capped" });
    expect(capped.report.asked).toBeLessThanOrEqual(MAX_TAG_QUESTIONS);
  });
  it("never accepts unknown or duplicated reply ids as new concepts", async () => {
    const judge = model(); judge.models.judge = async (items) => ({ verdicts: [...items.flatMap((item) => [{ id: item.alias, verdict: "supported" as const, reason: "" }, { id: item.alias, verdict: "supported" as const, reason: "" }]), { id: "invented", verdict: "supported", reason: "invented concept" }] });
    const result = await tagRequirements(judge.models, taxonomy(), [{ id: "r1", text: "Python required" }], made);
    expect(result.requirements[0]).toMatchObject({ status: "unknown", concepts: [], unknownReason: "declined" });
  });
});
