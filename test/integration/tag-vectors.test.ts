import { introspectWorkflow, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModels, type Models } from "../../src/ai/models";
import { TAG_JUDGE_METHOD, TAG_RULE_METHOD, TAG_VECTOR_METHOD, emptyTagReport, type ProposedTag, type TagMade, type TagReport } from "../../src/pipeline/tag";
import { AppError } from "../../src/shared/errors";
import type { FactView, RoleView } from "../../src/shared/api";
import type { ConceptTag } from "../../src/shared/record";
import { vault } from "../../src/shared/stubs";
import { MANIFEST_ID, manifestValues, type VectorIndex } from "../../src/taxonomy";
import { RecordStore } from "../../src/vault/record";
import { fromBase64url } from "../../src/worker/crypto";
import { fixtureIndex } from "../evals/tagging";
import { standInEmbed, type MemoryVectorIndex } from "../support/fake-vectorize";
import { TAXONOMY_FIXTURE, TAXONOMY_FIXTURE_SQL } from "../support/taxonomy-fixture";
import { EXTRACTION, RESUME, fakeModels, signIn, waitForSource, type User } from "./support";

// Vector candidates while an upload is read: concepts near a line in meaning, from the taxonomy's
// vector index, put to the judge after every word-for-word question. The taxonomy is the made-up
// one in the local D1 database; the index is one in memory, built from it with a stand-in
// embedding (test/support/fake-vectorize.ts), and bound for each test as TAXONOMY_VECTORS.

const S = (n: number) => `esco:skill:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BUDGETS_ACTIVITY = "onet:activity:4.A.4.c.3.I01";
const VERSION = TAXONOMY_FIXTURE.info.version;

/** A line said in other words: no label stands in it. And one that names a concept a vector lookup finds too. */
const SPENT = "Oversaw spending for three departments";
const BOTH = "Budget management: managed budgets for three departments";
const CONTENT = RESUME.replace("- Mentored 2 junior engineers", `- Mentored 2 junior engineers\n- ${SPENT}\n- ${BOTH}`);
const EXTRA = {
  ...EXTRACTION,
  facts: [
    ...EXTRACTION.facts,
    { roleKey: "globex", kind: "accomplishment", text: SPENT, level: null, quote: SPENT },
    { roleKey: "globex", kind: "accomplishment", text: BOTH, level: null, quote: BOTH },
  ],
};

const settings = env as unknown as { TAG_SHADOW_ENABLED?: string; TAXONOMY?: D1Database; TAXONOMY_VECTORS?: VectorIndex };
const AS_CONFIGURED = { tag: settings.TAG_SHADOW_ENABLED, taxonomy: settings.TAXONOMY!, vectors: settings.TAXONOMY_VECTORS };

beforeEach(async () => {
  const db = AS_CONFIGURED.taxonomy;
  for (const table of ["taxonomy_meta", "concepts", "labels", "relations"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  for (const statement of TAXONOMY_FIXTURE_SQL) await db.prepare(statement).run();
});
afterEach(() => {
  setModels(null);
  settings.TAG_SHADOW_ENABLED = AS_CONFIGURED.tag;
  settings.TAXONOMY = AS_CONFIGURED.taxonomy;
  settings.TAXONOMY_VECTORS = AS_CONFIGURED.vectors;
  vi.restoreAllMocks();
});

type Asked = { id: string; text: string; facts: { text: string; quote: string | null }[] };

/**
 * The usual stand-in models reading the resume above, with a judge that says what it was asked
 * and a stand-in embedding for lookups that records what it was given. `during` runs while a judge
 * call is open; calls are counted from 0. `lookup` can replace the lookup's embedding.
 */
function standing(during: (call: number) => Promise<void> = async () => {}, lookup?: (texts: string[]) => Promise<number[][]>) {
  const asked: Asked[][] = [];
  const looked: string[][] = [];
  const base = fakeModels({ extraction: EXTRA });
  const models: Models = {
    ...base,
    async complete(route, messages, schema, opts) {
      if (route === "judge") {
        asked.push((JSON.parse(messages.filter((message) => message.role === "user").at(-1)!.content) as { lines: Asked[] }).lines);
        await during(asked.length - 1);
      }
      return base.complete(route, messages, schema, opts);
    },
    async embed(texts, opts) {
      if (opts?.purpose !== "concept-query") return base.embed(texts, opts);
      expect(opts.model).toBe("@cf/qwen/qwen3-embedding-0.6b");
      looked.push([...texts]);
      return (lookup ?? standInEmbed)(texts);
    },
  };
  return { asked, looked, models };
}

function sessionOf(user: User): { vid: string } {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  return JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { vid: string };
}
const vaultOf = (user: User) => vault(env, sessionOf(user).vid);
const tagsOf = (user: User): Promise<ConceptTag[]> =>
  runInDurableObject(vaultOf(user), (_instance, state) => new RecordStore(state.storage.sql, (fn) => state.storage.transactionSync(fn)).export().conceptTags);
const shown = async (user: User) => ({
  facts: (await user.json<{ facts: FactView[] }>("/api/facts")).facts,
  roles: (await user.json<{ roles: RoleView[] }>("/api/roles")).roles,
});

/** Reads the resume with these models, and gives back what the stage reported and every tag kept, by its words. */
async function reading(models: Models, prepare: (user: User) => void = () => {}) {
  const workflow = await introspectWorkflow(env.DISTILL);
  try {
    setModels(() => models);
    const user = await signIn();
    prepare(user);
    const response = await user.upload("jane-doe.pdf", CONTENT);
    expect(response.status, await response.clone().text()).toBe(201);
    const { sourceId } = (await response.json()) as { sourceId: string };
    expect(await waitForSource(user, sourceId)).toMatchObject({ state: "ready", error: null });
    const [instance] = await workflow.get();
    let report: TagReport | undefined;
    if (settings.TAG_SHADOW_ENABLED === "true") {
      const result = await instance!.waitForStepResult({ name: "tag" });
      report = JSON.parse(JSON.stringify(result)) as TagReport;
      const dispose = (Symbol as unknown as { dispose?: symbol }).dispose;
      if (dispose && result && typeof result === "object") (result as Record<symbol, (() => void) | undefined>)[dispose]?.();
    }
    const { facts, roles } = await shown(user);
    const words = new Map([...facts.map((fact) => [fact.id, fact.text] as const), ...roles.map((role) => [role.id, `Job title: ${role.title}`] as const)]);
    const tags = await tagsOf(user);
    return { user, report, tags, by: tags.map((tag) => [words.get(tag.subject.id), tag.conceptId, tag.method]), facts };
  } finally {
    await workflow.dispose();
  }
}

const vectorTags = (by: (string | undefined)[][]) => by.filter(([, , method]) => method === TAG_VECTOR_METHOD);

async function indexWith(manifest: Record<string, VectorizeVectorMetadata> = {}): Promise<MemoryVectorIndex> {
  const index = await fixtureIndex();
  if (Object.keys(manifest).length) {
    const metadata = { ...index.vectors.get(MANIFEST_ID)!.metadata, ...manifest };
    await index.upsert([{ id: MANIFEST_ID, values: manifestValues(), metadata }]);
  }
  return index;
}

describe("vector candidates while an upload is read", () => {
  beforeEach(() => {
    settings.TAG_SHADOW_ENABLED = "true";
  });

  it("embeds nothing and has no vector candidates where no index is bound", async () => {
    settings.TAXONOMY_VECTORS = undefined;
    const { looked, models } = standing();
    const { report, by } = await reading(models);
    expect(looked).toEqual([]);
    expect(vectorTags(by)).toEqual([]);
    // As today: the word-for-word part ran, and the vector part did not start.
    expect(report!.vector).toEqual(emptyTagReport().vector);
    expect(report!.stored).toBeGreaterThan(0);
  });

  it("has none with a manifest for another version, another model, or still building", async () => {
    const others: Record<string, VectorizeVectorMetadata>[] = [{ taxonomyVersion: "esco-0.0.1+onet-0.0+00000000" }, { model: "@cf/baai/bge-m3" }, { state: "building", completedAt: 0 }];
    for (const manifest of others) {
      const index = await indexWith(manifest);
      settings.TAXONOMY_VECTORS = index;
      const { looked, models } = standing();
      const { report, by } = await reading(models);
      expect(looked, JSON.stringify(manifest)).toEqual([]);
      expect(vectorTags(by), JSON.stringify(manifest)).toEqual([]);
      expect(report!.vector, JSON.stringify(manifest)).toEqual({ ...emptyTagReport().vector, skipped: "not_ready" });
      // Only the manifest was read: no lookup was made.
      expect(index.calls.filter((call) => call.name === "query")).toEqual([]);
    }
  });

  it("has no stage without the switch, even with both bindings", async () => {
    settings.TAG_SHADOW_ENABLED = AS_CONFIGURED.tag;
    const index = await indexWith();
    index.calls.length = 0;
    settings.TAXONOMY_VECTORS = index;
    const { asked, looked, models } = standing();
    const { tags } = await reading(models);
    expect(index.calls).toEqual([]);
    expect(looked).toEqual([]);
    expect(asked).toEqual([]);
    expect(tags).toEqual([]);
  });

  it("tags by vector-judge/1 in shadow and never duplicates a word-for-word candidate", async () => {
    settings.TAXONOMY_VECTORS = await indexWith();
    const { asked, looked, models } = standing();
    const { report, tags, by, facts } = await reading(models);
    // Each job title and each fact the rule did not tag is embedded once, after every word-for-word question.
    expect(looked).toHaveLength(2);
    expect(looked[0]).toEqual(["Senior Software Engineer", "Software Engineer"]);
    expect(looked[1]).toContain(SPENT);
    expect(looked[1]).toContain(BOTH);
    // The line said in other words is tagged with what it says, and the line that names a concept
    // is tagged with it by its words: the vector part adds only the concept it does not name.
    expect(vectorTags(by).sort()).toEqual(
      [
        [BOTH, BUDGETS_ACTIVITY, TAG_VECTOR_METHOD],
        [SPENT, BUDGETS_ACTIVITY, TAG_VECTOR_METHOD],
        [SPENT, S(1), TAG_VECTOR_METHOD],
      ].sort(),
    );
    expect(by.filter(([words]) => words === BOTH)).toEqual(expect.arrayContaining([[BOTH, S(1), TAG_JUDGE_METHOD]]));
    // One row, one tag for a concept: never one from the words and another from the index.
    const pairs = tags.map((tag) => `${tag.subject.id} ${tag.conceptId}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    // The vector questions came last, in the judge's own form, around the record's label.
    const last = asked.at(-1)!.map((line) => [line.text, line.facts[0]!.text]);
    expect(last).toEqual(expect.arrayContaining([["Did or can do: manage budgets", SPENT], ["Did this work: Manage budgets or finances.", SPENT], ["Did this work: Manage budgets or finances.", BOTH]]));
    for (const tag of tags.filter((found) => found.method === TAG_VECTOR_METHOD))
      expect(tag).toMatchObject({ shadow: true, state: "proposed", proposedBy: "model", model: env.MODEL_JUDGE, taxonomyVersion: VERSION, confidence: null });
    expect(tags.find((tag) => tag.conceptId === S(1) && tag.method === TAG_VECTOR_METHOD)).toMatchObject({ conceptKind: "skill", label: "manage budgets", relation: "shows" });
    // Nothing the app shows has changed.
    expect(JSON.stringify(facts)).not.toMatch(/esco:|onet:|vector-judge|conceptId/);
    // The Workflow's own state holds numbers and nothing else.
    expect(report!.vector).toEqual({ ...emptyTagReport().vector, subjects: report!.vector.subjects, candidates: 3, asked: 3, yes: 3 });
    expect(report!.stored).toBe(tags.length);
    const leaves = (value: unknown): unknown[] => (value !== null && typeof value === "object" ? Object.values(value).flatMap(leaves) : [value]);
    expect(new Set(leaves(report).map((leaf) => typeof leaf))).toEqual(new Set(["number"]));
    expect(tags.filter((tag) => tag.method === TAG_RULE_METHOD)).toEqual([]);
  });

  it("never embeds a marked line", async () => {
    settings.TAXONOMY_VECTORS = await indexWith();
    let user!: User;
    const { looked, models } = standing(async (call) => {
      if (call !== 0) return;
      // The stage has read the line, and asks the judge about the jobs. Its owner marks the line.
      const spent = (await user.json<{ facts: FactView[] }>("/api/facts")).facts.find((fact) => fact.text === SPENT)!;
      const marked = await user.send("POST", "/api/facts/sensitive", { ids: [spent.id], sensitive: true });
      expect(marked.status, await marked.clone().text()).toBe(204);
    });
    const { report, by } = await reading(models, (signedIn) => (user = signedIn));
    expect(looked.length).toBeGreaterThan(0);
    expect(JSON.stringify(looked)).not.toContain("Oversaw");
    expect(by.filter(([words]) => words === SPENT)).toEqual([]);
    expect(vectorTags(by)).toEqual([[BOTH, BUDGETS_ACTIVITY, TAG_VECTOR_METHOD]]);
    expect(report!.vector).toMatchObject({ withheld: 1, candidates: 1 });
  });

  it("finishes the upload with word-for-word tags when the index fails", async () => {
    // The same file read with no index at all.
    settings.TAXONOMY_VECTORS = undefined;
    const without = await reading(standing().models);
    const index = await indexWith();
    index.query = () => Promise.reject(new Error(`VECTOR_QUERY_ERROR: could not look up "${SPENT}"`));
    settings.TAXONOMY_VECTORS = index;
    const { looked, models } = standing();
    const { report, by } = await reading(models);
    expect(looked.length).toBeGreaterThan(0);
    expect(vectorTags(by)).toEqual([]);
    expect(by.map(([words, concept, method]) => `${words} ${concept} ${method}`).sort()).toEqual(without.by.map(([words, concept, method]) => `${words} ${concept} ${method}`).sort());
    const { vector, ...wordForWord } = report!;
    const { vector: _none, ...before } = without.report!;
    expect(wordForWord).toEqual(before);
    expect(vector.failed).toBe("error");
    expect(JSON.stringify(report)).not.toMatch(/Oversaw|VECTOR_QUERY/);
  });

  it("finishes when the embedding is refused for quota", async () => {
    settings.TAXONOMY_VECTORS = await indexWith();
    const { models } = standing(undefined, () => Promise.reject(new AppError("quota", "the configured model spend budget is exhausted")));
    const { report, by } = await reading(models);
    expect(vectorTags(by)).toEqual([]);
    expect(by.length).toBeGreaterThan(0);
    expect(report!.failed).toBeUndefined();
    expect(report!.vector).toEqual({ ...emptyTagReport().vector, failed: "quota" });
  });
});

describe("a vault keeping vector tags", () => {
  const made: TagMade = { model: "test/judge", taxonomyVersion: VERSION };

  it("a vault never restamps a word-for-word tag with a vector stamp", async () => {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    await stub.init(`vector-owner-${crypto.randomUUID()}`);
    const sourceId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO sources (id, filename, r2_key, markdown, state, run_id, created_at) VALUES (?, 'resume.pdf', ?, 'text', 'queued', ?, 1)`, sourceId, `sources/${sourceId}`, runId);
      const inner = instance as unknown as { runs: { begin(run: Record<string, unknown>, write: () => void): void } };
      inner.runs.begin({ id: runId, kind: "distill", targetId: sourceId, requestKey: runId, inputDigest: runId, steps: ["convert", "extract", "embed"] }, () => {});
      await instance.claimRun(runId, { kind: "distill", targetId: sourceId });
      sql.exec(`INSERT INTO evidence (id, source_id, quote) VALUES ('quote-line', ?, ?)`, sourceId, BOTH);
      sql.exec(`INSERT INTO facts (id, role_id, kind, text, evidence_id, source_id, origin, state, updated_at) VALUES ('line', NULL, 'accomplishment', ?, 'quote-line', ?, 'extracted', 'proposed', 1)`, BOTH, sourceId);
    });
    const keep = (tags: ProposedTag[]) => runInDurableObject(stub, (instance) => instance.saveShadowTags(sourceId, runId, made, tags));
    const conceptTags = () => runInDurableObject(stub, (_instance, state) => new RecordStore(state.storage.sql, (fn) => state.storage.transactionSync(fn)).export().conceptTags);
    const about = (conceptId: string, method: ProposedTag["method"], label = "manage budgets", conceptKind: ProposedTag["conceptKind"] = "skill"): ProposedTag => ({ subject: { kind: "fact", id: "line" }, words: BOTH, conceptId, conceptKind, label, method });

    expect(await keep([about(S(1), TAG_JUDGE_METHOD)])).toEqual({ stored: 1, refused: 0 });
    const before = await conceptTags();
    // The same concept from the index: neither stored nor refused, and the word-for-word row is as it was.
    expect(await keep([about(S(1), TAG_VECTOR_METHOD)])).toEqual({ stored: 0, refused: 0 });
    expect(await conceptTags()).toEqual(before);
    expect(before).toEqual([expect.objectContaining({ conceptId: S(1), method: TAG_JUDGE_METHOD })]);
    // Another concept from the index is kept, with its own stamp.
    expect(await keep([about(BUDGETS_ACTIVITY, TAG_VECTOR_METHOD, "Manage budgets or finances.", "activity")])).toEqual({ stored: 1, refused: 0 });
    expect((await conceptTags()).find((tag) => tag.conceptId === BUDGETS_ACTIVITY)).toMatchObject({ method: TAG_VECTOR_METHOD, proposedBy: "model", model: "test/judge", shadow: true });
    // A method the vault does not know is refused whole.
    await expect(keep([about(S(2), "vector-judge/2" as ProposedTag["method"])])).rejects.toThrow("unknown tagging method");
  });
});
