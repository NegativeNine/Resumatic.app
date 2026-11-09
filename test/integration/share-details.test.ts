import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import type { ApplicationView, FactView, ResumeView, RoleView } from "../../src/shared/api";
import type { ShareGrant, SharedView } from "../../src/shared/sharing";
import { MIGRATIONS, migrate, SCHEMA_VERSION } from "../../src/vault/schema";
import { vault } from "../../src/shared/stubs";
import { fromBase64url } from "../../src/worker/crypto";
import { removeShareDetailMigration } from "../support/undo-vault-incarnation";
import { call, cookieFrom, fakeModels, JOB_DESCRIPTION, RESUME, signIn, waitForResume, waitForSource, type User } from "./support";

beforeEach(() => setModels(() => fakeModels()));
afterEach(() => setModels(null));

const FACT = "Cut deploy time from forty minutes to six";

function vaultOf(user: User) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  const session = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { vid: string };
  return vault(env, session.vid);
}

/** Someone with a name in their contact details and one confirmed fact of their own. */
async function owner() {
  const user = await signIn();
  expect((await user.send("PUT", "/api/profile", { name: "Avery Example" })).status).toBe(200);
  const role = await user.send("POST", "/api/roles", { kind: "job", org: "Acme", title: "Engineer", startDate: "2021", endDate: null });
  expect(role.status).toBe(201);
  const { roleId } = (await role.json()) as { roleId: string };
  const fact = await user.send("POST", "/api/facts", { roleId, kind: "accomplishment", text: FACT, level: "implemented" });
  expect(fact.status).toBe(201);
  const { factId } = (await fact.json()) as { factId: string };
  return { user, factId };
}

async function share(user: User, body: Record<string, unknown>) {
  const response = await user.send("POST", "/api/shares", body);
  expect(response.status, await response.clone().text()).toBe(201);
  const { grant, url } = (await response.json()) as { grant: ShareGrant; url: string };
  return { grant, token: new URL(url).hash.slice(1) };
}

function exchange(token: string) {
  return call("/share/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
}

/** Opens a link as a browser does, and returns the cookie for that copy alone. */
async function open(token: string, grantId: string) {
  const response = await exchange(token);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toEqual({ grantId });
  const own = cookieFrom(response, `__Host-share-${grantId}`);
  const single = cookieFrom(response, "__Host-share");
  expect(own).toBeTruthy();
  expect(single).toBeTruthy();
  return { own: own!, single: single! };
}

const copy = (grantId: string | null, cookie?: string) =>
  call(grantId === null ? "/share/snapshot" : `/share/snapshot?g=${grantId}`, cookie === undefined ? {} : { cookie });
const grants = async (user: User) => (await user.json<{ grants: ShareGrant[] }>("/api/shares")).grants;

describe("what a shared copy says, and what its owner sees", () => {
  it("names nobody unless asked, keeps the label for the owner, and notes when a copy is opened", async () => {
    const { user, factId } = await owner();
    const plain = await share(user, { factIds: [factId], resumes: [] });
    const named = await share(user, { factIds: [factId], resumes: [], label: "  For Dana ", showName: true, showJobs: true });
    expect(plain.grant).toMatchObject({ label: null, lastReadAt: null });
    expect(named.grant).toMatchObject({ label: "For Dana", lastReadAt: null });
    // The owner's list checks each link still works. That isn't the copy being opened.
    expect((await grants(user)).map((grant) => grant.lastReadAt)).toEqual([null, null]);

    const before = Date.now();
    const namedCookies = await open(named.token, named.grant.id);
    // Opening the link is not yet reading the copy.
    expect((await grants(user)).find((grant) => grant.id === named.grant.id)!.lastReadAt).toBeNull();
    const response = await copy(named.grant.id, namedCookies.own);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const view = (await response.json()) as SharedView;
    expect(view.snapshot).toMatchObject({ schemaVersion: 2, owner: { name: "Avery Example" }, resumes: [] });
    expect(view.snapshot.facts.map((fact) => fact.text)).toEqual([FACT]);
    // The label is the owner's own note of who the link is for.
    expect(Object.keys(view).sort()).toEqual(["expiresAt", "grantId", "snapshot"]);
    expect(JSON.stringify(view)).not.toContain("Dana");

    const listed = await grants(user);
    const opened = listed.find((grant) => grant.id === named.grant.id)!;
    expect(opened.lastReadAt).toBeGreaterThanOrEqual(before);
    expect(opened.lastReadAt).toBeLessThanOrEqual(Date.now());
    expect(opened.label).toBe("For Dana");
    expect(listed.find((grant) => grant.id === plain.grant.id)).toMatchObject({ label: null, lastReadAt: null, available: true });

    const plainCookies = await open(plain.token, plain.grant.id);
    const openedPlain = async () => (await grants(user)).find((grant) => grant.id === plain.grant.id)!.lastReadAt;
    // The owner looking at their own copy, in the browser they are signed in to, isn't a reader opening it.
    const own = await copy(plain.grant.id, `${plainCookies.own}; ${user.cookie}`);
    expect(own.status).toBe(200);
    expect(await openedPlain()).toBeNull();
    // Someone else who happens to be signed in is a reader like any other.
    const reader = await signIn();
    const unnamed = (await (await copy(plain.grant.id, `${plainCookies.own}; ${reader.cookie}`)).json()) as SharedView;
    expect(unnamed.snapshot).toMatchObject({ schemaVersion: 2, owner: null });
    expect(JSON.stringify(unnamed)).not.toContain("Avery");
    expect(await openedPlain()).toEqual(expect.any(Number));

    // The owner's own export has the label and the time; a stranger's list has neither.
    const exported = await user.json<{ shares: (ShareGrant & { snapshot: unknown })[] }>("/api/export");
    expect(exported.shares.find((grant) => grant.id === named.grant.id)).toMatchObject({ label: "For Dana", lastReadAt: opened.lastReadAt });
    expect(await grants(await signIn())).toEqual([]);
  });

  it("opens the right copy for a reader with two open at once", async () => {
    const first = await owner();
    const second = await owner();
    expect((await second.user.send("PUT", "/api/profile", { name: "Blake Sample" })).status).toBe(200);
    const a = await share(first.user, { factIds: [first.factId], resumes: [], showName: true });
    const b = await share(second.user, { factIds: [second.factId], resumes: [], showName: true });
    const cookiesA = await open(a.token, a.grant.id);
    const cookiesB = await open(b.token, b.grant.id);
    // One browser, both copies open: every cookie goes with every request.
    const jar = [cookiesA.own, cookiesB.own, cookiesB.single].join("; ");
    const name = async (response: Response) => ((await response.json()) as SharedView).snapshot.owner?.name;
    expect(await name(await copy(a.grant.id, jar))).toBe("Avery Example");
    expect(await name(await copy(b.grant.id, jar))).toBe("Blake Sample");
    expect(await name(await copy(a.grant.id.toUpperCase(), jar))).toBe("Avery Example");
    // A page loaded before copies had their own cookie asks without saying which: it gets the last one opened.
    expect(await name(await copy(null, jar))).toBe("Blake Sample");

    // A copy's cookie opens that copy and no other, whatever name it is sent under.
    const tokenB = cookiesB.own.slice(cookiesB.own.indexOf("=") + 1);
    expect((await copy(a.grant.id, `__Host-share-${a.grant.id}=${tokenB}`)).status).toBe(410);
    expect((await copy(a.grant.id, cookiesB.own)).status).toBe(410);
    expect((await copy(a.grant.id, cookiesA.single)).status).toBe(410);
    expect((await copy(a.grant.id)).status).toBe(410);
    for (const malformed of ["", "legacy", "..%2F..", `${a.grant.id}%3B`, crypto.randomUUID()])
      expect((await copy(malformed, jar)).status, malformed).toBe(410);
    // The link itself is not a session, and a session is not a link.
    expect((await copy(a.grant.id, `__Host-share-${a.grant.id}=${a.token}`)).status).toBe(410);
    expect((await exchange(cookiesA.own.slice(cookiesA.own.indexOf("=") + 1))).status).toBe(410);

    // Revoking one copy closes it at once and leaves the other open.
    expect((await first.user.send("DELETE", `/api/shares/${a.grant.id}`)).status).toBe(204);
    expect((await copy(a.grant.id, jar)).status).toBe(410);
    expect(await name(await copy(b.grant.id, jar))).toBe("Blake Sample");
    const revoked = (await grants(first.user))[0]!;
    expect(revoked.revokedAt).not.toBeNull();
    // It was opened before it was revoked, and a refused request afterwards doesn't count.
    const openedAt = revoked.lastReadAt;
    expect(openedAt).not.toBeNull();
    await copy(a.grant.id, jar);
    expect((await grants(first.user))[0]!.lastReadAt).toBe(openedAt);
  });

  it("refuses a label that is long or runs over a line", async () => {
    const { user, factId } = await owner();
    for (const label of ["x".repeat(81), "For Dana\nand Sam", "For Dana\tand Sam", 7])
      expect((await user.send("POST", "/api/shares", { factIds: [factId], resumes: [], label })).status).toBe(422);
    for (const field of ["showName", "showJobs"])
      expect((await user.send("POST", "/api/shares", { factIds: [factId], resumes: [], [field]: "yes" })).status).toBe(422);
    expect(await grants(user)).toEqual([]);
    expect((await share(user, { factIds: [factId], resumes: [], label: "   " })).grant.label).toBeNull();
    expect((await share(user, { factIds: [factId], resumes: [], label: "x".repeat(80) })).grant.label).toHaveLength(80);
  });

  it("says which job a resume is for only when asked, as the job was named when the copy was made", async () => {
    const user = await signIn();
    const upload = await user.upload("synthetic.pdf", RESUME);
    const { sourceId } = (await upload.json()) as { sourceId: string };
    await waitForSource(user, sourceId);
    const { facts } = await user.json<{ facts: FactView[] }>("/api/facts");
    const { roles } = await user.json<{ roles: RoleView[] }>("/api/roles");
    expect((await user.send("POST", "/api/review", { confirm: [...facts, ...roles].map((item) => item.id), reject: [] })).status).toBe(204);
    const application = await user.send("POST", "/api/applications", { jdText: JOB_DESCRIPTION });
    const { applicationId } = (await application.json()) as { applicationId: string };
    const { resumeId } = (await (await user.send("POST", `/api/applications/${applicationId}/resumes`)).json()) as { resumeId: string };
    const resume = (await waitForResume(user, resumeId)) as ResumeView;
    expect(resume.state).toBe("ready");
    expect((await user.send("PATCH", `/api/applications/${applicationId}`, { title: "Staff Engineer", company: "Litware" })).status).toBe(204);
    const job = (await user.json<{ applications: ApplicationView[] }>("/api/applications")).applications[0]!;
    expect(job).toMatchObject({ title: "Staff Engineer", company: "Litware" });

    const selection = { factIds: [], resumes: [{ id: resumeId, version: resume.version }] };
    const quiet = await share(user, selection);
    const told = await share(user, { ...selection, showJobs: true });
    const read = async (shared: { grant: ShareGrant; token: string }) => {
      const cookies = await open(shared.token, shared.grant.id);
      const response = await copy(shared.grant.id, cookies.own);
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as SharedView;
    };
    const withoutJob = await read(quiet);
    expect(withoutJob.snapshot.resumes[0]!.job).toBeNull();
    // Where someone is applying stays out of a copy unless they chose to say.
    expect(JSON.stringify(withoutJob)).not.toContain("Litware");
    expect(JSON.stringify(withoutJob)).not.toContain("Staff Engineer");
    const withJob = await read(told);
    expect(withJob.snapshot.resumes[0]!.job).toEqual({ title: "Staff Engineer", company: "Litware" });
    // The job is all that differs: the resume in both is the saved version, line for line.
    const { job: _job, ...resumeWithJob } = withJob.snapshot.resumes[0]!;
    const { job: _none, ...resumeWithout } = withoutJob.snapshot.resumes[0]!;
    expect(resumeWithJob).toEqual(resumeWithout);
    expect(JSON.stringify(withJob)).not.toContain('"notes"');
    expect(JSON.stringify(withJob)).not.toContain(JOB_DESCRIPTION.slice(0, 40));

    // A copy is fixed: renaming the job afterwards doesn't reach it.
    expect((await user.send("PATCH", `/api/applications/${applicationId}`, { title: "Principal Engineer", company: "Contoso" })).status).toBe(204);
    expect((await read(told)).snapshot.resumes[0]!.job).toEqual({ title: "Staff Engineer", company: "Litware" });
    expect((await read(await share(user, { ...selection, showJobs: true }))).snapshot.resumes[0]!.job).toEqual({ title: "Principal Engineer", company: "Contoso" });

    // A job with no name says nothing, and a stored job that isn't a plain name closes the copy.
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      state.storage.sql.exec(`UPDATE applications SET title = NULL, company = NULL WHERE id = ?`, applicationId);
    });
    expect((await read(await share(user, { ...selection, showJobs: true }))).snapshot.resumes[0]!.job).toBeNull();
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      const sql = state.storage.sql;
      const saved = JSON.parse(sql.exec<{ snapshot: string }>(`SELECT snapshot FROM share_grants WHERE id = ?`, told.grant.id).one().snapshot);
      saved.resumes[0].job = { title: "Staff Engineer", company: "Litware", notes: "Recruiter: Dana" };
      sql.exec(`UPDATE share_grants SET snapshot = ? WHERE id = ?`, JSON.stringify(saved), told.grant.id);
    });
    const cookies = await open(quiet.token, quiet.grant.id);
    expect((await exchange(told.token)).status).toBe(410);
    expect((await copy(quiet.grant.id, cookies.own)).status).toBe(200);
    expect((await grants(user)).find((grant) => grant.id === told.grant.id)).toMatchObject({ available: false });
  });
});

describe("share details in an existing vault", () => {
  it("adds the label and the opened time, and still opens a copy made before them", async () => {
    const { user, factId } = await owner();
    const earlier = await share(user, { factIds: [factId], resumes: [] });
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      const sql = state.storage.sql;
      // The copy as it was stored before names and jobs: version 1, with neither.
      const saved = JSON.parse(sql.exec<{ snapshot: string }>(`SELECT snapshot FROM share_grants WHERE id = ?`, earlier.grant.id).one().snapshot);
      expect(saved).toMatchObject({ schemaVersion: 2, owner: null });
      delete saved.owner;
      saved.schemaVersion = 1;
      sql.exec(`UPDATE share_grants SET snapshot = ? WHERE id = ?`, JSON.stringify(saved), earlier.grant.id);
      // Rewind this vault to the schema before share details, as an older vault would be.
      removeShareDetailMigration(sql);
      const previous = MIGRATIONS.findIndex((migration) => migration.some((statement) => statement.includes("ALTER TABLE share_grants ADD COLUMN label")));
      expect(previous).toBe(MIGRATIONS.length - 1);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      migrate(sql, <T>(fn: () => T) => state.storage.transactionSync(fn));
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(SCHEMA_VERSION));
      expect(sql.exec<{ label: string | null; last_read_at: number | null }>(`SELECT label, last_read_at FROM share_grants`).toArray()).toEqual([{ label: null, last_read_at: null }]);
    });
    expect(await grants(user)).toMatchObject([{ id: earlier.grant.id, label: null, lastReadAt: null, available: true }]);
    // A page that was open before copies had their own cookie: one cookie, no ?g=.
    const cookies = await open(earlier.token, earlier.grant.id);
    const response = await copy(null, cookies.single);
    expect(response.status).toBe(200);
    const view = (await response.json()) as SharedView;
    expect(view.snapshot.schemaVersion).toBe(1);
    expect(view.snapshot.owner).toBeUndefined();
    expect(view.snapshot.facts.map((fact) => fact.text)).toEqual([FACT]);
    expect((await grants(user))[0]!.lastReadAt).toEqual(expect.any(Number));
  });
});
