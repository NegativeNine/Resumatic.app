import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModels } from "../../src/ai/models";
import type { DocumentView } from "../../src/shared/documents";
import {
  MAX_APP_FIT_STARTS_PER_DAY,
  MCP_FIT_SCOPES,
  MCP_FIT_TEXT,
  type McpClaims,
  type McpFit,
  type McpScope,
} from "../../src/shared/mcp";
import type { Me } from "../../src/shared/api";
import { vault } from "../../src/shared/stubs";
import type { Vault as Instance } from "../../src/vault/vault";
import { fromBase64url } from "../../src/worker/crypto";
import { outwardParts } from "./outward";
import { JOB_DESCRIPTION, eventually, fakeModels, signIn, type FakeModelOptions, type User } from "./support";

// A connected app asks for a fit preview of a saved job: one tool that returns a current preview or
// starts one. These tests drive the Vault's method as the tool's handler does, with the real
// Workflow where a preview has to finish, and a stand-in Workflow binding where a run must stay put.

const GO = "Built a Go service that processes 2 million events per day";
const MENTORED = "Mentored 2 junior engineers";
const DENIED = /connected app|forbidden|wrong account|no such application|invalid request key|request key already used|no longer exists|being deleted/;
/** Workflows are slower while other suites share the machine. */
const WAIT = 60_000;

let options: FakeModelOptions & { calls: NonNullable<FakeModelOptions["calls"]>; inputs: string[] };
beforeEach(() => {
  options = { calls: {}, inputs: [] };
  setModels(() => fakeModels(options));
});
afterEach(() => setModels(null));

const modelCalls = () => Object.values(options.calls).reduce((sum, n) => sum + (n ?? 0), 0);

function sessionOf(user: User) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  return JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { uid: string; vid: string; gen: number; epoch?: string };
}
const vaultOf = (user: User) => vault(env, sessionOf(user).vid);
const whoOf = (user: User) => ({ userId: sessionOf(user).uid, gen: sessionOf(user).gen, epoch: sessionOf(user).epoch });
const sql = <T>(user: User, work: (db: SqlStorage) => T) => runInDurableObject(vaultOf(user), (_instance, state) => work(state.storage.sql));
const fitRuns = (user: User) => sql(user, (db) => db.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE kind = 'fit'`).one().n);

/** A connected app the owner approved with these permissions, as the consent page records one. */
async function connect(user: User, scopes: McpScope[] = [...MCP_FIT_SCOPES]): Promise<McpClaims> {
  const who = whoOf(user);
  const stub = vaultOf(user);
  const grant = await stub.createMcpGrant(who, {
    id: crypto.randomUUID(), clientId: "synthetic-fit-client", clientName: "Fit reader",
    scopes, expiresAt: Date.now() + 10 * 60_000,
  });
  const claims: McpClaims = {
    uid: who.userId, vid: sessionOf(user).vid, gen: grant.gen, epoch: grant.epoch,
    grantId: grant.id, clientId: grant.clientId, scopes: grant.scopes, expiresAt: grant.expiresAt,
  };
  await stub.bindMcpGrant(claims, `synthetic-oauth-${grant.id}`);
  return claims;
}

/** Someone with a role, two confirmed facts and a saved job. */
async function person() {
  const user = await signIn();
  const role = await user.send("POST", "/api/roles", { kind: "job", org: "Acme", title: "Engineer", startDate: "2021", endDate: null });
  expect(role.status).toBe(201);
  const { roleId } = (await role.json()) as { roleId: string };
  const fact = async (text: string, level: string) => {
    const response = await user.send("POST", "/api/facts", { roleId, kind: "accomplishment", text, level });
    expect(response.status).toBe(201);
    return ((await response.json()) as { factId: string }).factId;
  };
  const go = await fact(GO, "implemented");
  const mentored = await fact(MENTORED, "led");
  const applicationId = await job(user);
  return { user, roleId, go, mentored, applicationId, claims: await connect(user) };
}
async function job(user: User, jdText = JOB_DESCRIPTION): Promise<string> {
  const response = await user.send("POST", "/api/applications", { jdText });
  expect(response.status).toBe(201);
  return ((await response.json()) as { applicationId: string }).applicationId;
}

const ask = (user: User, claims: McpClaims, applicationId: string, key: string) =>
  vaultOf(user).mcpFit(claims, applicationId, key) as Promise<McpFit>;
/** Asks again with the same key, as the tool's description says to, until the preview is no longer being prepared. */
const answered = (user: User, claims: McpClaims, applicationId: string, key: string) =>
  eventually(async () => {
    const answer = await ask(user, claims, applicationId, key);
    return answer.state === "preparing" ? null : answer;
  }, "the fit preview to be answered", WAIT);
const ready = (answer: McpFit) => {
  expect(answer.state, JSON.stringify(answer)).toBe("ready");
  return answer as Extract<McpFit, { state: "ready" }>;
};

/** The owner's own fit preview, from Check your fit, finished. */
async function ownPreview(user: User, applicationId: string): Promise<DocumentView> {
  const response = await user.fetch(`/api/applications/${applicationId}/documents`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ kind: "fit" }),
  });
  expect(response.status, await response.clone().text()).toBe(202);
  const { documentId } = (await response.json()) as { documentId: string };
  const made = await eventually(async () => {
    const doc = await user.json<DocumentView>(`/api/documents/${documentId}`);
    return doc.state !== "running" ? doc : null;
  }, "the owner's fit preview", WAIT);
  expect(made.state, made.error ?? "").toBe("ready");
  return made;
}

/** Fit runs written straight into the ledger, as if started earlier: by apps, or by the owner. */
function seedRuns(db: SqlStorage, count: number, createdAt: number, by: "app" | "owner"): void {
  for (let i = 0; i < count; i++) {
    const id = crypto.randomUUID();
    const key = by === "app" ? `document:mcp_${crypto.randomUUID()}_${crypto.randomUUID()}` : `document:${crypto.randomUUID()}`;
    db.exec(
      `INSERT INTO runs (id, kind, target_id, request_key, input_digest, state, steps, credit_state, created_at, updated_at)
       VALUES (?, 'fit', ?, ?, 'seeded', 'succeeded', '[]', 'none', ?, ?)`,
      id, id, key, createdAt, createdAt,
    );
  }
}

describe("a connected app's fit preview, made by the real Workflow", () => {
  it("starts one run, however often the request is retried or another key asks", async () => {
    let release!: () => void;
    options.hold = new Promise<void>((resolve) => { release = resolve; });
    const { user, claims, applicationId } = await person();
    const key = crypto.randomUUID();
    try {
      expect(await ask(user, claims, applicationId, key)).toEqual({ state: "preparing", applicationId, message: MCP_FIT_TEXT.preparing });
      for (let i = 0; i < 3; i++) expect((await ask(user, claims, applicationId, key)).state).toBe("preparing");
      // Another key, from this app or another, waits for the same run.
      const other = await connect(user);
      expect((await ask(user, claims, applicationId, crypto.randomUUID())).state).toBe("preparing");
      expect((await ask(user, other, applicationId, crypto.randomUUID())).state).toBe("preparing");
      expect(await fitRuns(user)).toBe(1);
    } finally {
      release();
    }
    const first = ready(await answered(user, claims, applicationId, key));
    // Once it is ready, any key is given it as it is.
    expect(ready(await ask(user, claims, applicationId, crypto.randomUUID()))).toEqual(first);
    expect(await fitRuns(user)).toBe(1);
    expect(await sql(user, (db) => db.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM documents`).one().n)).toBe(1);
  }, 120_000);

  it("answers ready after the real Workflow with quota untouched, also when the month's outputs are used up", async () => {
    const { user, claims, applicationId, go, mentored } = await person();
    await user.json<Me>("/api/me");
    await sql(user, (db) => void db.exec(`UPDATE quota_buckets SET used = allowance`));
    const before = (await user.json<Me>("/api/me")).quota;
    expect(before.used).toBe(before.limit);
    const key = crypto.randomUUID();
    expect((await ask(user, claims, applicationId, key)).state).toBe("preparing");
    const answer = ready(await answered(user, claims, applicationId, key));
    expect(Object.keys(answer).sort()).toEqual(["applicationId", "checkedAt", "note", "requirements", "state"]);
    expect(answer.note).toBe(MCP_FIT_TEXT.note);
    expect(answer.applicationId).toBe(applicationId);
    const go_ = answer.requirements.find((requirement) => /Go/.test(requirement.text));
    expect(go_?.facts).toEqual([{ id: go, text: GO }]);
    expect(answer.requirements.find((requirement) => /Mentoring/.test(requirement.text))?.facts).toEqual([{ id: mentored, text: MENTORED }]);
    // Nothing matched is said as nothing beside it, never as a count or a score.
    expect(answer.requirements.find((requirement) => /Rust/.test(requirement.text))?.facts).toEqual([]);
    for (const requirement of answer.requirements) {
      expect(Object.keys(requirement).sort()).toEqual(["facts", "text"]);
      for (const fact of requirement.facts) expect(Object.keys(fact).sort()).toEqual(["id", "text"]);
    }
    expect((await user.json<Me>("/api/me")).quota).toMatchObject({ used: before.used, reserved: 0 });
    // The owner sees it among the job's documents like any other.
    const { documents } = await user.json<{ documents: DocumentView[] }>(`/api/applications/${applicationId}/documents`);
    expect(documents.map((doc) => [doc.kind, doc.state, doc.createdAt])).toEqual([["fit", "ready", answer.checkedAt]]);
  }, 120_000);

  it("gives an app the owner's own current preview without a run or a model call", async () => {
    const { user, claims, applicationId, go } = await person();
    const own = await ownPreview(user, applicationId);
    const runs = await fitRuns(user);
    options.calls = {};
    const answer = ready(await ask(user, claims, applicationId, crypto.randomUUID()));
    expect(answer.checkedAt).toBe(own.createdAt);
    expect(answer.requirements.map((requirement) => requirement.text)).toEqual(own.result!.fit!.requirements.map((requirement) => requirement.text));
    expect(answer.requirements.flatMap((requirement) => requirement.facts.map((fact) => fact.id))).toContain(go);
    expect(await fitRuns(user)).toBe(runs);
    expect(modelCalls()).toBe(0);
  }, 120_000);

  it("is not reused after a fact is edited, rejected or added, a role is rejected, or the posting changes", async () => {
    const { user, claims, applicationId, go, mentored, roleId } = await person();
    const changes: [string, () => Promise<Response>][] = [
      ["a fact is edited", () => user.send("PATCH", `/api/facts/${go}`, { text: "Built a Go service for internal tools" })],
      ["a fact is rejected", () => user.send("POST", "/api/review", { confirm: [], reject: [mentored] })],
      ["a fact is added", () => user.send("POST", "/api/facts", { roleId, kind: "accomplishment", text: "Designed internal APIs used by 3 teams", level: "led" })],
      ["a role is rejected", () => user.send("POST", "/api/review", { confirm: [], reject: [roleId] })],
      ["the posting changes", () => user.send("PATCH", `/api/applications/${applicationId}`, { jdText: `${JOB_DESCRIPTION}\nKubernetes on-call is shared.` })],
    ];
    let key = crypto.randomUUID();
    ready(await (await ask(user, claims, applicationId, key), answered(user, claims, applicationId, key)));
    for (const [change, make] of changes) {
      const response = await make();
      expect(response.status, `${change}: ${await response.clone().text()}`).toBeLessThan(300);
      const runs = await fitRuns(user);
      // The key whose preview is outdated says so, and starts nothing.
      expect(await ask(user, claims, applicationId, key), change).toEqual({ state: "changed", applicationId, message: MCP_FIT_TEXT.changed });
      expect(await fitRuns(user), change).toBe(runs);
      // A new key measures again.
      key = crypto.randomUUID();
      expect((await ask(user, claims, applicationId, key)).state, change).toBe("preparing");
      expect(await fitRuns(user), change).toBe(runs + 1);
      ready(await answered(user, claims, applicationId, key));
    }
  }, 240_000);

  it("stays current when the job's notes, status or title change", async () => {
    const { user, claims, applicationId } = await person();
    const key = crypto.randomUUID();
    await ask(user, claims, applicationId, key);
    const first = ready(await answered(user, claims, applicationId, key));
    for (const patch of [{ notes: "Recruiter: Dana. Private." }, { status: "applied" }, { title: "Staff Platform Engineer" }]) {
      expect((await user.send("PATCH", `/api/applications/${applicationId}`, patch)).status).toBe(204);
      expect(await ask(user, claims, applicationId, key), JSON.stringify(patch)).toEqual(first);
      expect(await ask(user, claims, applicationId, crypto.randomUUID())).toEqual(first);
    }
    expect(JSON.stringify(first)).not.toContain("Dana");
    expect(await fitRuns(user)).toBe(1);
  }, 120_000);

  it("says busy while a resume is tailored, and starts nothing", async () => {
    let release!: () => void;
    options.hold = new Promise<void>((resolve) => { release = resolve; });
    const { user, claims, applicationId } = await person();
    const started = await user.send("POST", `/api/applications/${applicationId}/resumes`);
    expect(started.status).toBe(202);
    const { resumeId } = (await started.json()) as { resumeId: string };
    try {
      const key = crypto.randomUUID();
      expect(await ask(user, claims, applicationId, key)).toEqual({ state: "busy", applicationId, message: MCP_FIT_TEXT.busy });
      expect(await ask(user, claims, applicationId, key)).toEqual({ state: "busy", applicationId, message: MCP_FIT_TEXT.busy });
      expect(await fitRuns(user)).toBe(0);
      expect(await sql(user, (db) => db.exec(`SELECT id FROM documents`).toArray())).toHaveLength(0);
    } finally {
      release();
    }
    await eventually(async () => (await user.json<{ state: string }>(`/api/resumes/${resumeId}`)).state !== "running", "the resume", WAIT);
  }, 120_000);

  it("doesn't reuse a preview without captured inputs, as in a moved vault, or with a null incarnation", async () => {
    const { user, claims, applicationId } = await person();
    const own = await ownPreview(user, applicationId);
    ready(await ask(user, claims, applicationId, crypto.randomUUID()));
    await sql(user, (db) => void db.exec(`UPDATE generation_input_items SET incarnation = NULL WHERE run_id = ?`, own.id));
    const key = crypto.randomUUID();
    expect((await ask(user, claims, applicationId, key)).state).toBe("preparing");
    const measured = ready(await answered(user, claims, applicationId, key));
    expect(measured.checkedAt).not.toBe(own.createdAt);
    // A moved vault brings its documents, not their runs or what those captured.
    const latest = await sql(user, (db) => db.exec<{ id: string }>(`SELECT id FROM documents WHERE kind = 'fit' ORDER BY created_at DESC LIMIT 1`).one().id);
    await sql(user, (db) => {
      db.exec(`DELETE FROM generation_input_items WHERE run_id = ?`, latest);
      db.exec(`DELETE FROM generation_inputs WHERE run_id = ?`, latest);
    });
    expect((await ask(user, claims, applicationId, key)).state).toBe("changed");
    expect((await ask(user, claims, applicationId, crypto.randomUUID())).state).toBe("preparing");
    expect(await fitRuns(user)).toBe(3);
  }, 120_000);

  it("never answers with a fact marked sensitive, and retires a preview that captured it until the mark is removed", async () => {
    const { user, claims, applicationId, go, mentored } = await person();
    const key = crypto.randomUUID();
    await ask(user, claims, applicationId, key);
    const before = ready(await answered(user, claims, applicationId, key));
    expect(before.requirements.find((requirement) => /Mentoring/.test(requirement.text))?.facts).toEqual([{ id: mentored, text: MENTORED }]);
    expect((await user.send("POST", "/api/facts/sensitive", { ids: [mentored], sensitive: true })).status).toBe(204);
    options.inputs.length = 0;
    // The preview that measured it is no longer given, and its key says so.
    expect(await ask(user, claims, applicationId, key)).toEqual({ state: "changed", applicationId, message: MCP_FIT_TEXT.changed });
    const fresh = crypto.randomUUID();
    expect((await ask(user, claims, applicationId, fresh)).state).toBe("preparing");
    const without = ready(await answered(user, claims, applicationId, fresh));
    for (const said of [JSON.stringify(without), options.inputs.join("\n")]) {
      expect(said).not.toContain(MENTORED);
      expect(said).not.toContain(mentored);
    }
    expect(options.inputs.length).toBeGreaterThan(0);
    expect(without.requirements.find((requirement) => /Mentoring/.test(requirement.text))?.facts).toEqual([]);
    expect(without.requirements.flatMap((requirement) => requirement.facts.map((fact) => fact.id))).toContain(go);
    // Unmarked, the first preview is current again and is given as it was, measured by no one.
    expect((await user.send("POST", "/api/facts/sensitive", { ids: [mentored], sensitive: false })).status).toBe(204);
    const runs = await fitRuns(user);
    options.calls = {};
    expect(await ask(user, claims, applicationId, key)).toEqual(before);
    expect(await ask(user, claims, applicationId, crypto.randomUUID())).toEqual(before);
    // And the one made while it was marked is not, because it measured fewer facts than there are.
    expect(await ask(user, claims, applicationId, fresh)).toEqual(before);
    expect(await fitRuns(user)).toBe(runs);
    expect(modelCalls()).toBe(0);
  }, 180_000);

  it("leaves list_jobs as it was, and a job with nothing matched listed and tailorable", async () => {
    const { user, claims, applicationId } = await person();
    const key = crypto.randomUUID();
    await ask(user, claims, applicationId, key);
    ready(await answered(user, claims, applicationId, key));
    // The job a posting with nothing the person has written down.
    options.analysis = { company: "Fabrikam", title: "Systems Engineer", requirements: ["Rust systems programming", "Embedded firmware"] };
    const unmatched = await job(user, "Systems Engineer at Fabrikam. Write Rust systems code and embedded firmware for our devices.");
    const other = crypto.randomUUID();
    await ask(user, claims, unmatched, other);
    const gaps = ready(await answered(user, claims, unmatched, other));
    expect(gaps.requirements.length).toBeGreaterThan(0);
    for (const requirement of gaps.requirements) expect(requirement.facts).toEqual([]);
    const listed = (await vaultOf(user).mcpJobs(claims, { limit: 100 })) as Record<string, unknown>[];
    // Newest first, as always: no fit, no order by it, and every job listed.
    expect(listed.map((entry) => entry.id)).toEqual([unmatched, applicationId]);
    for (const entry of listed) expect(Object.keys(entry).sort()).toEqual(["addedAt", "company", "excerpt", "id", "resumes", "status", "title", "url"]);
    ready(await ask(user, claims, unmatched, crypto.randomUUID()));
    expect(await vaultOf(user).mcpJobs(claims, { limit: 100 })).toEqual(listed);
    // Nothing matched doesn't stop an app from tailoring for the job.
    const started = (await vaultOf(user).mcpTailor(claims, unmatched, crypto.randomUUID())) as { resumeId: string };
    expect(started.resumeId).toBeTruthy();
    await eventually(async () => (await user.json<{ state: string }>(`/api/resumes/${started.resumeId}`)).state !== "running", "the resume", WAIT);
  }, 180_000);

  it("isn't offered for a copy, which refuses it, and is in the export with its run", async () => {
    const { user, claims, applicationId } = await person();
    const key = crypto.randomUUID();
    await ask(user, claims, applicationId, key);
    ready(await answered(user, claims, applicationId, key));
    const { id } = await sql(user, (db) => db.exec<{ id: string }>(`SELECT id FROM documents WHERE kind = 'fit'`).one());
    const { documents } = await user.json<{ documents: { id: string }[] }>("/api/documents");
    expect(documents.map((doc) => doc.id)).not.toContain(id);
    const copy = await user.send("POST", "/api/shares", { factIds: [], resumes: [], documents: [{ id, version: 1 }] });
    expect(copy.status).toBe(409);
    const exported = await user.json<{ documents: { id: string; kind: string }[]; runs: { id: string; request_key: string }[] }>("/api/export");
    expect(exported.documents.find((doc) => doc.id === id)?.kind).toBe("fit");
    expect(exported.runs.find((run) => run.id === id)?.request_key).toBe(`document:mcp_${claims.grantId}_${key}`);
  }, 120_000);
});

describe("what a vault sends outward", () => {
  it("includes each saved job's fit preview, and what a preview the app started sent to a model", async () => {
    const { user } = await person();
    options.inputs.length = 0;
    const parts = await outwardParts({ owner: user, copies: [], inputs: options.inputs });
    const previews = parts.filter((part) => part.surface === "preview_fit");
    expect(previews).toHaveLength(1);
    const answer = ready(JSON.parse(previews[0]!.text) as McpFit);
    expect(JSON.stringify(answer)).toContain(GO);
    expect(parts.filter((part) => part.surface === "model input").map((part) => part.text).join("\n")).toContain(GO);
  }, 120_000);

  it("refuses a current preview it can't read, starts nothing beside it, and gathers nothing from it at once", async () => {
    const { user, claims, applicationId } = await person();
    const own = await ownPreview(user, applicationId);
    // Still current, but its stored result is not a fit preview's.
    await sql(user, (db) => void db.exec(`UPDATE document_versions SET data = ? WHERE document_id = ?`, JSON.stringify({ result: { kind: "letter" } }), own.id));
    const runs = await fitRuns(user);
    options.calls = {};
    await runInDurableObject(vaultOf(user), (instance) =>
      expect(instance.mcpFit(claims, applicationId, crypto.randomUUID())).rejects.toThrow("This fit preview can't be read"));
    expect(await fitRuns(user)).toBe(runs);
    expect(modelCalls()).toBe(0);
    // A refusal is gathered as nothing, and is not asked again as if it were still being prepared.
    const started = Date.now();
    const parts = await outwardParts({ owner: user, copies: [], inputs: [] });
    expect(parts.filter((part) => part.surface === "preview_fit")).toEqual([]);
    expect(parts.some((part) => part.surface === "list_jobs")).toBe(true);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 120_000);
});

describe("a day's fit previews started by apps", () => {
  it("answers limit at the twenty-first, starting no run and calling no model; yesterday's and the owner's own aren't counted", async () => {
    expect(MAX_APP_FIT_STARTS_PER_DAY).toBe(20);
    const { user, claims, applicationId } = await person();
    const midnight = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    await sql(user, (db) => {
      seedRuns(db, 20, midnight, "app");
      seedRuns(db, 5, midnight - 1, "app");
      seedRuns(db, 5, Date.now(), "owner");
    });
    const runs = await fitRuns(user);
    options.calls = {};
    const key = crypto.randomUUID();
    expect(await ask(user, claims, applicationId, key)).toEqual({ state: "limit", applicationId, message: MCP_FIT_TEXT.limit });
    expect(await ask(user, claims, applicationId, crypto.randomUUID())).toEqual({ state: "limit", applicationId, message: MCP_FIT_TEXT.limit });
    expect(await fitRuns(user)).toBe(runs);
    expect(await sql(user, (db) => db.exec(`SELECT id FROM documents`).toArray())).toHaveLength(0);
    expect(modelCalls()).toBe(0);
    // One fewer today and the same key starts one: the thirty other runs were never counted.
    await sql(user, (db) => void db.exec(`DELETE FROM runs WHERE id = (SELECT id FROM runs WHERE request_key GLOB 'document:mcp_*' AND created_at = ? LIMIT 1)`, midnight));
    expect((await ask(user, claims, applicationId, key)).state).toBe("preparing");
    ready(await answered(user, claims, applicationId, key));
    // That was the twentieth today.
    await user.send("PATCH", `/api/applications/${applicationId}`, { jdText: `${JOB_DESCRIPTION}\nKubernetes on-call is shared.` });
    expect((await ask(user, claims, applicationId, crypto.randomUUID())).state).toBe("limit");
  }, 120_000);

  it("still lets the owner check fit at the cap, and still gives an app a current preview", async () => {
    const { user, claims, applicationId } = await person();
    await sql(user, (db) => seedRuns(db, MAX_APP_FIT_STARTS_PER_DAY, Date.now(), "app"));
    expect((await ask(user, claims, applicationId, crypto.randomUUID())).state).toBe("limit");
    const own = await ownPreview(user, applicationId);
    expect(ready(await ask(user, claims, applicationId, crypto.randomUUID())).checkedAt).toBe(own.createdAt);
  }, 120_000);
});

/** A vault with a saved job, and a stand-in Workflow binding, so a run stays where a test puts it. */
async function held(scopes: McpScope[] = [...MCP_FIT_SCOPES]) {
  const id = env.VAULT.newUniqueId().toString();
  const stub = vault(env, id);
  const who = { userId: crypto.randomUUID(), gen: 1 };
  await stub.init(who.userId);
  const grant = await stub.createMcpGrant(who, {
    id: crypto.randomUUID(), clientId: "synthetic-client", clientName: "Synthetic client",
    scopes, expiresAt: Date.now() + 10 * 60_000,
  });
  const claims: McpClaims = {
    uid: who.userId, vid: id, gen: grant.gen, epoch: grant.epoch,
    grantId: grant.id, clientId: grant.clientId, scopes: grant.scopes, expiresAt: grant.expiresAt,
  };
  await stub.bindMcpGrant(claims, "synthetic-oauth-grant");
  return { stub, who, claims };
}
type Held = Awaited<ReturnType<typeof held>>;

/** Runs `work` with the documents Workflow replaced: created runs stay running, and their status reads as `status`. */
async function withHeldWorkflow<T>(f: Held, work: (instance: Instance, db: SqlStorage, create: ReturnType<typeof vi.fn>) => Promise<T>, status = "errored"): Promise<T> {
  return runInDurableObject(f.stub, async (instance, state) => {
    const local = (instance as unknown as { env: Env }).env;
    const previous = local.DOCUMENTS;
    const create = vi.fn(async () => ({}));
    local.DOCUMENTS = {
      create,
      async get() { return { async status() { return { status }; }, async terminate() {} }; },
    } as unknown as Workflow;
    try {
      return await work(instance, state.storage.sql, create);
    } finally {
      local.DOCUMENTS = previous;
    }
  });
}
const JOB = "An engineering job description with enough detail for a new application.";
const runCount = (db: SqlStorage) => db.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE kind = 'fit'`).one().n;
const latestFit = (db: SqlStorage) => db.exec<{ id: string }>(`SELECT id FROM documents WHERE kind = 'fit' ORDER BY created_at DESC, id LIMIT 1`).one().id;

describe("a fit preview that stops", () => {
  it("says failed after a stop, a cancel and a usage limit, and never starts again by asking again", async () => {
    const f = await held();
    await withHeldWorkflow(f, async (instance, db, create) => {
      const { applicationId } = await instance.addApplication(f.who, JOB);
      const fit = (key: string) => instance.mcpFit(f.claims, applicationId, key);
      const stopped: [string, (runId: string) => Promise<void>, string][] = [
        ["a stop", async () => { await instance.alarm(); }, MCP_FIT_TEXT.failed],
        ["a cancel", async (runId) => { await instance.cancelRun(f.who, runId); await instance.alarm(); }, MCP_FIT_TEXT.failed],
        ["a usage limit", (runId) => instance.failDocument(runId, "quota"), MCP_FIT_TEXT.stopped],
      ];
      for (const [how, stop, message] of stopped) {
        const key = crypto.randomUUID();
        expect((await fit(key)).state, how).toBe("preparing");
        const runId = latestFit(db);
        await stop(runId);
        expect(db.exec<{ state: string }>(`SELECT state FROM documents WHERE id = ?`, runId).one().state, how).toBe("failed");
        const runs = runCount(db);
        for (let i = 0; i < 3; i++) expect(await fit(key), how).toEqual({ state: "failed", applicationId, message });
        expect(runCount(db), how).toBe(runs);
      }
      expect(create).toHaveBeenCalledTimes(3);
    });
  });
});

describe("who may ask for a fit preview", () => {
  const scopeCases: [string, McpScope[], McpScope[] | null][] = [
    ["read and jobs", ["vault:read", "vault:jobs"], null],
    ["read and generation", ["vault:read", "vault:generate"], null],
    ["claims with jobs and generation but not read", [...MCP_FIT_SCOPES], ["vault:jobs", "vault:generate"]],
    ["forged claims that add generation", ["vault:read", "vault:jobs"], [...MCP_FIT_SCOPES]],
    ["forged claims that add jobs", ["vault:read", "vault:generate"], [...MCP_FIT_SCOPES]],
  ];
  it.each(scopeCases)("needs read, jobs and generation together: refuses %s", async (_name, granted, claimed) => {
    const f = await held(granted);
    await withHeldWorkflow(f, async (instance, db, create) => {
      const { applicationId } = await instance.addApplication(f.who, JOB);
      const claims = claimed ? { ...f.claims, scopes: claimed } : f.claims;
      await expect(instance.mcpFit(claims, applicationId, crypto.randomUUID())).rejects.toThrow(/connected app permission is required|forbidden/);
      expect(runCount(db)).toBe(0);
      expect(create).not.toHaveBeenCalled();
    });
  });

  it("refuses an unknown job, a malformed key, a key reused for another job, another account's vault and a closing account", async () => {
    const f = await held();
    const stranger = await held();
    await withHeldWorkflow(f, async (instance, db) => {
      const { applicationId } = await instance.addApplication(f.who, JOB);
      const { applicationId: second } = await instance.addApplication(f.who, `${JOB} A second opening.`);
      await expect(instance.mcpFit(f.claims, crypto.randomUUID(), crypto.randomUUID())).rejects.toThrow("no such application");
      for (const key of ["", "has space", "x".repeat(70), "slash/key", "dots.key"])
        await expect(instance.mcpFit(f.claims, applicationId, key), key).rejects.toThrow("invalid request key");
      expect(runCount(db)).toBe(0);
      const key = crypto.randomUUID();
      expect((await instance.mcpFit(f.claims, applicationId, key)).state).toBe("preparing");
      await expect(instance.mcpFit(f.claims, second, key)).rejects.toThrow("request key already used");
      // Another account's claims name another vault, and are refused here whatever they say.
      await expect(instance.mcpFit(stranger.claims, applicationId, crypto.randomUUID())).rejects.toThrow("wrong account");
      await expect(instance.mcpFit({ ...stranger.claims, vid: f.claims.vid }, applicationId, crypto.randomUUID())).rejects.toThrow();
      expect(runCount(db)).toBe(1);
      db.exec(`UPDATE meta SET value = 'closing' WHERE key = 'state'`);
      try {
        await expect(instance.mcpFit(f.claims, applicationId, key)).rejects.toThrow("being deleted");
        await expect(instance.mcpFit(f.claims, second, crypto.randomUUID())).rejects.toThrow("being deleted");
      } finally {
        db.exec(`UPDATE meta SET value = 'open' WHERE key = 'state'`);
      }
      expect(runCount(db)).toBe(1);
    });
  });
});

describe("a fit preview when the app's access ends", () => {
  /**
   * Holds the named step open, revokes the grant while it waits, then lets it go on, and checks
   * what was left behind with `after`.
   */
  async function revokedDuring(
    step: "documentDigest" | "dispatchRun" | "rearmPendingRuns",
    after: (db: SqlStorage, create: ReturnType<typeof vi.fn>, runsBefore: number) => void,
    before?: (instance: Instance, who: Held["who"], applicationId: string) => Promise<void>,
  ): Promise<void> {
    const f = await held();
    await withHeldWorkflow(f, async (instance, db, create) => {
      const { applicationId } = await instance.addApplication(f.who, JOB);
      await before?.(instance, f.who, applicationId);
      const runsBefore = runCount(db);
      let entered!: () => void, release!: () => void;
      const paused = new Promise<void>((resolve) => { entered = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const local = instance as unknown as Record<typeof step, (...args: unknown[]) => Promise<unknown>>;
      const original = local[step].bind(instance);
      const spy = vi.spyOn(local, step).mockImplementation(async (...args: unknown[]) => { entered(); await hold; return original(...args); });
      let running: Promise<unknown> | undefined;
      try {
        running = instance.mcpFit(f.claims, applicationId, crypto.randomUUID());
        await paused;
        await instance.revokeMcpGrant(f.who, f.claims.grantId);
        release();
        await expect(running).rejects.toThrow("connected app access is no longer valid");
      } finally {
        release();
        await running?.catch(() => {});
        spy.mockRestore();
      }
      after(db, create, runsBefore);
    });
  }

  it("is refused at once when access was revoked before it asked", async () => {
    const f = await held();
    await withHeldWorkflow(f, async (instance, db, create) => {
      const { applicationId } = await instance.addApplication(f.who, JOB);
      await instance.revokeMcpGrant(f.who, f.claims.grantId);
      await expect(instance.mcpFit(f.claims, applicationId, crypto.randomUUID())).rejects.toThrow("connected app access is no longer valid");
      expect(runCount(db)).toBe(0);
      expect(create).not.toHaveBeenCalled();
    });
  });

  it("starts nothing when access ends while the request is digested", async () => {
    await revokedDuring("documentDigest", (db, create) => {
      expect(runCount(db)).toBe(0);
      expect(db.exec(`SELECT id FROM documents`).toArray()).toHaveLength(0);
      expect(create).not.toHaveBeenCalled();
    });
  });

  it("answers nothing when access ends while the run is dispatched; the owner keeps the run", async () => {
    await revokedDuring("dispatchRun", (db, _create, runsBefore) => {
      expect(runCount(db)).toBe(runsBefore + 1);
      expect(db.exec<{ state: string }>(`SELECT state FROM documents WHERE kind = 'fit'`).one().state).toBe("running");
    });
  });

  it("answers nothing when access ends while a run under way is rearmed", async () => {
    await revokedDuring(
      "rearmPendingRuns",
      (db, _create, runsBefore) => {
        expect(runsBefore).toBe(1);
        expect(runCount(db)).toBe(1);
      },
      // The owner's own preview of the job is under way.
      async (instance, who, applicationId) => { await instance.startDocument(who, applicationId, { kind: "fit" }, crypto.randomUUID()); },
    );
  });
});
