import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { Models } from "../ai/models";
import { TAG_KINDS } from "../pipeline/tag";
import { usableEmbedding } from "../shared/embedding";
import { AppError, errorCode } from "../shared/errors";
import {
  MANIFEST_ID,
  SELF_MATCH_MAX,
  SELF_MATCH_MIN,
  TAXONOMY_VECTOR_DIMENSIONS,
  TAXONOMY_VECTOR_DOCUMENT,
  TAXONOMY_VECTOR_MODEL,
  conceptDocument,
  kindsKey,
  manifestMatches,
  manifestValues,
  readManifest,
  taxonomyFor,
  vectorIdFor,
  type IndexManifest,
  type Taxonomy,
  type VectorIndex,
} from "../taxonomy";
import { operatorModels } from "./models";
import { MODEL_STEP, STEP, once } from "./steps";

// Builds the taxonomy's vector index: every concept of the kinds tagging uses, embedded as a
// document and put in the Vectorize index bound as TAXONOMY_VECTORS (docs/taxonomy.md, "The
// vector index"). An operator starts it through Access (src/worker/maintenance.ts). Each page's
// embedding is reserved in the global Directory's operator ledger before it is sent.
//
// The index notes how far the build has got in its manifest, which goes in with every page, so a
// build started again goes on after the last page that is in. It is complete only once it holds
// one vector per concept and the manifest, and a filtered lookup finds the first and the last
// concept as their own nearest match at a score that only cosine gives. The Workflow's state holds
// counts, codes and concept IDs only.
//
//   INDEX_BATCH         100    concepts in one page: one embedding call and one upsert
//   MAX_INDEX_PAGES     1,000  beyond it the build stops with too_large
//   SETTLE_POLLS        30     a minute apart, for the index to count every vector
//   MAX_BUILD_ATTEMPTS  20     instance IDs one taxonomy version can take

export const INDEX_BATCH = 100;
export const MAX_INDEX_PAGES = 1000;
export const SETTLE_POLLS = 30;
export const MAX_BUILD_ATTEMPTS = 20;

export interface TaxonomyIndexParams {
  taxonomyVersion: string;
}

/** What a build did: counts and a code, nothing else. */
export interface TaxonomyIndexResult {
  state: "complete" | "stopped";
  /** Pages embedded and put in by this run, and the concepts in them. */
  pages: number;
  embedded: number;
  /** How many concepts the index holds when it is complete. */
  count: number;
  /** Why it stopped. */
  code?: string;
}

/** What a test gives in place of the bound taxonomy and the operator's models. */
export interface IndexServices {
  taxonomy?: Pick<Taxonomy, "info" | "get" | "conceptPage" | "conceptCount">;
  models?: (step: string) => Pick<Models, "embed">;
}

export const TAXONOMY_VERSION = /^[A-Za-z0-9.+-]{1,100}$/;

/** The instance ID of one attempt at building the index of a taxonomy, by its content hash. */
export function indexBuildId(contentHash: string, attempt: number): string {
  if (!/^[0-9a-f]{8}/.test(contentHash)) throw new AppError("unavailable", "the taxonomy is not loaded");
  return `taxonomy-index-${contentHash.slice(0, 8)}-${attempt}`;
}

/** The switch and both bindings, or the build is refused. The index is built only where tagging could read it. */
export function indexConfiguration(env: Env): { index: VectorIndex; taxonomy: D1Database } {
  if (env.TAG_SHADOW_ENABLED !== "true" || !env.TAXONOMY || !env.TAXONOMY_VECTORS)
    throw new AppError("unavailable", "the taxonomy vector index is not configured");
  return { index: env.TAXONOMY_VECTORS, taxonomy: env.TAXONOMY };
}

/** True when a manifest was written by a build of this version, model, document form and kinds, whatever its state. */
export function sameBuild(manifest: IndexManifest, taxonomyVersion: string): boolean {
  return (
    manifest.format === 1 &&
    manifest.taxonomyVersion === taxonomyVersion &&
    manifest.model === TAXONOMY_VECTOR_MODEL &&
    manifest.dimensions === TAXONOMY_VECTOR_DIMENSIONS &&
    manifest.document === TAXONOMY_VECTOR_DOCUMENT &&
    manifest.kinds === kindsKey(TAG_KINDS)
  );
}

/** A reason to stop that is not an error: the index did not prove itself. */
class Stop extends Error {
  constructor(readonly code: "unsettled" | "unfiltered" | "metric") {
    super(code);
  }
}

function manifestRecord(manifest: IndexManifest): VectorizeVector {
  return { id: MANIFEST_ID, values: manifestValues(), metadata: { ...manifest } };
}

/** Runs one build. It never rejects: a failure stops it with a code. */
export async function runIndexBuild(
  env: Env,
  instanceId: string,
  params: TaxonomyIndexParams,
  step: WorkflowStep,
  services: IndexServices = {},
): Promise<TaxonomyIndexResult> {
  const result: TaxonomyIndexResult = { state: "stopped", pages: 0, embedded: 0, count: 0 };
  try {
    if (typeof params?.taxonomyVersion !== "string" || !TAXONOMY_VERSION.test(params.taxonomyVersion))
      throw new AppError("invalid", "a build names the taxonomy version it is for");
    const version = params.taxonomyVersion;
    const kinds = TAG_KINDS;
    const bound = () => {
      const { index, taxonomy } = indexConfiguration(env);
      return { index, taxonomy: services.taxonomy ?? taxonomyFor({ TAXONOMY: taxonomy })! };
    };
    /** The bound taxonomy must still be this version: a binding moved mid-build stops it. */
    const sameVersion = async (taxonomy: Pick<Taxonomy, "info">) => {
      if ((await taxonomy.info()).version !== version) throw new AppError("conflict", "the bound taxonomy is another version");
    };

    const checked = await step.do(
      "check",
      STEP,
      once(async () => {
        const { index, taxonomy } = bound();
        // A taxonomy loaded part of the way has no version, and is refused here.
        await sameVersion(taxonomy);
        const described = await index.describe();
        if (described?.dimensions !== TAXONOMY_VECTOR_DIMENSIONS) throw new AppError("invalid", "the index is not of the size this build makes");
        const manifest = await readManifest(index);
        if (manifest && !sameBuild(manifest, version)) throw new AppError("conflict", "this index holds another build; create a new index for this version");
        if (manifest && manifestMatches(manifest, { taxonomyVersion: version, kinds })) return { done: true, after: manifest.after, count: manifest.count, startedAt: manifest.startedAt };
        const count = await taxonomy.conceptCount(kinds);
        if (count < 1) throw new AppError("invalid", "the taxonomy has no concepts to index");
        const after = manifest?.state === "building" ? manifest.after : "";
        const startedAt = manifest?.state === "building" ? manifest.startedAt : Date.now();
        await index.upsert([manifestRecord(building(version, count, after, instanceId, startedAt))]);
        return { done: false, after, count, startedAt };
      }),
    );
    result.count = checked.count;
    // Already complete: nothing is embedded and nothing is spent.
    if (checked.done) return { ...result, state: "complete" };

    let after = checked.after;
    for (let n = 1; ; n++) {
      if (n > MAX_INDEX_PAGES) throw new AppError("too_large", "the taxonomy has too many concepts to index");
      const from = after;
      const page = await step.do(
        `batch ${n}`,
        MODEL_STEP,
        once(async () => {
          const { index, taxonomy } = bound();
          await sameVersion(taxonomy);
          const concepts = await taxonomy.conceptPage(from, kinds, INDEX_BATCH);
          if (concepts.length === 0) return { done: true, after: from, embedded: 0 };
          const models = services.models ? services.models(`batch ${n}`) : operatorModels(env, instanceId, `batch ${n}`);
          const values: unknown = await models.embed(concepts.map(conceptDocument), { model: TAXONOMY_VECTOR_MODEL, purpose: "document" });
          if (
            !Array.isArray(values) ||
            values.length !== concepts.length ||
            !values.every((vector) => Array.isArray(vector) && vector.length === TAXONOMY_VECTOR_DIMENSIONS && usableEmbedding(vector))
          )
            throw new AppError("unavailable", "the embedding is not of the index's size");
          const last = concepts.at(-1)!.id;
          const records: VectorizeVector[] = [];
          for (const [at, concept] of concepts.entries()) {
            const id = await vectorIdFor(concept.id);
            records.push({ id, values: values[at] as number[], metadata: { kind: concept.kind, taxonomyVersion: version, ...(id === concept.id ? {} : { concept: concept.id }) } });
          }
          // The page and how far the build has got go in together.
          await index.upsert([...records, manifestRecord(building(version, checked.count, last, instanceId, checked.startedAt))]);
          return { done: false, after: last, embedded: concepts.length };
        }),
      );
      if (page.done) break;
      after = page.after;
      result.pages++;
      result.embedded += page.embedded;
    }

    // Writes are applied in their own time. The index is counted until it holds every vector.
    for (let poll = 1; ; poll++) {
      const settled = await step.do(
        `settle ${poll}`,
        STEP,
        once(async () => {
          const { vectorCount } = await bound().index.describe();
          if (vectorCount === checked.count + 1) return true;
          if (vectorCount > checked.count + 1) throw new AppError("conflict", "the index holds more than this build put in");
          return false;
        }),
      );
      if (settled) break;
      if (poll >= SETTLE_POLLS) throw new Stop("unsettled");
      await step.sleep(`wait ${poll}`, "60 seconds");
    }

    // A lookup filtered by kind finds the first and the last concept as their own nearest match,
    // which shows the kind is indexed, and at a score of about 1, which shows the metric is cosine.
    const verified = await step.do(
      "verify",
      STEP,
      once(async () => {
        const { index, taxonomy } = bound();
        const first = (await taxonomy.conceptPage("", kinds, 1))[0];
        const last = (await taxonomy.get([after])).get(after);
        if (!first || !last) return { code: "unfiltered" as const };
        for (const concept of [first, last]) {
          const id = await vectorIdFor(concept.id);
          const found = await index.queryById(id, { topK: 1, filter: { kind: { $eq: concept.kind } } });
          const top = found?.matches?.[0];
          if (!top || top.id !== id) return { code: "unfiltered" as const };
          if (!(top.score >= SELF_MATCH_MIN && top.score <= SELF_MATCH_MAX)) return { code: "metric" as const };
        }
        return { code: null };
      }),
    );
    if (verified.code) throw new Stop(verified.code);

    await step.do(
      "complete",
      STEP,
      once(async () => {
        const { index, taxonomy } = bound();
        await sameVersion(taxonomy);
        await index.upsert([manifestRecord({ ...building(version, checked.count, after, instanceId, checked.startedAt), state: "complete", completedAt: Date.now() })]);
        return { ok: true };
      }),
    );
    return { ...result, state: "complete" };
  } catch (error) {
    // A code and nothing else.
    return { ...result, state: "stopped", code: error instanceof Stop ? error.code : (errorCode(error) ?? "error") };
  }
}

function building(taxonomyVersion: string, count: number, after: string, runId: string, startedAt: number): IndexManifest {
  return {
    kind: "manifest",
    format: 1,
    taxonomyVersion,
    model: TAXONOMY_VECTOR_MODEL,
    dimensions: TAXONOMY_VECTOR_DIMENSIONS,
    document: TAXONOMY_VECTOR_DOCUMENT,
    kinds: kindsKey(TAG_KINDS),
    count,
    state: "building",
    after,
    runId,
    startedAt,
    completedAt: 0,
  };
}

export class TaxonomyIndexWorkflow extends WorkflowEntrypoint<Env, TaxonomyIndexParams> {
  async run(event: WorkflowEvent<TaxonomyIndexParams>, step: WorkflowStep): Promise<TaxonomyIndexResult> {
    return runIndexBuild(this.env, event.instanceId, event.payload, step);
  }
}
