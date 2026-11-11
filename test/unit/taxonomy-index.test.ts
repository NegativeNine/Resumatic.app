import { DatabaseSync } from "node:sqlite";
import type { WorkflowStep } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { TAG_KINDS } from "../../src/pipeline/tag";
import { AppError } from "../../src/shared/errors";
import {
  MANIFEST_ID,
  MemoryStore,
  TAXONOMY_VECTOR_MODEL,
  Taxonomy,
  conceptDocument,
  kindsKey,
  manifestValues,
  readManifest,
  vectorIdFor,
  type Concept,
  type TaxonomyStore,
} from "../../src/taxonomy";
import { INDEX_BATCH, SETTLE_POLLS, runIndexBuild, type IndexServices } from "../../src/workflows/taxonomy-index";
import { MemoryVectorIndex, standInEmbed } from "../support/fake-vectorize";
import { TAXONOMY_FIXTURE, TAXONOMY_FIXTURE_SQL } from "../support/taxonomy-fixture";

// Building the taxonomy's vector index, step by step, with a stand-in for the Workflow engine
// (as test/integration/fleet.test.ts has), an index in memory and a stand-in embedding.

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
vi.mock("cloudflare:workflows", () => ({ NonRetryableError: class NonRetryableError extends Error {} }));

const VERSION = TAXONOMY_FIXTURE.info.version;
const RUN = "taxonomy-index-3191aa55-1";
const indexed = (concept: { kind: string }) => (TAG_KINDS as readonly string[]).includes(concept.kind);

/** The made-up taxonomy with `extra` more skills, so a build takes several pages. */
function bigger(extra: number): Concept[] {
  return [
    ...TAXONOMY_FIXTURE.concepts,
    ...Array.from({ length: extra }, (_, n): Concept => ({
      id: `esco:skill:10000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      kind: "skill",
      scheme: "esco",
      code: null,
      label: `synthetic skill ${n}`,
      description: `A synthetic skill for a test, number ${n}.`,
      meta: {},
    })),
  ];
}

function taxonomyOf(concepts: readonly Concept[] = TAXONOMY_FIXTURE.concepts, info: () => Promise<unknown> = async () => TAXONOMY_FIXTURE.info) {
  const store = new MemoryStore({ ...TAXONOMY_FIXTURE, concepts });
  return new Taxonomy(Object.assign(Object.create(store) as TaxonomyStore, { info }));
}

function stepper() {
  const saved: unknown[] = [];
  const names: string[] = [];
  const sleeps: string[] = [];
  const step = {
    async do(name: string, _config: unknown, body: () => Promise<unknown>) {
      names.push(name);
      const value = await body();
      saved.push(value);
      return value;
    },
    async sleep(name: string) {
      sleeps.push(name);
    },
  } as unknown as WorkflowStep;
  return { step, saved, names, sleeps };
}

/** Stand-in models for each step, recording what was embedded and with what. */
function embedding(refuse?: (step: string) => boolean) {
  const calls: { step: string; texts: string[]; opts: unknown }[] = [];
  const models: IndexServices["models"] = (step) => ({
    async embed(texts, opts) {
      if (refuse?.(step)) throw new AppError("quota", "the configured model spend budget is exhausted");
      calls.push({ step, texts: [...texts], opts });
      return standInEmbed(texts);
    },
  });
  return { calls, models };
}

function setup(options: { concepts?: readonly Concept[]; index?: MemoryVectorIndex; env?: Record<string, unknown>; refuse?: (step: string) => boolean; info?: () => Promise<unknown> } = {}) {
  const index = options.index ?? new MemoryVectorIndex();
  const env = { TAG_SHADOW_ENABLED: "true", TAXONOMY: {} as D1Database, TAXONOMY_VECTORS: index, ...options.env } as unknown as Env;
  const { calls, models } = embedding(options.refuse);
  const taxonomy = taxonomyOf(options.concepts, options.info);
  const build = async (version = VERSION, s = stepper()) => ({ result: await runIndexBuild(env, RUN, { taxonomyVersion: version }, s.step, { taxonomy, models }), ...s });
  return { index, env, calls, taxonomy, build };
}

const ids = (concepts: readonly Concept[]) => concepts.filter(indexed).map((concept) => concept.id).sort();

describe("building the taxonomy's vector index", () => {
  it("embeds every concept of the tagging kinds as documents, in pages, manifest last", async () => {
    const concepts = bigger(200);
    const all = ids(concepts);
    expect(all.length).toBeGreaterThan(2 * INDEX_BATCH);
    const { index, calls, build } = setup({ concepts });
    const { result, names } = await build();
    expect(result).toEqual({ state: "complete", pages: 3, embedded: all.length, count: all.length });
    expect(names).toEqual(["check", "batch 1", "batch 2", "batch 3", "batch 4", "settle 1", "verify", "complete"]);
    // Each page is embedded once, as documents with the index's model, in ID order.
    const byId = new Map(concepts.map((concept) => [concept.id, concept]));
    expect(calls.map((call) => call.step)).toEqual(["batch 1", "batch 2", "batch 3"]);
    expect(calls.every((call) => JSON.stringify(call.opts) === JSON.stringify({ model: TAXONOMY_VECTOR_MODEL, purpose: "document" }))).toBe(true);
    expect(calls.flatMap((call) => call.texts)).toEqual(all.map((id) => conceptDocument(byId.get(id)!)));
    // Every upsert ends with the manifest: the check's, each page's, and the last one's.
    const upserts = index.calls.filter((call) => call.name === "upsert").map((call) => call.args[0] as string[]);
    expect(upserts.map((batch) => batch.length)).toEqual([1, 101, 101, all.length - 200 + 1, 1]);
    expect(upserts.every((batch) => batch.at(-1) === MANIFEST_ID)).toBe(true);
    // One vector a concept and the manifest; tasks and groups of occupations are left out.
    expect([...index.vectors.keys()].filter((id) => id !== MANIFEST_ID).sort()).toEqual(all);
    expect(index.vectors.get(all[0]!)!.metadata).toEqual({ kind: byId.get(all[0]!)!.kind, taxonomyVersion: VERSION });
    expect(await readManifest(index)).toEqual({
      kind: "manifest", format: 1, taxonomyVersion: VERSION, model: TAXONOMY_VECTOR_MODEL, dimensions: 1024, document: "label-kind-description/1",
      kinds: kindsKey(TAG_KINDS), count: all.length, state: "complete", after: all.at(-1), runId: RUN, startedAt: expect.any(Number), completedAt: expect.any(Number),
    });
  });

  it("refuses a partly loaded taxonomy and embeds nothing", async () => {
    const { index, calls, build } = setup({ info: async () => null });
    expect((await build()).result).toEqual({ state: "stopped", pages: 0, embedded: 0, count: 0, code: "unavailable" });
    expect(calls).toEqual([]);
    expect(index.vectors.size).toBe(0);
  });

  it("refuses another version, or one that changes mid-build", async () => {
    const { index, calls, build } = setup();
    expect((await build("esco-0.0.1+onet-0.0+00000000")).result).toMatchObject({ state: "stopped", code: "conflict" });
    expect(calls).toEqual([]);
    expect(index.vectors.size).toBe(0);
    // The binding moves to another taxonomy after the first page.
    let reads = 0;
    const moving = setup({ concepts: bigger(150), info: async () => ({ ...TAXONOMY_FIXTURE.info, version: ++reads > 2 ? "esco-0.0.2+onet-0.0+11111111" : VERSION }) });
    const { result } = await moving.build();
    expect(result).toMatchObject({ state: "stopped", pages: 1, embedded: INDEX_BATCH, code: "conflict" });
    expect(moving.calls).toHaveLength(1);
    expect((await readManifest(moving.index))?.state).toBe("building");
  });

  it("refuses an index holding another build", async () => {
    for (const other of [{ taxonomyVersion: "esco-0.0.1+onet-0.0+00000000" }, { model: "@cf/baai/bge-m3" }, { document: "label/0" }, { kinds: "skill" }]) {
      const index = new MemoryVectorIndex();
      const metadata = { kind: "manifest", format: 1, taxonomyVersion: VERSION, model: TAXONOMY_VECTOR_MODEL, dimensions: 1024, document: "label-kind-description/1", kinds: kindsKey(TAG_KINDS), count: 5, state: "building", after: "", runId: "earlier", startedAt: 1, completedAt: 0, ...other };
      await index.upsert([{ id: MANIFEST_ID, values: manifestValues(), metadata }]);
      const { calls, build } = setup({ index });
      expect((await build()).result, JSON.stringify(other)).toMatchObject({ state: "stopped", code: "conflict" });
      expect(calls).toEqual([]);
      expect(index.vectors.get(MANIFEST_ID)!.metadata).toEqual(metadata);
    }
    // An index of another size is refused before anything is read from it.
    const { calls, build } = setup({ index: new MemoryVectorIndex({ dimensions: 768 }) });
    expect((await build()).result).toMatchObject({ state: "stopped", code: "invalid" });
    expect(calls).toEqual([]);
  });

  it("does nothing and spends nothing when already complete", async () => {
    const { index, calls, build } = setup();
    expect((await build()).result.state).toBe("complete");
    const embedded = calls.length;
    const writes = index.calls.filter((call) => call.name === "upsert").length;
    const again = await build();
    expect(again.result).toEqual({ state: "complete", pages: 0, embedded: 0, count: ids(TAXONOMY_FIXTURE.concepts).length });
    expect(again.names).toEqual(["check"]);
    expect(calls).toHaveLength(embedded);
    expect(index.calls.filter((call) => call.name === "upsert")).toHaveLength(writes);
  });

  it("resumes after the manifest's page, and a page done twice leaves the index as it was", async () => {
    const concepts = bigger(150);
    const all = ids(concepts);
    let refusing = true;
    const { index, calls, build } = setup({ concepts, refuse: (step) => refusing && step === "batch 2" });
    expect((await build()).result).toMatchObject({ state: "stopped", pages: 1, code: "quota" });
    expect((await readManifest(index))?.after).toBe(all[INDEX_BATCH - 1]);
    refusing = false;
    const resumed = await build();
    expect(resumed.result).toMatchObject({ state: "complete", pages: 1, embedded: all.length - INDEX_BATCH });
    // The second run began after the first page.
    expect(calls.map((call) => call.texts.length)).toEqual([INDEX_BATCH, all.length - INDEX_BATCH]);
    const snapshot = () => JSON.stringify([...index.vectors.entries()].filter(([id]) => id !== MANIFEST_ID).sort());
    const before = snapshot();
    // A manifest read late, as Vectorize may give it: the build goes back to the start and puts every page in again.
    const stale = { ...index.vectors.get(MANIFEST_ID)!.metadata, state: "building", after: "", completedAt: 0 };
    await index.upsert([{ id: MANIFEST_ID, values: manifestValues(), metadata: stale }]);
    expect((await build()).result).toMatchObject({ state: "complete", pages: 2 });
    expect(snapshot()).toBe(before);
    expect(index.vectors.size).toBe(all.length + 1);
  });

  it("stops with quota and keeps its place", async () => {
    const { index, calls, build } = setup({ refuse: () => true });
    expect((await build()).result).toEqual({ state: "stopped", pages: 0, embedded: 0, count: ids(TAXONOMY_FIXTURE.concepts).length, code: "quota" });
    expect(calls).toEqual([]);
    expect([...index.vectors.keys()]).toEqual([MANIFEST_ID]);
    expect(await readManifest(index)).toMatchObject({ state: "building", after: "" });
  });

  it("is not complete until every vector is in and a filtered query finds the first and last", async () => {
    // The index counts no write yet: the build waits, then stops without saying it is complete.
    const slow = new MemoryVectorIndex();
    slow.holding = true;
    const waiting = setup({ index: slow });
    const { result, sleeps, names } = await waiting.build();
    expect(result).toMatchObject({ state: "stopped", code: "unsettled" });
    expect(names.filter((name) => name.startsWith("settle"))).toHaveLength(SETTLE_POLLS);
    expect(sleeps).toHaveLength(SETTLE_POLLS - 1);
    slow.settle();
    expect((await readManifest(slow))?.state).toBe("building");
    // Counted at last, and complete.
    expect((await waiting.build()).result.state).toBe("complete");
    // More than this build put in is someone else's.
    const crowded = new MemoryVectorIndex();
    await crowded.upsert([{ id: "onet:tool:stray", values: manifestValues(), metadata: { kind: "tool" } }]);
    expect((await setup({ index: crowded }).build()).result).toMatchObject({ state: "stopped", code: "conflict" });
    // An index made without its metadata index on kind finds nothing by kind.
    const unfiltered = setup({ index: new MemoryVectorIndex({ filterable: false }) });
    expect((await unfiltered.build()).result).toMatchObject({ state: "stopped", code: "unfiltered" });
    expect((await readManifest(unfiltered.index))?.state).toBe("building");
  });

  it("stops with metric when a concept does not match itself at about 1", async () => {
    // Euclidean scores a vector against itself 0.
    const { index, build } = setup({ index: new MemoryVectorIndex({ metric: "euclidean" }) });
    expect((await build()).result).toMatchObject({ state: "stopped", code: "metric" });
    expect((await readManifest(index))?.state).toBe("building");
  });

  it("refuses without the switch or either binding", async () => {
    for (const [what, env] of [
      ["switch off", { TAG_SHADOW_ENABLED: undefined }],
      ["switch not exactly on", { TAG_SHADOW_ENABLED: "TRUE" }],
      ["no taxonomy", { TAXONOMY: undefined }],
      ["no index", { TAXONOMY_VECTORS: undefined }],
    ] as const) {
      const index = new MemoryVectorIndex();
      const { calls, build } = setup({ index, env: { TAXONOMY_VECTORS: index, ...env } });
      expect((await build()).result, what).toEqual({ state: "stopped", pages: 0, embedded: 0, count: 0, code: "unavailable" });
      expect(calls, what).toEqual([]);
      expect(index.vectors.size, what).toBe(0);
    }
  });

  it("returns IDs and counts only", async () => {
    const { build } = setup({ concepts: bigger(120) });
    const { result, saved } = await build();
    const text = JSON.stringify([result, saved]);
    for (const concept of bigger(120)) {
      expect(text).not.toContain(concept.label);
      if (concept.description) expect(text).not.toContain(concept.description);
    }
    const leaves = (value: unknown): unknown[] => (value !== null && typeof value === "object" ? Object.values(value).flatMap(leaves) : [value]);
    // Numbers, flags, codes and concept IDs: every string is an ID.
    for (const leaf of leaves(saved)) if (typeof leaf === "string" && leaf !== "") expect(leaf).toMatch(/^(?:esco|onet):/);
    expect(Object.keys(result)).toEqual(["state", "pages", "embedded", "count"]);
  });

  it("with its default services reserves in the operator ledger before every AI.run", async () => {
    // The taxonomy in a database as D1 serves it, and the Worker's own models: no stand-in for either.
    const db = new DatabaseSync(":memory:");
    for (const statement of TAXONOMY_FIXTURE_SQL) db.exec(statement);
    const statement = (query: string, values: unknown[] = []) => ({
      bind: (...more: unknown[]) => statement(query, [...values, ...more]),
      all: async () => ({ results: db.prepare(query).all(...(values as (string | number | null)[])) }),
      first: async () => db.prepare(query).get(...(values as (string | number | null)[])) ?? null,
    });
    const events: string[] = [];
    const reserved: unknown[][] = [];
    let refuse = false;
    const coordinator = {
      async reserveOperatorModelAttempt(...args: unknown[]) {
        if (refuse) throw new AppError("quota", "the configured model spend budget is exhausted");
        reserved.push(args);
        events.push(`reserve ${args[1]}`);
      },
      async settleOperatorModelAttempt() {
        events.push("settle");
      },
    };
    const run = vi.fn(async (_model: string, input: { documents: string[] }) => {
      events.push("run");
      return { data: await standInEmbed(input.documents), usage: { input_tokens: 10 } };
    });
    const index = new MemoryVectorIndex();
    const env = {
      TAG_SHADOW_ENABLED: "true",
      TAXONOMY: { prepare: (query: string) => statement(query) },
      TAXONOMY_VECTORS: index,
      DAILY_SPEND_CAP_USD: "10",
      AI: { run },
      DIRECTORY: { idFromName: (name: string) => name, get: (name: string) => (name === "global" ? coordinator : null) },
    } as unknown as Env;
    try {
      const { result } = await (async () => ({ result: await runIndexBuild(env, RUN, { taxonomyVersion: VERSION }, stepper().step) }))();
      expect(result).toMatchObject({ state: "complete", pages: 1 });
      expect(events).toEqual(["reserve batch 1", "run", "settle"]);
      expect(reserved).toEqual([[RUN, "batch 1", expect.objectContaining({ model: TAXONOMY_VECTOR_MODEL, route: "embed" }), expect.any(Number), 10_000_000]]);
      expect(run).toHaveBeenCalledWith(TAXONOMY_VECTOR_MODEL, { documents: expect.any(Array) }, expect.anything());
      expect(index.vectors.has(await vectorIdFor(ids(TAXONOMY_FIXTURE.concepts)[0]!))).toBe(true);

      // Refused: nothing is sent, and the build stops with the refusal's code.
      refuse = true;
      run.mockClear();
      const refused = await runIndexBuild({ ...env, TAXONOMY_VECTORS: new MemoryVectorIndex() } as unknown as Env, "taxonomy-index-3191aa55-2", { taxonomyVersion: VERSION }, stepper().step);
      expect(refused).toMatchObject({ state: "stopped", code: "quota" });
      expect(run).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
