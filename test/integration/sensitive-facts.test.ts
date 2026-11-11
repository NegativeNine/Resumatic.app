import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels, type Models } from "../../src/ai/models";
import { extractFacts } from "../../src/pipeline/distill";
import { setPdfRenderer } from "../../src/render/pdf";
import { MAX_SENSITIVE_IDS, type FactView, type Me, type ResumeLine, type ResumeView } from "../../src/shared/api";
import type { DocumentView, NewDocument } from "../../src/shared/documents";
import type { CoachClient, ShareableDocument, ShareGrant, SharedView } from "../../src/shared/sharing";
import { directory, vault } from "../../src/shared/stubs";
import type { FactRecord } from "../../src/shared/types";
import { MIGRATIONS, SCHEMA_VERSION, migrate } from "../../src/vault/schema";
import { fromBase64url } from "../../src/worker/crypto";
import { removeSensitiveMigration } from "../support/undo-vault-incarnation";
import { outward, outwardParts, printAsText, type OutwardPart } from "./outward";
import { EXTRACTION, JOB_DESCRIPTION, RESUME, call, cookieFrom, eventually, fakeModels, signIn, uniqueEmail, waitForSource, type FakeModelOptions, type User } from "./support";

// A fact its owner marks sensitive: theirs to read, edit and export, and nowhere else. These tests
// mark facts through the app's own routes and then read every way out of the vault.

const LED = "Led the migration of 40 services to Kubernetes, cutting deploy time by 60%";
const GO_SERVICE = "Built a Go service that processes 2 million events per day";
const MENTORED = "Mentored 2 junior engineers";
const REACT = "Implemented React dashboards for the sales team";
const SKILLS = "Go, TypeScript, Kubernetes, PostgreSQL";
/** What a run that captured a marked fact is told, and what a version that uses one is told. */
const FACTS_CHANGED = "Your facts changed while this draft was being made. Create it again.";
const USES_SENSITIVE = "This version uses a fact you marked sensitive. Remove those lines or tailor a new version, then try again.";
/** Workflows are slower while other suites share the machine. */
const WAIT = 60_000;

// A resume that says two things no posting says: a line under a job, and one item of the skills list.
const SECRET = "Thornfield union ballot";
const SECRET_LINE = `Mentored 6 apprentices through the ${SECRET}`;
const SECRET_SKILL = "Wiccan ritual planning";
const SKILLS_WITH_SECRET = `${SKILLS}, ${SECRET_SKILL}`;
const RESUME_WITH_SECRETS = RESUME.replace(`- ${GO_SERVICE}`, `- ${GO_SERVICE}\n- ${SECRET_LINE}`).replace(SKILLS, SKILLS_WITH_SECRET);
const EXTRACTION_WITH_SECRETS = {
  ...EXTRACTION,
  facts: [
    ...EXTRACTION.facts.map((fact) => (fact.quote === SKILLS ? { ...fact, quote: SKILLS_WITH_SECRET } : fact)),
    { roleKey: "acme", kind: "accomplishment", text: SECRET_LINE, level: "led", quote: SECRET_LINE },
    { roleKey: null, kind: "skill", text: SECRET_SKILL, level: null, quote: SKILLS_WITH_SECRET },
  ],
};

let options: FakeModelOptions & { inputs: string[]; calls: NonNullable<FakeModelOptions["calls"]> };
/** The facts a letter or preparation is written from: every one the writer is given, or only these. */
let writeOnly: string[] | null;
/** How a refinement rewords each line it is given. */
let rewrite: (line: string) => string;

/**
 * The usual stand-in models, and a writer for letters, preparation and refinements, which ask in
 * JSON. The writer says back every fact it is given, so a fact that reached it would be written.
 */
function standIns(): Models {
  const base = fakeModels(options);
  return {
    ...base,
    async complete(route, messages, schema, opts) {
      const user = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
      if (route !== "write" || !user.startsWith("{")) return base.complete(route, messages, schema, opts);
      options.calls.write = (options.calls.write ?? 0) + 1;
      options.inputs.push(JSON.stringify(messages));
      const asked = JSON.parse(user) as { facts?: { id: string; roleId: string | null; text: string }[]; lines?: { lineId: string; text: string }[] };
      if (asked.lines) return schema.parse({ edits: asked.lines.map((line) => ({ lineId: line.lineId, text: rewrite(line.text) })) });
      const chosen = (asked.facts ?? []).filter((fact) => !writeOnly || writeOnly.includes(fact.text)).slice(0, 24);
      return schema.parse({ units: chosen.map((fact) => ({ roleId: fact.roleId, text: fact.text, factIds: [fact.id], group: 0 })) });
    },
  };
}

beforeEach(() => {
  options = { calls: {}, inputs: [] };
  writeOnly = null;
  rewrite = (line) => line;
  setModels(() => standIns());
  printAsText();
});

type VaultStub = ReturnType<typeof vault>;
const fenced: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  setModels(null);
  setPdfRenderer(null);
  for (const lift of fenced.splice(0).reverse()) await lift();
});
/** Sets the deployment's maintenance fence, as this one object reads it, to these vaults until the test ends. */
async function fence(target: VaultStub | ReturnType<typeof directory>, ids: string[]): Promise<void> {
  const prior = await runInDurableObject(target, (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    const before = local.RESTORE_FENCE_IDS;
    local.RESTORE_FENCE_IDS = ids.join(",");
    return before;
  });
  fenced.push(() =>
    runInDurableObject(target, (instance) => {
      (instance as unknown as { env: Env }).env.RESTORE_FENCE_IDS = prior;
    }),
  );
}

function sessionOf(user: User) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  return JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { uid: string; vid: string; gen: number; epoch?: string; email?: string };
}
const vaultOf = (user: User) => vault(env, sessionOf(user).vid);
const whoOf = (user: User) => ({ userId: sessionOf(user).uid, gen: sessionOf(user).gen, epoch: sessionOf(user).epoch });
const sql = <T>(user: User, work: (sql: SqlStorage) => T) => runInDurableObject(vaultOf(user), (_instance, state) => work(state.storage.sql));
const count = (user: User, table: string, where = "1 = 1") => sql(user, (db) => db.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).one().n);

/** Uploads a file and waits until it has been read. */
async function read(user: User, filename: string, content: string): Promise<string> {
  const response = await user.upload(filename, content);
  expect(response.status, await response.clone().text()).toBe(201);
  const { sourceId } = (await response.json()) as { sourceId: string };
  expect(await waitForSource(user, sourceId)).toMatchObject({ state: "ready", error: null });
  return sourceId;
}
const facts = async (user: User) => (await user.json<{ facts: FactView[] }>("/api/facts")).facts;
/** The one fact with these words. */
async function factOf(user: User, text: string): Promise<FactView> {
  const found = (await facts(user)).filter((fact) => fact.text === text);
  expect(found, text).toHaveLength(1);
  return found[0]!;
}
/** Confirm all: every role and every fact in the vault. */
async function confirmEverything(user: User): Promise<void> {
  const { roles } = await user.json<{ roles: { id: string }[] }>("/api/roles");
  const confirm = [...(await facts(user)).map((fact) => fact.id), ...roles.map((role) => role.id)];
  expect((await user.send("POST", "/api/review", { confirm, reject: [] })).status).toBe(204);
}
/** Someone whose resume has been read, with every role and fact confirmed. */
async function reader(content = RESUME): Promise<User> {
  const user = await signIn();
  await read(user, "jane-doe.pdf", content);
  await confirmEverything(user);
  return user;
}
const mark = (user: User, ids: string[], sensitive = true, expectedRevisions?: Record<string, number>) =>
  user.send("POST", "/api/facts/sensitive", { ids, sensitive, ...(expectedRevisions ? { expectedRevisions } : {}) });
/** Marks the one fact with each of these wordings, and gives them back. */
async function marked(user: User, ...texts: string[]): Promise<FactView[]> {
  const chosen = [];
  for (const text of texts) chosen.push(await factOf(user, text));
  expect((await mark(user, chosen.map((fact) => fact.id))).status).toBe(204);
  return chosen;
}
/** The facts anything generated, copied or shown to someone else may use. */
const usable = (user: User) => runInDurableObject(vaultOf(user), (instance) => (instance as unknown as { usableFacts(): FactRecord[] }).usableFacts());
/** What the vault stores for a fact that a draft in flight is compared against, and its mark. */
const stored = (user: User, id: string) =>
  sql(user, (db) => {
    const row = db
      .exec<Record<string, SqlStorageValue>>(
        `SELECT f.text, f.revision, f.origin, f.level, f.level_revision, f.state, f.updated_at, f.vector, f.sensitive, i.value AS incarnation
         FROM facts f JOIN entity_incarnations i ON i.kind = 'fact' AND i.item_id = f.id WHERE f.id = ?`,
        id,
      )
      .one();
    return { ...row, vector: row.vector instanceof ArrayBuffer ? [...new Uint8Array(row.vector)] : row.vector };
  });

async function job(user: User): Promise<string> {
  const response = await user.send("POST", "/api/applications", { jdText: JOB_DESCRIPTION });
  expect(response.status).toBe(201);
  return ((await response.json()) as { applicationId: string }).applicationId;
}
const resumeOf = (user: User, id: string, version?: number) => user.json<ResumeView>(`/api/resumes/${id}${version ? `?version=${version}` : ""}`);
async function finishedResume(user: User, resumeId: string): Promise<ResumeView> {
  return eventually(async () => {
    const resume = await resumeOf(user, resumeId);
    return resume.state !== "running" ? resume : null;
  }, "the resume to finish", WAIT);
}
async function tailor(user: User, applicationId: string): Promise<ResumeView> {
  const started = await user.send("POST", `/api/applications/${applicationId}/resumes`);
  expect(started.status, await started.clone().text()).toBe(202);
  return finishedResume(user, ((await started.json()) as { resumeId: string }).resumeId);
}
const linesOf = (resume: ResumeView): ResumeLine[] => [...(resume.body!.summary ? [resume.body!.summary] : []), ...resume.body!.sections.flatMap((section) => section.lines)];
const lineOf = (resume: ResumeView, text: string) => linesOf(resume).find((line) => line.text === text)!;

const startDocument = (user: User, applicationId: string, options: NewDocument) =>
  user.fetch(`/api/applications/${applicationId}/documents`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(options),
  });
async function finishedDocument(user: User, documentId: string): Promise<DocumentView> {
  return eventually(async () => {
    const made = await user.json<DocumentView>(`/api/documents/${documentId}`);
    return made.state !== "running" ? made : null;
  }, "the document to finish", WAIT);
}
/** Starts a document and waits for it. It has finished or failed; the caller says which it expects. */
async function document(user: User, applicationId: string, options: NewDocument): Promise<DocumentView> {
  const started = await startDocument(user, applicationId, options);
  expect(started.status, await started.clone().text()).toBe(202);
  return finishedDocument(user, ((await started.json()) as { documentId: string }).documentId);
}
/** Gives the account its month's outputs back, so one test can make more than a month allows. */
const refill = (user: User) => sql(user, (db) => void db.exec(`UPDATE quota_buckets SET used = 0`));
const quota = async (user: User) => (await user.json<Me>("/api/me")).quota;

type Copy = { grant: ShareGrant; token: string };
async function share(user: User, body: Record<string, unknown>): Promise<Copy> {
  const response = await user.send("POST", "/api/shares", { factIds: [], resumes: [], ...body });
  expect(response.status, await response.clone().text()).toBe(201);
  const { grant, url } = (await response.json()) as { grant: ShareGrant; url: string };
  return { grant, token: new URL(url).hash.slice(1) };
}
/** Exchanges a link for its session, as the reader's browser does. */
const exchange = (copy: Copy) => call("/share/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: copy.token }) });
/** Opens a link as its reader would and reads the copy. */
async function open(copy: Copy): Promise<Response> {
  const session = await exchange(copy);
  if (session.status !== 200) return session;
  return call(`/share/snapshot?g=${copy.grant.id}`, { cookie: cookieFrom(session, `__Host-share-${copy.grant.id}`)! });
}
const grants = async (user: User) => (await user.json<{ grants: ShareGrant[] }>("/api/shares")).grants;
const shareable = async (user: User) => (await user.json<{ documents: ShareableDocument[] }>("/api/documents")).documents;

describe("marking a fact sensitive", () => {
  it("leaves it its owner's to read and export, with its mark and nothing else changed", async () => {
    const user = await reader();
    const led = await factOf(user, LED);
    const before = { all: await facts(user), row: await stored(user, led.id) };
    expect(before.row).toMatchObject({ sensitive: 0, origin: "extracted", level: "led", state: "confirmed" });
    expect(before.row.vector).not.toBeNull();

    const response = await mark(user, [led.id], true, { [led.id]: led.revision! });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    // The mark and nothing else: not the revision or the incarnation a draft compares, nor the
    // origin, the level, the time it was last changed or its place in the search index.
    expect(await stored(user, led.id)).toEqual({ ...before.row, sensitive: 1 });
    // Every fact is still listed, in the same order, and only this one says it is marked.
    expect(await facts(user)).toEqual(before.all.map((fact) => (fact.id === led.id ? { ...fact, sensitive: true } : fact)));
    const review = await user.json<{ facts: FactView[] }>("/api/v2/vault");
    expect(review.facts.filter((fact) => fact.sensitive).map((fact) => fact.id)).toEqual([led.id]);
    const exported = await user.json<{ format: number; facts: FactView[] }>("/api/export");
    expect(exported.format).toBe(2);
    expect(exported.facts.filter((fact) => fact.sensitive)).toMatchObject([{ id: led.id, text: LED, quote: led.quote, sensitive: true }]);
    expect(exported.facts).toHaveLength(before.all.length);

    // A repeat changes nothing.
    expect((await mark(user, [led.id])).status).toBe(204);
    expect(await stored(user, led.id)).toEqual({ ...before.row, sensitive: 1 });

    // Unmarked, it is exactly as it was before either request.
    expect((await mark(user, [led.id], false)).status).toBe(204);
    expect(await stored(user, led.id)).toEqual(before.row);
    expect(await facts(user)).toEqual(before.all);
    expect((await mark(user, [led.id], false)).status).toBe(204);
    expect(await facts(user)).toEqual(before.all);
  });

  it("calls no model to mark or unmark, and stays on a fact its owner then edits", async () => {
    const user = await reader();
    const mentored = await factOf(user, MENTORED);
    const before = { calls: { ...options.calls }, inputs: options.inputs.length, runs: await count(user, "runs"), attempts: await count(user, "model_attempts") };
    for (const sensitive of [true, false, true]) expect((await mark(user, [mentored.id], sensitive)).status).toBe(204);
    expect(options.calls).toEqual(before.calls);
    expect(options.inputs).toHaveLength(before.inputs);
    expect(await count(user, "runs")).toBe(before.runs);
    expect(await count(user, "model_attempts")).toBe(before.attempts);

    // It stays editable, and the edit keeps the mark.
    const edit = await user.send("PATCH", `/api/facts/${mentored.id}`, { text: "Mentored 3 junior engineers", expectedRevision: mentored.revision });
    expect(edit.status, await edit.clone().text()).toBe(204);
    expect((await facts(user)).find((fact) => fact.id === mentored.id)).toMatchObject({ text: "Mentored 3 junior engineers", origin: "user", revision: mentored.revision! + 1, sensitive: true });
    expect((await usable(user)).map((fact) => fact.id)).not.toContain(mentored.id);
    // The search index is the vault's own, and an edit renews a marked fact's place in it as it
    // does any fact's: the indexing model is sent the new words. No copy says otherwise.
    expect(options.calls.embed).toBe((before.calls.embed ?? 0) + 1);
    expect(options.inputs.slice(before.inputs)).toEqual(["Mentored 3 junior engineers"]);
  });

  it("marks and unmarks every fact with the same words, and the same words in a later upload arrive marked", async () => {
    const user = await signIn();
    await read(user, "jane-doe.pdf", RESUME);
    await read(user, "jane-doe-2024.pdf", `${RESUME}\nReferences on request.\n`);
    const copies = async (text: string) => (await facts(user)).filter((fact) => fact.text === text || fact.text === `${text}.`);
    const marks = async (text: string) => (await copies(text)).map((fact) => [fact.state, fact.sensitive === true]);
    expect(await facts(user)).toHaveLength(16);

    // One copy is named. The other upload's copy of the line goes with it, and no other line does.
    const [led] = await copies(LED);
    expect((await mark(user, [led!.id])).status).toBe(204);
    expect(await marks(LED)).toEqual([["proposed", true], ["proposed", true]]);
    expect((await facts(user)).filter((fact) => fact.sensitive)).toHaveLength(2);

    // Whatever state each copy is in, and however it is punctuated or came to be there.
    const [first, second] = await copies(MENTORED);
    expect((await user.send("POST", "/api/review", { confirm: [], reject: [second!.id] })).status).toBe(204);
    const typed = await user.send("POST", "/api/facts", { roleId: null, kind: "accomplishment", text: `${MENTORED}.`, level: null });
    expect(typed.status).toBe(201);
    const other = await user.send("POST", "/api/facts", { roleId: null, kind: "accomplishment", text: `${MENTORED} every quarter`, level: null });
    expect(other.status).toBe(201);
    expect((await mark(user, [first!.id])).status).toBe(204);
    expect((await marks(MENTORED)).sort()).toEqual([["confirmed", true], ["proposed", true], ["rejected", true]]);
    // Words that say more are other words.
    expect((await factOf(user, `${MENTORED} every quarter`)).sensitive).toBeUndefined();

    // Unmarking by any one copy unmarks them all, and leaves the other line marked.
    expect((await mark(user, [((await typed.json()) as { factId: string }).factId], false)).status).toBe(204);
    expect((await marks(MENTORED)).sort()).toEqual([["confirmed", false], ["proposed", false], ["rejected", false]]);
    expect(await marks(LED)).toEqual([["proposed", true], ["proposed", true]]);

    // A third upload says the marked line again. Its copy arrives marked, and nothing else of it does.
    const third = await read(user, "jane-doe-2025.pdf", `${RESUME}\nAvailable from January.\n`);
    const arrived = (await facts(user)).filter((fact) => fact.sourceId === third);
    expect(arrived).toHaveLength(8);
    expect(arrived.filter((fact) => fact.sensitive).map((fact) => fact.text)).toEqual([LED]);
    expect(await marks(LED)).toEqual([["proposed", true], ["proposed", true], ["proposed", true]]);

    // Confirm all puts every copy in the confirmed list, and none of the marked ones in use.
    await confirmEverything(user);
    expect((await marks(LED)).map(([state]) => state)).toEqual(["confirmed", "confirmed", "confirmed"]);
    const inUse = (await usable(user)).map((fact) => fact.text);
    expect(inUse).not.toContain(LED);
    expect(inUse.filter((text) => text === GO_SERVICE)).toHaveLength(3);
  });

  it("is not passed on to a fact its owner types, edits or gives as an interview answer", async () => {
    const user = await reader();
    const [original] = await marked(user, MENTORED);

    // Typed with the same words.
    const typed = await user.send("POST", "/api/facts", { roleId: null, kind: "accomplishment", text: MENTORED, level: null });
    expect(typed.status).toBe(201);
    // Another fact edited to say the same words.
    const react = await factOf(user, REACT);
    expect((await user.send("PATCH", `/api/facts/${react.id}`, { text: MENTORED })).status).toBe(204);
    // An interview answer in the same words.
    const questions = await document(user, await job(user), { kind: "questions" });
    expect(questions.state, questions.error ?? "").toBe("ready");
    const answered = await user.fetch(`/api/documents/${questions.id}/questions/${questions.result!.questions[0]!.id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ roleId: null, answer: MENTORED }),
    });
    expect(answered.status, await answered.clone().text()).toBe(201);

    const same = (await facts(user)).filter((fact) => fact.text === MENTORED);
    expect(same).toHaveLength(4);
    // Each is the owner's own claim, made after the mark, and the mark was not theirs to inherit.
    expect(same.filter((fact) => fact.sensitive).map((fact) => fact.id)).toEqual([original!.id]);
    expect((await usable(user)).filter((fact) => fact.text === MENTORED)).toHaveLength(3);

    // Each can be marked like any other fact, and then the words are marked wherever they are.
    expect((await mark(user, [((await typed.json()) as { factId: string }).factId])).status).toBe(204);
    expect((await facts(user)).filter((fact) => fact.text === MENTORED && fact.sensitive)).toHaveLength(4);
    expect((await usable(user)).filter((fact) => fact.text === MENTORED)).toEqual([]);
  });

  it("is kept when an upload is read again and its only marked copy was one of the proposals being replaced", async () => {
    const user = await signIn();
    const sourceId = await read(user, "jane-doe.pdf", RESUME);
    const led = await factOf(user, LED);
    expect(led.state).toBe("proposed");
    expect((await mark(user, [led.id])).status).toBe(204);

    // The reading as a retried extract step saves it again, in a vault from before a finished
    // reading left a receipt: its earlier proposals are deleted and written afresh.
    const { extraction } = await extractFacts(fakeModels(), RESUME);
    await runInDurableObject(vaultOf(user), async (instance, state) => {
      state.storage.sql.exec(`DELETE FROM extraction_commits WHERE source_id = ?`, sourceId);
      state.storage.sql.exec(`UPDATE runs SET state = 'running' WHERE id = ?`, sourceId);
      expect(await instance.saveExtraction(sourceId, extraction, sourceId)).toEqual({ roles: 3, facts: 8 });
      state.storage.sql.exec(`UPDATE runs SET state = 'succeeded' WHERE id = ?`, sourceId);
    });

    const again = await facts(user);
    expect(again).toHaveLength(8);
    // The marked proposal itself is gone, and the line it said is marked on arrival.
    expect(again.map((fact) => fact.id)).not.toContain(led.id);
    expect(again.filter((fact) => fact.sensitive).map((fact) => fact.text)).toEqual([LED]);
  });

  it("refuses anyone but the owner, an unknown fact, a malformed request and a stale page, and changes nothing", async () => {
    const alice = await reader();
    const bob = await reader();
    const fact = await factOf(alice, MENTORED);
    const other = await factOf(alice, GO_SERVICE);
    const post = (as: User, body: unknown) => as.send("POST", "/api/facts/sensitive", body);
    const refusal = async (response: Response) => [response.status, ((await response.json()) as { error: string }).error];

    // The vault is the caller's own, so another person's fact is not there to be found.
    expect(await refusal(await post(bob, { ids: [fact.id], sensitive: true }))).toEqual([404, "not_found"]);
    expect(await refusal(await post(alice, { ids: [crypto.randomUUID()], sensitive: true }))).toEqual([404, "not_found"]);
    // One unknown fact refuses the whole request: the fact named beside it is not marked.
    expect(await refusal(await post(alice, { ids: [fact.id, "no-such-fact"], sensitive: true }))).toEqual([404, "not_found"]);
    // A role is not a fact.
    const { roles } = await alice.json<{ roles: { id: string }[] }>("/api/roles");
    expect(await refusal(await post(alice, { ids: [roles[0]!.id], sensitive: true }))).toEqual([404, "not_found"]);

    for (const body of [
      { ids: [], sensitive: true },
      { ids: Array.from({ length: MAX_SENSITIVE_IDS + 1 }, (_, index) => `fact-${index}`), sensitive: true },
      { ids: [fact.id, fact.id], sensitive: true },
      { ids: fact.id, sensitive: true },
      { ids: [fact.id] },
      { ids: [fact.id], sensitive: "yes" },
      { ids: [fact.id], sensitive: true, userId: sessionOf(alice).uid },
      { ids: [fact.id], sensitive: true, expectedRevisions: { [fact.id]: "1" } },
      { sensitive: true },
    ])
      expect(await refusal(await post(alice, body)), JSON.stringify(body).slice(0, 60)).toEqual([422, "invalid"]);

    // The page showed an earlier revision of one of the facts it names.
    const stale = await post(alice, { ids: [fact.id, other.id], sensitive: true, expectedRevisions: { [fact.id]: fact.revision!, [other.id]: other.revision! + 1 } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "conflict", message: "Your facts changed. Refresh the page, then try again." });

    // No session, a session signed out since, and another site's page.
    const anonymous = await call("/api/facts/sensitive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [fact.id], sensitive: true }) });
    expect(anonymous.status).toBe(401);
    const crossSite = await alice.fetch("/api/facts/sensitive", { method: "POST", headers: { "content-type": "application/json", origin: "https://elsewhere.example" }, body: JSON.stringify({ ids: [fact.id], sensitive: true }) });
    expect(crossSite.status).toBe(403);
    // The vault asks who is calling for itself: an identity that is not its owner's is refused there too.
    await runInDurableObject(vaultOf(alice), async (instance) => {
      await expect(instance.markSensitive(whoOf(bob), { ids: [fact.id], sensitive: true })).rejects.toThrow("forbidden");
      await expect(instance.markSensitive({ ...whoOf(alice), gen: sessionOf(alice).gen + 1 }, { ids: [fact.id], sensitive: true })).rejects.toThrow("unauthenticated");
      await expect(instance.markSensitive(whoOf(alice), { ids: Array.from({ length: MAX_SENSITIVE_IDS + 1 }, (_, index) => `fact-${index}`), sensitive: true })).rejects.toThrow("choose 1 to 200 facts");
    });

    expect(await count(alice, "facts", "sensitive <> 0")).toBe(0);
    expect(await count(bob, "facts", "sensitive <> 0")).toBe(0);
    // And the same requests, well formed and current, from the owner: accepted.
    expect((await post(alice, { ids: [fact.id, other.id], sensitive: true, expectedRevisions: { [fact.id]: fact.revision!, [other.id]: other.revision! } })).status).toBe(204);
    expect(await count(alice, "facts", "sensitive <> 0")).toBe(2);
    expect((await alice.send("POST", "/api/account/sign-out-everywhere")).status).toBe(204);
    expect((await post(alice, { ids: [fact.id], sensitive: false })).status).toBe(401);
    expect(await count(alice, "facts", "sensitive <> 0")).toBe(2);
  });
});

describe("what leaves the vault once a fact is marked", () => {
  /** The surfaces that carry what facts say. A list of jobs and a coach's list of clients hold none. */
  const CARRY_FACTS: OutwardPart["surface"][] = ["copy by its link", "copy as its coach", "list_facts", "search_facts", "get_resume", "PDF", "Word", "print preview", "model input"];
  const carried = (parts: OutwardPart[], words: string) => CARRY_FACTS.filter((surface) => parts.some((part) => part.surface === surface && part.text.includes(words)));

  it("never holds its words: not a copy, a tool's answer, a download or anything sent to a model", async () => {
    options.extraction = EXTRACTION_WITH_SECRETS;
    const user = await reader(RESUME_WITH_SECRETS);
    expect((await user.send("PUT", "/api/profile", { name: "Jane Doe" })).status).toBe(200);
    expect(await facts(user)).toHaveLength(10);
    const applicationId = await job(user);
    const coach = await signIn(uniqueEmail("coach"));

    // The control. Unmarked, the words go out by every one of these ways, and in each kind of copy:
    // one of the facts themselves, one of a resume and one of a letter.
    const first = await tailor(user, applicationId);
    expect(first.state, first.error ?? "").toBe("ready");
    expect(linesOf(first).map((line) => line.text)).toContain(SECRET_LINE);
    const firstLetter = await document(user, applicationId, { kind: "letter" });
    expect(firstLetter.state, firstLetter.error ?? "").toBe("ready");
    const early = [
      { ...(await share(user, { factIds: (await facts(user)).map((fact) => fact.id), coachEmail: coach.email })), coach },
      await share(user, { resumes: [{ id: first.id, version: first.version }] }),
      await share(user, { documents: [{ id: firstLetter.id, version: 1 }] }),
    ];
    for (const copy of early) {
      const alone = await outwardParts({ owner: user, copies: [copy], inputs: [] });
      expect(carried(alone, SECRET), copy.grant.id).toContain("copy by its link");
    }
    const control = await outwardParts({ owner: user, copies: early, inputs: options.inputs });
    expect(carried(control, SECRET)).toEqual(CARRY_FACTS);
    expect(carried(control, SECRET_SKILL)).toEqual(expect.arrayContaining(["copy by its link", "copy as its coach", "list_facts", "search_facts", "model input"]));

    const secrets = await marked(user, SECRET_LINE, SECRET_SKILL);
    options.inputs.length = 0;
    // At once, before anything new is made: what already used them is closed.
    const closed = await outward({ owner: user, copies: early, inputs: options.inputs });
    expect(closed).not.toContain(SECRET);
    expect(closed).not.toContain(SECRET_SKILL);

    // Everything the app can make, all of it started after the mark.
    await refill(user);
    const resume = await tailor(user, applicationId);
    expect(resume.state, resume.error ?? "").toBe("ready");
    rewrite = (line) => (line === GO_SERVICE ? "Built a Go service" : line);
    const refinement = await document(user, applicationId, { kind: "refine", resumeId: resume.id, expectedVersion: resume.version, instruction: "Make it shorter" });
    const letter = await document(user, applicationId, { kind: "letter" });
    await refill(user);
    const preparation = await document(user, applicationId, { kind: "prep" });
    const gaps = await document(user, applicationId, { kind: "questions" });
    const fit = await document(user, applicationId, { kind: "fit" });
    for (const made of [refinement, letter, preparation, gaps, fit]) expect(made.state, `${made.kind} ${made.error ?? ""}`).toBe("ready");
    const refined = await resumeOf(user, resume.id);
    expect(refined.version).toBe(resume.version + 1);

    const inUse = (await facts(user)).filter((fact) => !fact.sensitive).map((fact) => fact.id);
    expect(inUse).toHaveLength(8);
    const late = {
      ...(await share(user, {
        factIds: inUse,
        resumes: [{ id: resume.id, version: resume.version }, { id: resume.id, version: refined.version }],
        documents: [{ id: letter.id, version: 1 }, { id: preparation.id, version: 1 }],
        coachEmail: coach.email,
      })),
      coach,
    };
    const parts = await outwardParts({ owner: user, copies: [...early, late], inputs: options.inputs });
    const sent = parts.map((part) => part.text).join("\n");
    expect(sent).not.toContain(SECRET);
    expect(sent).not.toContain(SECRET_SKILL);
    // That is not for want of looking: every one of those ways out carried the facts left in use,
    // and the models were asked to write from them.
    expect(carried(parts, "Built a Go service")).toEqual(CARRY_FACTS);
    expect(options.calls.write).toBeGreaterThanOrEqual(4);
    // What its owner is shown of the new work doesn't hold the words either: none of it was made from them.
    for (const made of [refined, letter, preparation, gaps, fit]) {
      expect(JSON.stringify(made)).not.toContain(SECRET);
      expect(JSON.stringify(made)).not.toContain(SECRET_SKILL);
    }
    // The marked facts are still the owner's to read.
    expect((await facts(user)).filter((fact) => fact.sensitive).map((fact) => fact.id).sort()).toEqual(secrets.map((fact) => fact.id).sort());
  }, 240_000);

  it("writes from a fact read off a marked fact's line with that fact's own words, and never the line", async () => {
    const user = await signIn();
    await read(user, "jane-doe.pdf", RESUME);
    // Only the three skills are confirmed, so nothing else in use here says "Kubernetes".
    const skills = (await facts(user)).filter((fact) => fact.kind === "skill");
    expect(skills.map((fact) => fact.text).sort()).toEqual(["Go", "Kubernetes", "PostgreSQL"]);
    expect(skills.every((fact) => fact.quote === SKILLS)).toBe(true);
    expect((await user.send("POST", "/api/review", { confirm: skills.map((fact) => fact.id), reject: [] })).status).toBe(204);
    // The posting names the skill that is about to be marked.
    expect(JOB_DESCRIPTION).toContain("Kubernetes");
    const applicationId = await job(user);

    /** What each fact was given to the models as, in the calls that write and check sentences. */
    const given = () => {
      const texts: string[] = [], quotes: (string | null)[] = [], sentences: string[] = [];
      for (const input of options.inputs) {
        if (!input.startsWith("[")) continue;
        const content = (JSON.parse(input) as { role: string; content: string }[]).filter((message) => message.role === "user").at(-1)!.content;
        if (!content.startsWith("{")) continue;
        const asked = JSON.parse(content) as { facts?: { text: string }[]; lines?: { text: string; facts: { text: string; quote: string | null }[] }[] };
        for (const fact of asked.facts ?? []) texts.push(fact.text);
        for (const line of asked.lines ?? []) {
          sentences.push(line.text);
          for (const fact of line.facts) {
            texts.push(fact.text);
            quotes.push(fact.quote);
          }
        }
      }
      return { texts: [...new Set(texts)].sort(), quotes: [...new Set(quotes)].sort(), sentences: [...new Set(sentences)].sort() };
    };

    // The control: unmarked, all three are written from, and each is checked against the whole list.
    const earlier = await document(user, applicationId, { kind: "letter" });
    expect(earlier.state, earlier.error ?? "").toBe("ready");
    expect(given()).toEqual({ texts: ["Go", "Kubernetes", "PostgreSQL"], quotes: [SKILLS], sentences: ["Go", "Kubernetes", "PostgreSQL"] });

    await marked(user, "Kubernetes");
    options.inputs.length = 0;
    const letter = await document(user, applicationId, { kind: "letter" });
    expect(letter.state, letter.error ?? "").toBe("ready");
    // The other two skills of the line are still written from, with their own words as their evidence.
    expect(letter.result!.units.map((unit) => unit.text).sort()).toEqual(["Go", "PostgreSQL"]);
    expect(given()).toEqual({ texts: ["Go", "PostgreSQL"], quotes: ["Go", "PostgreSQL"], sentences: ["Go", "PostgreSQL"] });
    // No model was sent the line, in any call, nor the marked word as a fact to rank or embed.
    expect(options.inputs.filter((input) => input.includes(SKILLS))).toEqual([]);
    expect(options.inputs).not.toContain("Kubernetes");
    // The posting's own requirements still say the word: a job asking for it is not the person saying it.
    expect(options.inputs.some((input) => input.includes("Kubernetes and deploy automation"))).toBe(true);
    // And the letter keeps what it was checked against as it was checked: the fact's own words.
    expect(Object.values(letter.facts).map((fact) => [fact.text, fact.quote]).sort()).toEqual([["Go", "Go"], ["PostgreSQL", "PostgreSQL"]]);
    expect(JSON.stringify(letter)).not.toContain("TypeScript");
  }, 120_000);

  it("won't share a letter written before the mark from a fact read off its line, and still prints that fact as a skill", async () => {
    const user = await reader();
    const applicationId = await job(user);
    // A letter that says "Go", checked while the whole skills list was that fact's quote.
    writeOnly = ["Go"];
    const letter = await document(user, applicationId, { kind: "letter" });
    expect(letter.state, letter.error ?? "").toBe("ready");
    expect(letter.result!.units.map((unit) => unit.text)).toEqual(["Go"]);
    const resume = await tailor(user, applicationId);
    expect(resume.state, resume.error ?? "").toBe("ready");
    expect([...resume.body!.skills].sort()).toEqual(["Go", "Kubernetes", "PostgreSQL"]);
    const copy = await share(user, { documents: [{ id: letter.id, version: 1 }] });
    expect((await open(copy)).status).toBe(200);
    expect(await shareable(user)).toMatchObject([{ id: letter.id, shareable: true }]);

    await marked(user, "Kubernetes");
    // The letter may rest on the marked word, which was in the line it was checked against.
    const listed = await shareable(user);
    expect(listed).toEqual([{ id: letter.id, kind: "letter", applicationId, version: 1, createdAt: expect.any(Number), shareable: false, usesSensitive: true }]);
    const refused = await user.send("POST", "/api/shares", { factIds: [], resumes: [], documents: [{ id: letter.id, version: 1 }] });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "conflict", message: expect.stringContaining("write it again") });
    expect((await open(copy)).status).toBe(410);
    expect((await grants(user))[0]).toMatchObject({ id: copy.grant.id, available: false });
    // Its owner still reads and downloads it.
    expect((await user.fetch(`/api/documents/${letter.id}/docx`)).status).toBe(200);

    // The resume prints the marked skill, and that is all that holds it back.
    const blocked = await resumeOf(user, resume.id);
    expect(blocked.sensitiveUse).toEqual({ lineIds: [], skills: ["Kubernetes"] });
    expect((await user.fetch(`/api/resumes/${resume.id}/pdf`)).status).toBe(409);
    const removed = await user.send("POST", `/api/resumes/${resume.id}/remove-skill`, { skillIndex: resume.body!.skills.indexOf("Kubernetes"), expectedVersion: resume.version });
    expect(removed.status, await removed.clone().text()).toBe(200);
    // "Go" and "PostgreSQL" were read from the same line. A skill prints as its own word, so they stay.
    const printed = await resumeOf(user, resume.id);
    expect([...printed.body!.skills].sort()).toEqual(["Go", "PostgreSQL"]);
    expect(printed.sensitiveUse).toBeUndefined();
    const pdf = await user.fetch(`/api/resumes/${resume.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(new TextDecoder().decode(await pdf.arrayBuffer())).toContain("PostgreSQL");

    // Unmarked, the letter can be shared again and its copy opens.
    expect((await mark(user, [(await factOf(user, "Kubernetes")).id], false)).status).toBe(204);
    expect(await shareable(user)).toMatchObject([{ id: letter.id, shareable: true }]);
    expect((await shareable(user))[0]).not.toHaveProperty("usesSensitive");
    expect((await open(copy)).status).toBe(200);
  }, 120_000);
});

describe("work in progress when a fact is marked", () => {
  it("stops at its next step, publishes nothing and gives the output back", async () => {
    let release!: () => void;
    options.hold = new Promise<void>((resolve) => (release = resolve));
    const user = await reader();
    const started = await user.send("POST", `/api/applications/${await job(user)}/resumes`);
    expect(started.status).toBe(202);
    const { resumeId, runId } = (await started.json()) as { resumeId: string; runId: string };
    // The run has captured its facts and is waiting on its first model call.
    await eventually(async () => options.calls.analyze === 1, "the run to reach its first model call", WAIT);
    expect(await quota(user)).toMatchObject({ used: 0, reserved: 1 });
    const sent = options.inputs.length;

    // A fact the run captured. No line has cited it, and none would: a skill is printed, not cited.
    await marked(user, "PostgreSQL");
    release();
    const resume = await finishedResume(user, resumeId);
    expect(resume).toMatchObject({ state: "failed", error: FACTS_CHANGED, body: null });
    expect(await quota(user)).toMatchObject({ used: 0, reserved: 0 });
    expect(await sql(user, (db) => db.exec(`SELECT state, credit_state FROM runs WHERE id = ?`, runId).one())).toEqual({ state: "failed", credit_state: "released" });
    expect(await count(user, "resume_versions")).toBe(0);
    // It went no further: nothing was ranked, written or judged after the mark.
    expect(options.inputs).toHaveLength(sent);
    expect(options.calls.write).toBeUndefined();
    expect(options.calls.judge).toBeUndefined();

    // A letter, the same way. Its job hasn't been read yet, so its first call is the held one.
    options.hold = new Promise<void>((resolve) => (release = resolve));
    const letter = await startDocument(user, await job(user), { kind: "letter" });
    expect(letter.status).toBe(202);
    const { documentId } = (await letter.json()) as { documentId: string };
    await eventually(async () => options.calls.analyze === 2, "the letter to reach its first model call", WAIT);
    expect(await quota(user)).toMatchObject({ used: 0, reserved: 1 });
    await marked(user, MENTORED);
    release();
    expect(await finishedDocument(user, documentId)).toMatchObject({ state: "failed", error: "conflict", result: null });
    expect(await quota(user)).toMatchObject({ used: 0, reserved: 0 });
    expect(await count(user, "document_versions")).toBe(0);
    expect(options.calls.write).toBeUndefined();

    // A run started now captures neither fact, and finishes.
    const next = await tailor(user, await job(user));
    expect(next.state, next.error ?? "").toBe("ready");
    expect(next.body!.skills).not.toContain("PostgreSQL");
    expect(linesOf(next).map((line) => line.text)).not.toContain(MENTORED);
  }, 120_000);

  it("reserves no further model call for a run that captured it", async () => {
    let release!: () => void;
    options.hold = new Promise<void>((resolve) => (release = resolve));
    const user = await reader();
    const started = await user.send("POST", `/api/applications/${await job(user)}/resumes`);
    const { resumeId, runId } = (await started.json()) as { resumeId: string; runId: string };
    await eventually(async () => options.calls.analyze === 1, "the run to reach its first model call", WAIT);

    // Stand-in models skip the budget, so the reservation every real call makes first is made here.
    const attempt = (attemptId = crypto.randomUUID()) => ({ attemptId, route: "write", model: "@cf/test/writer", inputChars: 100, maxOutputTokens: 100 });
    const reserve = (attemptId?: string) =>
      runInDurableObject(vaultOf(user), (instance) =>
        instance.reserveModelAttempt(runId, "select", attempt(attemptId), 1_000, 1_000_000).then(() => "reserved", (error: Error) => error.message));
    const reserved = crypto.randomUUID();
    expect(await reserve(reserved)).toBe("reserved");
    expect(await count(user, "model_attempts")).toBe(1);

    // Between that call and the next one of the same step, the owner marks a fact the run captured.
    await marked(user, MENTORED);
    expect(await reserve()).toBe(`conflict: ${FACTS_CHANGED}`);
    // Not even a repeat of the call already reserved goes out again.
    expect(await reserve(reserved)).toBe(`conflict: ${FACTS_CHANGED}`);
    expect(await count(user, "model_attempts")).toBe(1);

    release();
    expect(await finishedResume(user, resumeId)).toMatchObject({ state: "failed", error: FACTS_CHANGED, body: null });
    expect(await count(user, "resume_versions")).toBe(0);
    expect(await quota(user)).toMatchObject({ used: 0, reserved: 0 });
    // Unmarking does not revive the run. It lets the next one use the fact again.
    expect((await mark(user, [(await factOf(user, MENTORED)).id], false)).status).toBe(204);
    expect(await reserve()).toBe("conflict: this run no longer accepts writes");
    expect(await count(user, "model_attempts")).toBe(1);
  }, 120_000);
});

describe("a resume version that uses a marked fact", () => {
  it("can't be downloaded or previewed, says which lines and skills, and is freed by removing them or the mark", async () => {
    const user = await reader();
    const resume = await tailor(user, await job(user));
    expect(resume.state, resume.error ?? "").toBe("ready");
    const downloads = [`/api/resumes/${resume.id}/pdf`, `/api/resumes/${resume.id}/docx`, `/api/resumes/${resume.id}/preview`];
    const statuses = async (query = "") => Promise.all(downloads.map(async (path) => (await user.fetch(path + query)).status));
    // Downloaded once before the mark, so a rendered file is already kept for this version.
    expect(await statuses()).toEqual([200, 200, 200]);
    expect(resume.sensitiveUse).toBeUndefined();

    await marked(user, LED, "PostgreSQL");
    const blocked = await resumeOf(user, resume.id);
    // Its owner still reads all of it, and is told what holds it back.
    expect(blocked.body).toEqual(resume.body);
    expect(blocked.sensitiveUse).toEqual({ lineIds: [lineOf(resume, LED).id], skills: ["PostgreSQL"] });
    // It is not a version whose evidence needs review, and line-by-line review is not offered for it.
    expect(blocked.needsGroundingReview).toBeUndefined();
    const review = await user.send("POST", `/api/resumes/${resume.id}/grounding-review`, { expectedVersion: resume.version });
    expect(review.status).toBe(409);
    for (const path of downloads) {
      const refused = await user.fetch(path);
      expect(refused.status, path).toBe(409);
      expect(await refused.json(), path).toEqual({ error: "conflict", message: USES_SENSITIVE });
    }
    expect(await statuses(`?version=${resume.version}`)).toEqual([409, 409, 409]);

    // Removing the line leaves the skill, and the version made that way is still held back.
    const withoutLine = await user.send("POST", `/api/resumes/${resume.id}/remove-line`, { lineId: lineOf(resume, LED).id, expectedVersion: resume.version });
    expect(withoutLine.status, await withoutLine.clone().text()).toBe(200);
    const second = await resumeOf(user, resume.id);
    expect(second.version).toBe(resume.version + 1);
    expect(second.sensitiveUse).toEqual({ lineIds: [], skills: ["PostgreSQL"] });
    expect(await statuses()).toEqual([409, 409, 409]);
    // Removing the skill as well frees the new version. Removal costs nothing.
    const withoutSkill = await user.send("POST", `/api/resumes/${resume.id}/remove-skill`, { skillIndex: second.body!.skills.indexOf("PostgreSQL"), expectedVersion: second.version });
    expect(withoutSkill.status, await withoutSkill.clone().text()).toBe(200);
    const third = await resumeOf(user, resume.id);
    expect(third.sensitiveUse).toBeUndefined();
    expect(await statuses()).toEqual([200, 200, 200]);
    expect(await quota(user)).toMatchObject({ used: 1, reserved: 0 });
    const page = await (await user.fetch(`/api/resumes/${resume.id}/preview`)).text();
    expect(page).toContain("Built a Go service");
    expect(page).not.toContain("Led the migration");
    expect(page).not.toContain("PostgreSQL");
    // The earlier versions are kept as they were, and stay held back while the mark stands.
    expect(await statuses(`?version=${resume.version}`)).toEqual([409, 409, 409]);
    expect(await statuses(`?version=${second.version}`)).toEqual([409, 409, 409]);
    expect((await resumeOf(user, resume.id, resume.version)).sensitiveUse).toEqual(blocked.sensitiveUse);

    // Unmarking frees them too: nothing about them was changed.
    const [led, postgres] = [await factOf(user, LED), await factOf(user, "PostgreSQL")];
    expect((await mark(user, [led.id, postgres.id], false)).status).toBe(204);
    expect(await statuses(`?version=${resume.version}`)).toEqual([200, 200, 200]);
    expect((await resumeOf(user, resume.id, resume.version)).sensitiveUse).toBeUndefined();
    expect(await (await user.fetch(`/api/resumes/${resume.id}/preview?version=${resume.version}`)).text()).toContain("Led the migration");
  }, 120_000);

  it("can't be refined or have a line edited, and a marked fact can't be chosen as a line's evidence", async () => {
    const user = await reader();
    const applicationId = await job(user);
    const resume = await tailor(user, applicationId);
    expect(resume.state, resume.error ?? "").toBe("ready");
    const [mentored] = await marked(user, MENTORED);
    const go = await factOf(user, GO_SERVICE);
    const before = { documents: await count(user, "documents"), runs: await count(user, "runs"), write: options.calls.write };
    const refine = (extra: Partial<NewDocument>, version = resume.version) => startDocument(user, applicationId, { kind: "refine", resumeId: resume.id, expectedVersion: version, ...extra });
    const refusal = async (response: Response) => [response.status, await response.json()];

    // By an instruction, by an edit to the line that cites the fact, and by an edit to any other line.
    for (const extra of [
      { instruction: "Make it shorter" },
      { lineIds: [lineOf(resume, MENTORED).id], manualText: "Mentored junior engineers" },
      { lineIds: [lineOf(resume, GO_SERVICE).id], manualText: "Built a Go service" },
      { lineIds: [lineOf(resume, GO_SERVICE).id], manualText: "Built a Go service", manualFactIds: [go.id] },
    ])
      expect(await refusal(await refine(extra)), JSON.stringify(extra)).toEqual([409, { error: "conflict", message: USES_SENSITIVE }]);

    // With the line that cited it removed, the version can be worked on again.
    const removed = await user.send("POST", `/api/resumes/${resume.id}/remove-line`, { lineId: lineOf(resume, MENTORED).id, expectedVersion: resume.version });
    expect(removed.status).toBe(200);
    const clean = await resumeOf(user, resume.id);
    expect(clean.sensitiveUse).toBeUndefined();
    // But the marked fact is evidence for nothing: it can't be chosen to check a line against.
    const line = lineOf(clean, GO_SERVICE).id;
    expect(await refusal(await refine({ lineIds: [line], manualText: "Mentored 2 junior engineers", manualFactIds: [mentored!.id] }, clean.version))).toEqual([
      422,
      { error: "invalid", message: "Choose facts that aren't marked sensitive." },
    ]);
    expect(await refusal(await refine({ lineIds: [line], manualText: "Built a Go service", manualFactIds: [go.id, mentored!.id] }, clean.version))).toEqual([
      422,
      { error: "invalid", message: "Choose facts that aren't marked sensitive." },
    ]);
    // Nothing was started by any of that.
    expect({ documents: await count(user, "documents"), runs: await count(user, "runs"), write: options.calls.write }).toEqual(before);
    expect(await quota(user)).toMatchObject({ used: 1, reserved: 0 });

    // A fact that isn't marked is chosen as it always could be.
    const edited = await refine({ lineIds: [line], manualText: "Built a Go service", manualFactIds: [go.id] }, clean.version);
    expect(edited.status, await edited.clone().text()).toBe(202);
    expect((await finishedDocument(user, ((await edited.json()) as { documentId: string }).documentId)).state).toBe("ready");
    expect(linesOf(await resumeOf(user, resume.id)).map((item) => item.text)).toContain("Built a Go service");
  }, 120_000);
});

describe("an older version under review", () => {
  it("no longer counts a line as checked once the fact it was checked against is marked, and can't be finished until it is unmarked", async () => {
    const user = await reader();
    const applicationId = await job(user);
    const resume = await tailor(user, applicationId);
    expect(resume.state, resume.error ?? "").toBe("ready");
    // Make it a version from before evidence was kept: one job's lines, and nothing stored to prove them.
    const section = resume.body!.sections.find((item) => item.lines.some((line) => line.text === MENTORED))!;
    const ids = section.lines.map((line) => line.id);
    await sql(user, (db) => {
      const saved = JSON.parse(db.exec<{ data: string }>(`SELECT data FROM resume_versions WHERE resume_id = ? AND version = ?`, resume.id, resume.version).one().data);
      saved.render.body = { summary: null, skills: [], sections: saved.render.body.sections.filter((item: { roleId: string }) => item.roleId === section.roleId) };
      saved.provenance = "legacy";
      delete saved.evidence;
      delete saved.legacyReceipts;
      db.exec(`UPDATE resume_versions SET data = ? WHERE resume_id = ? AND version = ?`, JSON.stringify(saved), resume.id, resume.version);
      db.exec(`UPDATE resumes SET body = ? WHERE id = ?`, JSON.stringify(saved.render.body), resume.id);
    });
    // Its owner checks each line again, against the facts it was written from.
    const check = async (line: ResumeLine, factIds = line.factIds) =>
      startDocument(user, applicationId, { kind: "refine", resumeId: resume.id, expectedVersion: (await resumeOf(user, resume.id)).version, lineIds: [line.id], manualText: line.text, manualFactIds: factIds });
    for (const line of section.lines) {
      await refill(user);
      const started = await check(line);
      expect(started.status, await started.clone().text()).toBe(202);
      expect((await finishedDocument(user, ((await started.json()) as { documentId: string }).documentId)).state).toBe("ready");
    }
    const reviewed = await resumeOf(user, resume.id);
    expect(reviewed.legacyReview).toEqual({ verifiedLineIds: ids, totalLines: ids.length, headersReady: true, skillsReady: true });
    expect(reviewed.sensitiveUse).toBeUndefined();
    const finish = (version: number) => user.send("POST", `/api/resumes/${resume.id}/legacy-finalize`, { expectedVersion: version });

    const [mentored] = await marked(user, MENTORED);
    const line = section.lines.find((item) => item.text === MENTORED)!;
    // It can't be finished into a version that could be downloaded or shared, and nothing is saved.
    expect((await finish(reviewed.version)).status).toBe(409);
    const held = await resumeOf(user, resume.id);
    expect(held.version).toBe(reviewed.version);
    // The line's check no longer counts: the fact it rests on is evidence for nothing while it is
    // marked. Its owner is shown which line that is, and every other line's check stands.
    expect(held.legacyReview).toEqual({ verifiedLineIds: ids.filter((id) => id !== line.id), totalLines: ids.length, headersReady: true, skillsReady: true });
    expect(held.sensitiveUse).toEqual({ lineIds: [line.id], skills: [] });
    // Nor can the line be checked against the marked fact again.
    const again = await check(line, [mentored!.id]);
    expect([again.status, await again.json()]).toEqual([422, { error: "invalid", message: "Choose facts that aren't marked sensitive." }]);
    expect((await resumeOf(user, resume.id)).version).toBe(reviewed.version);

    // Unmarked, the check counts again, because nothing was rewritten, and the version can be finished.
    expect((await mark(user, [mentored!.id], false)).status).toBe(204);
    const freed = await resumeOf(user, resume.id);
    expect(freed.legacyReview).toEqual(reviewed.legacyReview);
    expect(freed.sensitiveUse).toBeUndefined();
    const finished = await finish(freed.version);
    expect(finished.status, await finished.clone().text()).toBe(200);
    const preview = await user.fetch(`/api/resumes/${resume.id}/preview`);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain(MENTORED);
    // The finished version is held back like any other when the fact is marked again.
    await marked(user, MENTORED);
    const blocked = await user.fetch(`/api/resumes/${resume.id}/preview`);
    expect([blocked.status, await blocked.json()]).toEqual([409, { error: "conflict", message: USES_SENSITIVE }]);
  }, 120_000);
});

// A limit, pinned as it stands. While a fact is marked, a fact read from the same line is used with
// its own words as its only evidence, so work made then was checked against those words alone.
// Unmarking gives that fact its whole line back, which that work never saw, and stored work counts
// only against a fact's evidence exactly as it is now. Nothing is rewritten either way. Whether
// such work should stay valid is not decided: docs/seeker-release-status.md says so.
describe("work made while a fact was marked, once it is unmarked", () => {
  const SUMMARY = "Works in Go";
  const CHECKED = { verifiedLineIds: ["summary"], totalLines: 1, headersReady: true, skillsReady: true };

  /** An older version under review: one summary line with nothing stored to prove it, and these printed skills. */
  async function older(skills: string[]) {
    const user = await reader();
    const applicationId = await job(user);
    const resume = await tailor(user, applicationId);
    expect(resume.state, resume.error ?? "").toBe("ready");
    const go = await factOf(user, "Go");
    expect(go.quote).toBe(SKILLS);
    await sql(user, (db) => {
      const saved = JSON.parse(db.exec<{ data: string }>(`SELECT data FROM resume_versions WHERE resume_id = ? AND version = ?`, resume.id, resume.version).one().data);
      saved.render.body = { summary: { id: "summary", text: SUMMARY, factIds: [], status: "kept" }, skills, sections: [] };
      saved.provenance = "legacy";
      delete saved.evidence;
      delete saved.legacyReceipts;
      db.exec(`UPDATE resume_versions SET data = ? WHERE resume_id = ? AND version = ?`, JSON.stringify(saved), resume.id, resume.version);
      db.exec(`UPDATE resumes SET body = ? WHERE id = ?`, JSON.stringify(saved.render.body), resume.id);
    });
    const latest = () => resumeOf(user, resume.id);
    /** Starts a check or an edit of the summary, at one output if it completes, and waits for it. */
    const work = async (extra: Partial<NewDocument>) => {
      await refill(user);
      const started = await startDocument(user, applicationId, { kind: "refine", resumeId: resume.id, expectedVersion: (await latest()).version, lineIds: ["summary"], ...extra });
      expect(started.status, await started.clone().text()).toBe(202);
      return finishedDocument(user, ((await started.json()) as { documentId: string }).documentId);
    };
    /** Checks the summary against "Go", and gives the version that check made. */
    const check = async () => {
      expect((await work({ manualText: SUMMARY, manualFactIds: [go.id] })).state).toBe("ready");
      expect(await quota(user)).toMatchObject({ used: 1, reserved: 0 });
      return latest();
    };
    const finish = async () => user.send("POST", `/api/resumes/${resume.id}/legacy-finalize`, { expectedVersion: (await latest()).version });
    return { user, resume, go, latest, work, check, finish };
  }

  it("counts a line checked against a fact read off the marked fact's line only while the mark stands", async () => {
    const { user, resume, go, latest, check, finish } = await older([]);
    // "Kubernetes" was read from the same line as "Go". While it is marked, the line is checked
    // against "Go" with that one word as its evidence, and the check counts.
    const [kubernetes] = await marked(user, "Kubernetes");
    const during = await check();
    expect(during.legacyReview).toEqual(CHECKED);
    expect(during.facts[go.id]).toEqual({ text: "Go", quote: "Go" });
    expect(during.sensitiveUse).toBeUndefined();

    // Unmarked, "Go" has its whole line for evidence again. The check was not made against that,
    // so it no longer counts, and the version can't be finished on the strength of it.
    expect((await mark(user, [kubernetes!.id], false)).status).toBe(204);
    const after = await latest();
    expect(after.version).toBe(during.version);
    expect(after.legacyReview).toEqual({ ...CHECKED, verifiedLineIds: [] });
    expect(after.sensitiveUse).toBeUndefined();
    const refused = await finish();
    expect([refused.status, await refused.json()]).toEqual([409, { error: "conflict", message: "verify every line and confirm its roles and skills before finishing" }]);
    // Nothing was rewritten: marked again, the same check counts as it did.
    expect((await mark(user, [kubernetes!.id])).status).toBe(204);
    expect((await latest()).legacyReview).toEqual(CHECKED);

    // Unmarked for good, its owner checks the line again, against the whole line this time, at
    // one more output. That check counts and the version is finished.
    expect((await mark(user, [kubernetes!.id], false)).status).toBe(204);
    const again = await check();
    expect(again.version).toBe(during.version + 1);
    expect(again.legacyReview).toEqual(CHECKED);
    expect(again.facts[go.id]).toEqual({ text: "Go", quote: SKILLS });
    const finished = await finish();
    expect(finished.status, await finished.clone().text()).toBe(200);
    const preview = await user.fetch(`/api/resumes/${resume.id}/preview`);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain(SUMMARY);
  }, 120_000);

  it("won't reword a line that cites a fact read off the marked fact's line while the version still prints that fact as a skill", async () => {
    const { user, resume, go, latest, work, check, finish } = await older(["Go"]);
    // Checked and finished while "Kubernetes" is marked: the version cites "Go" in its summary and
    // prints it as a skill, on that one word as its evidence. It downloads like any other.
    const [kubernetes] = await marked(user, "Kubernetes");
    await check();
    expect((await finish()).status).toBe(200);
    const finished = await latest();
    expect(finished).toMatchObject({ provenance: "snapshot", facts: { [go.id]: { text: "Go", quote: "Go" } } });
    expect(finished.body!.skills).toEqual(["Go"]);
    expect((await user.fetch(`/api/resumes/${resume.id}/preview`)).status).toBe(200);

    // Unmarked, it still downloads: nothing in it was rewritten. But its summary can't be reworded.
    // The new wording is checked against "Go" with its whole line, the printed skill rests on "Go"
    // as it was, and one version keeps one record for a fact.
    expect((await mark(user, [kubernetes!.id], false)).status).toBe(204);
    expect((await user.fetch(`/api/resumes/${resume.id}/preview`)).status).toBe(200);
    const REWORDED = "Writes services in Go";
    expect(await work({ manualText: REWORDED })).toMatchObject({ state: "failed", error: "conflict" });
    expect((await latest()).version).toBe(finished.version);
    // The failed check cost nothing.
    expect(await quota(user)).toMatchObject({ used: 0, reserved: 0 });

    // With the skill taken off the version, which is free, the line is reworded against the fact as it is now.
    const removed = await user.send("POST", `/api/resumes/${resume.id}/remove-skill`, { skillIndex: 0, expectedVersion: finished.version });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect((await work({ manualText: REWORDED })).state).toBe("ready");
    const reworded = await latest();
    expect(reworded.body!.summary!.text).toBe(REWORDED);
    expect(reworded.facts[go.id]).toEqual({ text: "Go", quote: SKILLS });
    expect((await user.fetch(`/api/resumes/${resume.id}/preview`)).status).toBe(200);
  }, 120_000);
});

describe("a letter that uses a marked fact", () => {
  it("is still its owner's to read and download, and is listed as one that can't be shared, with the reason", async () => {
    const user = await reader();
    const applicationId = await job(user);
    writeOnly = [GO_SERVICE];
    const letter = await document(user, applicationId, { kind: "letter" });
    writeOnly = [MENTORED];
    const other = await document(user, applicationId, { kind: "letter" });
    for (const made of [letter, other]) expect(made.state, made.error ?? "").toBe("ready");
    expect((await shareable(user)).map((listed) => [listed.id, listed.shareable, listed.usesSensitive])).toEqual([[other.id, true, undefined], [letter.id, true, undefined]]);

    await marked(user, GO_SERVICE);
    // The owner's own reading and download are not held back.
    expect((await user.json<DocumentView>(`/api/documents/${letter.id}`)).result!.units.map((unit) => unit.text)).toEqual([GO_SERVICE]);
    const download = await user.fetch(`/api/documents/${letter.id}/docx`);
    expect(download.status).toBe(200);
    // The list to share from says it can't be chosen and that the mark is why. The other letter is as it was.
    expect((await shareable(user)).map((listed) => [listed.id, listed.shareable, listed.usesSensitive])).toEqual([[other.id, true, undefined], [letter.id, false, true]]);
    const refused = await user.send("POST", "/api/shares", { factIds: [], resumes: [], documents: [{ id: letter.id, version: 1 }] });
    expect(refused.status).toBe(409);
    expect((await share(user, { documents: [{ id: other.id, version: 1 }] })).grant.documentCount).toBe(1);

    // A letter that can't be shared for another reason doesn't blame the mark.
    await sql(user, (db) => {
      const saved = JSON.parse(db.exec<{ data: string }>(`SELECT data FROM document_versions WHERE document_id = ?`, letter.id).one().data);
      delete saved.evidence;
      db.exec(`UPDATE document_versions SET data = ? WHERE document_id = ?`, JSON.stringify(saved), letter.id);
    });
    expect((await shareable(user)).find((listed) => listed.id === letter.id)).toEqual({ id: letter.id, kind: "letter", applicationId, version: 1, createdAt: expect.any(Number), shareable: false });
  }, 120_000);
});

describe("shared copies and a marked fact", () => {
  it("refuses a new copy, closes the ones that hold it to the link, the coach and the owner's list, and opens them again when unmarked", async () => {
    const user = await reader();
    expect((await user.send("PUT", "/api/profile", { name: "Jane Doe" })).status).toBe(200);
    const resume = await tailor(user, await job(user));
    expect(resume.state, resume.error ?? "").toBe("ready");
    const led = await factOf(user, LED);
    const mentored = await factOf(user, MENTORED);
    const coach = await signIn(uniqueEmail("coach"));
    const withFact = await share(user, { factIds: [led.id, mentored.id], coachEmail: coach.email, showName: true });
    const withResume = await share(user, { resumes: [{ id: resume.id, version: resume.version }] });
    const withOther = await share(user, { factIds: [mentored.id] });

    // The coach takes the copy up while it is open, and opens it from their list.
    const link = cookieFrom(await exchange(withFact), `__Host-share-${withFact.grant.id}`)!;
    const taken = await call("/api/coach/clients", { method: "POST", cookie: `${link}; ${coach.cookie}`, headers: { "content-type": "application/json" }, body: JSON.stringify({ grantId: withFact.grant.id }) });
    expect(taken.status, await taken.clone().text()).toBe(204);
    const fromList = () => coach.send("POST", `/api/coach/clients/${withFact.grant.id}/open`);
    expect((await fromList()).status).toBe(200);
    const before = (await (await open(withFact)).json()) as SharedView;
    expect(before.snapshot.facts.map((fact) => fact.text).sort()).toEqual([LED, MENTORED].sort());

    expect((await mark(user, [led.id])).status).toBe(204);

    // A new copy that would hold the fact, or a resume that uses it, is refused. Nothing is made.
    const refusedFact = await user.send("POST", "/api/shares", { factIds: [led.id, mentored.id], resumes: [] });
    expect(refusedFact.status).toBe(422);
    expect(await refusedFact.json()).toEqual({ error: "invalid", message: "A fact marked sensitive can't be shared. Unmark it, or leave it out." });
    const refusedResume = await user.send("POST", "/api/shares", { factIds: [], resumes: [{ id: resume.id, version: resume.version }] });
    expect(refusedResume.status).toBe(409);
    expect(await refusedResume.json()).toEqual({ error: "conflict", message: USES_SENSITIVE });
    expect(await grants(user)).toHaveLength(3);

    // The copies that hold it are closed. Their readers get the page any ended link gets, and
    // are told nothing of a fact or a mark.
    for (const copy of [withFact, withResume]) {
      const gone = await exchange(copy);
      expect(gone.status).toBe(410);
      expect(await gone.json()).toEqual({ error: "gone", message: "this share link is unavailable or expired" });
      expect(gone.headers.getSetCookie()).toEqual([]);
    }
    // A reader who opened the link before the mark holds a session still. It reads nothing now.
    const late = await call(`/share/snapshot?g=${withFact.grant.id}`, { cookie: link });
    expect(late.status).toBe(410);
    expect(await late.json()).toEqual({ error: "gone", message: "this share link is unavailable or expired" });
    // The coach is told the copy has ended, as for any copy that has. Their own account is untouched.
    const ended = await fromList();
    expect(ended.status).toBe(409);
    expect(await ended.json()).toMatchObject({ error: "conflict", message: expect.stringContaining("this copy has ended") });
    expect(ended.headers.getSetCookie()).toEqual([]);
    expect((await coach.send("GET", "/api/me")).status).toBe(200);
    // The owner's list says which links are closed. The copy of another fact is open.
    expect((await grants(user)).map((grant) => [grant.id, grant.revokedAt, grant.available])).toEqual([
      [withOther.grant.id, null, true],
      [withResume.grant.id, null, false],
      [withFact.grant.id, null, false],
    ]);
    expect((await open(withOther)).status).toBe(200);

    // Unmarked first, the copies open again exactly as they were.
    expect((await mark(user, [led.id], false)).status).toBe(204);
    expect((await (await open(withFact)).json()) as SharedView).toEqual(before);
    expect((await open(withResume)).status).toBe(200);
    expect((await fromList()).status).toBe(200);
    expect((await grants(user)).map((grant) => grant.available)).toEqual([true, true, true]);
  }, 120_000);

  it("lists a closed copy to its coach as one that has ended, and lets nobody take it up while it is closed", async () => {
    const user = await reader();
    expect((await user.send("PUT", "/api/profile", { name: "Jane Doe" })).status).toBe(200);
    const led = await factOf(user, LED);
    const mentored = await factOf(user, MENTORED);
    const coach = await signIn(uniqueEmail("coach"));
    const stranger = await signIn();
    // Three copies name the coach. The first two hold the fact about to be marked, and the coach
    // takes up only the first. The third holds another fact.
    const taken = await share(user, { factIds: [led.id, mentored.id], coachEmail: coach.email, showName: true });
    const waiting = await share(user, { factIds: [led.id], coachEmail: coach.email });
    const other = await share(user, { factIds: [mentored.id], coachEmail: coach.email });
    /** The link's own session for a copy, which a reader's browser holds for up to an hour. */
    const sessionFor = async (copy: Copy) => cookieFrom(await exchange(copy), `__Host-share-${copy.grant.id}`)!;
    const takeUp = (copy: Copy, link: string, as = coach) =>
      call("/api/coach/clients", { method: "POST", cookie: `${link}; ${as.cookie}`, headers: { "content-type": "application/json" }, body: JSON.stringify({ grantId: copy.grant.id }) });
    const listed = async (copy: Copy) => (await coach.json<{ clients: CoachClient[] }>("/api/coach/clients")).clients.find((client) => client.grantId === copy.grant.id);
    const named = async (copy: Copy) => (await grants(user)).find((grant) => grant.id === copy.grant.id)!.coach;
    const ENDED = { error: "conflict", message: "this copy has ended; the person who shared it can share again" };

    // Every link is opened while its copy is open, so each of these sessions outlives the mark.
    const links = { taken: await sessionFor(taken), waiting: await sessionFor(waiting), other: await sessionFor(other) };
    expect((await takeUp(taken, links.taken)).status).toBe(204);
    expect((await takeUp(other, links.other)).status).toBe(204);
    const live = await listed(taken);
    expect(live).toEqual({ grantId: taken.grant.id, ownerName: "Jane Doe", addedAt: expect.any(Number), expiresAt: taken.grant.expiresAt, active: true, factCount: 2, resumeCount: 0, documentCount: 0 });
    expect(await listed(waiting)).toBeUndefined();

    expect((await mark(user, [led.id])).status).toBe(204);

    // The coach's list says of the closed copy what it says of one that has ended: not that it is
    // live, and not how much it holds. The copy of another fact is listed as it was.
    const closed = await listed(taken);
    expect(closed).toEqual({ ...live, active: false, factCount: 0, resumeCount: 0, documentCount: 0 });
    expect(await listed(other)).toMatchObject({ active: true, factCount: 1 });
    // The link's session from before the mark takes up nothing now: not for the coach the copy
    // names, not for another account, and not as a repeat for a copy already taken up. Each is
    // told what the coach of any ended copy is told.
    for (const refused of [await takeUp(waiting, links.waiting), await takeUp(waiting, links.waiting, stranger), await takeUp(taken, links.taken)]) {
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual(ENDED);
    }
    // Nothing was written by that: the owner is shown no take-up, and neither list gained the copy.
    expect(await named(waiting)).toEqual({ email: coach.email, name: null, joinedAt: null });
    expect(await listed(waiting)).toBeUndefined();
    expect((await stranger.json<{ clients: CoachClient[] }>("/api/coach/clients")).clients).toEqual([]);

    // Unmarked, the copy is listed as it was, and the one that was waiting can be taken up.
    expect((await mark(user, [led.id], false)).status).toBe(204);
    expect(await listed(taken)).toEqual(live);
    expect((await takeUp(waiting, links.waiting)).status).toBe(204);
    expect(await listed(waiting)).toMatchObject({ active: true, factCount: 1 });
    expect((await named(waiting))!.joinedAt).toEqual(expect.any(Number));

    // A copy its owner revokes is listed exactly as the closed one was: nothing tells the two apart.
    expect((await user.send("DELETE", `/api/shares/${taken.grant.id}`)).status).toBe(204);
    expect(await listed(taken)).toEqual(closed);
    const ended = await takeUp(taken, links.taken);
    expect([ended.status, await ended.json()]).toEqual([409, ENDED]);
  });

  it("answers for a copy as it always has once the account is closing or gone", async () => {
    const user = await signIn();
    const typed = await user.send("POST", "/api/facts", { roleId: null, kind: "accomplishment", text: "Ran the on-call rotation", level: null });
    const { factId } = (await typed.json()) as { factId: string };
    const copy = await share(user, { factIds: [factId] });
    expect((await mark(user, [factId])).status).toBe(204);
    expect((await mark(user, [factId], false)).status).toBe(204);
    expect((await open(copy)).status).toBe(200);
    // A vault that is closing, and then one whose storage is gone, has no facts to be asked about.
    await vaultOf(user).quiesceForAccountDeletion(sessionOf(user).uid);
    expect((await exchange(copy)).status).toBe(410);
    await vaultOf(user).destroyForAccountDeletion(sessionOf(user).uid);
    const gone = await exchange(copy);
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({ error: "gone" });
  });
});

describe("the mark in a vault's own storage", () => {
  it("gains its column in a vault made before it, with every fact unmarked and as it was", async () => {
    const user = await reader();
    const before = await facts(user);
    await sql(user, (db) => {
      // Rewind this vault to the schema before the mark, as an older vault would be.
      removeSensitiveMigration(db);
      const previous = MIGRATIONS.findIndex((migration) => migration.some((statement) => statement.includes("ADD COLUMN sensitive")));
      expect(previous).toBeGreaterThan(-1);
      const columns = () => db.exec<{ name: string }>(`PRAGMA table_info(facts)`).toArray().map((column) => column.name);
      const indexes = () => db.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'facts_sensitive'`).toArray();
      expect(columns()).not.toContain("sensitive");
      expect(indexes()).toEqual([]);
      db.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
    });
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      const db = state.storage.sql;
      migrate(db, <T>(fn: () => T) => state.storage.transactionSync(fn));
      expect(db.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(SCHEMA_VERSION));
      expect(db.exec<{ name: string }>(`PRAGMA table_info(facts)`).toArray().map((column) => column.name)).toContain("sensitive");
      expect(db.exec(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'facts_sensitive'`).toArray()).toHaveLength(1);
      expect(db.exec(`SELECT sensitive, COUNT(*) AS n FROM facts GROUP BY sensitive`).toArray()).toEqual([{ sensitive: 0, n: 8 }]);
    });
    expect(await facts(user)).toEqual(before);
    expect(await usable(user)).toHaveLength(8);
    // And the column works: a fact can be marked, and is then out of use.
    await marked(user, MENTORED);
    expect((await facts(user)).filter((fact) => fact.sensitive).map((fact) => fact.text)).toEqual([MENTORED]);
    expect(await usable(user)).toHaveLength(7);
  });

  it("moves with the vault to a replacement, where the fact is still marked and still out of use", async () => {
    const user = await signIn(uniqueEmail("mover"));
    const add = async (text: string) => ((await (await user.send("POST", "/api/facts", { roleId: null, kind: "accomplishment", text, level: null })).json()) as { factId: string }).factId;
    const kept = await add("Ran the on-call rotation for the platform team");
    const secret = await add(`Organised the ${SECRET}`);
    expect((await mark(user, [secret])).status).toBe(204);

    // The fenced replacement an operator runs with scripts/move-vault.mjs, step for step.
    const old = sessionOf(user);
    const operation = crypto.randomUUID();
    const { targetVaultId } = await directory(env).prepareReplacement(old.vid, operation);
    const source = vault(env, old.vid);
    const target = vault(env, targetVaultId);
    for (const object of [source, target, directory(env)]) await fence(object, [old.vid, targetVaultId]);
    const manifest = await source.transferManifest(operation);
    expect(manifest.tables.find((table) => table.name === "facts")).toEqual({ name: "facts", count: 2 });
    await target.importManifest(manifest);
    for (const table of manifest.tables) {
      const page = await source.transferPage(operation, table.name);
      expect(page.done).toBe(true);
      // The mark travels as one more column of the fact's own row.
      if (table.name === "facts") expect(page.columns).toContain("sensitive");
      await target.importPage(page);
    }
    expect(await target.finishImport(operation, old.vid)).toMatchObject({ state: "ready", completedTables: manifest.tables.length });
    await directory(env).cutover(old.vid, targetVaultId, operation);
    await fence(target, [old.vid]);

    const moved = await signIn(user.email);
    expect(sessionOf(moved)).toMatchObject({ uid: old.uid, vid: targetVaultId });
    expect((await facts(moved)).map((fact) => [fact.id, fact.sensitive === true]).sort()).toEqual([[kept, false], [secret, true]].sort());
    expect((await usable(moved)).map((fact) => fact.id)).toEqual([kept]);
    const refused = await moved.send("POST", "/api/shares", { factIds: [secret], resumes: [] });
    expect(refused.status).toBe(422);
    expect((await share(moved, { factIds: [kept] })).grant.factCount).toBe(1);
    // It is the owner's to unmark there, as it was here.
    expect((await mark(moved, [secret], false)).status).toBe(204);
    expect((await usable(moved)).map((fact) => fact.id).sort()).toEqual([kept, secret].sort());
  });
});
