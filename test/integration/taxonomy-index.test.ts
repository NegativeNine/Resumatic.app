import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModels } from "../../src/ai/models";
import type { Directory } from "../../src/directory/directory";
import { DIRECTORY_MIGRATIONS, migrateDirectory } from "../../src/directory/schema";
import { INVITE_GLOBAL_ORPHAN_MIGRATIONS } from "../../src/directory/invite-revocation";
import { OPERATOR_SPEND_MIGRATIONS } from "../../src/directory/operator-spend";
import { TAG_KINDS } from "../../src/pipeline/tag";
import { directory, directoryByName } from "../../src/shared/stubs";
import { readManifest, type VectorIndex } from "../../src/taxonomy";
import { app } from "../../src/worker/routes";
import { fixtureIndex } from "../evals/tagging";
import { MemoryVectorIndex, standInEmbed } from "../support/fake-vectorize";
import { nowSeconds, rsaSigner } from "../support/keys";
import { TAXONOMY_FIXTURE, TAXONOMY_FIXTURE_SQL } from "../support/taxonomy-fixture";
import { eventually, fakeModels, signIn } from "./support";

// The operator's routes for the taxonomy's vector index, behind Cloudflare Access, and the build
// itself run as a Workflow over the made-up taxonomy and an index in memory.

const VERSION = TAXONOMY_FIXTURE.info.version;
const FIRST = `taxonomy-index-${TAXONOMY_FIXTURE.info.contentHash.slice(0, 8)}-1`;
const SECOND = `taxonomy-index-${TAXONOMY_FIXTURE.info.contentHash.slice(0, 8)}-2`;
const CONCEPTS = TAXONOMY_FIXTURE.concepts.filter((concept) => (TAG_KINDS as readonly string[]).includes(concept.kind)).length;

const settings = env as unknown as { TAG_SHADOW_ENABLED?: string; TAXONOMY?: D1Database; TAXONOMY_VECTORS?: VectorIndex; TAXONOMY_INDEX: Workflow };
const AS_CONFIGURED = { tag: settings.TAG_SHADOW_ENABLED, taxonomy: settings.TAXONOMY!, vectors: settings.TAXONOMY_VECTORS, workflow: settings.TAXONOMY_INDEX };

async function load(statements: readonly string[] = TAXONOMY_FIXTURE_SQL): Promise<void> {
  const db = AS_CONFIGURED.taxonomy;
  for (const table of ["taxonomy_meta", "concepts", "labels", "relations"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  for (const statement of statements) await db.prepare(statement).run();
}

beforeEach(async () => {
  await load();
  settings.TAG_SHADOW_ENABLED = "true";
  settings.TAXONOMY_VECTORS = new MemoryVectorIndex();
});
afterEach(() => {
  setModels(null);
  settings.TAG_SHADOW_ENABLED = AS_CONFIGURED.tag;
  settings.TAXONOMY = AS_CONFIGURED.taxonomy;
  settings.TAXONOMY_VECTORS = AS_CONFIGURED.vectors;
  settings.TAXONOMY_INDEX = AS_CONFIGURED.workflow;
  vi.unstubAllGlobals();
});

/** A request to the admin routes, through the app as the Worker serves it, with a valid Access token unless told otherwise. */
async function admin(path: string, init: RequestInit = {}, access = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (access) {
    const signer = await rsaSigner();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`) return Response.json(signer.jwks);
      return new Response("unexpected fetch in test", { status: 599 });
    });
    headers.set("cf-access-jwt-assertion", await signer.sign({ iss: env.ACCESS_TEAM_DOMAIN, aud: [env.ACCESS_AUD], email: "operator@example.com", exp: nowSeconds() + 600 }));
  }
  return app.fetch(new Request(`https://resumatic.test/admin${path}`, { ...init, headers }), env);
}
const build = (version: string = VERSION, access = true) =>
  admin("/taxonomy/vectors/build", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taxonomyVersion: version }) }, access);

/** A stand-in for the Workflow binding: each ID's status, or missing, and what was created. */
function instances(statuses: Record<string, string>, options: { createFails?: boolean } = {}) {
  const created: { id: string; params: unknown }[] = [];
  const binding = {
    async get(id: string) {
      const status = statuses[id];
      if (!status) throw new Error("instance.not_found");
      return { id, status: async () => ({ status }) };
    },
    async create({ id, params }: { id: string; params: unknown }) {
      if (options.createFails) {
        // Another request took the ID between the look and the start.
        statuses[id] = "queued";
        throw new Error("instance.already_exists");
      }
      created.push({ id, params });
      statuses[id] = "queued";
      return { id };
    },
  };
  settings.TAXONOMY_INDEX = binding as unknown as Workflow;
  return { created };
}

describe("the taxonomy vector index routes", () => {
  it("refuses without Access", async () => {
    const { created } = instances({});
    expect((await build(VERSION, false)).status).toBe(403);
    expect((await admin("/taxonomy/vectors", {}, false)).status).toBe(403);
    expect((await admin(`/taxonomy/vectors/build/${FIRST}`, {}, false)).status).toBe(403);
    expect((await admin(`/taxonomy/vectors/build/${FIRST}`, { method: "DELETE" }, false)).status).toBe(403);
    // A token that is not Access's is no token, and a person's session is not one either.
    expect((await admin("/taxonomy/vectors/build", { method: "POST", headers: { "cf-access-jwt-assertion": "nope" } }, false)).status).toBe(403);
    const user = await signIn();
    expect((await user.send("POST", "/admin/taxonomy/vectors/build", { taxonomyVersion: VERSION })).status).toBe(403);
    expect(created).toEqual([]);
  });

  it("answers 503 without the switch or either binding", async () => {
    const { created } = instances({});
    for (const [what, change] of [
      ["switch off", () => (settings.TAG_SHADOW_ENABLED = undefined)],
      ["no taxonomy", () => (settings.TAXONOMY = undefined)],
      ["no index", () => (settings.TAXONOMY_VECTORS = undefined)],
    ] as const) {
      settings.TAG_SHADOW_ENABLED = "true";
      settings.TAXONOMY = AS_CONFIGURED.taxonomy;
      settings.TAXONOMY_VECTORS = new MemoryVectorIndex();
      change();
      const response = await build();
      expect(response.status, what).toBe(503);
      expect(await response.json(), what).toEqual({ error: "unavailable", message: "the taxonomy vector index is not configured" });
      expect(await (await admin("/taxonomy/vectors")).json(), what).toEqual({ configured: false, taxonomyVersion: null, manifest: null, ready: false, done: 0 });
    }
    expect(created).toEqual([]);
    // A body that is not a version is refused before anything is read.
    const odd = await admin("/taxonomy/vectors/build", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taxonomyVersion: "../x", more: 1 }) });
    expect(odd.status).toBe(422);
  });

  it("answers 503 for a partly loaded taxonomy and starts nothing", async () => {
    const { created } = instances({});
    await load(TAXONOMY_FIXTURE_SQL.slice(0, -1));
    const response = await build();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable", message: "the taxonomy is not loaded" });
    expect(created).toEqual([]);
  });

  it("answers 409 for another version", async () => {
    const { created } = instances({});
    const response = await build("esco-0.0.1+onet-0.0+00000000");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict", message: "the bound taxonomy is another version" });
    // An index that holds another build is refused too: a new index is made for a new version.
    const other = await fixtureIndex();
    await other.upsert([{ id: "manifest", values: other.vectors.get("manifest")!.values, metadata: { ...other.vectors.get("manifest")!.metadata, model: "@cf/baai/bge-m3" } }]);
    settings.TAXONOMY_VECTORS = other;
    const held = await build();
    expect(held.status).toBe(409);
    expect(await held.json()).toEqual({ error: "conflict", message: "this index holds another build; create a new index for this version" });
    expect(created).toEqual([]);
  });

  it("answers complete without starting a run", async () => {
    const { created } = instances({});
    settings.TAXONOMY_VECTORS = await fixtureIndex();
    const response = await build();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "complete" });
    expect(created).toEqual([]);
  });

  it("refuses a second start while one is queued, running, waiting or paused", async () => {
    for (const status of ["queued", "running", "waiting", "paused", "waitingForPause", "unknown"]) {
      const { created } = instances({ [FIRST]: status });
      const response = await build();
      expect(response.status, status).toBe(409);
      expect(await response.json(), status).toEqual({ error: "conflict", message: "a build of this index is already running" });
      expect(created, status).toEqual([]);
    }
    // Two starts at once: the platform refuses the second instance under the same ID.
    const { created } = instances({}, { createFails: true });
    const raced = await build();
    expect(raced.status).toBe(409);
    expect(await raced.json()).toEqual({ error: "conflict", message: "a build of this index is already running" });
    expect(created).toEqual([]);
  });

  it("refuses a start while a later attempt is live, though an earlier one was deleted", async () => {
    // The first attempt finished and was deleted, by the operator or the platform's retention,
    // while the second is still at work: its free ID starts no second build beside it.
    const hash = TAXONOMY_FIXTURE.info.contentHash.slice(0, 8);
    for (const status of ["queued", "running", "waiting", "paused", "waitingForPause", "unknown"]) {
      const { created } = instances({ [SECOND]: status });
      const response = await build();
      expect(response.status, status).toBe(409);
      expect(await response.json(), status).toEqual({ error: "conflict", message: "a build of this index is already running" });
      expect(created, status).toEqual([]);
    }
    // Live at the last attempt, with every earlier ID free or finished.
    const { created } = instances({ [SECOND]: "errored", [`taxonomy-index-${hash}-20`]: "running" });
    expect((await build()).status).toBe(409);
    expect(created).toEqual([]);
    // With nothing live, the first free ID is taken again.
    const free = instances({ [SECOND]: "complete" });
    const response = await build();
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ runId: FIRST });
    expect(free.created).toEqual([{ id: FIRST, params: { taxonomyVersion: VERSION } }]);
  });

  it("starts the next attempt after a finished one", async () => {
    for (const status of ["complete", "errored", "terminated"]) {
      const { created } = instances({ [FIRST]: status });
      const response = await build();
      expect(response.status, status).toBe(202);
      expect(await response.json(), status).toEqual({ runId: SECOND });
      expect(created, status).toEqual([{ id: SECOND, params: { taxonomyVersion: VERSION } }]);
    }
    // Twenty finished: the operator deletes them first.
    const finished = Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`taxonomy-index-${TAXONOMY_FIXTURE.info.contentHash.slice(0, 8)}-${n + 1}`, "errored"]));
    const { created } = instances(finished);
    const full = await build();
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: "conflict", message: "delete earlier builds of this index first" });
    expect(created).toEqual([]);
    // A build's ID is the taxonomy's own: anything else is no build.
    expect((await admin("/taxonomy/vectors/build/fleet-1")).status).toBe(400);
  });

  it("builds the made-up taxonomy end to end", async () => {
    const embedded: { texts: string[]; opts: unknown }[] = [];
    setModels(() => ({
      ...fakeModels(),
      embed: async (texts, opts) => {
        embedded.push({ texts: [...texts], opts });
        return standInEmbed(texts);
      },
    }));
    const index = new MemoryVectorIndex();
    settings.TAXONOMY_VECTORS = index;
    const started = await build();
    expect(started.status).toBe(202);
    const { runId } = (await started.json()) as { runId: string };
    expect(runId).toBe(FIRST);
    const status = await eventually(async () => {
      const response = await admin(`/taxonomy/vectors/build/${runId}`);
      const body = (await response.json()) as { status: string; output: unknown };
      if (body.status !== "complete") throw new Error(`still ${body.status}`);
      return body;
    }, "the build to finish");
    expect(status).toEqual({ id: runId, status: "complete", output: { state: "complete", pages: 1, embedded: CONCEPTS, count: CONCEPTS } });
    expect(embedded).toHaveLength(1);
    expect(embedded[0]!.opts).toEqual({ model: "@cf/qwen/qwen3-embedding-0.6b", purpose: "document" });
    expect(index.vectors.size).toBe(CONCEPTS + 1);
    expect(await readManifest(index)).toMatchObject({ state: "complete", count: CONCEPTS, taxonomyVersion: VERSION, runId });
    // Asked again, it answers at once and starts nothing.
    expect(await (await build()).json()).toEqual({ state: "complete" });
    const after = await admin("/taxonomy/vectors");
    expect(await after.json()).toMatchObject({ configured: true, taxonomyVersion: VERSION, ready: true, done: CONCEPTS });
    // The finished build can be deleted.
    expect((await admin(`/taxonomy/vectors/build/${runId}`, { method: "DELETE" })).status).toBe(204);
  }, 30_000);

  it("reports status with no text", async () => {
    settings.TAXONOMY_VECTORS = await fixtureIndex();
    const response = await admin("/taxonomy/vectors");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const raw = await response.text();
    for (const concept of TAXONOMY_FIXTURE.concepts) {
      expect(raw).not.toContain(concept.label);
      if (concept.description) expect(raw).not.toContain(concept.description);
    }
    const body = JSON.parse(raw) as { manifest: Record<string, unknown> };
    expect(body).toMatchObject({ configured: true, taxonomyVersion: VERSION, ready: true, done: CONCEPTS });
    expect(Object.keys(body.manifest).sort()).toEqual(["after", "completedAt", "count", "dimensions", "document", "format", "kind", "kinds", "model", "runId", "startedAt", "state", "taxonomyVersion"]);
    // A build still at work says how far it has got.
    const half = await fixtureIndex();
    const metadata = { ...half.vectors.get("manifest")!.metadata, state: "building", after: "esco:skill:00000000-0000-4000-8000-000000000002", completedAt: 0 };
    await half.upsert([{ id: "manifest", values: half.vectors.get("manifest")!.values, metadata }]);
    settings.TAXONOMY_VECTORS = half;
    const building = (await (await admin("/taxonomy/vectors")).json()) as { ready: boolean; done: number };
    expect(building.ready).toBe(false);
    expect(building.done).toBeGreaterThan(0);
    expect(building.done).toBeLessThan(CONCEPTS);
  });

  it("a Directory made before the operator ledger gains it, its invites as they were", async () => {
    const global = directory(env);
    const invitee = `ledger-${crypto.randomUUID()}@example.test`;
    await global.addInvite(invitee);
    const at = DIRECTORY_MIGRATIONS.indexOf(OPERATOR_SPEND_MIGRATIONS);
    // After the invites' last entry; a later Directory migration comes after it, and the rewind still holds.
    expect(at).toBeGreaterThan(DIRECTORY_MIGRATIONS.indexOf(INVITE_GLOBAL_ORPHAN_MIGRATIONS));
    await runInDurableObject(global, (_instance, state) => {
      const sql = state.storage.sql;
      const invites = () => sql.exec(`SELECT email, generation FROM invites ORDER BY email`).toArray();
      const before = invites();
      expect(before.map((row) => row.email)).toContain(invitee);
      // As a Directory was before this release: no ledger, and the version before it.
      sql.exec(`DROP INDEX operator_model_attempts_by_day`);
      sql.exec(`DROP TABLE operator_model_attempts`);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(at));
      migrateDirectory(sql, (fn) => state.storage.transactionSync(fn), true, false);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(DIRECTORY_MIGRATIONS.length));
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE name IN ('operator_model_attempts', 'operator_model_attempts_by_day') ORDER BY name`).toArray()).toEqual([
        { name: "operator_model_attempts" },
        { name: "operator_model_attempts_by_day" },
      ]);
      expect(invites()).toEqual(before);
    });
    // The coordinator keeps operator spend; a shard does not.
    const attempt = { attemptId: crypto.randomUUID(), route: "embed", model: "@cf/qwen/qwen3-embedding-0.6b", inputChars: 10, maxOutputTokens: 0 };
    await global.reserveOperatorModelAttempt(FIRST, "batch 1", attempt, 100, 1_000_000);
    await global.settleOperatorModelAttempt(attempt.attemptId, 10, 5, null);
    await runInDurableObject(directoryByName(env, "directory-3"), async (shard) => {
      await expect((shard as Directory).reserveOperatorModelAttempt(FIRST, "batch 1", { ...attempt, attemptId: crypto.randomUUID() }, 100, 1_000_000)).rejects.toThrow(
        "operator spending is kept by the coordinator",
      );
    });
    await runInDurableObject(global, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT run_id, step, state, actual_cost_micros FROM operator_model_attempts WHERE id = ?`, attempt.attemptId).toArray()).toEqual([
        { run_id: FIRST, step: "batch 1", state: "settled", actual_cost_micros: 10 },
      ]);
    });
  });
});
