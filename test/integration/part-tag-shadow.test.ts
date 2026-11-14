import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels, type Models } from "../../src/ai/models";
import type { FactView } from "../../src/shared/api";
import { TAG_PART_JUDGE_METHOD, MAX_TAG_FACTS, type ProposedTag, type TagSubjects } from "../../src/pipeline/tag";
import type { RecordExport, Stamp } from "../../src/shared/record";
import { vault } from "../../src/shared/stubs";
import { RecordStore } from "../../src/vault/record";
import { fromBase64url } from "../../src/worker/crypto";
import { TAXONOMY_FIXTURE, TAXONOMY_FIXTURE_SQL } from "../support/taxonomy-fixture";
import { RESUME, fakeModels, signIn, waitForSource, type User } from "./support";
const LINE = "Led the migration of 40 services to Kubernetes, cutting deploy time by 60%";
const KUBERNETES = "onet:tool:kubernetes";
const settings = env as unknown as { SPLIT_SHADOW_ENABLED?: string; TAG_SHADOW_ENABLED?: string; TAXONOMY?: D1Database };
const configured = { split: settings.SPLIT_SHADOW_ENABLED, tag: settings.TAG_SHADOW_ENABLED, taxonomy: settings.TAXONOMY! };
const made = { model: "test/judge", taxonomyVersion: TAXONOMY_FIXTURE.info.version };
const splitStamp: Stamp = { proposedBy: "model", model: "test/split", method: "split/3", taxonomyVersion: null, confidence: null, shadow: true };
beforeEach(async () => {
  for (const table of ["taxonomy_meta", "concepts", "labels", "relations"]) await configured.taxonomy.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  for (const statement of TAXONOMY_FIXTURE_SQL) await configured.taxonomy.prepare(statement).run();
});
afterEach(() => { setModels(null); settings.SPLIT_SHADOW_ENABLED = configured.split; settings.TAG_SHADOW_ENABLED = configured.tag; settings.TAXONOMY = configured.taxonomy; });
function vaultOf(user: User) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  return vault(env, (JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { vid: string }).vid);
}
function divided(record: RecordStore, factId: string) {
  return record.proposeSplit({ factId, line: LINE, parts: [
    { kind: "clause", ranges: [[0, LINE.indexOf(",")]] },
    { kind: "result", ranges: [[LINE.indexOf("cutting"), LINE.length]], resultOf: 0 },
    { kind: "mention", ranges: [[LINE.indexOf("Kubernetes"), LINE.indexOf("Kubernetes") + "Kubernetes".length]] },
  ], stamp: splitStamp });
}
async function throughUpload(during: (user: User) => Promise<void> = async () => {}) {
  settings.SPLIT_SHADOW_ENABLED = "true"; settings.TAG_SHADOW_ENABLED = "true";
  const user = await signIn(); const base = fakeModels(); let marked = false;
  const asked: { text: string; facts: { text: string; quote: string | null }[] }[] = [];
  const models: Models = { ...base, async complete(route, messages, schema, options) {
    const content = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
    if (route === "extract" && content.startsWith("{")) {
      const { lines } = JSON.parse(content) as { lines: { id: string; text: string }[] };
      return schema.parse({ lines: lines.map((line) => ({ id: line.id, parts: line.text === LINE ? [
        { kind: "clause", words: [{ from: 0, to: 7 }], of: null }, { kind: "result", words: [{ from: 8, to: 12 }], of: 0 },
        { kind: "mention", words: [{ from: 7, to: 7 }], of: null },
      ] : [] })) });
    }
    if (route === "judge") {
      const { lines } = JSON.parse(content) as { lines: { text: string; facts: { text: string; quote: string | null }[] }[] };
      const parts = lines.filter((line) => line.text.includes("as demonstrated by this standalone part"));
      asked.push(...parts);
      if (parts.length && !marked) { marked = true; await during(user); }
    }
    return base.complete(route, messages, schema, options);
  } };
  setModels(() => models);
  const uploaded = await user.upload("resume.pdf", RESUME); expect(uploaded.status).toBe(201);
  const sourceId = (await uploaded.json() as { sourceId: string }).sourceId;
  expect(await waitForSource(user, sourceId)).toMatchObject({ state: "ready", error: null });
  const facts = (await user.json<{ facts: FactView[] }>("/api/facts")).facts;
  const held = await runInDurableObject(vaultOf(user), (_instance, state) => new RecordStore(state.storage.sql, (fn) => state.storage.transactionSync(fn)).export());
  return { user, facts, held, asked };
}
describe("tagging parts through the actual upload workflow", () => {
  it("keeps verified clause tags in shadow with no mention tags or changed source lines", async () => {
    const { user, facts, held, asked } = await throughUpload();
    const fact = facts.find((fact) => fact.text === LINE)!;
    const split = held.factSplits.find((split) => split.factId === fact.id)!;
    const clause = split.parts.find((part) => part.kind === "clause")!;
    const partTags = held.conceptTags.filter((tag) => tag.subject.kind === "part");
    expect(partTags).toHaveLength(2);
    expect(partTags.every((tag) => tag.subject.id === clause.id && tag.shadow && tag.state === "proposed" && tag.method === TAG_PART_JUDGE_METHOD)).toBe(true);
    expect(asked.every((item) => item.facts.length === 1 && item.facts[0]!.text === clause.text && item.facts[0]!.quote === null)).toBe(true);
    expect(facts).toHaveLength(8); expect(fact.quote).toBe(`- ${LINE}`); expect(fact.state).toBe("proposed");
    const exported = await user.json<RecordExport>("/api/export");
    expect(exported.conceptTags.filter((tag) => tag.subject.kind === "part")).toEqual(partTags);
  });
  it("inherits a parent's privacy mark that lands while the part judge is running", async () => {
    const { held, asked } = await throughUpload(async (user) => {
      const fact = (await user.json<{ facts: FactView[] }>("/api/facts")).facts.find((fact) => fact.text === LINE)!;
      expect((await user.send("POST", "/api/facts/sensitive", { ids: [fact.id], sensitive: true })).status).toBe(204);
    });
    expect(asked.length).toBeGreaterThan(0); expect(held.conceptTags.filter((tag) => tag.subject.kind === "part")).toEqual([]);
  });
});

async function open() {
  const stub = vault(env, env.VAULT.newUniqueId().toString()); await stub.init(`part-owner-${crypto.randomUUID()}`);
  const source = crypto.randomUUID(); const run = crypto.randomUUID();
  await runInDurableObject(stub, async (instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`INSERT INTO sources (id, filename, r2_key, markdown, state, run_id, created_at) VALUES (?, 'resume.pdf', ?, ?, 'queued', ?, 1)`, source, `sources/${source}`, LINE, run);
    const inner = instance as unknown as { runs: { begin(run: Record<string, unknown>, write: () => void): void } };
    inner.runs.begin({ id: run, kind: "distill", targetId: source, requestKey: run, inputDigest: run, steps: ["convert", "extract", "embed"] }, () => {});
    await instance.claimRun(run, { kind: "distill", targetId: source });
    sql.exec(`INSERT INTO evidence (id, source_id, quote) VALUES ('evidence', ?, ?)`, source, LINE);
    sql.exec(`INSERT INTO facts (id, role_id, kind, text, evidence_id, source_id, origin, state, updated_at) VALUES ('parent', NULL, 'accomplishment', ?, 'evidence', ?, 'extracted', 'proposed', 1)`, LINE, source);
    divided(new RecordStore(sql, (fn) => state.storage.transactionSync(fn)), "parent");
  });
  const inside = <T>(work: (record: RecordStore, sql: SqlStorage) => T) => runInDurableObject(stub, (_instance, state) => work(new RecordStore(state.storage.sql, (fn) => state.storage.transactionSync(fn)), state.storage.sql));
  const candidates = () => runInDurableObject(stub, (instance) => instance.tagCandidates(source, run));
  const keep = (tags: ProposedTag[]) => runInDurableObject(stub, (instance) => instance.saveShadowTags(source, run, made, tags));
  return { source, run, stub, inside, candidates, keep };
}
function proposed(subjects: TagSubjects): ProposedTag {
  const part = subjects.parts!.find((part) => part.part!.kind === "clause")!;
  return { subject: { kind: "part", id: part.id }, parent: part.part, words: part.text, conceptId: KUBERNETES, conceptKind: "tool", label: "Kubernetes", method: TAG_PART_JUDGE_METHOD };
}
describe("the vault's part-tag source and parent guards", () => {
  it("rejects stale parent revisions and replaced splits, but accepts the current guarded part", async () => {
    const { inside, candidates, keep } = await open(); const original = proposed(await candidates());
    await inside((_record, sql) => sql.exec(`UPDATE facts SET revision = revision + 1 WHERE id = 'parent'`));
    expect(await keep([original])).toEqual({ stored: 0, refused: 1 });
    const current = proposed(await candidates()); expect(await keep([current])).toEqual({ stored: 1, refused: 0 });
    await inside((record) => record.proposeSplit({ factId: "parent", line: LINE, parts: [{ kind: "clause", ranges: [[0, LINE.length]] }], stamp: splitStamp }));
    expect(await keep([current])).toEqual({ stored: 0, refused: 1 });
    expect(await inside((record) => record.export().conceptTags)).toEqual([]);
  });
  it("never returns private parts or stores a part tag after its parent becomes private", async () => {
    const { inside, candidates, keep } = await open(); const tag = proposed(await candidates());
    await inside((_record, sql) => sql.exec(`UPDATE facts SET sensitive = 1 WHERE id = 'parent'`));
    const rows = await candidates(); expect(rows.parts ?? []).toEqual([]); expect(rows.facts).toEqual([]);
    expect(await keep([tag])).toEqual({ stored: 0, refused: 1 });
  });
  it("refuses an old reading after a newer upload run takes over", async () => {
    const { source, inside, candidates, keep } = await open(); const tag = proposed(await candidates());
    await inside((_record, sql) => sql.exec(`UPDATE sources SET run_id = 'new-reading' WHERE id = ?`, source));
    await expect(candidates()).rejects.toThrow();
    await expect(keep([tag])).rejects.toThrow();
    expect(await inside((record) => record.export().conceptTags)).toEqual([]);
  });
  it("excludes mentions and refuses a valid-looking part from another upload", async () => {
    const { inside, candidates, keep } = await open(); const tag = proposed(await candidates());
    const mention = await inside((record) => record.split("parent", { shadow: true })!.parts.find((part) => part.kind === "mention")!);
    expect(await keep([{ ...tag, subject: { kind: "part", id: mention.id }, words: mention.text, parent: { ...tag.parent!, kind: "mention" } }])).toEqual({ stored: 0, refused: 1 });
    const foreign = await inside((record, sql) => {
      sql.exec(`INSERT INTO sources (id, filename, r2_key, markdown, state, created_at) VALUES ('other', 'other.pdf', 'other', ?, 'ready', 1)`, LINE);
      sql.exec(`INSERT INTO facts (id, role_id, kind, text, source_id, origin, state, updated_at) VALUES ('foreign', NULL, 'accomplishment', ?, 'other', 'extracted', 'proposed', 1)`, LINE);
      const split = divided(record, "foreign"); const part = record.split("foreign", { shadow: true })!.parts.find((part) => part.kind === "clause")!;
      return { ...tag, subject: { kind: "part" as const, id: part.id }, parent: { factId: "foreign", revision: 1, line: LINE, kind: "clause" as const, splitId: split.splitId } };
    });
    expect(await keep([foreign])).toEqual({ stored: 0, refused: 1 });
    expect(await inside((record) => record.export().conceptTags)).toEqual([]);
  });
  it("counts parts inside the existing 120-row upload cap instead of opening another budget", async () => {
    const { source, inside, candidates } = await open();
    await inside((_record, sql) => {
      for (let i = 1; i < MAX_TAG_FACTS; i++) sql.exec(`INSERT INTO facts (id, role_id, kind, text, source_id, origin, state, updated_at) VALUES (?, NULL, 'accomplishment', 'Maintained systems', ?, 'extracted', 'proposed', 1)`, `fact-${i}`, source);
    });
    const rows = await candidates(); expect(rows.facts).toHaveLength(MAX_TAG_FACTS); expect(rows.parts).toEqual([]); expect(rows.total.parts).toBe(2);
  });
});
