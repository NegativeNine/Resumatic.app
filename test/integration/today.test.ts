import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModels } from "../../src/ai/models";
import type { FactView, ResumeLine, ResumeView, RoleView } from "../../src/shared/api";
import type { KitView } from "../../src/shared/kit";
import { countByState } from "../../src/shared/review-groups";
import type { ShareComment, ShareGrant, ShareTarget } from "../../src/shared/sharing";
import { emptyStanding, MAX_TODAY_RECENT, TODAY_RECENT_MS, type Today, type TodayWaiting } from "../../src/shared/today";
import { vault } from "../../src/shared/stubs";
import { Vault } from "../../src/vault/vault";
import { fromBase64url } from "../../src/worker/crypto";
import { JOB_DESCRIPTION, RESUME, call, cookieFrom, fakeModels, signIn, uniqueEmail, waitForResume, waitForSource, type User } from "./support";

// GET /api/v2/today over HTTP: what waits for the owner in each room, from the session's own vault
// only, counted as the rooms count it, and holding no fact's, comment's, question's or answer's
// words and no stored error.

beforeEach(() => setModels(() => fakeModels()));
afterEach(() => {
  setModels(null);
  vi.restoreAllMocks();
});

const DAY = 86_400_000;

function sessionOf(user: User) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  return JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { uid: string; vid: string; gen: number; epoch?: string };
}
const vaultOf = (user: User) => vault(env, sessionOf(user).vid);
const whoOf = (user: User) => ({ userId: sessionOf(user).uid, gen: sessionOf(user).gen, epoch: sessionOf(user).epoch });
/** Runs statements against the user's vault storage, as a test that ages or seeds rows does. */
const sql = <T>(user: User, fn: (db: SqlStorage) => T) => runInDurableObject(vaultOf(user), (_instance, state) => fn(state.storage.sql));

async function today(user: User): Promise<{ today: Today; text: string }> {
  const response = await user.fetch("/api/v2/today");
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return { today: JSON.parse(text) as Today, text };
}
const of = <K extends TodayWaiting["kind"]>(today: Today, kind: K) =>
  today.waiting.filter((item): item is Extract<TodayWaiting, { kind: K }> => item.kind === kind);
const toCheck = (today: Today) => of(today, "check").reduce((sum, item) => sum + item.roles + item.facts, 0);

async function upload(user: User, filename: string, content: string): Promise<string> {
  const response = await user.upload(filename, content);
  expect(response.status, await response.clone().text()).toBe(201);
  const { sourceId } = (await response.json()) as { sourceId: string };
  expect((await waitForSource(user, sourceId)).state).toBe("ready");
  return sourceId;
}
const reviewView = (user: User) => user.json<{ roles: RoleView[]; facts: FactView[] }>("/api/v2/vault");
async function job(user: User): Promise<string> {
  const response = await user.send("POST", "/api/applications", { jdText: JOB_DESCRIPTION });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { applicationId: string }).applicationId;
}

/** What the Vault says when asked for Today directly, as `who`. */
const asking = (user: User, who: ReturnType<typeof whoOf>) =>
  runInDurableObject(vaultOf(user), async (instance) => {
    try {
      await instance.today(who);
      return "given";
    } catch (error) {
      return (error as Error).message;
    }
  });

/** A file that couldn't be read, with a stored error no person should see. */
const ERROR_CANARY = "Upstream exception 7f3a: provider said no";
async function unreadable(user: User, filename = "unreadable-cv.docx"): Promise<string> {
  const id = crypto.randomUUID();
  await sql(user, (db) =>
    db.exec(
      `INSERT INTO sources (id, filename, r2_key, state, error, created_at) VALUES (?, ?, ?, 'failed', ?, ?)`,
      id, filename, `vaults/${sessionOf(user).vid}/sources/${id}`, ERROR_CANARY, Date.now(),
    ),
  );
  return id;
}

// ---------------------------------------------------------------- a coach, a copy, a comment

async function share(user: User, body: Record<string, unknown>) {
  const response = await user.send("POST", "/api/shares", { factIds: [], resumes: [], showName: true, ...body });
  expect(response.status, await response.clone().text()).toBe(201);
  const { grant, url } = (await response.json()) as { grant: ShareGrant; url: string };
  return { grant, token: new URL(url).hash.slice(1) };
}
async function open(shared: { grant: ShareGrant; token: string }): Promise<string> {
  const exchange = await call("/share/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: shared.token }) });
  expect(exchange.status).toBe(200);
  return cookieFrom(exchange, `__Host-share-${shared.grant.id}`)!;
}
const jar = (...cookies: (string | null | undefined)[]) => cookies.filter(Boolean).join("; ");
const post = (cookie: string, path: string, body: unknown, key: string = crypto.randomUUID()) =>
  call(path, { method: "POST", cookie, headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
async function written(cookie: string, path: string, body: unknown): Promise<ShareComment> {
  const response = await post(cookie, path, body);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as ShareComment;
}
/** A coach, named on a copy and holding it in their list. */
async function coach(shared: { grant: ShareGrant; token: string }, address: string, name: string): Promise<User> {
  const link = await open(shared);
  const user = await signIn(address);
  expect((await user.send("PUT", "/api/profile", { name })).status).toBe(200);
  const taken = await call("/api/coach/clients", { method: "POST", cookie: jar(link, user.cookie), headers: { "content-type": "application/json" }, body: JSON.stringify({ grantId: shared.grant.id }) });
  expect(taken.status).toBe(204);
  return user;
}

const COMMENT = "Say what the Quillfeather migration cost the team";
const SUGGESTION = "Moved forty Quillfeather services in a quarter";

/**
 * Sam, with a tailored resume shared with Dana, who comments on one line and suggests wording for
 * another, and a copy of one fact shared with Lee, who comments on it.
 */
async function coached() {
  const sam = await signIn();
  expect((await sam.send("PUT", "/api/profile", { name: "Sam Rivera" })).status).toBe(200);
  await upload(sam, "synthetic.pdf", RESUME);
  const { roles, facts } = await reviewView(sam);
  expect((await sam.send("POST", "/api/review", { confirm: [...facts, ...roles].map((item) => item.id), reject: [] })).status).toBe(204);
  const applicationId = await job(sam);
  const started = await sam.send("POST", `/api/applications/${applicationId}/resumes`);
  expect(started.status, await started.clone().text()).toBe(202);
  const { resumeId } = (await started.json()) as { resumeId: string };
  const resume = (await waitForResume(sam, resumeId)) as ResumeView;
  expect(resume.state, resume.error ?? "").toBe("ready");
  const lines: ResumeLine[] = resume.body!.sections.flatMap((section) => section.lines);
  expect(lines.length).toBeGreaterThan(1);
  const [first, second] = lines;

  const danaAddress = uniqueEmail("coach");
  const resumeCopy = await share(sam, { resumes: [{ id: resume.id, version: resume.version }], coachEmail: danaAddress });
  const dana = await coach(resumeCopy, danaAddress, "Dana Okafor");
  const on = (line: ResumeLine): ShareTarget => ({ kind: "line", resumeId: resume.id, version: resume.version, lineId: line.id });
  const comment = await written(dana.cookie, `/api/coach/clients/${resumeCopy.grant.id}/comments`, { target: on(first!), body: COMMENT });
  const suggestion = await written(dana.cookie, `/api/coach/clients/${resumeCopy.grant.id}/suggestions`, { target: on(second!), text: SUGGESTION });

  const leeAddress = uniqueEmail("coach");
  const factCopy = await share(sam, { factIds: [facts[0]!.id], coachEmail: leeAddress });
  const lee = await coach(factCopy, leeAddress, "Lee Chen");
  const leeComment = await written(lee.cookie, `/api/coach/clients/${factCopy.grant.id}/comments`, { target: { kind: "fact", factId: facts[0]!.id }, body: `${COMMENT} too` });
  return { sam, dana, lee, danaAddress, leeAddress, resumeCopy, factCopy, comment, suggestion, leeComment, lines: [first!, second!] };
}

describe("what waits for the owner", () => {
  it("refuses a signed-out request without reading a vault", async () => {
    const read = vi.spyOn(Vault.prototype, "today");
    const response = await call("/api/v2/today");
    expect(response.status).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });

  it("answers each session from its own vault, whatever the request names", async () => {
    const sam = await signIn();
    const dana = await signIn();
    await unreadable(sam);
    expect((await today(sam)).today.counts.facts).toBe(1);
    // Dana's session reads Dana's vault, which holds nothing, whatever the address names.
    const named = await dana.fetch(`/api/v2/today?vault=${sessionOf(sam).vid}&user=${sessionOf(sam).uid}`);
    expect(named.status).toBe(200);
    const theirs = (await named.json()) as Today;
    expect(theirs.waiting).toEqual([]);
    expect(theirs.counts).toEqual({ today: 0, facts: 0, jobs: 0, sharing: 0 });
    expect(theirs.standing).toEqual(emptyStanding());
    expect((await today(sam)).today.standing?.files).toBe(1);
    // Sam's vault, asked with Dana's identity, refuses; so does a stale generation of Sam's own.
    expect(await asking(sam, whoOf(dana))).toMatch(/^forbidden: /);
    expect(await asking(sam, { ...whoOf(sam), gen: whoOf(sam).gen + 1 })).toMatch(/^unauthenticated: /);
    expect(await asking(sam, whoOf(sam))).toBe("given");
  });

  it("is closed while the vault is fenced, and gone once it is deleted", async () => {
    const sam = await signIn();
    await unreadable(sam);
    const fenced = await runInDurableObject(vaultOf(sam), (instance) => {
      const local = (instance as unknown as { env: Env }).env;
      const before = local.RESTORE_FENCE_IDS;
      local.RESTORE_FENCE_IDS = sessionOf(sam).vid;
      return before;
    });
    try {
      const response = await sam.fetch("/api/v2/today");
      const text = await response.text();
      expect(response.status).toBe(503);
      expect(text).not.toContain("unreadable-cv.docx");
    } finally {
      await runInDurableObject(vaultOf(sam), (instance) => {
        (instance as unknown as { env: Env }).env.RESTORE_FENCE_IDS = fenced;
      });
    }
    expect((await today(sam)).today.counts.facts).toBe(1);
    expect((await sam.send("DELETE", "/auth/account")).status).toBe(202);
    const gone = await sam.fetch("/api/v2/today");
    expect(gone.status).toBe(410);
    expect(await gone.text()).not.toContain("unreadable-cv.docx");
  });

  it("counts what To check counts, a role and fact found in two files once", async () => {
    const sam = await signIn();
    const first = await upload(sam, "first.pdf", `${RESUME}\nVersion 1`);
    const second = await upload(sam, "second.pdf", `${RESUME}\nVersion 2`);
    const view = await reviewView(sam);
    const proposed = countByState(view).proposed;
    const raw = view.roles.filter((role) => role.state === "proposed").length + view.facts.filter((fact) => fact.state === "proposed").length;
    // The two files say the same things, so To check asks about each once.
    expect(proposed).toBeGreaterThan(0);
    expect(raw).toBe(2 * proposed);
    const { today: answer } = await today(sam);
    expect(toCheck(answer)).toBe(proposed);
    expect(answer.counts.facts).toBe(proposed);
    // Each question is counted under the file it is shown under, by its name.
    const names = new Map([[first, "first.pdf"], [second, "second.pdf"]]);
    for (const item of of(answer, "check")) expect(item.filename).toBe(names.get(item.sourceId!));
    expect(of(answer, "check").map((item) => item.sourceId)).toContain(first);
  });

  it("names a file that couldn't be read, counts it under Facts, and carries no error text", async () => {
    const sam = await signIn();
    const id = await unreadable(sam);
    const { today: answer, text } = await today(sam);
    expect(of(answer, "unreadable")).toEqual([{ kind: "unreadable", sourceId: id, filename: "unreadable-cv.docx", createdAt: expect.any(Number) }]);
    expect(answer.counts).toEqual({ today: 1, facts: 1, jobs: 0, sharing: 0 });
    expect(text).not.toContain(ERROR_CANARY);
    expect(text).not.toContain("Upstream");
    expect(text).not.toContain('"error"');
  });

  it("counts a coach's unseen comments and waiting suggestions per copy apart, by name and address", async () => {
    const { sam, danaAddress, leeAddress, resumeCopy, factCopy, lines } = await coached();
    const { today: answer, text } = await today(sam);
    expect(of(answer, "comments")).toEqual([
      { kind: "comments", grantId: factCopy.grant.id, coachName: "Lee Chen", coachEmail: leeAddress, count: 1, latest: expect.any(Number) },
      { kind: "comments", grantId: resumeCopy.grant.id, coachName: "Dana Okafor", coachEmail: danaAddress, count: 1, latest: expect.any(Number) },
    ]);
    expect(of(answer, "suggestions")).toEqual([
      { kind: "suggestions", grantId: resumeCopy.grant.id, coachName: "Dana Okafor", coachEmail: danaAddress, count: 1, latest: expect.any(Number) },
    ]);
    expect(answer.counts.sharing).toBe(3);
    // Neither comment, nor the wording, nor the lines they are about.
    for (const words of [COMMENT, SUGGESTION, "Quillfeather", lines[0].text, lines[1].text]) expect(text, words).not.toContain(words);
  });

  it("drops a comment once seen and a suggestion once declined", async () => {
    const { sam, comment, suggestion, leeComment, resumeCopy } = await coached();
    expect((await today(sam)).today.counts.sharing).toBe(3);
    // Seen: the page that showed them names them.
    expect((await sam.send("POST", "/api/v2/shares/comments/seen", { ids: [comment.id, leeComment.id, suggestion.id] })).status).toBe(204);
    let answer = (await today(sam)).today;
    expect(of(answer, "comments")).toEqual([]);
    // A suggestion seen still waits for its answer.
    expect(of(answer, "suggestions")).toMatchObject([{ grantId: resumeCopy.grant.id, count: 1 }]);
    expect(answer.counts.sharing).toBe(1);
    expect((await sam.send("POST", `/api/shares/suggestions/${suggestion.id}/decline`)).status).toBe(204);
    answer = (await today(sam)).today;
    expect(of(answer, "suggestions")).toEqual([]);
    expect(answer.counts.sharing).toBe(0);
    // What was said is still recent.
    expect(answer.recent.filter((event) => event.kind === "coachCommented")).toHaveLength(2);
  });

  it("holds no fact's words, a marked fact's least of all", async () => {
    const sam = await signIn();
    await upload(sam, "synthetic.pdf", RESUME);
    const { facts, roles } = await reviewView(sam);
    expect(facts.length).toBeGreaterThan(2);
    // One proposed fact and one the owner added are marked sensitive.
    const added = await sam.send("POST", "/api/facts", { roleId: null, kind: "accomplishment", text: "Negotiated the Vellichor settlement quietly", level: null });
    const { factId } = (await added.json()) as { factId: string };
    expect((await sam.send("POST", "/api/facts/sensitive", { ids: [facts[0]!.id, factId], sensitive: true })).status).toBe(204);
    const { today: answer, text } = await today(sam);
    expect(toCheck(answer)).toBeGreaterThan(0);
    const words = [...facts.flatMap((fact) => [fact.text, fact.quote ?? ""]), ...roles.flatMap((role) => [role.quote ?? "", role.org]), "Vellichor"].filter(
      (value) => value.length >= 8,
    );
    expect(words.length).toBeGreaterThan(4);
    for (const value of words) expect(text, value).not.toContain(value);
  });

  it("counts a kit's unanswered and sensitive questions as the kit reports them, and no question's or answer's words", async () => {
    const sam = await signIn();
    const applicationId = await job(sam);
    const saved = await sam.send("POST", "/api/saved-answers", { label: "Notice period", answer: "Four weeks from the Zorblat offer." });
    const { id: savedId } = (await saved.json()) as { id: string };
    let response = await sam.send("PUT", `/api/applications/${applicationId}/kit/questions`, {
      questions: [{ text: "Why does the Zorblat team appeal to you?" }, { text: "What is your notice period?" }, { text: "Do you require visa sponsorship?" }],
      expectedRevision: 0,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    let kit = (await response.json()) as KitView;
    response = await sam.send("POST", `/api/applications/${applicationId}/kit/questions/${kit.questions[1]!.id}`, { change: { kind: "use", savedAnswerId: savedId }, expectedRevision: kit.revision });
    expect(response.status, await response.clone().text()).toBe(200);
    // The saved answer now says what the list refuses, so the kit can't use it.
    await sql(sam, (db) => db.exec(`UPDATE saved_answers SET answer_text = 'Four weeks, then my salary review at Zorblat.'`));
    kit = await sam.json<KitView>(`/api/applications/${applicationId}/kit`);
    const counted = (code: "unanswered" | "refused_kind") => {
      const problem = kit.problems.find((item) => item.code === code);
      return problem?.questionIds?.length ?? 0;
    };
    expect(counted("unanswered")).toBe(2);
    expect(counted("refused_kind")).toBe(1);

    const { today: answer, text } = await today(sam);
    const listed = (await sam.json<{ applications: { id: string; title: string | null; company: string | null }[] }>("/api/applications")).applications[0]!;
    expect(of(answer, "kit")).toEqual([
      { kind: "kit", applicationId, title: listed.title, company: listed.company, unanswered: counted("unanswered"), sensitive: counted("refused_kind") },
    ]);
    expect(answer.counts.jobs).toBe(3);
    // A closed job's kit still waits, as its page says.
    expect((await sam.send("PATCH", `/api/applications/${applicationId}`, { status: "closed" })).status).toBe(204);
    expect((await today(sam)).today.counts.jobs).toBe(3);
    for (const words of ["Zorblat", "notice period", "Notice period", "visa", "Four weeks", "salary", savedId]) expect(text, words).not.toContain(words);
  });

  it("lists reading, tailoring and a document in progress with their file or job", async () => {
    const sam = await signIn();
    const applicationId = await job(sam);
    const now = Date.now();
    const vid = sessionOf(sam).vid;
    await sql(sam, (db) => {
      db.exec(`INSERT INTO sources (id, filename, r2_key, state, created_at) VALUES ('reading', 'linkedin-export.zip', ?, 'queued', ?)`, `vaults/${vid}/sources/reading`, now - 3);
      db.exec(`INSERT INTO sources (id, filename, r2_key, state, created_at) VALUES ('read', 'old-cv.pdf', ?, 'ready', ?)`, `vaults/${vid}/sources/read`, now);
      db.exec(`INSERT INTO applications (id, jd_text, title, company, created_at) VALUES ('named', 'A posting', 'Senior Data Engineer', 'Tailspin Toys', ?)`, now);
      db.exec(`INSERT INTO resumes (id, application_id, state, step, created_at) VALUES ('tailoring', 'named', 'running', 'select', ?)`, now - 2);
      db.exec(`INSERT INTO resumes (id, application_id, state, created_at) VALUES ('done', 'named', 'ready', ?)`, now);
      db.exec(`INSERT INTO documents (id, application_id, kind, state, created_at) VALUES ('writing', ?, 'letter', 'running', ?)`, applicationId, now - 1);
      db.exec(`INSERT INTO documents (id, application_id, kind, state, created_at) VALUES ('written', ?, 'prep', 'ready', ?)`, applicationId, now);
    });
    const listed = (await sam.json<{ applications: { id: string; title: string | null; company: string | null }[] }>("/api/applications")).applications.find((item) => item.id === applicationId)!;
    const { today: answer } = await today(sam);
    expect(answer.working).toEqual([
      { kind: "document", documentId: "writing", documentKind: "letter", startedAt: now - 1, applicationId, title: listed.title, company: listed.company },
      { kind: "tailoring", resumeId: "tailoring", step: "select", startedAt: now - 2, applicationId: "named", title: "Senior Data Engineer", company: "Tailspin Toys" },
      { kind: "reading", sourceId: "reading", filename: "linkedin-export.zip", startedAt: now - 3 },
    ]);
    // Work in progress waits for nobody, so it is counted nowhere.
    expect(answer.counts.today).toBe(0);
  });

  it("keeps at most ten recent events from the last fourteen days, newest first", async () => {
    const sam = await signIn();
    const now = Date.now();
    await sql(sam, (db) => {
      db.exec(`INSERT INTO applications (id, jd_text, title, company, created_at) VALUES ('job', 'A posting', 'Site Reliability Engineer', 'Fabrikam', ?)`, now - 30 * DAY);
      db.exec(`INSERT INTO resumes (id, application_id, state, created_at) VALUES ('resume', 'job', 'ready', ?)`, now - 30 * DAY);
      for (let version = 1; version <= 12; version++)
        db.exec(`INSERT INTO resume_versions (resume_id, version, data, created_at) VALUES ('resume', ?, '{}', ?)`, version, now - (13 - version) * 60 * 60_000);
    });
    // A copy a coach opened, and a comment they wrote on it.
    const address = uniqueEmail("coach");
    const sharedFact = await sam.send("POST", "/api/facts", { roleId: null, kind: "skill", text: "Terraform", level: null });
    const { factId } = (await sharedFact.json()) as { factId: string };
    const copy = await share(sam, { factIds: [factId], coachEmail: address, label: "For Dana" });
    const dana = await coach(copy, address, "Dana Okafor");
    const read = await call(`/share/snapshot?g=${copy.grant.id}`, { cookie: jar(await open(copy), dana.cookie) });
    expect(read.status).toBe(200);
    await written(dana.cookie, `/api/coach/clients/${copy.grant.id}/comments`, { target: { kind: "fact", factId }, body: COMMENT });

    let { today: answer } = await today(sam);
    expect(answer.recent).toHaveLength(MAX_TODAY_RECENT);
    const times = answer.recent.map((event) => event.at);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(answer.recent.slice(0, 2).map((event) => event.kind).sort()).toEqual(["coachCommented", "copyOpened"]);
    expect(answer.recent.find((event) => event.kind === "copyOpened")).toEqual({
      kind: "copyOpened", grantId: copy.grant.id, label: "For Dana", coachName: "Dana Okafor", coachEmail: address, at: expect.any(Number),
    });
    expect(answer.recent.filter((event) => event.kind === "resumeReady").map((event) => event.kind === "resumeReady" && event.version)).toEqual([12, 11, 10, 9, 8, 7, 6, 5]);
    expect(answer.since).toBeGreaterThanOrEqual(now - TODAY_RECENT_MS);

    // Aged past the window, the copy, the comment and all but two versions drop out.
    await sql(sam, (db) => {
      db.exec(`UPDATE share_grants SET last_read_at = ?`, now - 15 * DAY);
      db.exec(`UPDATE share_comments SET created_at = ?`, now - 15 * DAY);
      db.exec(`UPDATE resume_versions SET created_at = ? WHERE version <= 10`, now - 15 * DAY);
    });
    answer = (await today(sam)).today;
    expect(answer.recent.map((event) => event.kind === "resumeReady" && event.version)).toEqual([12, 11]);
  });

  it("doesn't call a resume from before saved versions ready just because it was opened", async () => {
    const sam = await signIn();
    await upload(sam, "synthetic.pdf", RESUME);
    const { roles, facts } = await reviewView(sam);
    expect((await sam.send("POST", "/api/review", { confirm: [...facts, ...roles].map((item) => item.id), reject: [] })).status).toBe(204);
    const applicationId = await job(sam);
    const started = await sam.send("POST", `/api/applications/${applicationId}/resumes`);
    expect(started.status, await started.clone().text()).toBe(202);
    const { resumeId } = (await started.json()) as { resumeId: string };
    const resume = (await waitForResume(sam, resumeId)) as ResumeView;
    expect(resume.state, resume.error ?? "").toBe("ready");
    // As a resume tailored before versions were saved: its body is on the row and no version is kept.
    const tailored = Date.now() - 60 * DAY;
    await sql(sam, (db) => {
      db.exec(`DELETE FROM resume_versions WHERE resume_id = ?`, resumeId);
      db.exec(`UPDATE resumes SET created_at = ? WHERE id = ?`, tailored, resumeId);
    });
    expect((await today(sam)).today.recent.filter((event) => event.kind === "resumeReady")).toEqual([]);

    // Opening it saves the version it already had, dated when it was made, not when it was read.
    expect((await sam.fetch(`/api/resumes/${resumeId}`)).status).toBe(200);
    expect((await today(sam)).today.recent.filter((event) => event.kind === "resumeReady")).toEqual([]);
    const { versions } = await sam.json<{ versions: { version: number; createdAt: number }[] }>(`/api/resumes/${resumeId}/versions`);
    expect(versions).toEqual([{ version: resume.version, createdAt: tailored }]);
  });

  it("makes each room's count the sum of what waits there, and Today the sum of the rooms", async () => {
    const { sam, comment } = await coached();
    await upload(sam, "another.pdf", `${RESUME}\nAnother`);
    await unreadable(sam);
    const applicationId = await job(sam);
    const response = await sam.send("PUT", `/api/applications/${applicationId}/kit/questions`, { questions: [{ text: "Why us?" }], expectedRevision: 0 });
    expect(response.status).toBe(200);
    expect((await sam.send("POST", "/api/v2/shares/comments/seen", { ids: [comment.id] })).status).toBe(204);

    const { today: answer } = await today(sam);
    const sum = <T extends TodayWaiting>(items: T[], count: (item: T) => number) => items.reduce((total, item) => total + count(item), 0);
    const facts = toCheck(answer) + of(answer, "unreadable").length;
    const jobs = sum(of(answer, "kit"), (item) => item.unanswered + item.sensitive);
    const sharing = sum(of(answer, "comments"), (item) => item.count) + sum(of(answer, "suggestions"), (item) => item.count);
    expect([facts > 1, jobs, sharing]).toEqual([true, 1, 2]);
    expect(answer.counts).toEqual({ facts, jobs, sharing, today: facts + jobs + sharing });
    // To check here is To check on the Facts page.
    expect(toCheck(answer)).toBe(countByState(await reviewView(sam)).proposed);
  });

  it("falls by one when the owner confirms a fact", async () => {
    const sam = await signIn();
    await upload(sam, "synthetic.pdf", RESUME);
    let view = await reviewView(sam);
    // With every role confirmed, confirming a fact confirms nothing else.
    expect((await sam.send("POST", "/api/review", { confirm: view.roles.map((role) => role.id), reject: [] })).status).toBe(204);
    view = await reviewView(sam);
    const before = (await today(sam)).today.counts;
    expect(before.facts).toBe(countByState(view).proposed);
    const fact = view.facts.find((item) => item.state === "proposed")!;
    expect((await sam.send("POST", "/api/review", { confirm: [fact.id], reject: [] })).status).toBe(204);
    const after = (await today(sam)).today.counts;
    expect(after).toEqual({ ...before, facts: before.facts - 1, today: before.today - 1 });
  });
});

describe("where things stand", () => {
  it("stands at zero everywhere in a new vault", async () => {
    const sam = await signIn();
    expect((await today(sam)).today.standing).toEqual(emptyStanding());
  });

  it("counts files in any state, and roles and facts confirmed and left out as countByState does", async () => {
    const sam = await signIn();
    await upload(sam, "synthetic.pdf", RESUME);
    await unreadable(sam);
    const vid = sessionOf(sam).vid;
    await sql(sam, (db) =>
      db.exec(`INSERT INTO sources (id, filename, r2_key, state, created_at) VALUES ('reading', 'linkedin-export.zip', ?, 'queued', ?)`, `vaults/${vid}/sources/reading`, Date.now()),
    );
    let view = await reviewView(sam);
    expect(view.facts.length).toBeGreaterThan(2);
    // Every role confirmed, one fact confirmed and one left out; the rest still to check.
    const [kept, left] = view.facts;
    expect((await sam.send("POST", "/api/review", { confirm: [...view.roles.map((role) => role.id), kept!.id], reject: [left!.id] })).status).toBe(204);
    // And one the owner adds, which starts confirmed.
    expect((await sam.send("POST", "/api/facts", { roleId: null, kind: "skill", text: "Terraform", level: null })).status).toBe(201);
    view = await reviewView(sam);
    const states = countByState(view);
    expect(states.rejected).toBeGreaterThan(0);
    const { today: answer } = await today(sam);
    expect(answer.standing).toMatchObject({ files: 3, confirmed: states.confirmed, leftOut: states.rejected });
    // To check is what waits, as the header counts it.
    expect(toCheck(answer)).toBe(states.proposed);
  });

  it("counts jobs by status", async () => {
    const sam = await signIn();
    const [first, second, third, fourth] = [await job(sam), await job(sam), await job(sam), await job(sam)];
    expect((await today(sam)).today.standing?.jobs).toEqual({ saved: 4, applied: 0, interview: 0, offer: 0, closed: 0 });
    for (const [id, status] of [[first, "applied"], [second, "applied"], [third, "interview"], [fourth, "closed"]] as const)
      expect((await sam.send("PATCH", `/api/applications/${id}`, { status })).status).toBe(204);
    expect((await today(sam)).today.standing?.jobs).toEqual({ saved: 0, applied: 2, interview: 1, offer: 0, closed: 1 });
  });

  it("counts shared copies and those naming a coach, and drops a revoked one", async () => {
    const sam = await signIn();
    const added = await sam.send("POST", "/api/facts", { roleId: null, kind: "skill", text: "Terraform", level: null });
    const { factId } = (await added.json()) as { factId: string };
    const plain = await share(sam, { factIds: [factId] });
    const named = await share(sam, { factIds: [factId], coachEmail: uniqueEmail("coach") });
    await share(sam, { factIds: [factId], coachEmail: uniqueEmail("coach") });
    const expiring = await share(sam, { factIds: [factId], coachEmail: uniqueEmail("coach") });
    expect((await today(sam)).today.standing).toMatchObject({ copies: 4, coachCopies: 3 });
    expect((await sam.send("DELETE", `/api/shares/${named.grant.id}`)).status).toBe(204);
    expect((await today(sam)).today.standing).toMatchObject({ copies: 3, coachCopies: 2 });
    // One that has expired, before the alarm erases it, and one revoked plain copy.
    await sql(sam, (db) => db.exec(`UPDATE share_grants SET expires_at = ? WHERE id = ?`, Date.now() - 1, expiring.grant.id));
    expect((await sam.send("DELETE", `/api/shares/${plain.grant.id}`)).status).toBe(204);
    expect((await today(sam)).today.standing).toMatchObject({ copies: 1, coachCopies: 1 });
  });

  it("counts connected apps whose access is active", async () => {
    const sam = await signIn();
    const now = Date.now();
    const { gen, epoch = "legacy" } = whoOf(sam);
    // Grants are made in the session's own epoch and generation, as McpGrantStore.create makes them.
    const grant = (id: string, state: string, expiresAt: number, revokedAt: number | null, at = { epoch, gen }) =>
      sql(sam, (db) =>
        db.exec(
          `INSERT INTO mcp_grants (id, client_id, client_name, scopes, epoch, gen, created_at, expires_at, revoked_at, oauth_grant_id, state) VALUES (?, 'https://client.test/app', 'A client', '["vault:read"]', ?, ?, ?, ?, ?, ?, ?)`,
          id, at.epoch, at.gen, now, expiresAt, revokedAt, state === "pending" ? null : `remote_${id}`, state,
        ),
      );
    await grant(crypto.randomUUID(), "active", now + DAY, null);
    await grant(crypto.randomUUID(), "active", now + DAY, null);
    await grant(crypto.randomUUID(), "pending", now + DAY, null);
    await grant(crypto.randomUUID(), "revoked", now + DAY, now - 1);
    await grant(crypto.randomUUID(), "active", now + DAY, now - 1);
    await grant(crypto.randomUUID(), "active", now - 1, null);
    // Access the vault would refuse: a grant from a generation already signed out, or from another epoch.
    await grant(crypto.randomUUID(), "active", now + DAY, null, { epoch, gen: gen - 1 });
    await grant(crypto.randomUUID(), "active", now + DAY, null, { epoch: "an-earlier-epoch", gen });
    expect((await today(sam)).today.standing?.apps).toBe(2);
  });

  it("counts no connected app once the owner signs out everywhere", async () => {
    const sam = await signIn();
    const now = Date.now();
    const { gen, epoch = "legacy" } = whoOf(sam);
    await sql(sam, (db) =>
      db.exec(
        `INSERT INTO mcp_grants (id, client_id, client_name, scopes, epoch, gen, created_at, expires_at, revoked_at, oauth_grant_id, state) VALUES (?, 'https://client.test/app', 'A client', '["vault:read"]', ?, ?, ?, ?, NULL, 'remote_app', 'active')`,
        crypto.randomUUID(), epoch, gen, now, now + DAY,
      ),
    );
    expect((await today(sam)).today.standing?.apps).toBe(1);
    expect((await sam.send("POST", "/api/account/sign-out-everywhere", {})).status).toBe(204);
    // The grant's row is unchanged, but its generation can no longer reach the vault, so none is counted.
    const apps = await runInDurableObject(vaultOf(sam), async (instance) => (await instance.today({ ...whoOf(sam), gen: gen + 1 })).standing?.apps);
    expect(apps).toBe(0);
  });

  it("holds only numbers in standing", async () => {
    const sam = await signIn();
    await upload(sam, "synthetic.pdf", RESUME);
    await unreadable(sam);
    const applicationId = await job(sam);
    expect((await sam.send("PATCH", `/api/applications/${applicationId}`, { status: "applied" })).status).toBe(204);
    const added = await sam.send("POST", "/api/facts", { roleId: null, kind: "skill", text: "Vellichor tooling", level: null });
    const { factId } = (await added.json()) as { factId: string };
    const copy = await share(sam, { factIds: [factId], coachEmail: uniqueEmail("coach"), label: "For Dana at Quillfeather" });
    const { today: answer } = await today(sam);
    const standing = answer.standing!;
    expect(Object.keys(standing).sort()).toEqual(["apps", "coachCopies", "confirmed", "copies", "files", "jobs", "leftOut"]);
    expect(Object.keys(standing.jobs)).toEqual(["saved", "applied", "interview", "offer", "closed"]);
    const leaves = [...Object.entries(standing).filter(([key]) => key !== "jobs").map(([, value]) => value), ...Object.values(standing.jobs)];
    for (const value of leaves) expect(Number.isSafeInteger(value) && (value as number) >= 0, String(value)).toBe(true);
    const text = JSON.stringify(standing);
    for (const words of ["synthetic.pdf", "unreadable-cv.docx", "Vellichor", "Quillfeather", copy.grant.id, applicationId, factId]) expect(text, words).not.toContain(words);
  });
});
