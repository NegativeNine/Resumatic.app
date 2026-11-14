import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels, type Models } from "../../src/ai/models";
import type { DocumentView, NewDocument } from "../../src/shared/documents";
import type { ShareableDocument, ShareGrant, SharedView } from "../../src/shared/sharing";
import { MIGRATIONS, migrate, SCHEMA_VERSION } from "../../src/vault/schema";
import { vault } from "../../src/shared/stubs";
import { fromBase64url } from "../../src/worker/crypto";
import { removeShareDocumentMigration } from "../support/undo-vault-incarnation";
import { call, cookieFrom, eventually, fakeModels, JOB_DESCRIPTION, signIn, type User } from "./support";

const FACT = "Built a Go service that processes 2 million events per day";

/** A writer that says the one fact back, so every sentence is one the checks keep. */
function documentModels(): Models {
  const base = fakeModels();
  return {
    ...base,
    async complete(route, messages, schema, options) {
      const user = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
      if (route === "write" && user.startsWith("{")) {
        const data = JSON.parse(user) as { facts?: { id: string; roleId: string | null; text: string }[] };
        const first = data.facts?.find((fact) => fact.text === FACT) ?? data.facts?.[0];
        return schema.parse({ units: first ? [{ roleId: first.roleId, text: first.text, factIds: [first.id], group: 0 }] : [] });
      }
      return base.complete(route, messages, schema, options);
    },
  };
}

beforeEach(() => setModels(() => documentModels()));
afterEach(() => setModels(null));

function vaultOf(user: User) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  const session = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { vid: string };
  return vault(env, session.vid);
}

/** Someone with one confirmed fact and one saved job. */
async function owner() {
  const user = await signIn();
  const role = await user.send("POST", "/api/roles", { kind: "job", org: "Acme", title: "Engineer", startDate: "2021", endDate: null });
  const { roleId } = (await role.json()) as { roleId: string };
  const fact = await user.send("POST", "/api/facts", { roleId, kind: "accomplishment", text: FACT, level: "implemented" });
  expect(fact.status).toBe(201);
  const { factId } = (await fact.json()) as { factId: string };
  const job = await user.send("POST", "/api/applications", { jdText: JOB_DESCRIPTION });
  const { applicationId } = (await job.json()) as { applicationId: string };
  return { user, applicationId, factId };
}

async function write(user: User, applicationId: string, kind: NewDocument["kind"]): Promise<DocumentView> {
  const started = await user.fetch(`/api/applications/${applicationId}/documents`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ kind }),
  });
  expect(started.status, await started.clone().text()).toBe(202);
  const { documentId } = (await started.json()) as { documentId: string };
  const done = await eventually(async () => {
    const doc = await user.json<DocumentView>(`/api/documents/${documentId}`);
    return doc.state !== "running" ? doc : null;
  }, `${kind} to finish`);
  expect(done.state, done.error ?? "").toBe("ready");
  return done;
}

async function share(user: User, body: Record<string, unknown>) {
  const response = await user.send("POST", "/api/shares", { factIds: [], resumes: [], ...body });
  expect(response.status, await response.clone().text()).toBe(201);
  const { grant, url } = (await response.json()) as { grant: ShareGrant; url: string };
  return { grant, token: new URL(url).hash.slice(1) };
}

/** Opens a link as its reader would and reads the copy. */
async function read(shared: { grant: ShareGrant; token: string }): Promise<Response> {
  const exchange = await call("/share/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: shared.token }) });
  if (exchange.status !== 200) return exchange;
  return call(`/share/snapshot?g=${shared.grant.id}`, { cookie: cookieFrom(exchange, `__Host-share-${shared.grant.id}`)! });
}
const listed = async (user: User) => (await user.json<{ documents: ShareableDocument[] }>("/api/documents")).documents;
const grants = async (user: User) => (await user.json<{ grants: ShareGrant[] }>("/api/shares")).grants;

describe("cover letters and interview preparation in a copy", () => {
  it("shares their words, fixed, with the job only when asked, and nothing they were checked against", async () => {
    const { user, applicationId, factId } = await owner();
    const letter = await write(user, applicationId, "letter");
    const preparation = await write(user, applicationId, "prep");
    for (const document of [letter, preparation]) expect((await user.fetch(`/api/documents/${document.id}/docx`)).status).toBe(200);
    await write(user, applicationId, "questions");
    expect((await user.send("PATCH", `/api/applications/${applicationId}`, { title: "Staff Engineer", company: "Litware" })).status).toBe(204);

    // The list to choose from: finished letters and preparation, newest first, without their text.
    const choices = await listed(user);
    expect(choices).toEqual([
      { id: preparation.id, kind: "prep", applicationId, version: 1, createdAt: expect.any(Number), shareable: true },
      { id: letter.id, kind: "letter", applicationId, version: 1, createdAt: expect.any(Number), shareable: true },
    ]);
    expect(await listed(await signIn())).toEqual([]);

    const documents = [{ id: letter.id, version: 1 }, { id: preparation.id, version: 1 }];
    const quiet = await share(user, { documents });
    const told = await share(user, { documents, showJobs: true, showName: true, label: "Dana" });
    expect(quiet.grant).toMatchObject({ factCount: 0, resumeCount: 0, documentCount: 2 });

    const response = await read(told);
    expect(response.status, await response.clone().text()).toBe(200);
    const view = (await response.json()) as SharedView;
    const questions = preparation.result!.questions.map((item) => item.question);
    expect(questions.length).toBeGreaterThan(1);
    expect(view.snapshot).toEqual({
      schemaVersion: 3, createdAt: expect.any(Number), owner: null, facts: [], resumes: [],
      documents: [
        { id: letter.id, version: 1, kind: "letter", paragraphs: [FACT], questions: [], job: { title: "Staff Engineer", company: "Litware" } },
        {
          id: preparation.id, version: 1, kind: "prep", paragraphs: [], job: { title: "Staff Engineer", company: "Litware" },
          // The one fact speaks to the first question. The others have nothing prepared.
          questions: questions.map((question, index) => ({ question, points: index === 0 ? [FACT] : [] })),
        },
      ],
    });
    const json = JSON.stringify(view);
    for (const hidden of ['"quote"', '"factIds"', '"evidence"', '"requirement"', '"roleId"', factId, JOB_DESCRIPTION.slice(0, 30), "Dana"])
      expect(json, hidden).not.toContain(hidden);

    // Without being asked, a copy doesn't say which job its documents are for.
    const plain = (await (await read(quiet)).json()) as SharedView;
    expect(plain.snapshot.documents!.map((document) => document.job)).toEqual([null, null]);
    expect(JSON.stringify(plain)).not.toContain("Litware");

    // The copy is fixed: later changes to the fact and the job don't reach it.
    expect((await user.send("PATCH", `/api/facts/${factId}`, { text: "Built a Go service for internal tools" })).status).toBe(204);
    expect((await user.send("PATCH", `/api/applications/${applicationId}`, { title: "Principal Engineer", company: "Contoso" })).status).toBe(204);
    expect(await (await read(told)).json()).toEqual(view);

    // The owner sees what each link holds, and revoking ends it at once.
    expect((await grants(user)).map((grant) => [grant.label, grant.documentCount, grant.available])).toEqual([["Dana", 2, true], [null, 2, true]]);
    expect((await user.send("DELETE", `/api/shares/${told.grant.id}`)).status).toBe(204);
    expect((await read(told)).status).toBe(410);
    expect((await read(quiet)).status).toBe(200);
  });

  it("keeps the full record of each fact with a new letter, and won't share one that has none", async () => {
    const { user, applicationId, factId } = await owner();
    const letter = await write(user, applicationId, "letter");
    const stub = vaultOf(user);
    // What the owner is shown doesn't change: the record is kept for checking, not for display.
    expect(Object.keys(letter)).not.toContain("evidence");
    await runInDurableObject(stub, (_instance, state) => {
      const saved = JSON.parse(state.storage.sql.exec<{ data: string }>(`SELECT data FROM document_versions WHERE document_id = ?`, letter.id).one().data);
      expect(saved.evidence[factId]).toMatchObject({ id: factId, text: FACT, origin: "user", kind: "accomplishment", level: "implemented", quote: null });
    });
    const copy = await share(user, { documents: [{ id: letter.id, version: 1 }] });
    expect((await read(copy)).status).toBe(200);

    // A letter as one was saved before this: the same words, with no record to check them against.
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      const saved = JSON.parse(sql.exec<{ data: string }>(`SELECT data FROM document_versions WHERE document_id = ?`, letter.id).one().data);
      delete saved.evidence;
      sql.exec(`UPDATE document_versions SET data = ? WHERE document_id = ?`, JSON.stringify(saved), letter.id);
    });
    expect(await listed(user)).toMatchObject([{ id: letter.id, shareable: false }]);
    const refused = await user.send("POST", "/api/shares", { factIds: [], resumes: [], documents: [{ id: letter.id, version: 1 }] });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "conflict", message: expect.stringContaining("write it again") });
    // The copy made while it could be checked is closed too, and the owner's list says so.
    expect((await read(copy)).status).toBe(410);
    expect((await grants(user))[0]).toMatchObject({ documentCount: 1, available: false });
    // The owner can still inspect their letter; an unchecked historical version is not exported.
    expect((await user.json<DocumentView>(`/api/documents/${letter.id}`)).result?.units[0]?.text).toBe(FACT);
    expect((await user.fetch(`/api/documents/${letter.id}/docx`)).status).toBe(409);
  });

  it("shares only finished letters and preparation from the person's own vault", async () => {
    const { user, applicationId } = await owner();
    const letter = await write(user, applicationId, "letter");
    const gaps = await write(user, applicationId, "questions");
    const attempt = (documents: unknown, as: User = user) => as.send("POST", "/api/shares", { factIds: [], resumes: [], documents });
    // Gap questions are the person's own to answer, not something to send.
    expect((await attempt([{ id: gaps.id, version: 1 }])).status).toBe(409);
    for (const missing of [[{ id: crypto.randomUUID(), version: 1 }], [{ id: letter.id, version: 2 }]])
      expect((await attempt(missing)).status, JSON.stringify(missing)).toBe(422);
    // Someone else's letter is not in this vault to share.
    expect((await attempt([{ id: letter.id, version: 1 }], await signIn())).status).toBe(422);
    expect((await attempt([{ id: letter.id, version: 1 }, { id: letter.id, version: 1 }])).status).toBe(422);
    for (const malformed of [[{ id: letter.id }], [{ id: 7, version: 1 }], "all", Array.from({ length: 21 }, () => ({ id: letter.id, version: 1 }))])
      expect((await attempt(malformed)).status, JSON.stringify(malformed).slice(0, 40)).toBe(422);
    expect((await attempt([])).status).toBe(422);
    // A letter still being written can't be chosen.
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      state.storage.sql.exec(`UPDATE documents SET state = 'running' WHERE id = ?`, letter.id);
    });
    expect((await attempt([{ id: letter.id, version: 1 }])).status).toBe(422);
    expect(await listed(user)).toEqual([]);
    expect(await grants(user)).toEqual([]);
  });
});

describe("document counts in an existing vault", () => {
  it("adds the count, and a copy made before it holds none", async () => {
    const { user, factId } = await owner();
    const earlier = await share(user, { factIds: [factId] });
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      const sql = state.storage.sql;
      // Rewind this vault to the schema before copies counted documents, as an older vault would be.
      removeShareDocumentMigration(sql);
      const previous = MIGRATIONS.findIndex((migration) => migration.some((statement) => statement.includes("ADD COLUMN document_count")));
      expect(previous).toBeGreaterThan(-1);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      migrate(sql, <T>(fn: () => T) => state.storage.transactionSync(fn));
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(SCHEMA_VERSION));
      expect(sql.exec(`SELECT document_count FROM share_grants`).toArray()).toEqual([{ document_count: 0 }]);
    });
    expect(await grants(user)).toMatchObject([{ id: earlier.grant.id, factCount: 1, documentCount: 0, available: true }]);
    const view = (await (await read(earlier)).json()) as SharedView;
    expect(view.snapshot.schemaVersion).toBe(2);
    expect(view.snapshot).not.toHaveProperty("documents");
  });
});
