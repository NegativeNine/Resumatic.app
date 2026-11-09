import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrate, SCHEMA_VERSION } from "../../src/vault/schema";
import { vault } from "../../src/shared/stubs";
import { fromBase64url } from "../../src/worker/crypto";
import { removeJobDetailsMigration } from "../support/undo-vault-incarnation";
import { JOB_DESCRIPTION, signIn, type User } from "./support";

const LINK = "https://jobs.example.com/litware/platform-engineer";

function create(user: User, body: { jdText: string; url?: string }, key = crypto.randomUUID()): Promise<Response> {
  return user.fetch("/api/v2/applications", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

async function saved(user: User, body: { jdText: string; url?: string } = { jdText: JOB_DESCRIPTION }): Promise<string> {
  const response = await create(user, body);
  expect(response.status).toBe(201);
  return ((await response.json()) as { applicationId: string }).applicationId;
}

function vaultOf(user: User) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  const session = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { vid: string };
  return vault(env, session.vid);
}

type Detail = { id: string; revision: number; title: string | null; company: string | null; url: string | null; jdText: string; excerpt: string; canDelete: boolean };

describe("job details", () => {
  it("returns the whole posting and its link to the person who saved it, and to nobody else", async () => {
    const user = await signIn();
    const id = await saved(user, { jdText: JOB_DESCRIPTION, url: LINK });
    const detail = await user.json<Detail>(`/api/applications/${id}`);
    expect(detail).toMatchObject({ id, jdText: JOB_DESCRIPTION, url: LINK, title: null, company: null, canDelete: true });
    const listed = (await user.json<{ applications: { id: string; url: string | null }[] }>("/api/applications")).applications;
    expect(listed.find((a) => a.id === id)?.url).toBe(LINK);
    const other = await signIn();
    expect((await other.fetch(`/api/applications/${id}`)).status).toBe(404);
    expect((await other.send("DELETE", `/api/applications/${id}`)).status).toBe(404);
  });

  it("refuses a link that isn't a web address", async () => {
    const user = await signIn();
    for (const url of ["javascript:alert(1)", "ftp://example.com/job", "https://user:pw@example.com/job", "not a link", "https://localhost/job"])
      expect((await create(user, { jdText: JOB_DESCRIPTION, url })).status).toBe(422);
    expect((await user.json<{ applications: unknown[] }>("/api/applications")).applications).toHaveLength(0);
  });

  it("saves a title, company and link, and keeps them when the posting is read later", async () => {
    const user = await signIn();
    const id = await saved(user);
    const before = await user.json<Detail>(`/api/applications/${id}`);
    const patch = await user.send("PATCH", `/api/applications/${id}`, {
      title: "  Platform Engineer ", company: "Litware", url: LINK, expectedRevision: before.revision,
    });
    expect(patch.status).toBe(204);
    expect(await user.json<Detail>(`/api/applications/${id}`)).toMatchObject({
      title: "Platform Engineer", company: "Litware", url: LINK, revision: before.revision + 1, jdText: JOB_DESCRIPTION,
    });
    // What Tailor reads from the posting must not replace what the person typed.
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE applications SET company = CASE WHEN details_edited = 1 THEN company ELSE ? END,
           title = CASE WHEN details_edited = 1 THEN title ELSE ? END WHERE id = ?`, "Someone Else", "Another Title", id,
      );
      expect(state.storage.sql.exec<{ details_edited: number }>(`SELECT details_edited FROM applications WHERE id = ?`, id).one().details_edited).toBe(1);
    });
    expect(await user.json<Detail>(`/api/applications/${id}`)).toMatchObject({ title: "Platform Engineer", company: "Litware" });
    // Clearing both names hands the job back to be read from its posting.
    expect((await user.send("PATCH", `/api/applications/${id}`, { title: "", company: "", url: "" })).status).toBe(204);
    expect(await user.json<Detail>(`/api/applications/${id}`)).toMatchObject({ title: null, company: null, url: null });
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      expect(state.storage.sql.exec<{ details_edited: number }>(`SELECT details_edited FROM applications WHERE id = ?`, id).one().details_edited).toBe(0);
    });
  });

  it("rejects a name over its limit, a name on two lines, and a link that isn't one", async () => {
    const user = await signIn();
    const id = await saved(user);
    for (const patch of [{ title: "x".repeat(161) }, { company: "Lit\nware" }, { url: "javascript:alert(1)" }, { jdText: "too short" }])
      expect((await user.send("PATCH", `/api/applications/${id}`, patch)).status).toBe(422);
    expect(await user.json<Detail>(`/api/applications/${id}`)).toMatchObject({ title: null, company: null, url: null, jdText: JOB_DESCRIPTION, revision: 1 });
  });

  it("replaces the posting, and forgets what was read from the old one", async () => {
    const user = await signIn();
    const id = await saved(user);
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      state.storage.sql.exec(`UPDATE applications SET company = 'Read Co', title = 'Read Title', requirements = '["Python"]' WHERE id = ?`, id);
    });
    const next = `${JOB_DESCRIPTION}\n\nNow also hiring in Toronto.`;
    expect((await user.send("PATCH", `/api/applications/${id}`, { jdText: next })).status).toBe(204);
    expect(await user.json<Detail>(`/api/applications/${id}`)).toMatchObject({ jdText: next, title: null, company: null });
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      expect(state.storage.sql.exec<{ requirements: string | null }>(`SELECT requirements FROM applications WHERE id = ?`, id).one().requirements).toBeNull();
    });
  });

  it("won't change the posting while work on the job is in progress", async () => {
    const user = await signIn();
    const id = await saved(user);
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO resumes (id, application_id, state, created_at) VALUES ('resume-running', ?, 'running', 1)`, id);
    });
    const refused = await user.send("PATCH", `/api/applications/${id}`, { jdText: `${JOB_DESCRIPTION} More.` });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { message: string }).message).toMatch(/still in progress/);
    // Details that don't touch the posting can still be saved.
    expect((await user.send("PATCH", `/api/applications/${id}`, { title: "Platform Engineer" })).status).toBe(204);
    expect(await user.json<Detail>(`/api/applications/${id}`)).toMatchObject({ jdText: JOB_DESCRIPTION, title: "Platform Engineer" });
  });
});

describe("deleting a job", () => {
  it("removes a job with nothing attached, along with its request record", async () => {
    const user = await signIn();
    const key = crypto.randomUUID();
    const response = await create(user, { jdText: JOB_DESCRIPTION }, key);
    const { applicationId } = (await response.json()) as { applicationId: string };
    expect((await user.send("DELETE", `/api/applications/${applicationId}`)).status).toBe(204);
    expect((await user.json<{ applications: unknown[] }>("/api/applications")).applications).toHaveLength(0);
    expect((await user.fetch(`/api/applications/${applicationId}`)).status).toBe(404);
    expect((await user.send("DELETE", `/api/applications/${applicationId}`)).status).toBe(404);
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT 1 FROM application_create_requests`).toArray()).toHaveLength(0);
    });
    // The same request key now makes a new job: the old one is gone, not replayed.
    const again = await create(user, { jdText: JOB_DESCRIPTION }, key);
    expect(again.status).toBe(201);
    expect(((await again.json()) as { applicationId: string }).applicationId).not.toBe(applicationId);
  });

  it.each([
    ["a resume", `INSERT INTO resumes (id, application_id, state, created_at) VALUES ('r1', ?, 'failed', 1)`],
    ["a document", `INSERT INTO documents (id, application_id, kind, state, created_at) VALUES ('d1', ?, 'letter', 'failed', 1)`],
  ])("keeps a job that has %s, and says to close it instead", async (_what, insert) => {
    const user = await signIn();
    const id = await saved(user);
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      state.storage.sql.exec(insert, id);
    });
    expect((await user.json<Detail>(`/api/applications/${id}`)).canDelete).toBe(false);
    const refused = await user.send("DELETE", `/api/applications/${id}`);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { message: string }).message).toBe("This job has resumes or documents, so it can't be deleted. Mark it Closed instead.");
    expect((await user.json<{ applications: unknown[] }>("/api/applications")).applications).toHaveLength(1);
  });
});

describe("a posting that's already saved", () => {
  it("is found by its text, whatever the spacing, without saving anything", async () => {
    const user = await signIn();
    const id = await saved(user);
    const check = (jdText: string) => user.send("POST", "/api/applications/duplicates", { jdText }).then((r) => r.json() as Promise<{ duplicate: { id: string; excerpt: string } | null }>);
    expect((await check(JOB_DESCRIPTION)).duplicate).toMatchObject({ id });
    expect((await check(`  ${JOB_DESCRIPTION.replace(/ /g, "  \n")}  `)).duplicate).toMatchObject({ id });
    expect((await check(`${JOB_DESCRIPTION} And one more requirement.`)).duplicate).toBeNull();
    expect((await user.json<{ applications: unknown[] }>("/api/applications")).applications).toHaveLength(1);
    // Another person's jobs are never compared.
    const other = await signIn();
    expect(((await (await other.send("POST", "/api/applications/duplicates", { jdText: JOB_DESCRIPTION })).json()) as { duplicate: unknown }).duplicate).toBeNull();
  });

  it("can still be saved twice when the person chooses to", async () => {
    const user = await signIn();
    await saved(user);
    await saved(user);
    expect((await user.json<{ applications: unknown[] }>("/api/applications")).applications).toHaveLength(2);
  });
});

describe("job details in an existing vault", () => {
  it("adds the link and the name flag, leaving saved jobs as they were", async () => {
    const user = await signIn();
    const id = await saved(user);
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      const sql = state.storage.sql;
      // Rewind this vault to the schema before job details, as an older vault would be.
      removeJobDetailsMigration(sql);
      const previous = MIGRATIONS.findIndex((migration) => migration.some((statement) => statement.includes("ALTER TABLE applications ADD COLUMN url")));
      expect(previous).toBeGreaterThan(-1);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      migrate(sql, <T>(fn: () => T) => state.storage.transactionSync(fn));
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(SCHEMA_VERSION));
      expect(sql.exec<{ url: string | null; details_edited: number }>(`SELECT url, details_edited FROM applications`).toArray()).toEqual([{ url: null, details_edited: 0 }]);
    });
    expect(await user.json<Detail>(`/api/applications/${id}`)).toMatchObject({ id, url: null, jdText: JOB_DESCRIPTION, canDelete: true });
  });
});
