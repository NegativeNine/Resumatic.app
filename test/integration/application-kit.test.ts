import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModels, type Models } from "../../src/ai/models";
import type { KitMatchAnswer, KitMatchItem } from "../../src/ai/question-match";
import { setPdfRenderer } from "../../src/render/pdf";
import type { FactView, ResumeView } from "../../src/shared/api";
import type { DocumentView, NewDocument } from "../../src/shared/documents";
import {
  KIT_ANSWER_REFUSED,
  KIT_CHANGED,
  KIT_CHOICE_REFUSED,
  KIT_DOCUMENT_REFUSED,
  KIT_NOT_APPROVED,
  KIT_NO_RESUME,
  KIT_QUESTIONS_REFUSED,
  KIT_RESUME_REFUSED,
  KIT_SENSITIVE_NEVER_SAVED,
  KIT_UNANSWERED,
  MAX_SAVED_ANSWERS,
  REFUSED_KIND_SENTENCE,
  SAVED_ANSWERS_FULL,
  SAVED_ANSWER_CHANGED,
  SAVED_ANSWER_LABEL_EMPTY,
  SAVED_ANSWER_LABEL_TAKEN,
  SAVED_ANSWER_REFUSED,
  type KitAnswerChange,
  type KitPart,
  type KitView,
  type SavedAnswer,
} from "../../src/shared/kit";
import { TRANSFER_TABLES } from "../../src/shared/operations";
import type { ShareGrant } from "../../src/shared/sharing";
import { directory, vault } from "../../src/shared/stubs";
import type { Who } from "../../src/shared/types";
import { MIGRATIONS, migrate, SCHEMA_VERSION } from "../../src/vault/schema";
import { fromBase64url } from "../../src/worker/crypto";
import { removeSavedAnswerMigration } from "../support/undo-vault-incarnation";
import { outwardParts, printAsText } from "./outward";
import { JOB_DESCRIPTION, User, call, eventually, fakeModels, signIn, uniqueEmail, type FakeModelOptions } from "./support";

// Saved answers and application kits inside a real vault, reached the way the app reaches them:
// over HTTP by their owner, exported, moved and erased with the vault, matched by the closed list,
// a label or (switched on) a stand-in judge, and found nowhere else.

const FACT = "Built a Go service that processes 2 million events per day";
const OTHER_FACT = "Mentored 2 junior engineers every quarter";
/** Workflows are slower while other suites share the machine. */
const WAIT = 60_000;

let options: FakeModelOptions & { inputs: string[]; calls: NonNullable<FakeModelOptions["calls"]> };

/** The usual stand-ins, and a writer that says back the first fact it is given, so every sentence of a letter or preparation is one the checks keep. */
function standIns(): Models {
  const base = fakeModels(options);
  return {
    ...base,
    async complete(route, messages, schema, callOptions) {
      const user = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
      if (route === "write" && user.startsWith("{")) {
        options.inputs.push(JSON.stringify(messages));
        const data = JSON.parse(user) as { facts?: { id: string; roleId: string | null; text: string }[] };
        const first = data.facts?.find((fact) => fact.text === FACT) ?? data.facts?.[0];
        return schema.parse({ units: first ? [{ roleId: first.roleId, text: first.text, factIds: [first.id], group: 0 }] : [] });
      }
      return base.complete(route, messages, schema, callOptions);
    },
  };
}

/** Settings changed on a vault for one test, put back after it. */
const restore: (() => Promise<unknown>)[] = [];
beforeEach(() => {
  options = { inputs: [], calls: {} };
  setModels(() => standIns());
});
afterEach(async () => {
  for (const undo of restore.splice(0).reverse()) await undo();
  setModels(null);
  setPdfRenderer(null);
  vi.restoreAllMocks();
});

function sessionOf(user: User) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  return JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { uid: string; vid: string; gen: number; epoch?: string };
}
const vaultOf = (user: User) => vault(env, sessionOf(user).vid);
type VaultStub = ReturnType<typeof vault>;
function whoOf(user: User): Who {
  const session = sessionOf(user);
  return { userId: session.uid, gen: session.gen, epoch: session.epoch };
}
const sql = <T>(user: User, work: (db: SqlStorage) => T) => runInDurableObject(vaultOf(user), (_instance, state) => work(state.storage.sql));
const count = (user: User, table: string, where = "1 = 1") => sql(user, (db) => db.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).one().n);
/** What a rejected call into a vault said, or "nothing" when it was let through. */
const refusal = (work: Promise<unknown>): Promise<string> => work.then(() => "nothing", (error: unknown) => String((error as Error).message ?? error));

/** Sets one of a vault object's settings until the test ends. */
async function setting(target: VaultStub | ReturnType<typeof directory>, name: keyof Env, value: string | undefined): Promise<void> {
  const prior = await runInDurableObject(target, (instance) => {
    const local = (instance as unknown as { env: Record<string, unknown> }).env;
    const before = local[name];
    local[name] = value;
    return before;
  });
  restore.push(() =>
    runInDurableObject(target, (instance) => {
      (instance as unknown as { env: Record<string, unknown> }).env[name] = prior;
    }),
  );
}
const judgeOn = (user: User) => setting(vaultOf(user), "APPLICATION_KIT_ENABLED", "true");

// ---------------------------------------------------------------- making things over HTTP

/** Someone with two confirmed facts under one job, and one saved job. */
async function owner(email = uniqueEmail()) {
  const user = await signIn(email);
  expect((await user.send("PUT", "/api/profile", { name: "Sam Rivera" })).status).toBe(200);
  const role = await user.send("POST", "/api/roles", { kind: "job", org: "Acme", title: "Engineer", startDate: "2021", endDate: null });
  const { roleId } = (await role.json()) as { roleId: string };
  const factIds: string[] = [];
  for (const text of [FACT, OTHER_FACT]) {
    const fact = await user.send("POST", "/api/facts", { roleId, kind: "accomplishment", text, level: "implemented" });
    expect(fact.status, await fact.clone().text()).toBe(201);
    factIds.push(((await fact.json()) as { factId: string }).factId);
  }
  const applicationId = await job(user);
  return { user, applicationId, roleId, factIds };
}
async function job(user: User): Promise<string> {
  const response = await user.send("POST", "/api/applications", { jdText: JOB_DESCRIPTION });
  expect(response.status).toBe(201);
  return ((await response.json()) as { applicationId: string }).applicationId;
}
/** Gives the account its month's outputs back, so one test can make more than a month allows. */
const refill = (user: User) => sql(user, (db) => void db.exec(`UPDATE quota_buckets SET used = 0, reserved = 0`));
/** Tailors a resume for the job and waits for it to be ready. */
async function tailor(user: User, applicationId: string): Promise<ResumeView> {
  await refill(user);
  const started = await user.fetch(`/api/applications/${applicationId}/resumes`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() } });
  expect(started.status, await started.clone().text()).toBe(202);
  const { resumeId } = (await started.json()) as { resumeId: string };
  const done = await eventually(async () => {
    const resume = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    return resume.state !== "running" ? resume : null;
  }, "the resume to finish", WAIT);
  expect(done.state, done.error ?? "").toBe("ready");
  return done;
}
/** Writes a letter or preparation for the job and waits for it. */
async function write(user: User, applicationId: string, kind: NewDocument["kind"]): Promise<DocumentView> {
  await refill(user);
  const started = await user.fetch(`/api/applications/${applicationId}/documents`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ kind }),
  });
  expect(started.status, await started.clone().text()).toBe(202);
  const { documentId } = (await started.json()) as { documentId: string };
  const done = await eventually(async () => {
    const made = await user.json<DocumentView>(`/api/documents/${documentId}`);
    return made.state !== "running" ? made : null;
  }, `the ${kind} to finish`, WAIT);
  expect(done.state, done.error ?? "").toBe("ready");
  return done;
}
const partOf = (made: { id: string; version: number }): KitPart => ({ id: made.id, version: made.version });

// ---------------------------------------------------------------- saved answers and kits over HTTP

const savedList = async (user: User) => (await user.json<{ savedAnswers: SavedAnswer[] }>("/api/saved-answers")).savedAnswers;
const postSaved = (user: User, label: unknown, answer: unknown) => user.send("POST", "/api/saved-answers", { label, answer });
async function addSaved(user: User, label: string, answer: string): Promise<SavedAnswer> {
  const response = await postSaved(user, label, answer);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as SavedAnswer;
}
const putSaved = (user: User, id: string, label: string, answer: string, expectedRevision: number) =>
  user.send("PUT", `/api/saved-answers/${id}`, { label, answer, expectedRevision });

const kitOf = (user: User, applicationId: string) => user.json<KitView>(`/api/applications/${applicationId}/kit`);
const putQuestions = (user: User, applicationId: string, questions: { id?: string; text: string }[], expectedRevision: number) =>
  user.send("PUT", `/api/applications/${applicationId}/kit/questions`, { questions, expectedRevision });
const putParts = (user: User, applicationId: string, parts: { resume: KitPart | null; letter?: KitPart | null; prep?: KitPart | null }, expectedRevision: number) =>
  user.send("PUT", `/api/applications/${applicationId}/kit/parts`, { resume: parts.resume, letter: parts.letter ?? null, prep: parts.prep ?? null, expectedRevision });
const postAnswer = (user: User, applicationId: string, questionId: string, change: KitAnswerChange, expectedRevision: number) =>
  user.send("POST", `/api/applications/${applicationId}/kit/questions/${questionId}`, { change, expectedRevision });
const postApprove = (user: User, applicationId: string, expectedRevision: number) =>
  user.send("POST", `/api/applications/${applicationId}/kit/approve`, { expectedRevision });

/** The kit a write gave back, after checking it landed. */
async function landed(response: Promise<Response>): Promise<KitView> {
  const answered = await response;
  expect(answered.status, await answered.clone().text()).toBe(200);
  return (await answered.json()) as KitView;
}
/** A refused write: its status and its sentence. */
async function refused(response: Promise<Response>): Promise<[number, string]> {
  const answered = await response;
  const body = (await answered.json()) as { message: string };
  return [answered.status, body.message];
}
const questions = (user: User, applicationId: string, texts: string[], expectedRevision: number) =>
  landed(putQuestions(user, applicationId, texts.map((text) => ({ text })), expectedRevision));
const answer = (user: User, applicationId: string, questionId: string, change: KitAnswerChange, expectedRevision: number) =>
  landed(postAnswer(user, applicationId, questionId, change, expectedRevision));
/** What the stand-in judge was given, in order: nothing else that was recorded. */
const matchInputs = () => options.inputs.filter((input) => input.startsWith('{"question":')).map((input) => JSON.parse(input) as KitMatchItem);
/** Waits, inside the vault, until `ready()` holds: the vault's own timers, so the wait does no I/O of the test's. */
async function until(ready: () => boolean): Promise<void> {
  while (!ready()) await new Promise((resolve) => setTimeout(resolve, 5));
}
const runsOf = (user: User, kind: string) =>
  sql(user, (db) => db.exec<{ id: string; state: string; error_code: string | null; target_id: string }>(`SELECT id, state, error_code, target_id FROM runs WHERE kind = ?`, kind).toArray());

/** A kit ready to approve: a resume chosen and one question answered by typing. */
async function readyKit(user: User, applicationId: string, resume: ResumeView, extra: { letter?: KitPart; prep?: KitPart } = {}) {
  let kit = await questions(user, applicationId, ["Why do you want this job?"], (await kitOf(user, applicationId)).revision);
  kit = await answer(user, applicationId, kit.questions[0]!.id, { kind: "type", answer: "Because I like building services." }, kit.revision);
  kit = await landed(putParts(user, applicationId, { resume: partOf(resume), ...extra }, kit.revision));
  return kit;
}
const download = (user: User, applicationId: string) => user.fetch(`/api/applications/${applicationId}/kit/archive`);

describe("saved answers", () => {
  it("saves, reads back and edits a saved answer at the next revision, and refuses a stale edit with 409", async () => {
    const user = await signIn();
    expect(await savedList(user)).toEqual([]);
    const before = Date.now();
    const saved = await addSaved(user, "  Notice   period ", "Four weeks,\r\nfrom the day I accept.");
    // As stored: the label one line, the answer's line endings made one.
    expect(saved).toEqual({
      id: expect.any(String),
      revision: 1,
      label: "Notice period",
      answer: "Four weeks,\nfrom the day I accept.",
      refusedKind: null,
      createdAt: expect.any(Number),
      updatedAt: saved.createdAt,
    });
    expect(saved.createdAt).toBeGreaterThanOrEqual(before);
    expect(await savedList(user)).toEqual([saved]);
    const edited = await putSaved(user, saved.id, "Notice period", "Two weeks.", 1);
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ id: saved.id, revision: 2, label: "Notice period", answer: "Two weeks." });
    // The revision a save was read at is spent once it lands.
    expect(await refused(putSaved(user, saved.id, "Notice period", "Six weeks.", 1))).toEqual([409, SAVED_ANSWER_CHANGED]);
    // The same words again are still an edit, at the next revision.
    expect(await (await putSaved(user, saved.id, "Notice period", "Two weeks.", 2)).json()).toMatchObject({ revision: 3, answer: "Two weeks." });
    expect(await savedList(user)).toEqual([expect.objectContaining({ revision: 3, answer: "Two weeks." })]);
    // An edit or a delete of one that isn't there is not found.
    expect((await putSaved(user, "no-such-answer", "Notice period", "Two weeks.", 1)).status).toBe(404);
    expect((await user.send("DELETE", "/api/saved-answers/no-such-answer")).status).toBe(404);
    expect((await user.send("DELETE", `/api/saved-answers/${saved.id}`)).status).toBe(204);
    expect(await savedList(user)).toEqual([]);
    expect(await count(user, "saved_answers")).toBe(0);
  });

  it("refuses a saved answer about work authorisation, pay or a personal matter, in its label or its answer, with that kind's sentence, and stores nothing", async () => {
    const user = await signIn();
    const cases: [string, string, keyof typeof REFUSED_KIND_SENTENCE][] = [
      ["Visa status", "I hold a work visa.", "work_authorisation"],
      ["Start date", "I need sponsorship to start.", "work_authorisation"],
      ["Salary expectations", "Open to discussion.", "pay"],
      ["Expectations", "A salary of 90,000.", "pay"],
      ["Pronouns", "They and them.", "personal"],
      ["About me", "I am a protected veteran.", "personal"],
      ["Date of birth", "1 January 1990", "personal"],
    ];
    for (const [label, words, kind] of cases) expect(await refused(postSaved(user, label, words)), label).toEqual([422, REFUSED_KIND_SENTENCE[kind]]);
    // An edit to one is refused the same way.
    const saved = await addSaved(user, "Portfolio link", "https://example.com/sam");
    expect(await refused(putSaved(user, saved.id, "Portfolio link", "Hourly rate: 50", 1))).toEqual([422, REFUSED_KIND_SENTENCE.pay]);
    expect(await savedList(user)).toEqual([saved]);
    expect(await count(user, "saved_answers")).toBe(1);
  });

  it("refuses a 51st saved answer, a label over 80 characters, an answer over 4,000, a label of punctuation only, and a second label that normalises the same", async () => {
    const user = await signIn();
    expect(await refused(postSaved(user, "x".repeat(81), "Yes."))).toEqual([422, SAVED_ANSWER_REFUSED]);
    expect(await refused(postSaved(user, "Long answer", "y".repeat(4001)))).toEqual([422, SAVED_ANSWER_REFUSED]);
    expect(await refused(postSaved(user, "  ", "Yes."))).toEqual([422, SAVED_ANSWER_REFUSED]);
    expect(await refused(postSaved(user, "Willing to travel", "   "))).toEqual([422, SAVED_ANSWER_REFUSED]);
    expect(await refused(postSaved(user, 7, "Yes."))).toEqual([422, SAVED_ANSWER_REFUSED]);
    expect(await refused(postSaved(user, "?!… —", "Yes."))).toEqual([422, SAVED_ANSWER_LABEL_EMPTY]);
    // Exactly at the caps is taken.
    await addSaved(user, "x".repeat(80), "y".repeat(4000));
    await addSaved(user, "Notice period", "Four weeks.");
    expect(await refused(postSaved(user, "NOTICE—period!", "Two weeks."))).toEqual([409, SAVED_ANSWER_LABEL_TAKEN]);
    // An edit can't take another's label either.
    const other = await addSaved(user, "Willing to relocate", "Yes, within Canada.");
    expect(await refused(putSaved(user, other.id, "notice period", "Yes.", 1))).toEqual([409, SAVED_ANSWER_LABEL_TAKEN]);
    for (let index = (await savedList(user)).length; index < MAX_SAVED_ANSWERS; index++) await addSaved(user, `Answer ${index}`, `Words ${index}`);
    expect(await savedList(user)).toHaveLength(MAX_SAVED_ANSWERS);
    expect(await refused(postSaved(user, "One more", "Words."))).toEqual([409, SAVED_ANSWERS_FULL]);
    // One already kept is still returned when it is sent again, full or not.
    expect((await postSaved(user, "Notice period", "Four weeks.")).status).toBe(201);
    expect(await count(user, "saved_answers")).toBe(MAX_SAVED_ANSWERS);
  });

  it("returns the same saved answer for the same label and answer sent twice", async () => {
    const user = await signIn();
    const [first, second] = await Promise.all([postSaved(user, "Portfolio link", "https://example.com/sam"), postSaved(user, "portfolio  link", "https://example.com/sam ")]);
    expect([first.status, second.status]).toEqual([201, 201]);
    const [a, b] = [(await first.json()) as SavedAnswer, (await second.json()) as SavedAnswer];
    expect(b).toEqual(a);
    expect(await count(user, "saved_answers")).toBe(1);
  });
});

describe("matching an employer's questions", () => {
  it("matches a question word for word to a label, normalised, and needs the owner's confirmation", async () => {
    const { user, applicationId } = await owner();
    const saved = await addSaved(user, "Notice period", "Four weeks.");
    expect(await kitOf(user, applicationId)).toMatchObject({ revision: 0, state: "draft", questions: [], problems: [{ code: "no_resume" }], ready: false });
    // Nothing is written until the first write.
    expect(await count(user, "application_kits")).toBe(0);
    let kit = await questions(user, applicationId, ["  What’s your NOTICE-period?? "], 0);
    // Not word for word: "whats your notice period" is not the label's key.
    expect(kit.questions).toEqual([expect.objectContaining({ text: "What’s your NOTICE-period??", state: "asks" })]);
    expect(kit.revision).toBe(1);
    kit = await questions(user, applicationId, ["NOTICE   period:", "Why us?"], 1);
    expect(kit.questions).toEqual([
      expect.objectContaining({ position: 0, text: "NOTICE period:", state: "matched", matchedBy: "label", savedAnswer: saved, confirmed: false, typedAnswer: null }),
      expect.objectContaining({ position: 1, text: "Why us?", state: "asks", matchedBy: null, savedAnswer: null, confirmed: false }),
    ]);
    expect(kit.problems).toEqual([{ code: "no_resume" }, { code: "unanswered", questionIds: kit.questions.map((question) => question.id) }]);
    kit = await answer(user, applicationId, kit.questions[0]!.id, { kind: "confirm" }, kit.revision);
    expect(kit.questions[0]).toMatchObject({ state: "matched", confirmed: true });
    expect(kit.problems).toEqual([{ code: "no_resume" }, { code: "unanswered", questionIds: [kit.questions[1]!.id] }]);
    // No model was asked: a word-for-word match needs none.
    expect(options.calls.match).toBeUndefined();
  });

  it("never matches a refused-kind question, even when a label matches it word for word, and never calls the judge for it", async () => {
    const { user, applicationId } = await owner();
    await judgeOn(user);
    options.match = () => ({ kind: "label", index: 0 });
    // An older vault could hold a label the list refuses now. It is seeded as one would be stored.
    await sql(user, (db) =>
      db.exec(
        `INSERT INTO saved_answers (id, revision, label, label_key, answer_text, created_at, updated_at) VALUES ('older', 1, 'Salary expectations', 'salary expectations', 'Ninety thousand', 1, 1)`,
      ),
    );
    expect(await savedList(user)).toEqual([expect.objectContaining({ id: "older", refusedKind: "pay" })]);
    const kit = await questions(user, applicationId, ["Salary expectations", "Are you Hispanic or Latino?", "Male"], 0);
    expect(kit.questions.map((question) => [question.state, question.sensitiveKind, question.savedAnswer])).toEqual([
      ["sensitive", "pay", null],
      ["sensitive", "personal", null],
      ["sensitive", "personal", null],
    ]);
    expect(options.calls.match).toBeUndefined();
    expect(await runsOf(user, "match")).toEqual([]);
    // Nor is it offered for any other question: a saved answer the list refuses is used for nothing.
    await addSaved(user, "Notice period", "Four weeks.");
    const more = await questions(user, applicationId, ["Can you start soon?"], kit.revision);
    expect(options.calls.match).toBe(1);
    expect(matchInputs()).toEqual([{ question: "Can you start soon?", labels: ["Notice period"] }]);
    // The judge's first label is the one it was shown.
    expect(more.questions[0]).toMatchObject({ state: "matched", matchedBy: "judge", savedAnswer: expect.objectContaining({ label: "Notice period" }) });
  });

  it("asks the judge only the question and the labels: no answer text is in any recorded input", async () => {
    const { user, applicationId } = await owner();
    await judgeOn(user);
    const ANSWER = "Zennor quoit fourteen-day notice";
    const LINK = "https://example.com/carn-galver-portfolio";
    await addSaved(user, "Notice period", ANSWER);
    await addSaved(user, "Portfolio link", LINK);
    options.match = (item) => (item.question.includes("start") ? { kind: "label", index: 0 } : { kind: "none" });
    const kit = await questions(user, applicationId, ["When could you start?", "Tell us about a project", "Notice period"], 0);
    // The third matched its label word for word and was never asked about.
    expect(options.calls.match).toBe(2);
    expect(matchInputs()).toEqual([
      { question: "When could you start?", labels: ["Notice period", "Portfolio link"] },
      { question: "Tell us about a project", labels: ["Notice period", "Portfolio link"] },
    ]);
    for (const input of options.inputs) {
      expect(input).not.toContain("Zennor");
      expect(input).not.toContain("carn-galver");
    }
    expect(kit.questions.map((question) => [question.state, question.matchedBy, question.confirmed])).toEqual([
      ["matched", "judge", false],
      ["asks", null, false],
      ["matched", "label", false],
    ]);
    // One run for the asking, finished, about this job.
    expect(await runsOf(user, "match")).toEqual([{ id: expect.any(String), state: "succeeded", error_code: null, target_id: applicationId }]);
  });

  it("asks, and stores no guess, when the judge throws, answers malformed, refuses for quota, or there is no typed-decision model", async () => {
    const { user, applicationId } = await owner();
    await judgeOn(user);
    await addSaved(user, "Notice period", "Four weeks.");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failures: [string, () => KitMatchAnswer | Error][] = [
      ["a throw", () => new Error("provider said: When could you start?")],
      ["a malformed answer", () => new Error("unavailable: model provider HTTP error")],
      ["a quota refusal", () => new Error("quota: the configured model spend budget is exhausted")],
    ];
    let revision = 0;
    for (const [why, failure] of failures) {
      options.match = failure;
      const kit = await questions(user, applicationId, [`When could you start, ${why}?`], revision);
      revision = kit.revision;
      expect(kit.questions[0], why).toMatchObject({ state: "asks", matchedBy: null, savedAnswer: null });
      expect(await count(user, "kit_questions", "state <> 'asks'"), why).toBe(0);
    }
    expect(options.calls.match).toBe(3);
    // Each failure is logged as a code, and nothing of the question.
    const codes = logged.mock.calls.filter(([event]) => event === "application kit match failed").map(([, detail]) => detail);
    expect(codes).toEqual([
      { code: "kit_match_failed", cause: "unexpected" },
      { code: "kit_match_failed", cause: "unavailable" },
      { code: "kit_match_failed", cause: "quota" },
    ]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain("start");
    // With no typed-decision model, nothing is asked and no run is begun.
    const runs = (await runsOf(user, "match")).length;
    delete options.match;
    const kit = await questions(user, applicationId, ["When could you start, with no judge?"], revision);
    expect(kit.questions[0]).toMatchObject({ state: "asks" });
    expect(await runsOf(user, "match")).toHaveLength(runs);
  });

  it("asks for every unsettled question when building the models throws, and the save succeeds", async () => {
    const { user, applicationId } = await owner();
    await addSaved(user, "Notice period", "Four weeks.");
    await judgeOn(user);
    // The real models, with the typed-decision judge, and prices that can't be read.
    await setting(vaultOf(user), "MODEL_JUDGE", "@cf/cloudflare/clef");
    await setting(vaultOf(user), "MODEL_PRICES_JSON", "not json");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    setModels(null);
    const kit = await questions(user, applicationId, ["When could you start?", "Tell us about a project", "Notice period"], 0);
    expect(kit.questions.map((question) => question.state)).toEqual(["asks", "asks", "matched"]);
    expect(await runsOf(user, "match")).toEqual([]);
    expect(logged.mock.calls.filter(([event]) => event === "application kit match failed").map(([, detail]) => detail)).toEqual([
      { code: "kit_match_failed", cause: "unavailable" },
    ]);
  });

  it("calls no model when APPLICATION_KIT_ENABLED is off, or there are no usable saved answers", async () => {
    const { user, applicationId } = await owner();
    options.match = () => ({ kind: "label", index: 0 });
    await addSaved(user, "Notice period", "Four weeks.");
    for (const value of [undefined, "false", "TRUE", "1"]) {
      await setting(vaultOf(user), "APPLICATION_KIT_ENABLED", value);
      const kit = await kitOf(user, applicationId);
      await questions(user, applicationId, [`When could you start (${value})?`], kit.revision);
    }
    expect(options.calls.match).toBeUndefined();
    // Switched on, with nothing a question may be matched to.
    await judgeOn(user);
    const other = await owner();
    await setting(vaultOf(other.user), "APPLICATION_KIT_ENABLED", "true");
    await sql(other.user, (db) =>
      db.exec(`INSERT INTO saved_answers (id, revision, label, label_key, answer_text, created_at, updated_at) VALUES ('older', 1, 'Visa', 'visa', 'Yes', 1, 1)`),
    );
    const kit = await questions(other.user, other.applicationId, ["When could you start?"], 0);
    expect(kit.questions[0]).toMatchObject({ state: "asks" });
    expect(options.calls.match).toBeUndefined();
    expect(await runsOf(other.user, "match")).toEqual([]);
    expect(options.inputs.filter((input) => input.includes("When could you start"))).toEqual([]);
  });

  it("marks a question sensitive when the judge says refused, and offers no saved answer for it", async () => {
    const { user, applicationId } = await owner();
    await judgeOn(user);
    const saved = await addSaved(user, "Notice period", "Four weeks.");
    options.match = () => ({ kind: "refused" });
    let kit = await questions(user, applicationId, ["Do you have any obligations we should know about?"], 0);
    expect(kit.questions[0]).toMatchObject({ state: "sensitive", sensitiveKind: "judge", savedAnswer: null, matchedBy: null });
    const id = kit.questions[0]!.id;
    expect(await refused(postAnswer(user, applicationId, id, { kind: "use", savedAnswerId: saved.id }, kit.revision))).toEqual([409, KIT_CHANGED]);
    expect(await refused(postAnswer(user, applicationId, id, { kind: "save", label: "Obligations", answer: "None." }, kit.revision))).toEqual([409, KIT_CHANGED]);
    kit = await answer(user, applicationId, id, { kind: "type", answer: "None that affect this role." }, kit.revision);
    expect(kit.questions[0]).toMatchObject({ state: "sensitive", typedAnswer: "None that affect this role." });
    expect(await savedList(user)).toEqual([saved]);
  });

  it("discards the judge's answer when a saved answer changed while it was asked", async () => {
    const { user, applicationId } = await owner();
    await judgeOn(user);
    const saved = await addSaved(user, "Notice period", "Four weeks.");
    let asked = false;
    let released = false;
    options.match = async () => {
      asked = true;
      await until(() => released);
      return { kind: "label", index: 0 };
    };
    const saving = putQuestions(user, applicationId, [{ text: "When could you start?" }], 0);
    await until(() => asked);
    // While the judge is asked, the label it was shown is edited.
    expect((await putSaved(user, saved.id, "Start date", "Four weeks.", 1)).status).toBe(200);
    released = true;
    const kit = await landed(saving);
    expect(kit.questions[0]).toMatchObject({ state: "asks", savedAnswer: null, matchedBy: null });
  });

  it("reorders questions, inserts one between others and keeps each kept question's answer; refuses a repeated id", async () => {
    const { user, applicationId } = await owner();
    const saved = await addSaved(user, "Notice period", "Four weeks.");
    let kit = await questions(user, applicationId, ["Notice period", "Why us?", "Visa status"], 0);
    const [notice, why, visa] = kit.questions.map((question) => question.id) as [string, string, string];
    kit = await answer(user, applicationId, notice, { kind: "confirm" }, kit.revision);
    kit = await answer(user, applicationId, why, { kind: "type", answer: "The mission." }, kit.revision);
    kit = await answer(user, applicationId, visa, { kind: "type", answer: "Not needed." }, kit.revision);
    // Reversed, with a new one in the middle and one reworded.
    kit = await landed(putQuestions(user, applicationId, [{ id: visa, text: "Visa status" }, { text: "Anything else?" }, { id: why, text: "Why us?" }, { id: notice, text: "Notice period" }], kit.revision));
    expect(kit.questions.map((question) => [question.position, question.text, question.state, question.typedAnswer, question.confirmed])).toEqual([
      [0, "Visa status", "sensitive", "Not needed.", false],
      [1, "Anything else?", "asks", null, false],
      [2, "Why us?", "asks", "The mission.", false],
      [3, "Notice period", "matched", null, true],
    ]);
    expect(kit.questions.map((question) => question.id)).toEqual([visa, expect.any(String), why, notice]);
    expect(kit.questions[3]!.savedAnswer).toEqual(saved);
    // A reworded question is asked again, from nothing.
    kit = await landed(putQuestions(user, applicationId, [{ id: why, text: "Why this team?" }], kit.revision));
    expect(kit.questions).toEqual([expect.objectContaining({ id: why, text: "Why this team?", state: "asks", typedAnswer: null })]);
    // A repeated ID, one from no question of this kit, an empty line and too many are refused, and nothing changes.
    const held = await sql(user, (db) => db.exec(`SELECT * FROM kit_questions ORDER BY position`).toArray());
    expect(await refused(putQuestions(user, applicationId, [{ id: why, text: "A" }, { id: why, text: "B" }], kit.revision))).toEqual([422, KIT_QUESTIONS_REFUSED]);
    expect(await refused(putQuestions(user, applicationId, [{ id: notice, text: "Gone" }], kit.revision))).toEqual([422, KIT_QUESTIONS_REFUSED]);
    expect(await refused(putQuestions(user, applicationId, [{ text: " \u200b " }], kit.revision))).toEqual([422, KIT_QUESTIONS_REFUSED]);
    expect(await refused(putQuestions(user, applicationId, [{ text: "q".repeat(1001) }], kit.revision))).toEqual([422, KIT_QUESTIONS_REFUSED]);
    expect(await refused(putQuestions(user, applicationId, Array.from({ length: 31 }, (_, index) => ({ text: `Question ${index}` })), kit.revision))).toEqual([422, KIT_QUESTIONS_REFUSED]);
    expect(await refused(putQuestions(user, applicationId, [{ text: "Fine" }], kit.revision - 1))).toEqual([409, KIT_CHANGED]);
    expect(await sql(user, (db) => db.exec(`SELECT * FROM kit_questions ORDER BY position`).toArray())).toEqual(held);
    // Thirty questions of a thousand three-byte characters fit the route's own limit.
    const long = Array.from({ length: 30 }, (_, index) => ({ text: `${index} ${"€".repeat(997)}` }));
    kit = await landed(putQuestions(user, applicationId, long, kit.revision));
    expect(kit.questions).toHaveLength(30);
    // Hidden characters are taken out of a question before it is stored or matched.
    kit = await landed(putQuestions(user, applicationId, [{ text: "Notice\u200b period\u202e" }], kit.revision));
    expect(kit.questions[0]).toMatchObject({ text: "Notice period", state: "matched", matchedBy: "label" });
  });
});

// Tailoring and writing run as Workflows, which are slower while other suites share the machine.
describe("approving and downloading a kit", { timeout: 120_000 }, () => {
  it("refuses approval with an unanswered question, an unconfirmed match, no resume, or a match whose saved answer was edited", async () => {
    const { user, applicationId } = await owner();
    const resume = await tailor(user, applicationId);
    const saved = await addSaved(user, "Notice period", "Four weeks.");
    // Nothing at all: no resume.
    expect(await refused(postApprove(user, applicationId, 0))).toEqual([422, KIT_NO_RESUME]);
    let kit = await questions(user, applicationId, ["Notice period", "Why us?"], 0);
    expect(await refused(postApprove(user, applicationId, kit.revision))).toEqual([422, KIT_NO_RESUME]);
    kit = await landed(putParts(user, applicationId, { resume: partOf(resume) }, kit.revision));
    // The match isn't confirmed, and the second has no answer.
    expect(kit.problems).toEqual([{ code: "unanswered", questionIds: kit.questions.map((question) => question.id) }]);
    expect(await refused(postApprove(user, applicationId, kit.revision))).toEqual([422, KIT_UNANSWERED]);
    kit = await answer(user, applicationId, kit.questions[1]!.id, { kind: "type", answer: "The mission." }, kit.revision);
    expect(await refused(postApprove(user, applicationId, kit.revision))).toEqual([422, KIT_UNANSWERED]);
    kit = await answer(user, applicationId, kit.questions[0]!.id, { kind: "confirm" }, kit.revision);
    expect(kit.problems).toEqual([]);
    // Confirmed at revision 1. An edit to the saved answer unconfirms it.
    expect((await putSaved(user, saved.id, "Notice period", "Two weeks.", 1)).status).toBe(200);
    kit = await kitOf(user, applicationId);
    expect(kit.questions[0]).toMatchObject({ confirmed: false, savedAnswer: expect.objectContaining({ revision: 2, answer: "Two weeks." }) });
    expect(await refused(postApprove(user, applicationId, kit.revision))).toEqual([422, KIT_UNANSWERED]);
    // A stale revision is refused before anything is checked.
    kit = await answer(user, applicationId, kit.questions[0]!.id, { kind: "confirm" }, kit.revision);
    expect(await refused(postApprove(user, applicationId, kit.revision - 1))).toEqual([409, KIT_CHANGED]);
    kit = await landed(postApprove(user, applicationId, kit.revision));
    expect(kit).toMatchObject({ state: "approved", approvedAt: expect.any(Number), ready: true, problems: [] });
    // An approved kit is approved once.
    expect(await refused(postApprove(user, applicationId, kit.revision))).toEqual([409, KIT_CHANGED]);
  });

  it("returns an approved kit to draft on each change: a question added, a question edited, a question moved, an answer typed, a match rejected, parts changed, a saved answer edited, a saved answer deleted", async () => {
    const { user, applicationId } = await owner();
    const resume = await tailor(user, applicationId);
    const saved = await addSaved(user, "Notice period", "Four weeks.");
    let kit = await questions(user, applicationId, ["Notice period", "Why us?"], 0);
    kit = await answer(user, applicationId, kit.questions[0]!.id, { kind: "confirm" }, kit.revision);
    kit = await answer(user, applicationId, kit.questions[1]!.id, { kind: "type", answer: "The mission." }, kit.revision);
    kit = await landed(putParts(user, applicationId, { resume: partOf(resume) }, kit.revision));
    const [notice, why] = kit.questions.map((question) => ({ id: question.id, text: question.text }));
    const approved = async () => {
      const now = await kitOf(user, applicationId);
      if (now.state === "draft") {
        // Put it back as it was, then approve it.
        let again = await landed(putQuestions(user, applicationId, [notice!, why!], now.revision));
        if (again.questions[0]!.state === "asks") again = await answer(user, applicationId, notice!.id, { kind: "use", savedAnswerId: saved.id }, again.revision);
        else if (!again.questions[0]!.confirmed) again = await answer(user, applicationId, notice!.id, { kind: "confirm" }, again.revision);
        if (again.questions[1]!.typedAnswer === null) again = await answer(user, applicationId, why!.id, { kind: "type", answer: "The mission." }, again.revision);
        if (!again.resume) again = await landed(putParts(user, applicationId, { resume: partOf(resume) }, again.revision));
        return landed(postApprove(user, applicationId, again.revision));
      }
      return now;
    };
    const changes: [string, (kit: KitView) => Promise<unknown>][] = [
      ["a question added", (at) => landed(putQuestions(user, applicationId, [notice!, why!, { text: "Anything else?" }], at.revision))],
      ["a question edited", (at) => landed(putQuestions(user, applicationId, [notice!, { id: why!.id, text: "Why this team?" }], at.revision))],
      ["a question moved", (at) => landed(putQuestions(user, applicationId, [why!, notice!], at.revision))],
      ["an answer typed", (at) => answer(user, applicationId, why!.id, { kind: "type", answer: "The people." }, at.revision)],
      ["a match rejected", (at) => answer(user, applicationId, notice!.id, { kind: "reject" }, at.revision)],
      ["parts changed", (at) => landed(putParts(user, applicationId, { resume: partOf(resume) }, at.revision))],
      ["a saved answer edited", async () => expect((await putSaved(user, saved.id, "Notice period", "Four weeks.", (await savedList(user))[0]!.revision)).status).toBe(200)],
    ];
    for (const [what, change] of changes) {
      const at = await approved();
      expect(at, what).toMatchObject({ state: "approved", ready: true });
      await change(at);
      const after = await kitOf(user, applicationId);
      expect(after, what).toMatchObject({ state: "draft", approvedAt: null, ready: false, revision: at.revision + 1 });
      expect((await download(user, applicationId)).status, what).toBe(409);
    }
    // Deleting the saved answer it uses: the question asks again.
    const at = await approved();
    expect(at.state).toBe("approved");
    expect((await user.send("DELETE", `/api/saved-answers/${saved.id}`)).status).toBe(204);
    const after = await kitOf(user, applicationId);
    expect(after).toMatchObject({ state: "draft", revision: at.revision + 1 });
    expect(after.questions[0]).toMatchObject({ state: "asks", savedAnswer: null, matchedBy: null, confirmed: false });
  });

  it("refuses a resume version from another job, a resume in review, and a document from another job or of the wrong kind", async () => {
    const { user, applicationId } = await owner();
    const resume = await tailor(user, applicationId);
    const letter = await write(user, applicationId, "letter");
    const prep = await write(user, applicationId, "prep");
    const elsewhere = await job(user);
    const theirs = await tailor(user, elsewhere);
    const theirLetter = await write(user, elsewhere, "letter");
    const choose = (parts: { resume: KitPart | null; letter?: KitPart | null; prep?: KitPart | null }) => refused(putParts(user, applicationId, parts, 0));
    expect(await choose({ resume: partOf(theirs) })).toEqual([422, KIT_CHOICE_REFUSED]);
    expect(await choose({ resume: { id: resume.id, version: resume.version + 5 } })).toEqual([422, KIT_CHOICE_REFUSED]);
    expect(await choose({ resume: { id: "no-such-resume", version: 1 } })).toEqual([422, KIT_CHOICE_REFUSED]);
    expect(await choose({ resume: partOf(resume), letter: partOf(theirLetter) })).toEqual([422, KIT_CHOICE_REFUSED]);
    expect(await choose({ resume: partOf(resume), letter: partOf(prep) })).toEqual([422, KIT_CHOICE_REFUSED]);
    expect(await choose({ resume: partOf(resume), prep: partOf(letter) })).toEqual([422, KIT_CHOICE_REFUSED]);
    expect(await choose({ resume: partOf(resume), prep: { id: prep.id, version: 9 } })).toEqual([422, KIT_CHOICE_REFUSED]);
    // A resume in review: the version a grounding review begins, which no check has passed yet, as
    // beginResumeReview writes it. It is refused as a version that can't go in a kit.
    await sql(user, (db) => {
      const row = db.exec<{ data: string }>(`SELECT data FROM resume_versions WHERE resume_id = ? AND version = ?`, resume.id, resume.version).one();
      const data = JSON.parse(row.data) as { provenance: string; render: { version: number } };
      const review = { ...data, render: { ...data.render, version: resume.version + 1 }, provenance: "legacy", legacyReceipts: {}, reviewStartedFrom: resume.version };
      db.exec(`INSERT INTO resume_versions (resume_id, version, data, created_at) VALUES (?, ?, ?, ?)`, resume.id, resume.version + 1, JSON.stringify(review), Date.now());
      db.exec(`UPDATE resumes SET version = ? WHERE id = ?`, resume.version + 1, resume.id);
    });
    expect(await choose({ resume: { id: resume.id, version: resume.version + 1 } })).toEqual([409, KIT_RESUME_REFUSED]);
    // A document that fails its gate.
    await sql(user, (db) => db.exec(`UPDATE document_versions SET data = ? WHERE document_id = ?`, JSON.stringify({ result: { kind: "letter", units: [], questions: [] } }), letter.id));
    expect(await choose({ resume: partOf(resume), letter: partOf(letter) })).toEqual([409, KIT_DOCUMENT_REFUSED]);
    // A resume still being made, or one that failed, is not finished.
    await sql(user, (db) => db.exec(`UPDATE resumes SET state = 'running' WHERE id = ?`, theirs.id));
    await sql(user, (db) => db.exec(`UPDATE resumes SET application_id = ? WHERE id = ?`, applicationId, theirs.id));
    expect(await choose({ resume: partOf(theirs) })).toEqual([422, KIT_CHOICE_REFUSED]);
    expect(await count(user, "application_kits")).toBe(0);
    // And what can be chosen is offered: this job's ready versions, letters and preparation that pass now.
    const kit = await kitOf(user, applicationId);
    expect(kit.choices.resumes.map((choice) => [choice.id, choice.version])).toEqual([[resume.id, resume.version]]);
    expect(kit.choices.letters).toEqual([]);
    expect(kit.choices.preps.map((choice) => choice.id)).toEqual([prep.id]);
    expect((await landed(putParts(user, applicationId, { resume: partOf(resume), prep: partOf(prep) }, 0))).prep).toEqual(partOf(prep));
  });
});

// Tailoring and writing run as Workflows, which are slower while other suites share the machine.
describe("approving and downloading a kit, its gates", { timeout: 120_000 }, () => {
  it("refuses approval and download once a fact the chosen resume cites is marked sensitive, and says so in the view", async () => {
    const { user, applicationId, factIds } = await owner();
    const resume = await tailor(user, applicationId);
    let kit = await readyKit(user, applicationId, resume);
    kit = await landed(postApprove(user, applicationId, kit.revision));
    expect(kit.ready).toBe(true);
    printAsText();
    expect((await download(user, applicationId)).status).toBe(200);
    const cited = resume.body!.sections.flatMap((section) => section.lines).flatMap((line) => line.factIds);
    const marked = factIds.filter((id) => cited.includes(id));
    expect(marked.length).toBeGreaterThan(0);
    expect((await user.send("POST", "/api/facts/sensitive", { ids: marked, sensitive: true })).status).toBe(204);
    // Still approved, as written, and blocked on every read: the gate is worked out each time.
    const now = await kitOf(user, applicationId);
    expect(now).toMatchObject({ state: "approved", revision: kit.revision, ready: false, problems: [{ code: "resume_refused" }] });
    expect(now.choices.resumes).toEqual([]);
    expect(await refused(download(user, applicationId))).toEqual([409, KIT_RESUME_REFUSED]);
    // A draft with the same resume can't be approved either.
    const draft = await answer(user, applicationId, kit.questions[0]!.id, { kind: "type", answer: "Because of the team." }, now.revision);
    expect(await refused(postApprove(user, applicationId, draft.revision))).toEqual([409, KIT_RESUME_REFUSED]);
    // Nor chosen again.
    expect(await refused(putParts(user, applicationId, { resume: partOf(resume) }, draft.revision))).toEqual([409, KIT_RESUME_REFUSED]);
    // Unmarked, the same kit passes again.
    expect((await user.send("POST", "/api/facts/sensitive", { ids: marked, sensitive: false })).status).toBe(204);
    expect((await kitOf(user, applicationId)).problems).toEqual([]);
  });

  it("keeps a sensitive answer in the kit only: it is not in saved answers, and use or save on it is refused", async () => {
    const { user, applicationId } = await owner();
    const saved = await addSaved(user, "Notice period", "Four weeks.");
    let kit = await questions(user, applicationId, ["Do you require visa sponsorship?", "Notice period"], 0);
    const [visa, notice] = kit.questions;
    expect(visa).toMatchObject({ state: "sensitive", sensitiveKind: "work_authorisation" });
    const ANSWER = "Tregeseal permit holder until 2031";
    kit = await answer(user, applicationId, visa!.id, { kind: "type", answer: ANSWER }, kit.revision);
    expect(kit.questions[0]).toMatchObject({ state: "sensitive", typedAnswer: ANSWER });
    expect(JSON.stringify(await savedList(user))).not.toContain("Tregeseal");
    expect(await count(user, "saved_answers")).toBe(1);
    // Never saved and never matched, even when the owner asks.
    expect(await refused(postAnswer(user, applicationId, visa!.id, { kind: "use", savedAnswerId: saved.id }, kit.revision))).toEqual([409, KIT_CHANGED]);
    expect(await refused(postAnswer(user, applicationId, visa!.id, { kind: "save", label: "Visa", answer: ANSWER }, kit.revision))).toEqual([409, KIT_CHANGED]);
    // A question asking about it in words the list caught only later: asks, and use and save are refused for it.
    await sql(user, (db) => db.exec(`UPDATE kit_questions SET question = 'Will you need a work permit?', state = 'asks', sensitive_kind = NULL, typed_answer = NULL WHERE id = ?`, visa!.id));
    kit = await kitOf(user, applicationId);
    expect(await refused(postAnswer(user, applicationId, visa!.id, { kind: "use", savedAnswerId: saved.id }, kit.revision))).toEqual([422, KIT_SENSITIVE_NEVER_SAVED]);
    expect(await refused(postAnswer(user, applicationId, visa!.id, { kind: "save", label: "Permit", answer: "Yes" }, kit.revision))).toEqual([422, KIT_SENSITIVE_NEVER_SAVED]);
    // A typed answer can be kept as a saved answer, unless it is about a refused kind.
    kit = await answer(user, applicationId, notice!.id, { kind: "reject" }, kit.revision);
    expect(await refused(postAnswer(user, applicationId, notice!.id, { kind: "save", label: "Start", answer: "After my visa is renewed." }, kit.revision))).toEqual([
      422,
      REFUSED_KIND_SENTENCE.work_authorisation,
    ]);
    expect(await refused(postAnswer(user, applicationId, notice!.id, { kind: "type", answer: "x".repeat(4001) }, kit.revision))).toEqual([422, KIT_ANSWER_REFUSED]);
    expect(await refused(postAnswer(user, applicationId, notice!.id, { kind: "type", answer: " \u200b " }, kit.revision))).toEqual([422, KIT_ANSWER_REFUSED]);
    expect(await refused(postAnswer(user, applicationId, "no-such-question", { kind: "type", answer: "Yes" }, kit.revision))).toEqual([404, "no such question"]);
    kit = await answer(user, applicationId, notice!.id, { kind: "save", label: "Start", answer: "Two weeks after an offer." }, kit.revision);
    expect(kit.questions[1]).toMatchObject({ state: "matched", matchedBy: "owner", confirmed: true, savedAnswer: expect.objectContaining({ label: "Start" }) });
    expect((await savedList(user)).map((answer) => answer.label)).toEqual(["Notice period", "Start"]);
    // A match whose saved answer the list now refuses is treated as sensitive: it can't be confirmed, and blocks approval.
    await sql(user, (db) => db.exec(`UPDATE saved_answers SET answer_text = 'Two weeks, then my salary review.' WHERE label = 'Start'`));
    kit = await kitOf(user, applicationId);
    expect(kit.questions[1]!.savedAnswer).toMatchObject({ refusedKind: "pay" });
    expect(kit.problems).toEqual(expect.arrayContaining([{ code: "refused_kind", questionIds: [notice!.id] }]));
    expect(await refused(postAnswer(user, applicationId, notice!.id, { kind: "confirm" }, kit.revision))).toEqual([422, KIT_SENSITIVE_NEVER_SAVED]);
    expect(await refused(postAnswer(user, applicationId, kit.questions[0]!.id, { kind: "use", savedAnswerId: kit.questions[1]!.savedAnswer!.id }, kit.revision))).toEqual([
      422,
      KIT_SENSITIVE_NEVER_SAVED,
    ]);
  });

  it("downloads an approved kit as a ZIP of resume.pdf, resume.docx, cover-letter.docx, interview-preparation.docx and answers.txt, with each question and answer", async () => {
    const { user, applicationId } = await owner();
    const resume = await tailor(user, applicationId);
    const letter = await write(user, applicationId, "letter");
    const prep = await write(user, applicationId, "prep");
    const saved = await addSaved(user, "Notice period", "Four weeks, from the day I accept.");
    let kit = await questions(user, applicationId, ["Notice period", "Do you need sponsorship?", "Why us?"], 0);
    kit = await answer(user, applicationId, kit.questions[0]!.id, { kind: "confirm" }, kit.revision);
    kit = await answer(user, applicationId, kit.questions[1]!.id, { kind: "type", answer: "No." }, kit.revision);
    kit = await answer(user, applicationId, kit.questions[2]!.id, { kind: "type", answer: "The mission,\nand the team." }, kit.revision);
    kit = await landed(putParts(user, applicationId, { resume: partOf(resume), letter: partOf(letter), prep: partOf(prep) }, kit.revision));
    kit = await landed(postApprove(user, applicationId, kit.revision));
    expect(kit).toMatchObject({ state: "approved", ready: true, resume: partOf(resume), letter: partOf(letter), prep: partOf(prep) });
    printAsText();
    const response = await download(user, applicationId);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="application-kit-[\w-]+\.zip"$/);
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(files)).toEqual(["resume.pdf", "resume.docx", "cover-letter.docx", "interview-preparation.docx", "answers.txt"]);
    const word = (name: string) => strFromU8(unzipSync(files[name]!)["word/document.xml"]!);
    expect(strFromU8(files["resume.pdf"]!)).toContain(FACT);
    expect(word("resume.docx")).toContain("Sam Rivera");
    expect(word("cover-letter.docx")).toContain("Cover letter");
    expect(word("cover-letter.docx")).toContain(FACT);
    expect(word("interview-preparation.docx")).toContain("Interview preparation");
    expect(strFromU8(files["answers.txt"]!)).toBe(
      ["Question 1", "Notice period", "Your answer", saved.answer, "Question 2", "Do you need sponsorship?", "Your answer", "No.", "Question 3", "Why us?", "Your answer", "The mission,\nand the team."].join("\n\n") + "\n",
    );
    // A matched answer is its saved answer's words now: an edit makes the kit a draft, and once
    // checked and approved again the download says the new words.
    expect((await putSaved(user, saved.id, "Notice period", "Two weeks.", 1)).status).toBe(200);
    expect(await refused(download(user, applicationId))).toEqual([409, KIT_NOT_APPROVED]);
    kit = await answer(user, applicationId, kit.questions[0]!.id, { kind: "confirm" }, (await kitOf(user, applicationId)).revision);
    kit = await landed(postApprove(user, applicationId, kit.revision));
    const again = unzipSync(new Uint8Array(await (await download(user, applicationId)).arrayBuffer()));
    expect(strFromU8(again["answers.txt"]!)).toContain("Your answer\n\nTwo weeks.");
    // A kit without a letter or preparation leaves them out.
    kit = await landed(putParts(user, applicationId, { resume: partOf(resume) }, kit.revision));
    kit = await landed(postApprove(user, applicationId, kit.revision));
    expect(Object.keys(unzipSync(new Uint8Array(await (await download(user, applicationId)).arrayBuffer())))).toEqual(["resume.pdf", "resume.docx", "answers.txt"]);
  });

  it("refuses to download a draft kit", async () => {
    const { user, applicationId } = await owner();
    const resume = await tailor(user, applicationId);
    expect(await refused(download(user, applicationId))).toEqual([409, KIT_NOT_APPROVED]);
    const kit = await readyKit(user, applicationId, resume);
    expect(kit).toMatchObject({ state: "draft", problems: [] });
    expect(await refused(download(user, applicationId))).toEqual([409, KIT_NOT_APPROVED]);
    // And a job that isn't there has no kit to download.
    expect((await download(user, "no-such-job")).status).toBe(404);
    expect((await user.fetch("/api/applications/no-such-job/kit")).status).toBe(404);
  });
});

// Tailoring and writing run as Workflows, which are slower while other suites share the machine.
describe("a kit's life with its vault", { timeout: 120_000 }, () => {
  it("is in the owner's export, JSON and ZIP", async () => {
    const { user, applicationId } = await owner();
    const empty = await user.json<Record<string, unknown>>("/api/export");
    expect([empty.savedAnswers, empty.applicationKits, empty.kitQuestions]).toEqual([[], [], []]);
    const saved = await addSaved(user, "Notice period", "Four weeks.");
    let kit = await questions(user, applicationId, ["Notice period", "Visa status"], 0);
    kit = await answer(user, applicationId, kit.questions[1]!.id, { kind: "type", answer: "Not needed." }, kit.revision);
    const exported = await user.json<Record<string, unknown>>("/api/export");
    expect(exported.format).toBe(2);
    expect(exported.savedAnswers).toEqual([{ id: saved.id, revision: 1, label: "Notice period", labelKey: "notice period", answer: "Four weeks.", createdAt: saved.createdAt, updatedAt: saved.updatedAt }]);
    expect(exported.applicationKits).toEqual([
      { applicationId, revision: kit.revision, state: "draft", approvedAt: null, resume: null, letter: null, prep: null, createdAt: expect.any(Number), updatedAt: kit.updatedAt },
    ]);
    expect(exported.kitQuestions).toEqual([
      { id: kit.questions[0]!.id, applicationId, position: 0, question: "Notice period", state: "matched", matchedBy: "label", savedAnswerId: saved.id, confirmedRevision: null, sensitiveKind: null, typedAnswer: null },
      { id: kit.questions[1]!.id, applicationId, position: 1, question: "Visa status", state: "sensitive", matchedBy: null, savedAnswerId: null, confirmedRevision: null, sensitiveKind: "work_authorisation", typedAnswer: "Not needed." },
    ]);
    const archive = await user.fetch("/api/export/archive");
    expect(archive.status).toBe(200);
    const json = JSON.parse(strFromU8(unzipSync(new Uint8Array(await archive.arrayBuffer()))["vault.json"]!)) as Record<string, unknown>;
    expect([json.savedAnswers, json.applicationKits, json.kitQuestions]).toEqual([exported.savedAnswers, exported.applicationKits, exported.kitQuestions]);
    // Another account's export holds its own, which is nothing.
    const other = await (await signIn()).json<Record<string, unknown>>("/api/export");
    expect([other.savedAnswers, other.applicationKits, other.kitQuestions]).toEqual([[], [], []]);
  });

  it("goes with a vault moved to a replacement, revisions and state as they were, with a finished match run in the vault", async () => {
    const email = uniqueEmail();
    const { user, applicationId } = await owner(email);
    const resume = await tailor(user, applicationId);
    await judgeOn(user);
    options.match = () => ({ kind: "label", index: 0 });
    const saved = await addSaved(user, "Notice period", "Four weeks.");
    expect((await putSaved(user, saved.id, "Notice period", "Two weeks.", 1)).status).toBe(200);
    let kit = await questions(user, applicationId, ["When could you start?"], 0);
    kit = await answer(user, applicationId, kit.questions[0]!.id, { kind: "confirm" }, kit.revision);
    kit = await landed(putParts(user, applicationId, { resume: partOf(resume) }, kit.revision));
    kit = await landed(postApprove(user, applicationId, kit.revision));
    expect(await runsOf(user, "match")).toEqual([expect.objectContaining({ state: "succeeded" })]);
    const before = { kit, saved: await savedList(user), rows: await sql(user, (db) => db.exec(`SELECT * FROM kit_questions`).toArray()) };

    const old = sessionOf(user);
    const operation = crypto.randomUUID();
    const { targetVaultId } = await directory(env).prepareReplacement(old.vid, operation);
    const source = vault(env, old.vid);
    const target = vault(env, targetVaultId);
    for (const object of [source, target, directory(env)]) await setting(object, "RESTORE_FENCE_IDS", [old.vid, targetVaultId].join(","));
    const manifest = await source.transferManifest(operation);
    // The three tables are sent after every table they name, in their migration's order.
    const names = manifest.tables.map((table) => table.name);
    expect(names).toEqual(TRANSFER_TABLES);
    const at = names.indexOf("saved_answers");
    expect(names.slice(at - 1, at + 3)).toEqual(["share_comments", "saved_answers", "application_kits", "kit_questions"]);
    expect(manifest.tables.slice(at, at + 3).map((table) => table.count)).toEqual([1, 1, 1]);
    await target.importManifest(manifest);
    for (const table of manifest.tables) {
      const page = await source.transferPage(operation, table.name);
      expect(page.done).toBe(true);
      await target.importPage(page);
    }
    expect(await target.finishImport(operation, old.vid)).toMatchObject({ state: "ready", completedTables: manifest.tables.length });
    await directory(env).cutover(old.vid, targetVaultId, operation);
    await setting(target, "RESTORE_FENCE_IDS", old.vid);

    const moved = await signIn(email);
    expect(sessionOf(moved)).toMatchObject({ uid: old.uid, vid: targetVaultId });
    // Approved as it was, at the same revision, and gated again on the read.
    expect(await kitOf(moved, applicationId)).toEqual(before.kit);
    expect(await savedList(moved)).toEqual(before.saved);
    expect(await sql(moved, (db) => db.exec(`SELECT * FROM kit_questions`).toArray())).toEqual(before.rows);
    // Runs move only as the spend ledger the control checkpoint carries, so the finished match
    // arrives finished, and nothing in the replacement is left to ask.
    expect(await runsOf(moved, "match")).toEqual([expect.objectContaining({ state: "succeeded" })]);
    printAsText();
    expect((await download(moved, applicationId)).status).toBe(200);
    // A page that loaded the kit before the move is as current or as stale as it was.
    expect(await refused(postApprove(moved, applicationId, kit.revision - 1))).toEqual([409, KIT_CHANGED]);
  });

  it("deletes a job's kit with the job, and is gone when the account is deleted after the judge has run", async () => {
    const email = uniqueEmail();
    const { user } = await owner(email);
    const { vid } = sessionOf(user);
    await judgeOn(user);
    options.match = () => ({ kind: "none" });
    await addSaved(user, "Notice period", "Four weeks.");
    const spare = await job(user);
    let kit = await questions(user, spare, ["When could you start?", "Visa status"], 0);
    kit = await answer(user, spare, kit.questions[1]!.id, { kind: "type", answer: "Not needed." }, kit.revision);
    expect(await runsOf(user, "match")).toEqual([expect.objectContaining({ state: "succeeded" })]);
    // A kit is not work that keeps a job: a job with only a kit can be deleted, and its kit goes with it.
    expect((await user.json(`/api/applications/${spare}`)).canDelete).toBe(true);
    expect((await user.send("DELETE", `/api/applications/${spare}`)).status).toBe(204);
    expect([await count(user, "application_kits"), await count(user, "kit_questions")]).toEqual([0, 0]);
    // Saved answers are the owner's, not the job's: they stay.
    expect(await count(user, "saved_answers")).toBe(1);
    // A kit again, on another job, so there is something to erase.
    const other = await job(user);
    await questions(user, other, ["Why us?"], 0);
    expect([await count(user, "saved_answers"), await count(user, "application_kits"), await count(user, "kit_questions")]).toEqual([1, 1, 1]);

    // The finished match run needs no Workflow stopped, so deletion goes all the way.
    expect((await user.send("DELETE", "/auth/account")).status).toBe(202);
    await runDurableObjectAlarm(directory(env));
    await eventually(async () => {
      const page: { vaultId: string }[] = await directory(env).listVaults({ limit: 200 });
      const tables = await runInDurableObject(vault(env, vid), (_instance, state) =>
        state.storage.sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).toArray().map((table) => table.name),
      );
      return !page.some((row) => row.vaultId === vid) && tables.filter((name) => !name.startsWith("_cf_") && !name.startsWith("sqlite_")).length === 0;
    }, "the account to be erased", WAIT);
    expect(await vault(env, vid).deletionProbe()).toEqual({ rows: 0 });
    expect((await user.fetch("/api/saved-answers")).status).toBe(410);
  });

  it("never reaches a shared copy, a coach's view or a connected app's tools, and the application kit surface carries no fact marked sensitive", async () => {
    const { user, applicationId, factIds } = await owner();
    printAsText();
    const resume = await tailor(user, applicationId);
    const letter = await write(user, applicationId, "letter");
    const SAVED = "Penwith-saved-canary-answer";
    const TYPED = "Lamorna-typed-canary-answer";
    const QUESTION = "Boscawen-question-canary";
    await addSaved(user, "Notice period", SAVED);
    let kit = await questions(user, applicationId, ["Notice period", `${QUESTION} why us?`], 0);
    kit = await answer(user, applicationId, kit.questions[0]!.id, { kind: "confirm" }, kit.revision);
    kit = await answer(user, applicationId, kit.questions[1]!.id, { kind: "type", answer: TYPED }, kit.revision);
    kit = await landed(putParts(user, applicationId, { resume: partOf(resume), letter: partOf(letter) }, kit.revision));
    kit = await landed(postApprove(user, applicationId, kit.revision));
    const coach = await signIn(uniqueEmail("coach"));
    const response = await user.send("POST", "/api/shares", {
      factIds, resumes: [partOf(resume)], documents: [partOf(letter)], showName: true, showJobs: true, coachEmail: coach.email,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const { grant, url } = (await response.json()) as { grant: ShareGrant; url: string };
    const copies = [{ grant, token: new URL(url).hash.slice(1), coach }];
    const surfaces = (parts: { surface: string; text: string }[], words: string) => [...new Set(parts.filter((part) => part.text.includes(words)).map((part) => part.surface))].sort();

    const parts = await outwardParts({ owner: user, copies, inputs: options.inputs });
    // The kit's words leave only in its own ZIP, which its owner sends on.
    for (const words of [SAVED, TYPED, QUESTION]) expect(surfaces(parts, words), words).toEqual(["application kit"]);
    // The ZIP carries the resume and letter, which every other way out of a copy carries too.
    expect(surfaces(parts, FACT)).toEqual(expect.arrayContaining(["application kit", "copy by its link", "copy as its coach", "list_facts", "PDF", "Word", "model input"]));

    // Marked sensitive, a fact the kit's resume and letter use closes the kit: its surface gives nothing.
    expect((await user.send("POST", "/api/facts/sensitive", { ids: factIds, sensitive: true })).status).toBe(204);
    const after = await outwardParts({ owner: user, copies, inputs: [] });
    expect(after.filter((part) => part.surface === "application kit")).toEqual([]);
    expect(after.map((part) => part.text).join("\n")).not.toContain(FACT);
    expect(after.map((part) => part.text).join("\n")).not.toContain(OTHER_FACT);
    expect((await kitOf(user, applicationId)).problems.map((problem) => problem.code)).toEqual(["resume_refused", "letter_refused"]);
  });

  it("is owner-only: no session, another account's who, a stale generation, a fenced or closing vault", async () => {
    const { user, applicationId } = await owner();
    const saved = await addSaved(user, "Notice period", "Four weeks.");
    const kit = await questions(user, applicationId, ["Notice period"], 0);
    const questionId = kit.questions[0]!.id;
    const held = async () => ({
      saved: await sql(user, (db) => db.exec(`SELECT * FROM saved_answers`).toArray()),
      kits: await sql(user, (db) => db.exec(`SELECT * FROM application_kits`).toArray()),
      questions: await sql(user, (db) => db.exec(`SELECT * FROM kit_questions`).toArray()),
    });
    const before = await held();
    const routes: [string, string, unknown?][] = [
      ["GET", "/api/saved-answers"],
      ["POST", "/api/saved-answers", { label: "Portfolio", answer: "https://example.com" }],
      ["PUT", `/api/saved-answers/${saved.id}`, { label: "Notice period", answer: "Two weeks.", expectedRevision: 1 }],
      ["DELETE", `/api/saved-answers/${saved.id}`],
      ["GET", `/api/applications/${applicationId}/kit`],
      ["PUT", `/api/applications/${applicationId}/kit/questions`, { questions: [{ text: "Why us?" }], expectedRevision: kit.revision }],
      ["PUT", `/api/applications/${applicationId}/kit/parts`, { resume: null, letter: null, prep: null, expectedRevision: kit.revision }],
      ["POST", `/api/applications/${applicationId}/kit/questions/${questionId}`, { change: { kind: "confirm" }, expectedRevision: kit.revision }],
      ["POST", `/api/applications/${applicationId}/kit/approve`, { expectedRevision: kit.revision }],
      ["GET", `/api/applications/${applicationId}/kit/archive`],
    ];
    for (const [method, path, body] of routes) {
      const answered = await call(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
      expect(answered.status, `${method} ${path}`).toBe(401);
      expect(await answered.text()).not.toContain("Four weeks");
    }
    /** Every owner call on the Vault, as a caller would make it. */
    const calls = (stub: VaultStub, who: Who) => [
      stub.listSavedAnswers(who),
      stub.addSavedAnswer(who, { label: "Portfolio", answer: "https://example.com" }),
      stub.editSavedAnswer(who, saved.id, { label: "Notice period", answer: "Two weeks." }, 1),
      stub.deleteSavedAnswer(who, saved.id),
      stub.getKit(who, applicationId),
      stub.saveKitQuestions(who, applicationId, { questions: [{ text: "Why us?" }], expectedRevision: kit.revision }),
      stub.chooseKitParts(who, applicationId, { resume: null, letter: null, prep: null, expectedRevision: kit.revision }),
      stub.answerKitQuestion(who, applicationId, questionId, { kind: "confirm" }, kit.revision),
      stub.approveKit(who, applicationId, kit.revision),
      stub.kitArchiveData(who, applicationId),
    ];
    const refusals = async (who: Who) => Promise.all(calls(vaultOf(user), who).map(refusal));
    const dana = await signIn();
    expect(await refusals(whoOf(dana))).toEqual(Array(10).fill("forbidden: not this user's vault"));
    expect(await refusals({ ...whoOf(user), epoch: "an-earlier-epoch" })).toEqual(Array(10).fill("unauthenticated: this session is no longer valid"));
    const earlier = whoOf(user);
    expect((await user.send("POST", "/api/account/sign-out-everywhere")).status).toBe(204);
    expect(await refusals(earlier)).toEqual(Array(10).fill("unauthenticated: this session was signed out"));
    expect(await held()).toEqual(before);

    // Fenced for maintenance, every call is unavailable.
    const again = await signIn(user.email);
    await setting(vaultOf(again), "RESTORE_FENCE_IDS", sessionOf(again).vid);
    expect(await refusals(whoOf(again))).toEqual(Array(10).fill("unavailable: this account is temporarily unavailable during maintenance"));
    await setting(vaultOf(again), "RESTORE_FENCE_IDS", "");

    // A vault that closes while the judge is asked writes nothing when the answer comes back.
    await judgeOn(again);
    let asked = false;
    let released = false;
    options.match = async () => {
      asked = true;
      await until(() => released);
      return { kind: "none" };
    };
    const saving = putQuestions(again, applicationId, [{ id: questionId, text: "Notice period" }, { text: "When could you start?" }], kit.revision);
    await until(() => asked);
    expect((await again.send("DELETE", "/auth/account")).status).toBe(202);
    released = true;
    expect((await saving).status).toBe(410);
    expect(await held()).toEqual(before);
    expect(await refusals(whoOf(again))).toEqual(Array(10).fill("gone: this account is being deleted"));
  });

  it("gains saved answers and kits in a vault made before them, with its applications as they were", async () => {
    const { user, applicationId } = await owner();
    const before = (await user.json<{ applications: unknown[] }>("/api/applications")).applications;
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      const db = state.storage.sql;
      // Rewind this vault to the schema before saved answers, as an older vault would be.
      removeSavedAnswerMigration(db);
      const previous = MIGRATIONS.findIndex((migration) => migration.some((statement) => statement.includes("CREATE TABLE saved_answers")));
      expect(previous).toBeGreaterThan(-1);
      const named = () =>
        db
          .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE tbl_name IN ('saved_answers', 'application_kits', 'kit_questions') AND name NOT LIKE 'sqlite_%' ORDER BY name`)
          .toArray()
          .map((row) => row.name);
      expect(named()).toEqual([]);
      db.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      migrate(db, <T>(fn: () => T) => state.storage.transactionSync(fn));
      expect(db.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(SCHEMA_VERSION));
      expect(named()).toEqual(["application_kits", "kit_questions", "kit_questions_by_saved_answer", "saved_answers"]);
      for (const table of ["saved_answers", "application_kits", "kit_questions"]) expect(db.exec(`SELECT COUNT(*) AS n FROM ${table}`).one(), table).toEqual({ n: 0 });
    });
    expect((await user.json<{ applications: unknown[] }>("/api/applications")).applications).toEqual(before);
    // A job from before has no kit yet, and the tables work.
    expect(await kitOf(user, applicationId)).toMatchObject({ revision: 0, questions: [] });
    await addSaved(user, "Notice period", "Four weeks.");
    expect((await questions(user, applicationId, ["Notice period"], 0)).questions[0]).toMatchObject({ state: "matched" });
  });

  it("refuses maintenance while a match is running, and the alarm fails a stale one", async () => {
    const { user, applicationId } = await owner();
    await judgeOn(user);
    await addSaved(user, "Notice period", "Four weeks.");
    let asked = false;
    let released = false;
    options.match = async () => {
      asked = true;
      await until(() => released);
      return { kind: "none" };
    };
    const saving = putQuestions(user, applicationId, [{ text: "When could you start?" }], 0);
    await until(() => asked);
    const { vid } = sessionOf(user);
    await setting(vaultOf(user), "RESTORE_FENCE_IDS", vid);
    expect(await refusal(vaultOf(user).prepareMaintenance())).toBe("conflict: wait for the in-flight answer matching to settle before maintenance");
    await setting(vaultOf(user), "RESTORE_FENCE_IDS", "");
    released = true;
    expect((await saving).status).toBe(200);
    expect(await runsOf(user, "match")).toEqual([expect.objectContaining({ state: "succeeded" })]);

    // A match run left behind, as a vault evicted mid-match would leave it, is failed by the alarm once it is ten minutes old.
    const stale = crypto.randomUUID();
    await runInDurableObject(vaultOf(user), async (instance, state) => {
      const runs = (instance as unknown as { runs: { begin(input: unknown): unknown; claim(id: string): unknown } }).runs;
      runs.begin({ id: stale, kind: "match", targetId: applicationId, requestKey: `match:${stale}`, inputDigest: stale, steps: ["match"] });
      runs.claim(stale);
      await state.storage.setAlarm(Date.now());
    });
    expect(await runDurableObjectAlarm(vaultOf(user))).toBe(true);
    expect((await runsOf(user, "match")).find((run) => run.id === stale)).toMatchObject({ state: "running" });
    await sql(user, (db) => db.exec(`UPDATE runs SET created_at = ? WHERE id = ?`, Date.now() - 601_000, stale));
    await runInDurableObject(vaultOf(user), (_instance, state) => state.storage.setAlarm(Date.now()));
    expect(await runDurableObjectAlarm(vaultOf(user))).toBe(true);
    expect((await runsOf(user, "match")).find((run) => run.id === stale)).toMatchObject({ state: "failed", error_code: "match_interrupted" });
  });
});
