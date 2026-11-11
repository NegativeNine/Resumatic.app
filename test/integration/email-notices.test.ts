import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModels } from "../../src/ai/models";
import { Directory } from "../../src/directory/directory";
import type { FactView, Me, ResumeLine, ResumeView, RoleView } from "../../src/shared/api";
import { EMAIL_OFF, NOTICE_KINDS, noticeMessage, type EmailNotices, type NoticeKind } from "../../src/shared/email-notices";
import type { ShareComment, ShareGrant, ShareTarget } from "../../src/shared/sharing";
import { directory, directoryForUser, vault } from "../../src/shared/stubs";
import { NOTICE_DELAY_MS, NOTICE_INTERVAL_MS, RETRY_DELAYS_MS, REVIEW_WAIT_MS, noticeAddressCheck } from "../../src/vault/email-notices";
import { MIGRATIONS, migrate, SCHEMA_VERSION } from "../../src/vault/schema";
import { base64url, fromBase64url } from "../../src/worker/crypto";
import { createSession } from "../../src/worker/session";
import { ORIGIN, SENDER, installEmail, providerError, restoreEmail, type RecordingEmail, type Sent } from "../support/email";
import { removeNotificationMigration } from "../support/undo-vault-incarnation";
import { outwardParts } from "./outward";
import { JOB_DESCRIPTION, RESUME, call, cookieFrom, eventually, fakeModels, signIn, uniqueEmail, waitForResume, waitForSource, User } from "./support";

// Email notices over HTTP and through the Vault's alarm: who may turn them on, when one is sent,
// where it goes, and what it can never hold. The binding is a recorder installed as env.EMAIL, so
// the Vault's own sender runs over it. Time is moved by setting the vault's stored times back.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOTICES = "/api/email-notices";

const restore: (() => Promise<unknown>)[] = [];
beforeEach(() => setModels(() => fakeModels()));
afterEach(async () => {
  setModels(null);
  restoreEmail();
  for (const undo of restore.splice(0).reverse()) await undo();
});

function sessionOf(user: User) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  return JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { uid: string; vid: string; gen: number; epoch?: string; email?: string };
}
const vaultOf = (user: User) => vault(env, sessionOf(user).vid);
const whoOf = (user: User) => {
  const session = sessionOf(user);
  return { userId: session.uid, gen: session.gen, epoch: session.epoch };
};
type VaultStub = ReturnType<typeof vault>;

/** Changes one setting as one object reads it, until the test ends. */
async function setting<K extends keyof Env>(target: VaultStub | ReturnType<typeof directory>, key: K, value: Env[K]): Promise<void> {
  const prior = await runInDurableObject(target, (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    const before = local[key];
    local[key] = value;
    return before;
  });
  restore.push(() =>
    runInDurableObject(target, (instance) => {
      (instance as unknown as { env: Env }).env[key] = prior;
    }),
  );
}

// ---------------------------------------------------------------- an owner, a copy and its coach

const FACT = "Cut deploy time from forty minutes to six";

/** Someone with a name and one confirmed fact to share. */
async function owner(email?: string) {
  const user = await signIn(email);
  expect((await user.send("PUT", "/api/profile", { name: "Sam Rivera" })).status).toBe(200);
  const role = await user.send("POST", "/api/roles", { kind: "job", org: "Acme", title: "Engineer", startDate: "2021", endDate: null });
  const { roleId } = (await role.json()) as { roleId: string };
  const fact = await user.send("POST", "/api/facts", { roleId, kind: "accomplishment", text: FACT, level: "implemented" });
  const { factId } = (await fact.json()) as { factId: string };
  return { user, factId };
}

async function share(user: User, body: Record<string, unknown>) {
  const response = await user.send("POST", "/api/shares", { resumes: [], factIds: [], showName: true, ...body });
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
const takeUp = (grantId: string, cookie: string) =>
  call("/api/coach/clients", { method: "POST", cookie, headers: { "content-type": "application/json" }, body: JSON.stringify({ grantId }) });

/** An owner, a copy of one fact that names a coach, and that coach with the copy in their list. */
async function coached() {
  const { user: sam, factId } = await owner();
  const address = uniqueEmail("coach");
  const shared = await share(sam, { factIds: [factId], coachEmail: address });
  const link = await open(shared);
  const dana = await signIn(address);
  expect((await dana.send("PUT", "/api/profile", { name: "Dana Okafor" })).status).toBe(200);
  expect((await takeUp(shared.grant.id, jar(link, dana.cookie))).status).toBe(204);
  const target: ShareTarget = { kind: "fact", factId };
  return { sam, dana, factId, shared, address, target, grantId: shared.grant.id };
}

const post = (cookie: string, path: string, body: unknown, key: string = crypto.randomUUID()) =>
  call(path, { method: "POST", cookie, headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
const commentsOf = (grantId: string) => `/api/coach/clients/${grantId}/comments`;
/** A coach's comment, which has to be taken. */
async function comment(user: User, grantId: string, target: ShareTarget, body: string, key?: string): Promise<ShareComment> {
  const response = await post(user.cookie, commentsOf(grantId), { target, body }, key);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as ShareComment;
}
async function suggested(user: User, grantId: string, target: ShareTarget, text: string): Promise<ShareComment> {
  const response = await post(user.cookie, `/api/coach/clients/${grantId}/suggestions`, { target, text });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as ShareComment;
}

const linesOf = (resume: ResumeView): ResumeLine[] => [...(resume.body!.summary ? [resume.body!.summary] : []), ...resume.body!.sections.flatMap((section) => section.lines)];

/** Sam, with facts read from an upload and confirmed, a tailored resume, and a copy of it that names Dana, who has taken it up. */
async function coachedResume() {
  const sam = await signIn();
  const upload = await sam.upload("synthetic.pdf", RESUME);
  const { sourceId } = (await upload.json()) as { sourceId: string };
  expect((await waitForSource(sam, sourceId)).state).toBe("ready");
  const { facts } = await sam.json<{ facts: FactView[] }>("/api/facts");
  const { roles } = await sam.json<{ roles: RoleView[] }>("/api/roles");
  expect((await sam.send("POST", "/api/review", { confirm: [...facts, ...roles].map((item) => item.id), reject: [] })).status).toBe(204);
  const { applicationId } = (await (await sam.send("POST", "/api/applications", { jdText: JOB_DESCRIPTION })).json()) as { applicationId: string };
  const started = await sam.send("POST", `/api/applications/${applicationId}/resumes`);
  expect(started.status, await started.clone().text()).toBe(202);
  const { resumeId } = (await started.json()) as { resumeId: string };
  const resume = (await waitForResume(sam, resumeId)) as ResumeView;
  expect(resume.state, resume.error ?? "").toBe("ready");
  const line = resume.body!.sections.flatMap((section) => section.lines)[0]!;
  const address = uniqueEmail("coach");
  const shared = await share(sam, { factIds: facts.slice(0, 2).map((fact) => fact.id), resumes: [{ id: resume.id, version: resume.version }], coachEmail: address });
  const link = await open(shared);
  const dana = await signIn(address);
  expect((await takeUp(shared.grant.id, jar(link, dana.cookie))).status).toBe(204);
  const target: ShareTarget = { kind: "line", resumeId: resume.id, version: resume.version, lineId: line.id };
  return { sam, dana, facts, resume, line, target, shared, address, grantId: shared.grant.id, all: linesOf(resume) };
}

// ---------------------------------------------------------------- notices, time and the alarm

const read = (user: User) => user.json<EmailNotices>(NOTICES);
const turn = (user: User, kind: string, on: unknown) => user.send("PUT", `${NOTICES}/${kind}`, { on });
async function turnOn(user: User, ...kinds: NoticeKind[]) {
  for (const kind of kinds) {
    const response = await turn(user, kind, true);
    expect(response.status, await response.clone().text()).toBe(200);
  }
}
const capability = async (user: User) => (await user.json<Me>("/api/me")).capabilities?.emailNotices;

/** The vault's notice rows as stored. */
const rows = (stub: VaultStub) =>
  runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec<Record<string, string | number | null>>(`SELECT * FROM email_notices ORDER BY kind`).toArray(),
  );
const rowOf = async (stub: VaultStub, kind: NoticeKind) => (await rows(stub)).find((row) => row.kind === kind);

/** As if `ms` had passed for this vault: every stored time its notices are decided by is set back by that much. */
const pass = (stub: VaultStub, ms: number) =>
  runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`UPDATE email_notices SET on_at = on_at - ?, pending_at = pending_at - ?, last_at = last_at - ?, retry_at = retry_at - ?`, ms, ms, ms, ms);
    sql.exec(`UPDATE share_comments SET created_at = created_at - ?, seen_at = seen_at - ?`, ms, ms);
    sql.exec(`UPDATE facts SET updated_at = updated_at - ?`, ms);
  });

/** Runs the vault's alarm now, arming one first if none is set. */
async function fire(stub: VaultStub): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    if ((await state.storage.getAlarm()) === null) await state.storage.setAlarm(Date.now() + HOUR);
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}

/** A notice exactly as the binding should be given it. */
const notice = (kind: NoticeKind, to: string): Sent => ({ from: { email: SENDER, name: "Resumatic" }, to, ...noticeMessage(kind, ORIGIN) });

/** Every data point the vault writes while the test runs. */
function recordMetrics(): unknown[] {
  const points: unknown[] = [];
  const target = env as unknown as Record<string, unknown>;
  const prior = target.METRICS;
  target.METRICS = { writeDataPoint: (point: unknown) => points.push(structuredClone(point)) };
  restore.push(async () => {
    target.METRICS = prior;
  });
  return points;
}

/** What a rejected call into a vault said, or "nothing" when it was let through. */
const refusal = (work: Promise<unknown>): Promise<string> => work.then(() => "nothing", (error: unknown) => String((error as Error).message ?? error));

/** The data points that are about email notices. */
const noticePoints = (points: unknown[]) => (points as { blobs: string[] }[]).filter((point) => point.blobs?.[1] === "email_notice");

// ---------------------------------------------------------------- off

describe("email notices that are off", () => {
  it("off by default: no capability, 503 on both routes, a comment queues nothing, the alarm sends nothing", async () => {
    expect((env as unknown as { EMAIL?: unknown }).EMAIL).toBeUndefined();
    expect(env.EMAIL_ENABLED).toBeUndefined();
    const { sam, dana, target, grantId } = await coached();
    expect(await capability(sam)).toBe(false);
    for (const response of [await sam.fetch(NOTICES), await turn(sam, "comment", true)]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "unavailable", message: EMAIL_OFF });
    }
    // The Vault refuses too: a route is not its only caller.
    expect(await refusal(vaultOf(sam).emailNotices(whoOf(sam)))).toBe(`unavailable: ${EMAIL_OFF}`);
    expect(await refusal(vaultOf(sam).setEmailNotice(whoOf(sam), "comment", true, sam.email))).toBe(`unavailable: ${EMAIL_OFF}`);
    await comment(dana, grantId, target, "Nobody is emailed about this");
    expect(await rows(vaultOf(sam))).toEqual([]);
    await pass(vaultOf(sam), DAY);
    await fire(vaultOf(sam));
    expect(await rows(vaultOf(sam))).toEqual([]);
  });

  const broken: [string, Parameters<typeof installEmail>[1]][] = [
    ["without the switch", { EMAIL_ENABLED: undefined }],
    ["with the switch anything but true", { EMAIL_ENABLED: "TRUE" }],
    ["without the binding", { EMAIL: undefined }],
    ["with a missing EMAIL_FROM", { EMAIL_FROM: undefined }],
    ["with a malformed EMAIL_FROM", { EMAIL_FROM: "Resumatic <notices@notices.example.test>" }],
    ["without an https APP_ORIGIN", { APP_ORIGIN: "http://app.example.test" }],
  ];
  for (const [name, overrides] of broken)
    it(`nothing is sent or queued ${name}`, async () => {
      const { sam, dana, target, grantId } = await coached();
      // Turned on while the deployment sent notices.
      const first = installEmail(env);
      await turnOn(sam, "comment");
      restoreEmail();
      const recorder = installEmail(env, overrides);
      expect(await capability(sam)).toBe(false);
      expect((await sam.fetch(NOTICES)).status).toBe(503);
      expect((await turn(sam, "comment", false)).status).toBe(503);
      await comment(dana, grantId, target, "Not announced");
      expect(await rowOf(vaultOf(sam), "comment")).toMatchObject({ pending_at: null, attempts: 0 });
      await pass(vaultOf(sam), DAY);
      await fire(vaultOf(sam));
      expect(first.calls).toEqual([]);
      expect(recorder.calls).toEqual([]);
      expect(await rowOf(vaultOf(sam), "comment")).toMatchObject({ pending_at: null, attempts: 0, outcome: null });
    });

  it("turning the switch off drops what was queued, and turning it on again sends nothing for it", async () => {
    const { sam, dana, target, grantId } = await coached();
    const recorder = installEmail(env);
    await turnOn(sam, "comment");
    await comment(dana, grantId, target, "Queued, then dropped");
    expect((await rowOf(vaultOf(sam), "comment"))!.pending_at).toEqual(expect.any(Number));
    (env as unknown as Record<string, unknown>).EMAIL_ENABLED = "false";
    await pass(vaultOf(sam), HOUR);
    await fire(vaultOf(sam));
    expect(await rowOf(vaultOf(sam), "comment")).toMatchObject({ pending_at: null, attempts: 0, retry_at: null });
    (env as unknown as Record<string, unknown>).EMAIL_ENABLED = "true";
    await pass(vaultOf(sam), DAY);
    await fire(vaultOf(sam));
    expect(recorder.calls).toEqual([]);
    // Still on, and the next comment is announced as any other.
    expect(await read(sam)).toMatchObject({ comment: true, status: "ok" });
    await comment(dana, grantId, target, "After the switch came back");
    await pass(vaultOf(sam), NOTICE_DELAY_MS);
    await fire(vaultOf(sam));
    expect(recorder.sent).toEqual([notice("comment", sam.email)]);
  });

  it("a kind that isn't turned on sends nothing", async () => {
    const { sam, dana, target, grantId } = await coached();
    const recorder = installEmail(env);
    await turnOn(sam, "suggestion", "reminder");
    await comment(dana, grantId, target, "A comment, which nobody asked to hear about");
    expect(await rowOf(vaultOf(sam), "comment")).toBeUndefined();
    expect(await rowOf(vaultOf(sam), "suggestion")).toMatchObject({ pending_at: null });
    await pass(vaultOf(sam), DAY);
    await fire(vaultOf(sam));
    expect(recorder.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------- each kind

describe("each kind of notice", () => {
  it("a coach's comment sends one comment notice to the owner's sign-in address, with the exact subject and text", async () => {
    const { sam, dana, target, grantId } = await coached();
    const recorder = installEmail(env);
    expect(await capability(sam)).toBe(true);
    expect(await read(sam)).toEqual({ comment: false, suggestion: false, reminder: false, status: "ok", address: sam.email });
    await turnOn(sam, "comment");
    expect(await read(sam)).toEqual({ comment: true, suggestion: false, reminder: false, status: "ok", address: sam.email });
    const before = Date.now();
    await comment(dana, grantId, target, "Say what the forty minutes cost");
    const queued = (await rowOf(vaultOf(sam), "comment"))!;
    expect(queued.pending_at).toBeGreaterThanOrEqual(before);
    // The comment's own write brought the alarm forward to when the notice is due.
    const alarm = await runInDurableObject(vaultOf(sam), (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBeLessThanOrEqual((queued.pending_at as number) + NOTICE_DELAY_MS);
    // Not before 15 minutes.
    await pass(vaultOf(sam), NOTICE_DELAY_MS - MINUTE);
    await fire(vaultOf(sam));
    expect(recorder.calls).toEqual([]);
    await pass(vaultOf(sam), MINUTE);
    await fire(vaultOf(sam));
    expect(recorder.sent).toEqual([notice("comment", sam.email)]);
    expect(await rowOf(vaultOf(sam), "comment")).toMatchObject({ pending_at: null, attempts: 0, retry_at: null, outcome: "sent", last_at: expect.any(Number) });
    // Sent once: the next alarm finds nothing to say.
    await fire(vaultOf(sam));
    expect(recorder.calls).toHaveLength(1);
  });

  it("a coach's suggestion sends one suggestion notice to the owner's sign-in address, with the exact subject and text", async () => {
    const { sam, dana, target, grantId, line } = await coachedResume();
    const recorder = installEmail(env);
    await turnOn(sam, "suggestion");
    await suggested(dana, grantId, target, `${line.text} again`);
    expect((await rowOf(vaultOf(sam), "suggestion"))!.pending_at).toEqual(expect.any(Number));
    await pass(vaultOf(sam), NOTICE_DELAY_MS);
    await fire(vaultOf(sam));
    expect(recorder.sent).toEqual([notice("suggestion", sam.email)]);
  }, 60_000);

  it("facts waiting for review send one reminder notice to the owner's sign-in address, with the exact subject and text", async () => {
    const sam = await signIn();
    const upload = await sam.upload("synthetic.pdf", RESUME);
    const { sourceId } = (await upload.json()) as { sourceId: string };
    const source = await waitForSource(sam, sourceId);
    expect(source.state).toBe("ready");
    expect(source.proposed).toBeGreaterThan(0);
    const recorder = installEmail(env);
    await turnOn(sam, "reminder");
    // Turning reminders on with facts waiting sends nothing at once: the owner is looking at them.
    await fire(vaultOf(sam));
    expect(recorder.calls).toEqual([]);
    await pass(vaultOf(sam), REVIEW_WAIT_MS - HOUR);
    await fire(vaultOf(sam));
    expect(recorder.calls).toEqual([]);
    await pass(vaultOf(sam), HOUR);
    await fire(vaultOf(sam));
    expect(recorder.sent).toEqual([notice("reminder", sam.email)]);
    // Not again within the week.
    await pass(vaultOf(sam), 6 * DAY);
    await fire(vaultOf(sam));
    expect(recorder.sent).toHaveLength(1);
    await pass(vaultOf(sam), DAY);
    await fire(vaultOf(sam));
    expect(recorder.sent).toHaveLength(2);
    // Once every fact is reviewed, reminders stop.
    const { facts } = await sam.json<{ facts: FactView[] }>("/api/facts?state=proposed");
    const { roles } = await sam.json<{ roles: RoleView[] }>("/api/roles");
    expect((await sam.send("POST", "/api/review", { confirm: [...facts, ...roles].map((item) => item.id), reject: [] })).status).toBe(204);
    await pass(vaultOf(sam), 30 * DAY);
    await fire(vaultOf(sam));
    expect(recorder.sent).toHaveLength(2);
  }, 60_000);

  it("three comments in a minute send one", async () => {
    const { sam, dana, target, grantId } = await coached();
    const recorder = installEmail(env);
    await turnOn(sam, "comment");
    for (const words of ["First", "Second", "Third"]) {
      await comment(dana, grantId, target, words);
      await pass(vaultOf(sam), 20_000);
    }
    await pass(vaultOf(sam), NOTICE_DELAY_MS);
    await fire(vaultOf(sam));
    await fire(vaultOf(sam));
    expect(recorder.sent).toEqual([notice("comment", sam.email)]);
  });

  it("a second comment the same day waits a day", async () => {
    const { sam, dana, target, grantId } = await coached();
    const recorder = installEmail(env);
    await turnOn(sam, "comment");
    await comment(dana, grantId, target, "In the morning");
    await pass(vaultOf(sam), NOTICE_DELAY_MS);
    await fire(vaultOf(sam));
    expect(recorder.sent).toHaveLength(1);
    await pass(vaultOf(sam), 2 * HOUR);
    await comment(dana, grantId, target, "In the afternoon");
    await pass(vaultOf(sam), NOTICE_DELAY_MS);
    await fire(vaultOf(sam));
    expect(recorder.sent).toHaveLength(1);
    expect((await rowOf(vaultOf(sam), "comment"))!.pending_at).toEqual(expect.any(Number));
    await pass(vaultOf(sam), NOTICE_INTERVAL_MS - 2 * HOUR - NOTICE_DELAY_MS - MINUTE);
    await fire(vaultOf(sam));
    expect(recorder.sent).toHaveLength(1);
    await pass(vaultOf(sam), MINUTE);
    await fire(vaultOf(sam));
    expect(recorder.sent).toEqual([notice("comment", sam.email), notice("comment", sam.email)]);
  });

  it("a retried comment request marks nothing new", async () => {
    const { sam, dana, target, grantId } = await coached();
    const recorder = installEmail(env);
    await turnOn(sam, "comment");
    const key = crypto.randomUUID();
    const made = await comment(dana, grantId, target, "Sent once", key);
    await pass(vaultOf(sam), NOTICE_DELAY_MS);
    await fire(vaultOf(sam));
    expect(recorder.sent).toHaveLength(1);
    // The same request again gets the same comment (its time as this test has moved it), and queues nothing.
    expect(await comment(dana, grantId, target, "Sent once", key)).toEqual({ ...made, createdAt: made.createdAt - NOTICE_DELAY_MS });
    expect((await rowOf(vaultOf(sam), "comment"))!.pending_at).toBeNull();
    await pass(vaultOf(sam), 2 * DAY);
    await fire(vaultOf(sam));
    expect(recorder.sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- who gets it

describe("who a notice goes to", () => {
  it("a coach is never notified: their own vault with every kind on, the owner's replies, and no send ever addressed to the coach", async () => {
    const { sam, dana, target, grantId, address } = await coached();
    const recorder = installEmail(env);
    await turnOn(sam, "comment");
    await turnOn(dana, ...NOTICE_KINDS);
    const made = await comment(dana, grantId, target, "From the coach");
    const replied = await post(sam.cookie, `/api/shares/comments/${made.id}/replies`, { body: "From the owner" });
    expect(replied.status).toBe(201);
    // Nothing in the coach's own vault noticed either comment.
    expect((await rows(vaultOf(dana))).map((row) => row.pending_at)).toEqual([null, null, null]);
    for (const stub of [vaultOf(sam), vaultOf(dana)]) await pass(stub, 30 * DAY);
    for (const stub of [vaultOf(sam), vaultOf(dana)]) await fire(stub);
    expect(recorder.calls).toEqual([notice("comment", sam.email)]);
    expect(recorder.calls.map((sent) => sent.to)).not.toContain(address);
    // A second reply from the owner, a day on, still tells nobody.
    expect((await post(sam.cookie, `/api/shares/comments/${made.id}/replies`, { body: "Again" })).status).toBe(201);
    for (const stub of [vaultOf(sam), vaultOf(dana)]) await pass(stub, 2 * DAY);
    for (const stub of [vaultOf(sam), vaultOf(dana)]) await fire(stub);
    expect(recorder.calls).toHaveLength(1);
  });

  it("the profile's email is never used", async () => {
    const { sam, dana, target, grantId } = await coached();
    const recorder = installEmail(env);
    const other = uniqueEmail("profile");
    expect((await sam.send("PUT", "/api/profile", { email: other })).status).toBe(200);
    await turnOn(sam, "comment");
    await comment(dana, grantId, target, "Where does this go");
    await pass(vaultOf(sam), NOTICE_DELAY_MS);
    await fire(vaultOf(sam));
    expect(recorder.sent).toEqual([notice("comment", sam.email)]);
    expect(JSON.stringify(recorder.calls)).not.toContain(other);
  });
});

// ---------------------------------------------------------------- the address

describe("the address a notice goes to", () => {
  it("a session without an address can't turn a notice on (409)", async () => {
    const sam = await signIn();
    installEmail(env);
    const session = sessionOf(sam);
    const bare = `__Host-session=${await createSession(env.SESSION_KEY, { uid: session.uid, vid: session.vid, gen: session.gen, epoch: session.epoch })}`;
    const asked = await call(NOTICES, { cookie: bare });
    expect(asked.status).toBe(200);
    expect(await asked.json()).toEqual({ comment: false, suggestion: false, reminder: false, status: "ok", address: null });
    const refused = await call(`${NOTICES}/comment`, { method: "PUT", cookie: bare, headers: { "content-type": "application/json" }, body: JSON.stringify({ on: true }) });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "conflict", message: "sign out and in again to turn on email notices" });
    expect(await rows(vaultOf(sam))).toEqual([]);
    // Turning one off needs no address.
    const off = await call(`${NOTICES}/comment`, { method: "PUT", cookie: bare, headers: { "content-type": "application/json" }, body: JSON.stringify({ on: false }) });
    expect(off.status).toBe(200);
    // Nor does the Vault take an address that isn't one.
    for (const given of [null, undefined, "", "not an address"])
      expect(await refusal(vaultOf(sam).setEmailNotice(whoOf(sam), "comment", true, given))).toBe("conflict: sign out and in again to turn on email notices");
  });

  it("turned on with A, a sign-in with B pauses: nothing sent, Account says paused; signing in with A again sends the next notice", async () => {
    const { sam, dana, target, grantId } = await coached();
    const recorder = installEmail(env);
    await turnOn(sam, "comment");
    await comment(dana, grantId, target, "Before the other sign-in");
    const { uid } = sessionOf(sam);
    await vaultOf(sam).openSession(uid, uniqueEmail("other"));
    expect(await rowOf(vaultOf(sam), "comment")).toMatchObject({ outcome: "paused", pending_at: null, attempts: 0 });
    expect(await read(sam)).toMatchObject({ comment: true, status: "paused" });
    await comment(dana, grantId, target, "While paused");
    expect((await rowOf(vaultOf(sam), "comment"))!.pending_at).toBeNull();
    await pass(vaultOf(sam), DAY);
    await fire(vaultOf(sam));
    expect(recorder.calls).toEqual([]);
    // An older caller that passes no address at all changes nothing.
    await vaultOf(sam).openSession(uid);
    expect((await rowOf(vaultOf(sam), "comment"))!.outcome).toBe("paused");
    // Signing in again with the address it was turned on with.
    const again = await signIn(sam.email);
    expect(await read(again)).toMatchObject({ comment: true, status: "ok" });
    await comment(dana, grantId, target, "After signing in again");
    await pass(vaultOf(sam), NOTICE_DELAY_MS);
    await fire(vaultOf(sam));
    expect(recorder.sent).toEqual([notice("comment", sam.email)]);
    // A sign-in with no address pauses it once more.
    await vaultOf(sam).openSession(uid, null);
    expect((await rowOf(vaultOf(sam), "comment"))!.outcome).toBe("paused");
  });

  it("a Directory address that differs from the check pauses and sends nothing", async () => {
    const { sam, dana, target, grantId } = await coached();
    const recorder = installEmail(env);
    const metrics = recordMetrics();
    await turnOn(sam, "comment");
    await comment(dana, grantId, target, "To an address that has changed");
    const { uid } = sessionOf(sam);
    const changed = uniqueEmail("changed");
    await runInDurableObject(directoryForUser(env, uid), (_instance, state) => {
      state.storage.sql.exec(`UPDATE users SET email = ? WHERE user_id = ?`, changed, uid);
    });
    await pass(vaultOf(sam), NOTICE_DELAY_MS);
    await fire(vaultOf(sam));
    expect(recorder.calls).toEqual([]);
    expect(await rowOf(vaultOf(sam), "comment")).toMatchObject({ outcome: "paused", attempts: 0, retry_at: null, pending_at: null });
    expect(await read(sam)).toMatchObject({ status: "paused" });
    expect(noticePoints(metrics)).toEqual([{ indexes: [sessionOf(sam).vid], blobs: ["email", "email_notice", "comment", "E_ADDRESS_CHANGED", "paused"], doubles: [1, 0, 0, 0] }]);
  });

  it("the Directory gives no address for a retired vault, a deleting account or another account's vault", async () => {
    const sam = await signIn();
    const other = await signIn();
    const mine = sessionOf(sam);
    const theirs = sessionOf(other);
    const home = directoryForUser(env, mine.uid);
    expect(await home.noticeAddress(mine.uid, mine.vid)).toBe(sam.email);
    expect(await home.noticeAddress(mine.uid, theirs.vid)).toBeNull();
    expect(await directoryForUser(env, theirs.uid).noticeAddress(theirs.uid, mine.vid)).toBeNull();
    for (const [user, vaultId] of [["", mine.vid], [mine.uid, ""], [42, mine.vid]] as const)
      expect(await home.noticeAddress(user as string, vaultId)).toBeNull();
    // Moved: the vault it left has no address, and its replacement has the account's.
    const operation = crypto.randomUUID();
    const { targetVaultId } = await directory(env).prepareReplacement(mine.vid, operation);
    expect(await home.noticeAddress(mine.uid, targetVaultId)).toBeNull();
    await moveVault(mine.vid, targetVaultId, operation);
    await directory(env).cutover(mine.vid, targetVaultId, operation);
    expect(await home.noticeAddress(mine.uid, mine.vid)).toBeNull();
    expect(await home.noticeAddress(mine.uid, targetVaultId)).toBe(sam.email);
    // Deleting: none, from the moment deletion begins.
    const gone = await signIn();
    const its = sessionOf(gone);
    expect(await directoryForUser(env, its.uid).noticeAddress(its.uid, its.vid)).toBe(gone.email);
    expect((await gone.send("DELETE", "/auth/account")).status).toBe(202);
    expect(await directoryForUser(env, its.uid).noticeAddress(its.uid, its.vid)).toBeNull();
  });
});

// ---------------------------------------------------------------- retries

describe("when a notice can't be sent", () => {
  it("temporary codes retry at 5 and 30 minutes, then fail; each permanent code fails at once; Account says failing", async () => {
    const { sam, dana, target, grantId } = await coached();
    const recorder = installEmail(env);
    await turnOn(sam, "comment");
    recorder.failWith(providerError("E_RATE_LIMIT_EXCEEDED"), providerError("E_INTERNAL_SERVER_ERROR"), providerError("E_DELIVERY_FAILED"));
    await comment(dana, grantId, target, "Hard to deliver");
    await pass(vaultOf(sam), NOTICE_DELAY_MS);
    await fire(vaultOf(sam));
    expect(recorder.calls).toHaveLength(1);
    expect(await rowOf(vaultOf(sam), "comment")).toMatchObject({ attempts: 1, outcome: null });
    expect(await read(sam)).toMatchObject({ status: "ok" });
    // Not before its time.
    await pass(vaultOf(sam), RETRY_DELAYS_MS[0]! - MINUTE);
    await fire(vaultOf(sam));
    expect(recorder.calls).toHaveLength(1);
    await pass(vaultOf(sam), MINUTE);
    await fire(vaultOf(sam));
    expect(recorder.calls).toHaveLength(2);
    expect(await rowOf(vaultOf(sam), "comment")).toMatchObject({ attempts: 2 });
    await pass(vaultOf(sam), RETRY_DELAYS_MS[1]! - MINUTE);
    await fire(vaultOf(sam));
    expect(recorder.calls).toHaveLength(2);
    await pass(vaultOf(sam), MINUTE);
    await fire(vaultOf(sam));
    expect(recorder.calls).toHaveLength(3);
    expect(recorder.sent).toEqual([]);
    expect(await rowOf(vaultOf(sam), "comment")).toMatchObject({ attempts: 0, retry_at: null, outcome: "failed" });
    expect(await read(sam)).toMatchObject({ comment: true, status: "failing" });
    // No fourth attempt.
    await pass(vaultOf(sam), DAY);
    await fire(vaultOf(sam));
    expect(recorder.calls).toHaveLength(3);

    // Each permanent code, and one nobody has listed, fails at the first attempt.
    for (const code of ["E_SENDER_NOT_VERIFIED", "E_SENDER_DOMAIN_NOT_AVAILABLE", "E_RECIPIENT_SUPPRESSED", "E_DAILY_LIMIT_EXCEEDED", "E_SOMETHING_NEW"]) {
      const before = recorder.calls.length;
      recorder.failWith(providerError(code));
      await comment(dana, grantId, target, `Refused with ${code}`);
      await pass(vaultOf(sam), DAY);
      await fire(vaultOf(sam));
      expect(recorder.calls, code).toHaveLength(before + 1);
      expect(await rowOf(vaultOf(sam), "comment"), code).toMatchObject({ attempts: 0, retry_at: null, outcome: "failed" });
      await pass(vaultOf(sam), DAY);
      await fire(vaultOf(sam));
      expect(recorder.calls, code).toHaveLength(before + 1);
    }
    // A notice that goes clears the warning.
    await comment(dana, grantId, target, "At last");
    await pass(vaultOf(sam), DAY);
    await fire(vaultOf(sam));
    expect(recorder.sent).toEqual([notice("comment", sam.email)]);
    expect(await read(sam)).toMatchObject({ status: "ok" });
  });

  it("metrics hold kind, code and outcome, never the address or the provider's message", async () => {
    const { sam, dana, target, grantId } = await coached();
    const recorder = installEmail(env);
    const metrics = recordMetrics();
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await turnOn(sam, "comment");
      recorder.failWith(providerError("E_DELIVERY_FAILED"), providerError("E_RECIPIENT_SUPPRESSED"));
      await comment(dana, grantId, target, "Watched");
      await pass(vaultOf(sam), NOTICE_DELAY_MS);
      await fire(vaultOf(sam));
      await pass(vaultOf(sam), RETRY_DELAYS_MS[0]!);
      await fire(vaultOf(sam));
      await comment(dana, grantId, target, "Watched again");
      await pass(vaultOf(sam), DAY);
      await fire(vaultOf(sam));
      const vid = sessionOf(sam).vid;
      expect(noticePoints(metrics)).toEqual([
        { indexes: [vid], blobs: ["email", "email_notice", "comment", "E_DELIVERY_FAILED", "retry"], doubles: [1, 0, 0, 0] },
        { indexes: [vid], blobs: ["email", "email_notice", "comment", "E_RECIPIENT_SUPPRESSED", "failed"], doubles: [2, 0, 0, 0] },
        { indexes: [vid], blobs: ["email", "email_notice", "comment", "", "ok"], doubles: [1, 0, 0, 0] },
      ]);
      const failures = logs.mock.calls.filter(([event]) => event === "email notice failed");
      expect(failures).toEqual([
        ["email notice failed", { code: "E_DELIVERY_FAILED", kind: "comment" }],
        ["email notice failed", { code: "E_RECIPIENT_SUPPRESSED", kind: "comment" }],
      ]);
      const kept = JSON.stringify([metrics, logs.mock.calls]);
      for (const absent of [sam.email, "secret-provider-detail", "owner@example.test", "Watched"]) expect(kept, absent).not.toContain(absent);
      expect(JSON.stringify(await rows(vaultOf(sam)))).not.toContain("secret-provider-detail");
    } finally {
      logs.mockRestore();
    }
  });

  it("a failed Directory lookup retries", async () => {
    const { sam, dana, target, grantId } = await coached();
    const recorder = installEmail(env);
    const metrics = recordMetrics();
    await turnOn(sam, "comment");
    await comment(dana, grantId, target, "The Directory is away");
    const lookup = vi.spyOn(Directory.prototype, "noticeAddress").mockRejectedValueOnce(new Error("directory unavailable for owner@example.test"));
    try {
      await pass(vaultOf(sam), NOTICE_DELAY_MS);
      await fire(vaultOf(sam));
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(recorder.calls).toEqual([]);
      expect(await rowOf(vaultOf(sam), "comment")).toMatchObject({ attempts: 1, outcome: null });
      await pass(vaultOf(sam), RETRY_DELAYS_MS[0]!);
      await fire(vaultOf(sam));
      expect(recorder.sent).toEqual([notice("comment", sam.email)]);
      expect(noticePoints(metrics).map((point) => point.blobs.slice(3))).toEqual([["E_ADDRESS_UNAVAILABLE", "retry"], ["", "ok"]]);
    } finally {
      lookup.mockRestore();
    }
  });
});

// ---------------------------------------------------------------- the control plane

describe("the control plane", () => {
  it("a coach's comment with notices on calls no Directory method", async () => {
    const { sam, dana, target, grantId } = await coached();
    installEmail(env);
    await turnOn(sam, "comment");
    await turnOn(dana, "comment");
    const methods = ["signIn", "deleteAccount", "listVaults", "addInvite", "removeInvite", "listInvites", "noticeAddress"] as const;
    const spies = methods.map((method) => vi.spyOn(Directory.prototype, method));
    try {
      await comment(dana, grantId, target, "No control plane on this path");
      expect((await sam.fetch(NOTICES)).status).toBe(200);
      expect((await turn(sam, "suggestion", true)).status).toBe(200);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      // The alarm is where the address is asked for, once.
      await pass(vaultOf(sam), NOTICE_DELAY_MS);
      await fire(vaultOf(sam));
      expect(spies.at(-1)).toHaveBeenCalledTimes(1);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------- access

describe("who may read and change the settings", () => {
  it("routes need the session: none, forged, stale generation, another user's who (403)", async () => {
    const sam = await signIn();
    const other = await signIn();
    installEmail(env);
    const put = (cookie?: string) => call(`${NOTICES}/comment`, { method: "PUT", cookie, headers: { "content-type": "application/json" }, body: JSON.stringify({ on: true }) });
    expect((await call(NOTICES)).status).toBe(401);
    expect((await put()).status).toBe(401);
    const [body, mac] = sam.cookie.slice("__Host-session=".length).split(".");
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(body!)));
    const forged = `__Host-session=${base64url(new TextEncoder().encode(JSON.stringify({ ...claims, uid: sessionOf(other).uid })))}.${mac}`;
    expect((await call(NOTICES, { cookie: forged })).status).toBe(401);
    expect((await put(forged)).status).toBe(401);
    // Another account's identity, handed to this vault, is refused by the vault itself.
    expect(await refusal(vaultOf(sam).emailNotices(whoOf(other)))).toBe("forbidden: not this user's vault");
    expect(await refusal(vaultOf(sam).setEmailNotice(whoOf(other), "comment", true, other.email))).toBe("forbidden: not this user's vault");
    // Signed out everywhere: the old session's generation is stale.
    const stale = sam.cookie;
    expect((await sam.send("POST", "/api/account/sign-out-everywhere")).status).toBe(204);
    expect((await call(NOTICES, { cookie: stale })).status).toBe(401);
    expect((await put(stale)).status).toBe(401);
    expect(await rows(vaultOf(sam))).toEqual([]);
  });

  it("a malformed kind or body is 422", async () => {
    const sam = await signIn();
    installEmail(env);
    for (const kind of ["digest", "COMMENT", "comment%20", "reminders"])
      expect((await turn(sam, kind, true)).status, kind).toBe(422);
    for (const body of [{ on: "true" }, { on: 1 }, { on: null }, {}, { on: true, address: "someone@example.test" }, [true]])
      expect((await sam.send("PUT", `${NOTICES}/comment`, body)).status, JSON.stringify(body)).toBe(422);
    expect((await sam.fetch(`${NOTICES}/comment`, { method: "PUT", headers: { "content-type": "application/json" }, body: "not json" })).status).toBe(422);
    // The Vault checks again.
    for (const [kind, on] of [["digest", true], ["comment", "yes"]] as const)
      expect(await refusal(vaultOf(sam).setEmailNotice(whoOf(sam), kind as NoticeKind, on as boolean, sam.email))).toBe("invalid: choose a notice to turn on or off");
    expect(await rows(vaultOf(sam))).toEqual([]);
  });

  it("closed while fenced or being deleted", async () => {
    const sam = await signIn();
    installEmail(env);
    await turnOn(sam, "comment");
    await setting(vaultOf(sam), "RESTORE_FENCE_IDS", sessionOf(sam).vid);
    expect((await sam.fetch(NOTICES)).status).toBe(503);
    expect((await turn(sam, "comment", false)).status).toBe(503);
    // Lifted, the settings are as they were.
    await restore.pop()!();
    expect(await read(sam)).toMatchObject({ comment: true });
    expect((await sam.send("DELETE", "/auth/account")).status).toBe(202);
    expect((await sam.fetch(NOTICES)).status).toBe(410);
    expect((await turn(sam, "comment", false)).status).toBe(410);
  });
});

// ---------------------------------------------------------------- lifecycle

/** The fenced replacement an operator runs with scripts/move-vault.mjs, step for step, ending in cutover. */
async function moveVault(sourceId: string, targetVaultId: string, operation: string) {
  const source = vault(env, sourceId);
  const replacement = vault(env, targetVaultId);
  for (const object of [source, replacement, directory(env)]) await setting(object, "RESTORE_FENCE_IDS", [sourceId, targetVaultId].join(","));
  const manifest = await source.transferManifest(operation);
  await replacement.importManifest(manifest);
  for (const table of manifest.tables) {
    const page = await source.transferPage(operation, table.name);
    expect(page.done).toBe(true);
    await replacement.importPage(page);
  }
  expect(await replacement.finishImport(operation, sourceId)).toMatchObject({ state: "ready", completedTables: manifest.tables.length });
  return { source, replacement, manifest };
}

describe("email notices and a vault's own storage", () => {
  it("is in the owner's export, JSON and ZIP", async () => {
    const { sam, dana, target, grantId } = await coached();
    installEmail(env);
    await turnOn(sam, "comment", "reminder");
    await comment(dana, grantId, target, "Queued at export");
    const stored = await rows(vaultOf(sam));
    expect(stored.map((row) => row.kind)).toEqual(["comment", "reminder"]);
    const check = await noticeAddressCheck(sam.email);
    expect(stored.every((row) => row.address_check === check)).toBe(true);
    const json = await sam.json<{ emailNotices: unknown[] }>("/api/export");
    expect(json.emailNotices).toEqual(stored);
    const archive = await sam.fetch("/api/export/archive");
    expect(archive.status).toBe(200);
    const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    expect((JSON.parse(strFromU8(entries["vault.json"]!)) as { emailNotices: unknown[] }).emailNotices).toEqual(stored);
    // The check, never the address.
    expect(JSON.stringify(json.emailNotices)).not.toContain(sam.email);
  });

  it("a moved vault takes its settings and sends from the replacement, not the source", async () => {
    const { sam, dana, target, grantId } = await coached();
    const recorder = installEmail(env);
    await turnOn(sam, "comment", "suggestion");
    await comment(dana, grantId, target, "Queued before the move");
    const old = sessionOf(sam);
    const operation = crypto.randomUUID();
    const { targetVaultId } = await directory(env).prepareReplacement(old.vid, operation);
    const { source, replacement, manifest } = await moveVault(old.vid, targetVaultId, operation);
    expect(manifest.tables.at(-1)).toEqual({ name: "email_notices", count: 2 });
    const before = await rows(source);
    expect(await rows(replacement)).toEqual(before);
    // Fenced, the source sends nothing even when the notice is due.
    await pass(source, NOTICE_DELAY_MS);
    await fire(source);
    expect(recorder.calls).toEqual([]);
    await directory(env).cutover(old.vid, targetVaultId, operation);
    await setting(replacement, "RESTORE_FENCE_IDS", old.vid);
    // Cutover let the replacement out and armed its alarm for the notice it brought.
    expect(await runInDurableObject(replacement, (_instance, state) => state.storage.getAlarm())).not.toBeNull();
    await pass(replacement, NOTICE_DELAY_MS);
    await fire(replacement);
    expect(recorder.sent).toEqual([notice("comment", sam.email)]);
    const moved = await signIn(sam.email);
    expect(sessionOf(moved).vid).toBe(targetVaultId);
    expect(await read(moved)).toMatchObject({ comment: true, suggestion: true, status: "ok" });
  });

  it("is gone when the account is deleted, and nothing is sent after deletion begins", async () => {
    const { sam, dana, target, grantId } = await coached();
    const recorder = installEmail(env);
    await turnOn(sam, ...NOTICE_KINDS);
    await comment(dana, grantId, target, "Before the account went");
    await pass(vaultOf(sam), NOTICE_DELAY_MS);
    expect((await sam.send("DELETE", "/auth/account")).status).toBe(202);
    // The vault's alarm does deletion's work and nothing else: it doesn't even ask for an address.
    const lookup = vi.spyOn(Directory.prototype, "noticeAddress");
    try {
      await fire(vaultOf(sam));
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
    expect(recorder.calls).toEqual([]);
    await runDurableObjectAlarm(directory(env));
    await eventually(async () => {
      const tables = await runInDurableObject(vaultOf(sam), (_instance, state) =>
        state.storage.sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).toArray().map((table) => table.name),
      );
      return tables.filter((name) => !name.startsWith("_cf_") && !name.startsWith("sqlite_")).length === 0;
    }, "the owner's vault to be erased");
    expect(recorder.calls).toEqual([]);
  });

  it("a vault from before gains the table with every notice off, its comments and facts as they were", async () => {
    const { sam, dana, target, grantId } = await coached();
    const made = await comment(dana, grantId, target, "Written before notices existed");
    const before = { facts: (await sam.json<{ facts: FactView[] }>("/api/facts")).facts, threads: await sam.json("/api/shares/comments") };
    await runInDurableObject(vaultOf(sam), (_instance, state) => {
      const sql = state.storage.sql;
      removeNotificationMigration(sql);
      const previous = MIGRATIONS.findIndex((migration) => migration.some((statement) => statement.includes("CREATE TABLE email_notices")));
      expect(previous).toBeGreaterThan(-1);
      const named = () => sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE name = 'email_notices'`).toArray();
      expect(named()).toEqual([]);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      migrate(sql, <T>(fn: () => T) => state.storage.transactionSync(fn));
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(SCHEMA_VERSION));
      expect(named()).toEqual([{ name: "email_notices" }]);
      expect(sql.exec(`SELECT COUNT(*) AS n FROM email_notices`).one()).toEqual({ n: 0 });
    });
    expect((await sam.json<{ facts: FactView[] }>("/api/facts")).facts).toEqual(before.facts);
    expect(await sam.json("/api/shares/comments")).toEqual(before.threads);
    const recorder = installEmail(env);
    expect(await read(sam)).toEqual({ comment: false, suggestion: false, reminder: false, status: "ok", address: sam.email });
    // The comment from before is never announced; the table works for one written after.
    await turnOn(sam, "comment");
    await pass(vaultOf(sam), DAY);
    await fire(vaultOf(sam));
    expect(recorder.calls).toEqual([]);
    expect(made.id).toEqual(expect.any(String));
    await comment(dana, grantId, target, "Written after");
    await pass(vaultOf(sam), NOTICE_DELAY_MS);
    await fire(vaultOf(sam));
    expect(recorder.sent).toEqual([notice("comment", sam.email)]);
  });
});

// ---------------------------------------------------------------- outward

describe("where a notice goes", () => {
  it("where a notice goes: a sensitive fact, a comment's text and a suggestion's text appear in no email notice", async () => {
    const { sam, dana, facts, target, grantId, shared, line, all } = await coachedResume();
    const recorder = installEmail(env);
    await turnOn(sam, ...NOTICE_KINDS);
    const COMMENT = "PANGOLIN-5521 the coach's comment";
    const SUGGESTION = `${line.text} OCELOT-8830`;
    await comment(dana, grantId, { kind: "fact", factId: facts[0]!.id }, COMMENT);
    await suggested(dana, grantId, target, SUGGESTION);
    // A fact marked sensitive, and one more waiting for review so a reminder goes too.
    const inCopy = new Set(facts.slice(0, 2).map((fact) => fact.id));
    const marked = facts.find((fact) => !inCopy.has(fact.id) && !all.some((item) => item.factIds.includes(fact.id))) ?? facts.at(-1)!;
    expect((await sam.send("POST", "/api/facts/sensitive", { ids: [marked.id], sensitive: true })).status).toBe(204);
    const role = (await sam.json<{ roles: RoleView[] }>("/api/roles")).roles[0]!;
    const added = await sam.send("POST", "/api/facts", { roleId: role.id, kind: "accomplishment", text: "Waiting fact MARMOSET-1207", level: "implemented" });
    expect(added.ok, await added.clone().text()).toBe(true);
    await runInDurableObject(vaultOf(sam), (_instance, state) => {
      state.storage.sql.exec(`UPDATE facts SET state = 'proposed' WHERE text = ?`, "Waiting fact MARMOSET-1207");
    });
    await pass(vaultOf(sam), 4 * DAY);
    await fire(vaultOf(sam));
    expect(recorder.sent.map((sent) => sent.subject).sort()).toEqual(NOTICE_KINDS.map((kind) => noticeMessage(kind, ORIGIN).subject).sort());
    const parts = await outwardParts({ owner: sam, copies: [{ ...shared, coach: dana }], inputs: [], notices: recorder.sent });
    const notices = parts.filter((part) => part.surface === "email notice");
    expect(notices).toHaveLength(3);
    const fixed = NOTICE_KINDS.map((kind) => {
      const message = noticeMessage(kind, ORIGIN);
      return `${message.subject}\n${message.text}`;
    });
    for (const part of notices) expect(fixed).toContain(part.text);
    for (const part of notices)
      for (const word of [marked.text, "PANGOLIN", "OCELOT", "MARMOSET", line.text, sam.email, dana.email, grantId, ...facts.map((fact) => fact.text)])
        expect(part.text.includes(word), word).toBe(false);
  }, 120_000);
});
