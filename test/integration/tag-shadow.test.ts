import { introspectWorkflow, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModels, type Models } from "../../src/ai/models";
import { MAX_TAGS_PER_SAVE, MAX_TAG_FACTS, MAX_TAG_ROLES, TAG_JUDGE_METHOD, TAG_RULE_METHOD, emptyTagReport, tagStamp, type ProposedTag, type TagMade } from "../../src/pipeline/tag";
import type { FactView, RoleView } from "../../src/shared/api";
import { TRANSFER_TABLES, type TransferPage } from "../../src/shared/operations";
import { vaultPrefix } from "../../src/shared/r2";
import { MAX_TAGS_PER_SUBJECT, type ConceptTag, type RecordExport, type Stamp } from "../../src/shared/record";
import type { ShareGrant } from "../../src/shared/sharing";
import { directory, vault } from "../../src/shared/stubs";
import { D1Store, Taxonomy } from "../../src/taxonomy";
import { OPERATION_MIGRATIONS, VaultOperations } from "../../src/vault/operations";
import { RecordStore } from "../../src/vault/record";
import { SCHEMA_VERSION, createSchema, hasSchema } from "../../src/vault/schema";
import { Vault } from "../../src/vault/vault";
import { fromBase64url } from "../../src/worker/crypto";
import { TAXONOMY_FIXTURE, TAXONOMY_FIXTURE_SQL } from "../support/taxonomy-fixture";
import { EXTRACTION, RESUME, call, cookieFrom, eventually, fakeModels, signIn, waitForSource, type FakeModelOptions, type User } from "./support";

// Tagging facts and job roles while an upload is read: off unless switched on, inert without a
// loaded taxonomy, and in shadow when it runs. The taxonomy is the made-up one, loaded into the
// local D1 database before each test. Each test file has a database of its own.

const S = (n: number) => `esco:skill:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const O = (n: number) => `esco:occupation:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DEV = "onet:occ:99-1001.00";
const KUBERNETES = "onet:tool:kubernetes";
const GO = "onet:tool:go";
const VERSION = TAXONOMY_FIXTURE.info.version;

const LED = "Led the migration of 40 services to Kubernetes, cutting deploy time by 60%";
const BUILT = "Built a Go service that processes 2 million events per day";
const SKILLS = "Go, SQL, Kubernetes, C++";
/** The usual resume with another skills line, and what a reading model gives for it. */
const resume = (skills: string) => RESUME.replace("Go, TypeScript, Kubernetes, PostgreSQL", skills);
const extraction = (skills: string, texts: string[]) => ({
  ...EXTRACTION,
  facts: [...EXTRACTION.facts.filter((fact) => fact.kind !== "skill"), ...texts.map((text) => ({ roleKey: null, kind: "skill", text, level: null, quote: skills }))],
});

const settings = env as unknown as { TAG_SHADOW_ENABLED?: string; TAXONOMY?: D1Database };
const AS_CONFIGURED = { tag: settings.TAG_SHADOW_ENABLED, taxonomy: settings.TAXONOMY! };

const TABLES = ["taxonomy_meta", "concepts", "labels", "relations"] as const;
/** Empties the taxonomy's database, then runs these statements of a load in order. */
async function load(statements: readonly string[] = TAXONOMY_FIXTURE_SQL): Promise<void> {
  const db = AS_CONFIGURED.taxonomy;
  for (const table of TABLES) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  for (const statement of statements) await db.prepare(statement).run();
}

beforeEach(() => load());
afterEach(() => {
  setModels(null);
  settings.TAG_SHADOW_ENABLED = AS_CONFIGURED.tag;
  settings.TAXONOMY = AS_CONFIGURED.taxonomy;
  vi.restoreAllMocks();
});

type Asked = { id: string; text: string; facts: { text: string; quote: string | null }[] };

/**
 * The usual stand-in models, reading the resume above, with a judge that says what it was asked.
 * `during` runs while a judge call is open: after the stage has read its rows and before it
 * stores that call's answers. Calls are counted from 0.
 */
function judging(options: FakeModelOptions = {}, during: (call: number) => Promise<void> = async () => {}) {
  const asked: Asked[][] = [];
  const base = fakeModels({ extraction: extraction(SKILLS, ["Go", "SQL", "Kubernetes", "C++"]), ...options });
  const models: Models = {
    ...base,
    async complete(route, messages, schema, opts) {
      if (route === "judge") {
        asked.push((JSON.parse(messages.filter((message) => message.role === "user").at(-1)!.content) as { lines: Asked[] }).lines);
        await during(asked.length - 1);
      }
      return base.complete(route, messages, schema, opts);
    },
  };
  return { asked, models };
}
const said = (asked: Asked[][]) => asked.map((lines) => lines.map((line) => [line.text, line.facts[0]!.text]));

const ABOUT_ROLES = [
  ["Worked in the occupation: software developer (also called software engineer)", "Job title: Senior Software Engineer"],
  ["Worked in the occupation: Example Software Developers (also called Software Engineer)", "Job title: Senior Software Engineer"],
  ["Worked in the occupation: software developer (also called software engineer)", "Job title: Software Engineer"],
  ["Worked in the occupation: Example Software Developers (also called Software Engineer)", "Job title: Software Engineer"],
];
const ABOUT_FACTS = [
  ["Used the software: Kubernetes", LED],
  ["Knows: container orchestration (also called Kubernetes)", LED],
  ["Used the software: Go", BUILT],
  ["Knows: Go (computer programming) (also called Go)", BUILT],
  ["Used the software: Go", "Skill: Go"],
  ["Knows: Go (computer programming) (also called Go)", "Skill: Go"],
  ["Used the software: Kubernetes", "Skill: Kubernetes"],
  ["Knows: container orchestration (also called Kubernetes)", "Skill: Kubernetes"],
];
/** Every tag a reading of the resume makes: what it is on, its concept, what made it, and how it relates. */
const RULE_TAGS = [
  ["Skill: SQL", S(8), TAG_RULE_METHOD, "shows"],
  ["Skill: C++", "onet:tool:c++", TAG_RULE_METHOD, "uses"],
];
const ROLE_TAGS = [
  ["Job title: Senior Software Engineer", O(1), TAG_JUDGE_METHOD, "occupation"],
  ["Job title: Senior Software Engineer", DEV, TAG_JUDGE_METHOD, "occupation"],
  ["Job title: Software Engineer", O(1), TAG_JUDGE_METHOD, "occupation"],
  ["Job title: Software Engineer", DEV, TAG_JUDGE_METHOD, "occupation"],
];
const LED_TAGS = [
  [LED, KUBERNETES, TAG_JUDGE_METHOD, "uses"],
  [LED, S(4), TAG_JUDGE_METHOD, "shows"],
];
const GO_TAGS = [
  [BUILT, GO, TAG_JUDGE_METHOD, "uses"],
  [BUILT, S(6), TAG_JUDGE_METHOD, "shows"],
  ["Skill: Go", GO, TAG_JUDGE_METHOD, "uses"],
  ["Skill: Go", S(6), TAG_JUDGE_METHOD, "shows"],
];
const KUBERNETES_SKILL_TAGS = [
  ["Skill: Kubernetes", KUBERNETES, TAG_JUDGE_METHOD, "uses"],
  ["Skill: Kubernetes", S(4), TAG_JUDGE_METHOD, "shows"],
];
const ALL_TAGS = [...RULE_TAGS, ...ROLE_TAGS, ...LED_TAGS, ...GO_TAGS, ...KUBERNETES_SKILL_TAGS];
const sorted = <T>(rows: T[]): T[] => [...rows].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
/** What a reading of the resume reports when every question is answered yes. */
const WHOLE = { ...emptyTagReport(), roles: 2, facts: 9, candidates: 14, byRule: 2, asked: 12, yes: 12, stored: 14 };

function sessionOf(user: User): { vid: string } {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  return JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { vid: string };
}
const vaultOf = (user: User) => vault(env, sessionOf(user).vid);

async function upload(user: User, filename = "jane-doe.pdf", content = resume(SKILLS)): Promise<string> {
  const response = await user.upload(filename, content);
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { sourceId: string }).sourceId;
}

/** Uploads the resume and waits until it has been read. */
async function read(user: User, filename?: string, content?: string): Promise<string> {
  const sourceId = await upload(user, filename, content);
  expect(await waitForSource(user, sourceId)).toMatchObject({ state: "ready", error: null });
  return sourceId;
}

const shown = async (user: User) => ({
  facts: (await user.json<{ facts: FactView[] }>("/api/facts")).facts,
  roles: (await user.json<{ roles: RoleView[] }>("/api/roles")).roles,
});

function inVault<T>(user: User, work: (record: RecordStore, sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(vaultOf(user), (_instance, state) => work(new RecordStore(state.storage.sql, (fn) => state.storage.transactionSync(fn)), state.storage.sql));
}
const tagsOf = (user: User): Promise<ConceptTag[]> => inVault(user, (record) => record.export().conceptTags);

/**
 * What the stage's step returned to the Workflow, as plain data. A step's result reaches a test
 * over RPC and has to be let go by hand, so it is copied first.
 */
async function reported(instance: { waitForStepResult(step: { name: string }): Promise<unknown> }): Promise<unknown> {
  const result = await instance.waitForStepResult({ name: "tag" });
  const copy: unknown = JSON.parse(JSON.stringify(result));
  const dispose = (Symbol as unknown as { dispose?: symbol }).dispose;
  if (dispose && result && typeof result === "object") (result as Record<symbol, (() => void) | undefined>)[dispose]?.();
  return copy;
}

/** Every shadow tag as what it is on, its concept, what made it and how it relates, in a fixed order. */
async function tagged(user: User, sourceId?: string): Promise<(string | undefined)[][]> {
  const { facts, roles } = await shown(user);
  const rows = [...facts.map((fact) => ({ id: fact.id, sourceId: fact.sourceId, words: fact.kind === "skill" ? `Skill: ${fact.text}` : fact.text })), ...roles.map((role) => ({ id: role.id, sourceId: role.sourceId, words: `Job title: ${role.title}` }))];
  const on = new Map(rows.filter((row) => sourceId === undefined || row.sourceId === sourceId).map((row) => [row.id, row.words]));
  return sorted((await tagsOf(user)).filter((tag) => tag.shadow && on.has(tag.subject.id)).map((tag) => [on.get(tag.subject.id), tag.conceptId, tag.method, tag.relation]));
}

describe("reading an upload as it is configured everywhere today", () => {
  it("looks nothing up in the taxonomy, asks no judge and keeps no tag", async () => {
    expect(AS_CONFIGURED.tag).toBeUndefined();
    // A taxonomy is bound here and wholly loaded. The switch alone keeps the stage out.
    expect((await new Taxonomy(new D1Store(AS_CONFIGURED.taxonomy)).info()).version).toBe(VERSION);
    const reads = (["info", "mentions", "lookup", "get", "profile", "broader"] as const).map((name) => vi.spyOn(Taxonomy.prototype, name));
    const { asked, models } = judging();
    setModels(() => models);
    const user = await signIn();
    await read(user);
    for (const spy of reads) expect(spy).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
    expect((await shown(user)).facts).toHaveLength(9);
    expect(await tagsOf(user)).toEqual([]);
  });
});

describe("reading with shadow tagging switched on and no taxonomy to read", () => {
  beforeEach(() => {
    settings.TAG_SHADOW_ENABLED = "true";
  });

  /** Reads the resume, and says what the stage reported where it is expected to have run. */
  async function outcome(staged = true) {
    const reading = await introspectWorkflow(env.DISTILL);
    try {
      const mentions = vi.spyOn(Taxonomy.prototype, "mentions");
      const { asked, models } = judging();
      setModels(() => models);
      const user = await signIn();
      await read(user);
      const [instance] = await reading.get();
      const result = staged ? await reported(instance!) : undefined;
      return { result, asked, lookedUp: mentions.mock.calls.length, facts: (await shown(user)).facts, tags: await tagsOf(user) };
    } finally {
      await reading.dispose();
    }
  }

  it("has no stage at all where no taxonomy is bound", async () => {
    settings.TAXONOMY = undefined;
    // Nothing the stage begins with is ever reached: not the taxonomy's version, not the vault's rows.
    const info = vi.spyOn(Taxonomy.prototype, "info");
    const candidates = vi.spyOn(Vault.prototype, "tagCandidates");
    const { asked, lookedUp, facts, tags } = await outcome(false);
    expect(info).not.toHaveBeenCalled();
    expect(candidates).not.toHaveBeenCalled();
    expect(lookedUp).toBe(0);
    expect(asked).toEqual([]);
    expect(facts).toHaveLength(9);
    expect(tags).toEqual([]);
  });

  it.each([
    ["a database with nothing in it", () => load([])],
    ["a database loaded short of the statement that ends a load", () => load(TAXONOMY_FIXTURE_SQL.slice(0, -1))],
  ])("stops before it reads a line from %s", async (_what, prepare) => {
    await prepare();
    const { result, asked, lookedUp, facts, tags } = await outcome();
    // The taxonomy says it is not loaded. Nothing was read from the vault, looked up or asked.
    expect(result).toEqual({ ...emptyTagReport(), failed: "unavailable" });
    expect(lookedUp).toBe(0);
    expect(asked).toEqual([]);
    expect(facts).toHaveLength(9);
    expect(tags).toEqual([]);
  });

  it("asks nothing and keeps nothing when a table goes missing from under it", async () => {
    await AS_CONFIGURED.taxonomy.prepare(`DROP TABLE concepts`).run();
    const { result, asked, lookedUp, facts, tags } = await outcome();
    // It names its version and its labels are found. The concepts those labels belong to cannot
    // be read, and that is one of the reads made before anything is asked or stored.
    expect(lookedUp).toBe(11);
    expect(result).toEqual({ ...emptyTagReport(), roles: 2, facts: 9, failed: "error" });
    expect(asked).toEqual([]);
    expect(facts).toHaveLength(9);
    expect(tags).toEqual([]);
  });
});

describe("reading with shadow tagging switched on", () => {
  beforeEach(() => {
    settings.TAG_SHADOW_ENABLED = "true";
  });

  it("tags jobs and facts in shadow, by the judge and by the rule, and changes nothing the app shows", async () => {
    // The same file read by someone for whom nothing is switched on.
    settings.TAG_SHADOW_ENABLED = AS_CONFIGURED.tag;
    setModels(() => judging().models);
    const untagged = await signIn();
    await read(untagged);
    expect(await tagsOf(untagged)).toEqual([]);

    settings.TAG_SHADOW_ENABLED = "true";
    const reading = await introspectWorkflow(env.DISTILL);
    try {
      const { asked, models } = judging();
      setModels(() => models);
      const user = await signIn();
      await read(user);

      // Two calls: one about the two jobs, one about the lines and skills.
      expect(said(asked)).toEqual([ABOUT_ROLES, ABOUT_FACTS]);
      expect(asked.flat().map((line) => line.id)).toEqual(Array.from({ length: 12 }, (_, index) => `T${index + 1}`));

      expect(await tagged(user)).toEqual(sorted(ALL_TAGS));
      const tags = await tagsOf(user);
      expect(tags).toHaveLength(14);
      for (const tag of tags) {
        expect(tag).toMatchObject({ shadow: true, state: "proposed", taxonomyVersion: VERSION, confidence: null, decidedBy: null, decidedAt: null });
        // Each decider's own stamp: the judge's names the model that was asked, the rule's names none.
        if (tag.method === TAG_RULE_METHOD) expect(tag).toMatchObject({ proposedBy: "rule", model: null });
        else expect(tag).toMatchObject({ method: TAG_JUDGE_METHOD, proposedBy: "model", model: env.MODEL_JUDGE });
        expect(tag.relation).toBe(tag.conceptKind === "occupation" ? "occupation" : tag.conceptKind === "tool" ? "uses" : "shows");
      }
      // The label is the taxonomy's own preferred one, whatever name the line used.
      expect(sorted([...new Set(tags.map((tag) => `${tag.conceptId} ${tag.conceptKind} ${tag.label}`))])).toEqual(
        sorted([
          `${S(8)} knowledge SQL`,
          `onet:tool:c++ tool C++`,
          `${O(1)} occupation software developer`,
          `${DEV} occupation Example Software Developers`,
          `${KUBERNETES} tool Kubernetes`,
          `${S(4)} knowledge container orchestration`,
          `${GO} tool Go`,
          `${S(6)} knowledge Go (computer programming)`,
        ]),
      );

      // Nothing the app shows has changed: the same facts and roles as with tagging off, and no judgement decides anything.
      const comparable = (view: Awaited<ReturnType<typeof shown>>) => ({
        facts: sorted(view.facts.map(({ id: _id, roleId: _roleId, sourceId: _sourceId, ...rest }) => rest)),
        roles: sorted(view.roles.map(({ id: _id, sourceId: _sourceId, ...rest }) => rest)),
      });
      const after = await shown(user);
      expect(after.facts).toHaveLength(9);
      expect(comparable(after)).toEqual(comparable(await shown(untagged)));
      expect(JSON.stringify(after)).not.toMatch(/esco:|onet:|mention-|conceptId/);

      // The Workflow's own state holds numbers and nothing else.
      const [instance] = await reading.get();
      const result = await reported(instance!);
      expect(result).toEqual(WHOLE);
      const leaves = (value: unknown): unknown[] => (value !== null && typeof value === "object" ? Object.values(value).flatMap(leaves) : [value]);
      expect(leaves(result).map((leaf) => typeof leaf)).toEqual(Array(15).fill("number"));
    } finally {
      await reading.dispose();
    }
  });

  it("leaves a skill the reading model re-cased to the judge", async () => {
    // The upload writes "sql". The reading keeps the model's "SQL", because it compares without case.
    const list = "Go, sql, Kubernetes, C++";
    const { asked, models } = judging({ extraction: extraction(list, ["Go", "SQL", "Kubernetes", "C++"]) });
    setModels(() => models);
    const user = await signIn();
    await read(user, "jane-doe.pdf", resume(list));
    expect((await shown(user)).facts.filter((fact) => fact.kind === "skill").map((fact) => [fact.text, fact.quote])).toEqual(expect.arrayContaining([["SQL", list]]));
    expect(said(asked)[1]).toEqual([...ABOUT_FACTS.slice(0, 6), ["Knows: SQL", "Skill: SQL"], ...ABOUT_FACTS.slice(6)]);
    const tags = await tagged(user);
    expect(tags).toEqual(sorted([...ALL_TAGS.filter(([words]) => words !== "Skill: SQL"), ["Skill: SQL", S(8), TAG_JUDGE_METHOD, "shows"]]));
    // And a judge that says no leaves it untagged: the rule had no say.
    const declining = judging({ extraction: extraction(list, ["Go", "SQL", "Kubernetes", "C++"]), judgeRejects: ["Knows: SQL"] });
    setModels(() => declining.models);
    const other = await signIn();
    await read(other, "jane-doe.pdf", resume(list));
    expect((await tagged(other)).filter(([words]) => words === "Skill: SQL")).toEqual([]);
  });

  it("asks again only about what was declined when a reading is retried, and changes no row", async () => {
    const reading = await introspectWorkflow(env.DISTILL);
    let introspected = true;
    try {
      // The first reading tags, then fails at its last step.
      await reading.modifyAll(async (step) => {
        await step.disableRetryDelays();
        await step.mockStepError({ name: "finish" }, new Error("unavailable: storage is busy"));
      });
      // This judge declines everything about Go, each time it is asked.
      const { asked, models } = judging({ judgeRejects: ["Go"] });
      setModels(() => models);
      const user = await signIn();
      const sourceId = await upload(user);
      expect((await waitForSource(user, sourceId)).state).toBe("failed");
      expect(said(asked)).toEqual([ABOUT_ROLES, ABOUT_FACTS]);
      const first = await tagsOf(user);
      expect(await tagged(user)).toEqual(sorted([...RULE_TAGS, ...ROLE_TAGS, ...LED_TAGS, ...KUBERNETES_SKILL_TAGS]));
      await reading.dispose();
      introspected = false;

      const again = await introspectWorkflow(env.DISTILL);
      try {
        const retry = await user.send("POST", `/api/runs/${sourceId}/retry`);
        expect(retry.status, await retry.clone().text()).toBe(202);
        expect(await waitForSource(user, sourceId)).toMatchObject({ state: "ready", error: null });
        // One more call, about the four candidates the judge declined. What it accepted, and
        // what the rule tagged, is known from the rows themselves.
        expect(said(asked).slice(2)).toEqual([ABOUT_FACTS.filter(([question]) => question.includes("Go"))]);
        expect(await tagsOf(user)).toEqual(first);
        expect((await shown(user)).facts).toHaveLength(9);
        const [instance] = await again.get();
        expect(await reported(instance!)).toEqual({ ...emptyTagReport(), roles: 2, facts: 9, candidates: 14, known: 10, asked: 4 });
      } finally {
        await again.dispose();
      }
    } finally {
      if (introspected) await reading.dispose();
    }
  });

  it("asks nothing about a second upload of the same lines, and tags its own rows", async () => {
    const reading = await introspectWorkflow(env.DISTILL);
    try {
      const { asked, models } = judging();
      setModels(() => models);
      const user = await signIn();
      const first = await read(user);
      const before = await tagsOf(user);
      expect(asked).toHaveLength(2);
      const second = await read(user, "jane-doe-2024.pdf", `${resume(SKILLS)}\nVolunteer: Code Club mentor, 2019`);
      // The judge already answered about these words, so its answers are carried to the new rows.
      expect(asked).toHaveLength(2);
      expect((await shown(user)).facts).toHaveLength(18);
      expect(await tagged(user, first)).toEqual(sorted(ALL_TAGS));
      expect(await tagged(user, second)).toEqual(sorted(ALL_TAGS));
      const after = await tagsOf(user);
      expect(after).toHaveLength(28);
      // The first upload's tags are exactly as they were.
      expect(after.filter((tag) => before.some((known) => known.id === tag.id))).toEqual(before);
      const results = await Promise.all((await reading.get()).map((instance) => reported(instance)));
      expect(results).toEqual(expect.arrayContaining([WHOLE, { ...emptyTagReport(), roles: 2, facts: 9, candidates: 14, byRule: 2, carried: 12, stored: 14 }]));
    } finally {
      await reading.dispose();
    }
  });

  it("drops a fact's tags when it is reworded, and a job's occupations when it is retitled", async () => {
    setModels(() => judging().models);
    const user = await signIn();
    await read(user);
    const { facts, roles } = await shown(user);
    const led = facts.find((fact) => fact.text === LED)!;
    const senior = roles.find((role) => role.title === "Senior Software Engineer")!;
    expect((await user.send("PATCH", `/api/facts/${led.id}`, { text: "Led the migration of 40 services" })).status).toBe(204);
    expect((await user.send("PATCH", `/api/roles/${senior.id}`, { title: "Staff Engineer" })).status).toBe(204);
    // The tags were decided about words that are gone. Every other tag stays.
    expect(await tagged(user)).toEqual(sorted(ALL_TAGS.filter(([words]) => words !== LED && words !== "Job title: Senior Software Engineer")));
    const left = await tagsOf(user);
    expect(left.filter((tag) => tag.subject.id === led.id || tag.subject.id === senior.id)).toEqual([]);
    expect(left).toHaveLength(10);
  });

  it("keeps no tag for a line that was reworded while the judge was being asked about roles", async () => {
    const reading = await introspectWorkflow(env.DISTILL);
    try {
      const reworded = "Led the migration of 40 services";
      let user!: User;
      const { asked, models } = judging({}, async (callNumber) => {
        if (callNumber !== 0) return;
        // The stage has read the line. Before any answer about it is stored, its owner changes it.
        const listed = (await user.json<{ facts: FactView[] }>("/api/facts")).facts;
        const edited = await user.send("PATCH", `/api/facts/${listed.find((fact) => fact.text === LED)!.id}`, { text: reworded });
        expect(edited.status, await edited.clone().text()).toBe(204);
      });
      setModels(() => models);
      user = await signIn();
      await read(user);
      // The judge was asked about the line as it was read, and said yes.
      expect(said(asked)).toEqual([ABOUT_ROLES, ABOUT_FACTS]);
      const { facts } = await shown(user);
      const changed = facts.find((fact) => fact.text === reworded)!;
      expect(changed.origin).toBe("user");
      expect((await tagsOf(user)).filter((tag) => tag.subject.id === changed.id)).toEqual([]);
      expect(await tagged(user)).toEqual(sorted(ALL_TAGS.filter(([words]) => words !== LED)));
      const [instance] = await reading.get();
      expect(await reported(instance!)).toEqual({ ...WHOLE, stored: 12 });
    } finally {
      await reading.dispose();
    }
  });

  it("counts as refused the tags of a row that already holds as many as it can, and keeps the others", async () => {
    const reading = await introspectWorkflow(env.DISTILL);
    try {
      const filler: Stamp = { proposedBy: "model", model: "@cf/test/judge", method: "judge/1", taxonomyVersion: VERSION, confidence: null, shadow: false };
      let user!: User;
      const { models } = judging({}, async (callNumber) => {
        if (callNumber !== 0) return;
        const skill = (await user.json<{ facts: FactView[] }>("/api/facts")).facts.find((fact) => fact.kind === "skill" && fact.text === "Kubernetes")!;
        await inVault(user, (record) => {
          for (let n = 0; n < MAX_TAGS_PER_SUBJECT; n++) record.proposeTag({ subject: { kind: "fact", id: skill.id }, conceptId: `onet:tool:filler-${n}`, conceptKind: "tool", label: `Filler ${n}`, stamp: filler });
        });
      });
      setModels(() => models);
      user = await signIn();
      await read(user);
      expect(await tagged(user)).toEqual(sorted(ALL_TAGS.filter(([words]) => words !== "Skill: Kubernetes")));
      const [instance] = await reading.get();
      expect(await reported(instance!)).toEqual({ ...WHOLE, stored: 12, refused: 2 });
    } finally {
      await reading.dispose();
    }
  });

  it("keeps the rule's tags and the answers about roles when the judge fails on facts, and finishes the upload", async () => {
    const reading = await introspectWorkflow(env.DISTILL);
    try {
      const stand = judging();
      const models: Models = {
        ...stand.models,
        // The second judge call, about facts, fails with a message that holds a line of the resume.
        complete: (route, messages, schema, opts) =>
          route === "judge" && stand.asked.length === 1 ? Promise.reject(new Error(`unavailable: provider rejected "${LED}"`)) : stand.models.complete(route, messages, schema, opts),
      };
      setModels(() => models);
      const user = await signIn();
      await read(user);
      expect((await shown(user)).facts).toHaveLength(9);
      expect(await tagged(user)).toEqual(sorted([...RULE_TAGS, ...ROLE_TAGS]));
      const [instance] = await reading.get();
      // A code, and counts of what was asked and kept: the eight questions of the failed call were sent.
      expect(await reported(instance!)).toEqual({ ...emptyTagReport(), roles: 2, facts: 9, candidates: 14, byRule: 2, asked: 12, yes: 4, stored: 6, failed: "unavailable" });
    } finally {
      await reading.dispose();
    }
  });

  it("finishes the upload when the vault cannot answer the stage, as a vault on older code cannot", async () => {
    const reading = await introspectWorkflow(env.DISTILL);
    try {
      // A vault that has not yet taken this code has neither of the stage's methods, and the first call to it fails.
      const missing = vi.spyOn(Vault.prototype, "tagCandidates").mockRejectedValue(new TypeError('The RPC receiver does not implement the method "tagCandidates".'));
      const { asked, models } = judging();
      setModels(() => models);
      const user = await signIn();
      await read(user);
      expect(missing).toHaveBeenCalledTimes(1);
      expect(asked).toEqual([]);
      expect((await shown(user)).facts).toHaveLength(9);
      expect(await tagsOf(user)).toEqual([]);
      const [instance] = await reading.get();
      expect(await reported(instance!)).toEqual({ ...emptyTagReport(), failed: "error" });
    } finally {
      await reading.dispose();
    }
  });

  it("gets one try: when the stage runs out of time nothing is asked again, and the upload finishes", async () => {
    const reading = await introspectWorkflow(env.DISTILL);
    try {
      // The stage's first try runs out of time before it does anything. A second try would ask the judge.
      await reading.modifyAll(async (step) => {
        await step.forceStepTimeout({ name: "tag" }, 1);
      });
      const { asked, models } = judging();
      setModels(() => models);
      const user = await signIn();
      await read(user);
      expect((await shown(user)).facts).toHaveLength(9);
      expect(asked).toEqual([]);
      expect(await tagsOf(user)).toEqual([]);
    } finally {
      await reading.dispose();
    }
  });
});

describe("where a person's shadow tags go", () => {
  beforeEach(() => {
    settings.TAG_SHADOW_ENABLED = "true";
    setModels(() => judging().models);
  });

  it("puts every tag in the owner's export, marked as in shadow", async () => {
    const user = await signIn();
    await read(user);
    const exported = await user.json<RecordExport>("/api/export");
    expect(exported.conceptTags).toHaveLength(14);
    expect(exported.conceptTags.every((tag) => tag.shadow === true && tag.state === "proposed" && tag.taxonomyVersion === VERSION)).toBe(true);
    expect(exported.conceptTags).toEqual(await tagsOf(user));
  });

  it("puts none in a coach's copy of a tagged fact", async () => {
    const user = await signIn();
    await read(user);
    const led = (await shown(user)).facts.find((fact) => fact.text === LED)!;
    expect((await user.send("POST", "/api/review", { confirm: [led.id], reject: [] })).status).toBe(204);
    // Confirming a fact changes none of its words, so its two tags are still there.
    expect((await tagsOf(user)).filter((tag) => tag.subject.id === led.id)).toHaveLength(2);
    const made = await user.send("POST", "/api/shares", { factIds: [led.id], resumes: [] });
    expect(made.status, await made.clone().text()).toBe(201);
    const { grant, url } = (await made.json()) as { grant: ShareGrant; url: string };
    const exchange = await call("/share/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(url).hash.slice(1) }) });
    expect(exchange.status).toBe(200);
    const copy = await call(`/share/snapshot?g=${grant.id}`, { cookie: cookieFrom(exchange, `__Host-share-${grant.id}`)! });
    expect(copy.status).toBe(200);
    const text = await copy.text();
    expect(text).toContain(LED);
    for (const kept of ["container orchestration", "onet:tool", "esco:skill", "conceptTags", "mention-judge", "taxonomy", VERSION]) expect(text, kept).not.toContain(kept);
  });

  it("erases them with the account", async () => {
    const user = await signIn();
    await read(user);
    const { vid } = sessionOf(user);
    expect(await inVault(user, (_record, sql) => sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM record_tags`).one().n)).toBe(14);
    expect((await user.send("DELETE", "/auth/account")).status).toBe(202);
    await runDurableObjectAlarm(directory(env));
    // The probe counts every row of every table the vault's storage still lists.
    const probe = () => runInDurableObject(vault(env, vid), (instance) => instance.deletionProbe());
    await eventually(async () => (await probe()).rows === 0, "the vault to be erased");
    expect(await probe()).toEqual({ rows: 0 });
    expect(await runInDurableObject(vault(env, vid), (_instance, state) => state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE name = 'record_tags'`).toArray())).toEqual([]);
  });

  it("moves them to a replacement vault with the stamps they were given", async () => {
    type Stub = ReturnType<typeof env.VAULT.get>;
    const stub = () => env.VAULT.get(env.VAULT.newUniqueId());
    const made: TagMade = { model: env.MODEL_JUDGE, taxonomyVersion: VERSION };
    function storage<T>(target: Stub, work: (ops: VaultOperations, record: RecordStore, sql: SqlStorage) => T | Promise<T>): Promise<T> {
      return runInDurableObject(target, async (_instance, state) => {
        const sql = state.storage.sql;
        const transaction = <R>(fn: () => R): R => state.storage.transactionSync(fn);
        if (!hasSchema(sql)) createSchema(sql, transaction);
        for (const migration of OPERATION_MIGRATIONS) sql.exec(migration);
        const ops = new VaultOperations(sql, transaction, { vaultId: target.id.toString(), userId: "owner", schemaVersion: SCHEMA_VERSION, requireMaintenanceFence: () => {} });
        return work(ops, new RecordStore(sql, transaction), sql);
      });
    }
    const source = stub();
    const destination = stub();
    const sent = await storage(source, async (ops, record, sql) => {
      sql.exec(`INSERT INTO profile (id, name) VALUES (1, 'Test Candidate')`);
      sql.exec(`INSERT INTO sources (id, filename, r2_key, markdown, state, created_at) VALUES ('source', 'resume.docx', ?, ?, 'ready', 1)`, `${vaultPrefix(source.id.toString())}sources/source`, SKILLS);
      sql.exec(`INSERT INTO source_revisions (id, source_id, markdown, created_at) VALUES ('revision', 'source', ?, 1)`, SKILLS);
      sql.exec(`INSERT INTO evidence (id, source_id, quote, start, end, source_revision_id) VALUES ('quote', 'source', ?, 0, ?, 'revision')`, SKILLS, SKILLS.length);
      sql.exec(`INSERT INTO roles (id, kind, org, title, start_date, end_date, state, source_id) VALUES ('role', 'job', 'Acme', 'Software Engineer', '2020', '2022', 'proposed', 'source')`);
      for (const [id, text] of [["fact-sql", "SQL"], ["fact-kubernetes", "Kubernetes"]] as const)
        sql.exec(`INSERT INTO facts (id, role_id, kind, text, evidence_id, source_id, origin, state, vector, updated_at) VALUES (?, NULL, 'skill', ?, 'quote', 'source', 'extracted', 'proposed', ?, 1)`, id, text, new Float32Array([0.25, 0.75]).buffer);
      sql.exec(`INSERT INTO meta (key, value) VALUES ('embedding_model', '@cf/test/embedding'), ('embedding_dimensions', '2'), ('embedding_generation', 'generation-1'), ('security_epoch', 'old-epoch')`);
      // One tag from each decider and one occupation, stamped as the stage stamps them.
      record.proposeTag({ subject: { kind: "fact", id: "fact-sql" }, conceptId: S(8), conceptKind: "knowledge", label: "SQL", stamp: tagStamp(TAG_RULE_METHOD, made) });
      record.proposeTag({ subject: { kind: "fact", id: "fact-kubernetes" }, conceptId: KUBERNETES, conceptKind: "tool", label: "Kubernetes", stamp: tagStamp(TAG_JUDGE_METHOD, made) });
      record.proposeTag({ subject: { kind: "role", id: "role" }, conceptId: O(1), conceptKind: "occupation", label: "software developer", stamp: tagStamp(TAG_JUDGE_METHOD, made) });
      const manifest = ops.beginExport("move-tags");
      const pages: TransferPage[] = [];
      for (const table of manifest.tables) pages.push(await ops.exportPage("move-tags", table.name));
      return { manifest, pages, held: record.export().conceptTags };
    });
    expect(sent.manifest.tables.map((table) => table.name)).toEqual(TRANSFER_TABLES);
    expect(sent.manifest.tables.find((table) => table.name === "record_tags")!.count).toBe(3);
    expect(sorted(sent.held.map((tag) => [tag.conceptId, tag.relation, tag.proposedBy, tag.model, tag.method, tag.taxonomyVersion, tag.shadow, tag.state]))).toEqual(
      sorted([
        [S(8), "shows", "rule", null, TAG_RULE_METHOD, VERSION, true, "proposed"],
        [KUBERNETES, "uses", "model", env.MODEL_JUDGE, TAG_JUDGE_METHOD, VERSION, true, "proposed"],
        [O(1), "occupation", "model", env.MODEL_JUDGE, TAG_JUDGE_METHOD, VERSION, true, "proposed"],
      ]),
    );
    const arrived = await storage(destination, async (ops, record) => {
      ops.beginImport(sent.manifest);
      for (const page of sent.pages) await ops.importPage(page);
      const status = ops.finishImport(sent.manifest.operationId, "replacement-epoch", () => {});
      return { status, held: record.export().conceptTags };
    });
    expect(arrived.status).toMatchObject({ state: "ready", completedTables: TRANSFER_TABLES.length });
    // The same rows: IDs, subjects, concepts, states and stamps.
    expect(arrived.held).toEqual(sent.held);
  });
});

// ---------------------------------------------------------------- the vault's two methods

describe("what a reading may ask of a vault", () => {
  const made: TagMade = { model: "test/judge", taxonomyVersion: VERSION };
  type Rows = (sql: SqlStorage, sourceId: string) => void;
  const addSource = (sql: SqlStorage, id: string, runId: string | null) =>
    sql.exec(`INSERT INTO sources (id, filename, r2_key, markdown, state, run_id, created_at) VALUES (?, 'resume.pdf', ?, 'text', 'queued', ?, 1)`, id, `sources/${id}`, runId);
  const addRole = (sql: SqlStorage, sourceId: string, id: string, title: string | null, kind = "job") =>
    sql.exec(`INSERT INTO roles (id, kind, org, title, state, source_id) VALUES (?, ?, 'Acme', ?, 'proposed', ?)`, id, kind, title, sourceId);
  const addFact = (sql: SqlStorage, sourceId: string, id: string, kind: string, text: string, quote: string | null, origin = "extracted") => {
    if (quote !== null) sql.exec(`INSERT INTO evidence (id, source_id, quote) VALUES (?, ?, ?)`, `quote-${id}`, sourceId, quote);
    sql.exec(`INSERT INTO facts (id, role_id, kind, text, evidence_id, source_id, origin, state, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?, 'proposed', 1)`, id, kind, text, quote === null ? null : `quote-${id}`, sourceId, origin);
  };
  const OTHER = "another-upload";

  /** A vault made by hand with one upload still being read: its run is claimed, and its rows are what a test inserts. */
  async function open(rows: Rows = () => {}) {
    const stub = vault(env, env.VAULT.newUniqueId().toString());
    await stub.init(`tag-owner-${crypto.randomUUID()}`);
    const sourceId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      addSource(sql, sourceId, runId);
      // An earlier upload, read and done.
      addSource(sql, OTHER, null);
      const inner = instance as unknown as { runs: { begin(run: Record<string, unknown>, write: () => void): void } };
      inner.runs.begin({ id: runId, kind: "distill", targetId: sourceId, requestKey: runId, inputDigest: runId, steps: ["convert", "extract", "embed"] }, () => {});
      await instance.claimRun(runId, { kind: "distill", targetId: sourceId });
      rows(sql, sourceId);
    });
    const inside = <T>(work: (record: RecordStore, sql: SqlStorage) => T): Promise<T> =>
      runInDurableObject(stub, (_instance, state) => work(new RecordStore(state.storage.sql, (fn) => state.storage.transactionSync(fn)), state.storage.sql));
    // The two methods are called on the vault itself, as the reading named. `refusal` gives the
    // sentence a call was refused with, so a test holds a denial to its exact words.
    const candidates = (source = sourceId, run: string | undefined = runId) => runInDurableObject(stub, (instance) => instance.tagCandidates(source, run));
    const keep = (tags: ProposedTag[], by: TagMade = made, source = sourceId, run: string | undefined = runId) => runInDurableObject(stub, (instance) => instance.saveShadowTags(source, run, by, tags));
    const refusal = (work: (instance: Vault) => Promise<unknown>): Promise<string> =>
      runInDurableObject(stub, async (instance) => {
        try {
          await work(instance);
        } catch (error) {
          return (error as Error).message;
        }
        return "answered";
      });
    return { sourceId, runId, inside, candidates, keep, refusal };
  }
  const tag = (subject: ProposedTag["subject"], words: string, conceptId: string, conceptKind: ProposedTag["conceptKind"], label: string, method: ProposedTag["method"] = TAG_JUDGE_METHOD): ProposedTag => ({ subject, words, conceptId, conceptKind, label, method });
  const LIST = "Skills: Go, SQL, Kubernetes";
  const usual: Rows = (sql, sourceId) => {
    addRole(sql, sourceId, "job", "Software Engineer");
    addFact(sql, sourceId, "fact-sql", "skill", "SQL", LIST);
    addFact(sql, sourceId, "fact-kubernetes", "skill", "Kubernetes", LIST);
    addFact(sql, sourceId, "fact-line", "accomplishment", "Ran Kubernetes clusters", "Ran Kubernetes clusters");
    addRole(sql, OTHER, "other-job", "Software Engineer");
    addFact(sql, OTHER, "other-fact", "skill", "Kubernetes", "Kubernetes, Go");
  };
  const SQL_TAG = tag({ kind: "fact", id: "fact-sql" }, "SQL", S(8), "knowledge", "SQL", TAG_RULE_METHOD);
  const KUBERNETES_TAG = tag({ kind: "fact", id: "fact-kubernetes" }, "Kubernetes", KUBERNETES, "tool", "Kubernetes");
  const JOB_TAG = tag({ kind: "role", id: "job" }, "Software Engineer", O(1), "occupation", "software developer");

  describe("to tag", () => {
    it("gives the upload's first jobs and extracted facts, in the order they were read, and how many there are", async () => {
      const { candidates } = await open((sql, source) => {
        // Read first, and not jobs with a title: a course, and jobs whose title is missing or empty.
        addRole(sql, source, "course", "B.S. Computer Science", "education");
        addRole(sql, source, "untitled", null);
        addRole(sql, source, "blank", "");
        // Not this reading's proposals: a line its owner typed or changed, and another upload's rows.
        addFact(sql, source, "typed", "accomplishment", "Typed by the owner", null, "user");
        addRole(sql, OTHER, "other-job", "Engineer 0");
        addFact(sql, OTHER, "other-fact", "accomplishment", "Line 0", "Line 0");
        for (let n = 0; n < MAX_TAG_ROLES + 3; n++) addRole(sql, source, `job-${n}`, `Engineer ${n}`);
        for (let n = 0; n < MAX_TAG_FACTS + 5; n++) addFact(sql, source, `fact-${n}`, "accomplishment", `Line ${n}`, `Line ${n}`);
      });
      const subjects = await candidates();
      expect(subjects.roles.map((role) => [role.id, role.title])).toEqual(Array.from({ length: MAX_TAG_ROLES }, (_, n) => [`job-${n}`, `Engineer ${n}`]));
      expect(subjects.facts.map((fact) => [fact.id, fact.roleId, fact.kind, fact.text])).toEqual(Array.from({ length: MAX_TAG_FACTS }, (_, n) => [`fact-${n}`, null, "accomplishment", `Line ${n}`]));
      expect(subjects.total).toEqual({ roles: MAX_TAG_ROLES + 3, facts: MAX_TAG_FACTS + 5 });
    });

    it("says whether a skill is an item of its own line as written, and never gives the line out", async () => {
      const { candidates } = await open((sql, source) => {
        addFact(sql, source, "as-written", "skill", "SQL", "Skills: Go, SQL, canary-quote-7f3a");
        addFact(sql, source, "re-cased", "skill", "Go", "Skills: go, SQL");
        addFact(sql, source, "marked", "skill", "Rust", "Skills: **Rust**, SQL");
        addFact(sql, source, "credential", "credential", "SQL", "Name: SQL");
        addFact(sql, source, "no-line", "skill", "Python", null);
      });
      const subjects = await candidates();
      expect(subjects.facts.map((fact) => [fact.id, fact.asWritten])).toEqual([["as-written", true], ["re-cased", false], ["marked", false], ["credential", false], ["no-line", false]]);
      expect(JSON.stringify(subjects)).not.toContain("canary-quote-7f3a");
      expect(Object.keys(subjects.facts[0]!).sort()).toEqual(["asWritten", "held", "id", "kind", "roleId", "text"]);
    });

    it("says which shadow tags a row holds, and which another row with the same words holds", async () => {
      const shown: Stamp = { ...tagStamp(TAG_JUDGE_METHOD, made), shadow: false };
      const { candidates, inside } = await open((sql, source) => {
        usual(sql, source);
        // The same words as another kind of fact, and the same title on something that is not a job.
        addFact(sql, OTHER, "other-credential", "credential", "Kubernetes", "Name: Kubernetes");
        addRole(sql, OTHER, "other-course", "Software Engineer", "education");
        addFact(sql, OTHER, "third-fact", "skill", "Kubernetes", "Kubernetes");
      });
      await inside((record) => {
        const judge = tagStamp(TAG_JUDGE_METHOD, made);
        record.proposeTag({ subject: { kind: "fact", id: "fact-sql" }, conceptId: S(8), conceptKind: "knowledge", label: "SQL", stamp: tagStamp(TAG_RULE_METHOD, made) });
        record.proposeTag({ subject: { kind: "fact", id: "fact-kubernetes" }, conceptId: KUBERNETES, conceptKind: "tool", label: "Kubernetes", stamp: judge });
        // Two other rows say "Kubernetes" as a skill, and both hold the knowledge of it from the same decider.
        for (const id of ["other-fact", "third-fact"]) record.proposeTag({ subject: { kind: "fact", id }, conceptId: S(4), conceptKind: "knowledge", label: "container orchestration", stamp: { ...judge, taxonomyVersion: "esco-0.0.1+onet-0.0+00000000" } });
        record.proposeTag({ subject: { kind: "role", id: "other-job" }, conceptId: O(1), conceptKind: "occupation", label: "software developer", stamp: judge });
        // None of these is held: a tag that shows, a tag on another kind of fact, and one on a course.
        record.proposeTag({ subject: { kind: "fact", id: "other-fact" }, conceptId: KUBERNETES, conceptKind: "tool", label: "Kubernetes", stamp: shown });
        record.proposeTag({ subject: { kind: "fact", id: "other-credential" }, conceptId: KUBERNETES, conceptKind: "tool", label: "Kubernetes", stamp: judge });
        record.proposeTag({ subject: { kind: "role", id: "other-course" }, conceptId: DEV, conceptKind: "occupation", label: "Example Software Developers", stamp: judge });
      });
      const before = await inside((_record, sql) => sql.exec<{ n: number }>(`SELECT (SELECT COUNT(*) FROM record_tags) + (SELECT COUNT(*) FROM facts) + (SELECT COUNT(*) FROM roles) AS n`).one().n);
      const subjects = await candidates();
      const held = new Map([...subjects.roles, ...subjects.facts].map((row) => [row.id, row.held]));
      expect(held.get("fact-sql")).toEqual([{ conceptId: S(8), method: TAG_RULE_METHOD, model: null, taxonomyVersion: VERSION, own: true }]);
      expect(sorted(held.get("fact-kubernetes")!)).toEqual(
        sorted([
          { conceptId: KUBERNETES, method: TAG_JUDGE_METHOD, model: "test/judge", taxonomyVersion: VERSION, own: true },
          { conceptId: S(4), method: TAG_JUDGE_METHOD, model: "test/judge", taxonomyVersion: "esco-0.0.1+onet-0.0+00000000", own: false },
        ]),
      );
      expect(held.get("fact-line")).toEqual([]);
      expect(held.get("job")).toEqual([{ conceptId: O(1), method: TAG_JUDGE_METHOD, model: "test/judge", taxonomyVersion: VERSION, own: false }]);
      // It read, and wrote nothing.
      expect(await inside((_record, sql) => sql.exec<{ n: number }>(`SELECT (SELECT COUNT(*) FROM record_tags) + (SELECT COUNT(*) FROM facts) + (SELECT COUNT(*) FROM roles) AS n`).one().n)).toBe(before);
    });
  });

  describe("to keep", () => {
    it("stores each tag in shadow with its decider's stamp, and stores none of them twice", async () => {
      const { inside, keep } = await open(usual);
      expect(await keep([SQL_TAG, KUBERNETES_TAG, JOB_TAG])).toEqual({ stored: 3, refused: 0 });
      const first = await inside((record) => record.export().conceptTags);
      expect(sorted(first.map((found) => [found.subject.kind, found.subject.id, found.conceptId, found.conceptKind, found.label, found.relation, found.proposedBy, found.model, found.method, found.taxonomyVersion, found.shadow, found.state, found.confidence]))).toEqual(
        sorted([
          ["fact", "fact-sql", S(8), "knowledge", "SQL", "shows", "rule", null, TAG_RULE_METHOD, VERSION, true, "proposed", null],
          ["fact", "fact-kubernetes", KUBERNETES, "tool", "Kubernetes", "uses", "model", "test/judge", TAG_JUDGE_METHOD, VERSION, true, "proposed", null],
          ["role", "job", O(1), "occupation", "software developer", "occupation", "model", "test/judge", TAG_JUDGE_METHOD, VERSION, true, "proposed", null],
        ]),
      );
      // Nothing shows: a tag in shadow is not among the tags a fact is seen to have.
      expect(await inside((record) => record.tags({ kind: "fact", id: "fact-sql" }))).toEqual([]);
      // Found before by the same decider: neither stored again nor refused, and each row is as it was.
      expect(await keep([SQL_TAG, KUBERNETES_TAG, JOB_TAG])).toEqual({ stored: 0, refused: 0 });
      expect(await inside((record) => record.export().conceptTags)).toEqual(first);
      // Another model's yes, or another taxonomy's, is a judgement of its own. It takes the place
      // of the old one: a row holds one tag for a concept, and the stamp says what made it last.
      expect(await keep([SQL_TAG, KUBERNETES_TAG], { ...made, model: "other/judge" })).toEqual({ stored: 1, refused: 0 });
      const restamped = await inside((record) => record.export().conceptTags);
      expect(restamped).toHaveLength(3);
      expect(restamped.find((found) => found.conceptId === KUBERNETES)).toMatchObject({ id: first.find((found) => found.conceptId === KUBERNETES)!.id, model: "other/judge" });
      expect(restamped.find((found) => found.conceptId === S(8))).toEqual(first.find((found) => found.conceptId === S(8)));
    });

    it("leaves out a tag decided about words its row no longer has", async () => {
      const { inside, keep } = await open(usual);
      const about = (words: string) => [{ ...KUBERNETES_TAG, words }, { ...JOB_TAG, words }, { ...tag({ kind: "fact", id: "fact-line" }, words, KUBERNETES, "tool", "Kubernetes") }];
      for (const words of ["kubernetes", "Kubernetes ", "", "Software engineer", undefined as unknown as string])
        expect(await keep(about(words)), String(words)).toEqual({ stored: 0, refused: 0 });
      // A job that has become something else is no longer given an occupation, whatever its title.
      await inside((_record, sql) => sql.exec(`UPDATE roles SET kind = 'project' WHERE id = 'job'`));
      expect(await keep([JOB_TAG])).toEqual({ stored: 0, refused: 0 });
      expect(await inside((record) => record.export().conceptTags)).toEqual([]);
    });

    it("leaves out the rule's tag for anything but a skill that is still an item of its line as written", async () => {
      const { inside, keep } = await open((sql, source) => {
        usual(sql, source);
        addFact(sql, source, "re-cased", "skill", "SQL", "Skills: sql, Go");
        addFact(sql, source, "credential", "credential", "SQL", "Name: SQL");
        addFact(sql, source, "no-line", "skill", "SQL", null);
      });
      const byRule = (subject: ProposedTag["subject"], words: string) => tag(subject, words, S(8), "knowledge", "SQL", TAG_RULE_METHOD);
      expect(
        await keep([
          byRule({ kind: "fact", id: "re-cased" }, "SQL"),
          byRule({ kind: "fact", id: "credential" }, "SQL"),
          byRule({ kind: "fact", id: "no-line" }, "SQL"),
          byRule({ kind: "fact", id: "fact-line" }, "Ran Kubernetes clusters"),
          // The rule never names a job's occupation.
          { ...JOB_TAG, method: TAG_RULE_METHOD },
        ]),
      ).toEqual({ stored: 0, refused: 0 });
      expect(await inside((record) => record.export().conceptTags)).toEqual([]);
      // The judge's yes for the same rows is kept: only the rule is held to the line.
      expect(await keep([{ ...byRule({ kind: "fact", id: "re-cased" }, "SQL"), method: TAG_JUDGE_METHOD }])).toEqual({ stored: 1, refused: 0 });
    });

    it("counts what the record refuses, and keeps the rest", async () => {
      const { inside, keep } = await open(usual);
      await inside((record) => {
        const filler: Stamp = { ...tagStamp(TAG_JUDGE_METHOD, made), shadow: false };
        for (let n = 0; n < MAX_TAGS_PER_SUBJECT; n++) record.proposeTag({ subject: { kind: "fact", id: "fact-line" }, conceptId: `onet:tool:filler-${n}`, conceptKind: "tool", label: `Filler ${n}`, stamp: filler });
      });
      expect(
        await keep([
          // Not a concept's ID; a fact tagged with an occupation; a job tagged with software; a label that is not one.
          { ...KUBERNETES_TAG, conceptId: "kubernetes" },
          { ...KUBERNETES_TAG, conceptId: undefined as unknown as string },
          { ...KUBERNETES_TAG, conceptId: O(1), conceptKind: "occupation" },
          { ...JOB_TAG, conceptId: KUBERNETES, conceptKind: "tool" },
          { ...KUBERNETES_TAG, conceptId: S(4), conceptKind: "knowledge", label: " " },
          // A row that holds as many tags as it can.
          tag({ kind: "fact", id: "fact-line" }, "Ran Kubernetes clusters", KUBERNETES, "tool", "Kubernetes"),
          SQL_TAG,
          JOB_TAG,
        ]),
      ).toEqual({ stored: 2, refused: 6 });
      expect(sorted((await inside((record) => record.export().conceptTags)).filter((found) => found.shadow).map((found) => [found.subject.id, found.conceptId]))).toEqual(sorted([["fact-sql", S(8)], ["job", O(1)]]));
    });

    it("refuses a whole call that is not a reading's tags for facts and jobs", async () => {
      const { sourceId, runId, inside, keep, refusal } = await open(usual);
      const refused: [why: string, made: TagMade, tags: ProposedTag[], message: string][] = [
        ["more tags than an upload can have", made, Array.from({ length: MAX_TAGS_PER_SAVE + 1 }, () => KUBERNETES_TAG), "invalid: too many tags for one upload"],
        ["a method that is not one of the two", made, [SQL_TAG, { ...KUBERNETES_TAG, method: "vector-judge/1" as ProposedTag["method"] }], "invalid: unknown tagging method"],
        ["no method", made, [{ ...KUBERNETES_TAG, method: undefined as unknown as ProposedTag["method"] }], "invalid: unknown tagging method"],
        ["a part of a line", made, [SQL_TAG, { ...KUBERNETES_TAG, subject: { kind: "part" as "fact", id: "fact-kubernetes" } }], "invalid: tags are proposed for facts and job roles"],
        ["a subject with no ID", made, [{ ...KUBERNETES_TAG, subject: { kind: "fact", id: 7 as unknown as string } }], "invalid: tags are proposed for facts and job roles"],
        ["something that is not a list", made, { length: 1 } as unknown as ProposedTag[], "invalid: tags are proposed for facts and job roles"],
        ["a judge with no name", { ...made, model: "" }, [SQL_TAG], "invalid: a model's judgement names the model"],
        ["a taxonomy version that is not one", { ...made, taxonomyVersion: "not a version" }, [SQL_TAG], "invalid: unknown taxonomy version"],
        ["nothing said of what made them", null as unknown as TagMade, [SQL_TAG], "invalid: a judgement says what made it"],
      ];
      for (const [why, by, tags, message] of refused) expect(await refusal((instance) => instance.saveShadowTags(sourceId, runId, by, tags)), why).toBe(message);
      // Refused whole: the good tag that came before the bad one was not kept.
      expect(await inside((record) => record.export().conceptTags)).toEqual([]);
      // Exactly as many as an upload can have is not too many.
      expect(await keep(Array.from({ length: MAX_TAGS_PER_SAVE }, () => KUBERNETES_TAG))).toEqual({ stored: 1, refused: 0 });
    });

    it("refuses a tag for a fact or a job of another upload", async () => {
      const { sourceId, runId, inside, refusal } = await open(usual);
      const refused = (tags: ProposedTag[]) => refusal((instance) => instance.saveShadowTags(sourceId, runId, made, tags));
      const foreign = tag({ kind: "fact", id: "other-fact" }, "Kubernetes", KUBERNETES, "tool", "Kubernetes");
      expect(await refused([SQL_TAG, foreign, KUBERNETES_TAG])).toBe("conflict: fact is not part of this source");
      expect(await refused([tag({ kind: "role", id: "other-job" }, "Software Engineer", O(1), "occupation", "software developer")])).toBe("conflict: role is not part of this source");
      expect(await refused([tag({ kind: "fact", id: "no-such-fact" }, "Kubernetes", KUBERNETES, "tool", "Kubernetes")])).toBe("conflict: fact is not part of this source");
      // A job's ID does not pass for a fact's, nor a fact's for a job's.
      expect(await refused([{ ...JOB_TAG, subject: { kind: "fact", id: "job" } }])).toBe("conflict: fact is not part of this source");
      expect(await refused([{ ...KUBERNETES_TAG, subject: { kind: "role", id: "fact-kubernetes" } }])).toBe("conflict: role is not part of this source");
      // Nothing was stored on the other upload's rows, or after the refusal. The tag decided
      // before it stands, as a division kept before a refused one does.
      expect((await inside((record) => record.export().conceptTags)).map((found) => found.subject.id)).toEqual(["fact-sql"]);
    });
  });

  it("answers only the run that is reading this upload, while it is still at work", async () => {
    const { sourceId, runId, inside, candidates, keep, refusal } = await open(usual);
    /** What each of the two methods says to a call made in this run's name, or another's. */
    const both = async (source: string, run: string | undefined) => [
      await refusal((instance) => instance.tagCandidates(source, run)),
      await refusal((instance) => instance.saveShadowTags(source, run, made, [SQL_TAG])),
    ];
    // No run named, a run that is not this upload's, an upload that is not this run's, and no such upload.
    expect(await both(sourceId, undefined)).toEqual(Array(2).fill("invalid: workflow identity is required"));
    expect(await both(sourceId, crypto.randomUUID())).toEqual(Array(2).fill("conflict: this attempt was superseded"));
    expect(await both(OTHER, runId)).toEqual(Array(2).fill("conflict: this attempt was superseded"));
    expect(await both(crypto.randomUUID(), runId)).toEqual(Array(2).fill("not_found: no such source"));
    expect(await inside((record) => record.export().conceptTags)).toEqual([]);
    // The run itself is answered.
    expect((await candidates()).facts).toHaveLength(3);
    expect(await keep([SQL_TAG])).toEqual({ stored: 1, refused: 0 });
    // A newer reading has taken the upload over.
    await inside((_record, sql) => sql.exec(`UPDATE sources SET run_id = ? WHERE id = ?`, crypto.randomUUID(), sourceId));
    expect(await both(sourceId, runId)).toEqual(Array(2).fill("conflict: this attempt was superseded"));
    await inside((_record, sql) => sql.exec(`UPDATE sources SET run_id = ? WHERE id = ?`, runId, sourceId));
    // The reading was stopped.
    await inside((_record, sql) => sql.exec(`UPDATE runs SET state = 'cancel_requested' WHERE id = ?`, runId));
    expect(await both(sourceId, runId)).toEqual(Array(2).fill("conflict: this run no longer accepts work"));
    expect(await inside((record) => record.export().conceptTags)).toHaveLength(1);
  });

  it("answers nothing once the upload has been read", async () => {
    setModels(() => judging().models);
    const user = await signIn();
    const sourceId = await read(user);
    // The first reading of an upload is the run named after it. It has finished.
    const refused = await runInDurableObject(vaultOf(user), async (instance) => {
      const said: string[] = [];
      for (const ask of [() => instance.tagCandidates(sourceId, sourceId), () => instance.saveShadowTags(sourceId, sourceId, made, [])]) await ask().then(() => said.push("answered"), (error: Error) => said.push(error.message));
      return said;
    });
    expect(refused).toEqual(Array(2).fill("conflict: this run no longer accepts work"));
  });
});
