import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { allDirectories, directory, vault } from "../shared/stubs";
import { operationalMetrics } from "./metrics";
import { oauthUserGrantCount } from "./mcp";
import { AppError } from "../shared/errors";
import { correlateCacheWrites } from "./cache-correlation";
import { deletionFenceReport } from "./deletion-fences";
import { isMissingWorkflowInstance } from "../shared/workflow-errors";
import { nextR2Cursor } from "../shared/r2";
import { TAG_KINDS } from "../pipeline/tag";
import { manifestMatches, readManifest, taxonomyFor } from "../taxonomy";
import { MAX_BUILD_ATTEMPTS, TAXONOMY_VERSION, indexBuildId, indexConfiguration, sameBuild } from "../workflows/taxonomy-index";
import {
  TRANSFER_TABLES,
  type TransferManifest,
  type TransferPage,
} from "../shared/operations";
export const maintenance = new Hono<{ Bindings: Env }>();
maintenance.use("*", bodyLimit({ maxSize: 9 * 1024 * 1024 }));
const Operation = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const VaultId = z.string().regex(/^[a-f0-9]{64}$/i);
async function home(env: Env, id: string) {
  const matches = await Promise.all(
    [...allDirectories(env)].map(async (d) =>
      (await d.hasVault(id)) ? d : null,
    ),
  );
  const found = matches.filter((d) => d !== null);
  if (found.length !== 1)
    throw new AppError("not_found", "vault directory entry is unavailable");
  return found[0]!;
}
// Durable Object IDs parse case-insensitively but their canonical string and
// the R2 prefixes we write are lowercase. Normalize before any cross-store
// lookup so a valid uppercase spelling cannot look like an empty prefix.
const id = (value: string) => VaultId.parse(value).toLowerCase();
function requireSyntheticPlacement(env: Env): void {
  if (env.PLACEMENT_FENCE_ENABLED !== "true" || env.ALLOW_TEST_SIGNIN !== "true" || !env.PILOT_BUDGET)
    throw new AppError("unavailable", "placement reconciliation requires staging configuration");
}
async function syntheticPlacementBody(request: Request, generationRequired = false): Promise<{ subject: string; generation?: string }> {
  let raw: unknown;
  try { raw = await request.json(); } catch { throw new AppError("invalid", "expected a JSON body"); }
  const parsed = z.object({ subject: z.string().regex(/^placement-[0-9a-f-]{36}@placement\.invalid$/i), generation: z.uuid().optional() }).strict().safeParse(raw);
  if (!parsed.success || generationRequired !== (parsed.data.generation !== undefined)) throw new AppError("invalid", "invalid synthetic placement subject");
  return { ...parsed.data, subject: parsed.data.subject.toLowerCase() };
}

// Access-protected, synthetic-only recovery. It seals known attempts; it does
// not establish that older Workers or unregistered dispatches are quiescent.
maintenance.post("/placement/reconcile", bodyLimit({ maxSize: 2048 }), async (c) => {
  requireSyntheticPlacement(c.env);
  const { subject } = await syntheticPlacementBody(c.req.raw);
  return c.json(await directory(c.env).reconcileSyntheticPlacement("test", subject));
});
maintenance.post("/placement/inspect", bodyLimit({ maxSize: 2048 }), async (c) => {
  requireSyntheticPlacement(c.env);
  const { subject } = await syntheticPlacementBody(c.req.raw);
  return c.json(await directory(c.env).inspectSyntheticPlacement("test", subject));
});
maintenance.post("/placement/cleanup-orphan", bodyLimit({ maxSize: 2048 }), async (c) => {
  requireSyntheticPlacement(c.env);
  const { subject, generation } = await syntheticPlacementBody(c.req.raw, true);
  return c.json(await directory(c.env).cleanupSyntheticOrphan("test", subject, generation!));
});

// This is an observation for operator review, not an authorization to remove
// an invitation. Each Directory is read at a different time and neither
// current nor previously dispatched sign-ins are fenced by this endpoint.
maintenance.post("/invite-user-inventory", bodyLimit({ maxSize: 2048 }), async (c) => {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new AppError("invalid", "expected a JSON body"); }
  const body = z.object({ email: z.string().min(1).max(320) }).strict().safeParse(raw);
  if (!body.success || !body.data.email.trim()) throw new AppError("invalid", "invalid inventory request");
  const email = body.data.email.trim().toLowerCase();
  if (email.length > 320) throw new AppError("invalid", "invalid inventory request");
  const locations = [...allDirectories(c.env)];
  const observations = await Promise.all(locations.map(async (location, index) => {
    const name = index === 0 ? "global" : `directory-${index - 1}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        location.inviteUserInventory(email),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 5000); }),
      ]);
      if (result.status === "observed" && Number.isSafeInteger(result.active) && result.active >= 0 &&
          Number.isSafeInteger(result.deleting) && result.deleting >= 0)
        return { directory: name, status: "observed" as const, active: result.active, deleting: result.deleting };
      if (result.status === "row_limit" || result.status === "invalid_rows")
        return { directory: name, status: result.status };
      return { directory: name, status: "unavailable" as const };
    } catch {
      return { directory: name, status: "unavailable" as const };
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }));
  c.header("cache-control", "private, no-store");
  return c.json({
    status: "pending" as const,
    scope: "current_rows_only" as const,
    complete: false as const,
    reasons: ["unfenced_concurrent_and_legacy_writes", "snapshots_at_different_times"],
    observations,
  });
});

maintenance.post("/vaults/:id/replacement", async (c) => {
  const { operationId } = z
    .object({ operationId: Operation })
    .parse(await c.req.json());
  const source = id(c.req.param("id"));
  return c.json(
    await (await home(c.env, source)).prepareReplacement(source, operationId),
  );
});
maintenance.post("/vaults/:id/transfer", async (c) => {
  const { operationId } = z
    .object({ operationId: Operation })
    .parse(await c.req.json());
  return c.json(
    await vault(c.env, id(c.req.param("id"))).transferManifest(operationId),
  );
});
maintenance.get("/vaults/:id/transfer/:operation/:table", async (c) => {
  const table = z.enum(TRANSFER_TABLES).parse(c.req.param("table"));
  const after = z.coerce
    .number()
    .int()
    .nonnegative()
    .parse(c.req.query("after") ?? 0);
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .parse(c.req.query("limit") ?? 50);
  return c.json(
    await vault(c.env, id(c.req.param("id"))).transferPage(
      Operation.parse(c.req.param("operation")),
      table,
      after,
      limit,
    ),
  );
});
maintenance.post("/vaults/:id/import", async (c) => {
  const body = (await c.req.json()) as { manifest: TransferManifest };
  if (!body?.manifest) throw new AppError("invalid", "missing manifest");
  return c.json(
    await vault(c.env, id(c.req.param("id"))).importManifest(body.manifest),
  );
});
maintenance.post("/vaults/:id/import-page", async (c) => {
  const body = (await c.req.json()) as { page: TransferPage };
  if (!body?.page) throw new AppError("invalid", "missing page");
  return c.json(
    await vault(c.env, id(c.req.param("id"))).importPage(body.page),
  );
});
maintenance.post("/vaults/:id/import-finish", async (c) => {
  const body = z
    .object({ operationId: Operation, sourceVaultId: VaultId })
    .parse(await c.req.json());
  return c.json(
    await vault(c.env, id(c.req.param("id"))).finishImport(
      body.operationId,
      body.sourceVaultId,
    ),
  );
});
maintenance.post("/vaults/:id/cutover", async (c) => {
  const body = z
    .object({ operationId: Operation, targetVaultId: VaultId })
    .parse(await c.req.json());
  const source = id(c.req.param("id"));
  await (
    await home(c.env, source)
  ).cutover(source, body.targetVaultId, body.operationId);
  return c.body(null, 204);
});
maintenance.post("/vaults/:id/reembed", async (c) => {
  const body = z
    .object({
      model: z.string().max(200),
      dimensions: z.number().int().min(1).max(16384),
    })
    .parse(await c.req.json());
  return c.json(
    await vault(c.env, id(c.req.param("id"))).startReembed(
      body.model,
      body.dimensions,
    ),
    202,
  );
});
maintenance.get("/vaults/:id/reembed/:run", async (c) =>
  c.json(
    await vault(c.env, id(c.req.param("id"))).reembedStatus(
      Operation.parse(c.req.param("run")),
    ),
  ),
);

// Access-protected metadata only. An empty result does not establish that
// legacy, upload, transfer or provider-side writes have quiesced.
maintenance.get("/vaults/:id/cache-write-fences", async (c) =>
  c.json(await vault(c.env, id(c.req.param("id"))).cacheWriteFences()),
);

// A bounded, read-only hint. An empty scan or a matching object is never
// evidence that a dispatched write settled or cannot still arrive.
maintenance.get("/vaults/:id/cache-write-correlation", async (c) => {
  const vaultId = id(c.req.param("id"));
  const snapshot = await (async () => {
    try { return await vault(c.env, vaultId).cacheWriteFences(); }
    catch { return { status: "unavailable" as const }; }
  })();
  c.header("cache-control", "private, no-store");
  return c.json(await correlateCacheWrites(c.env.FILES, vaultId, snapshot));
});

// Access-protected, owner-checked and read-only. A zero count never proves
// erasure, provider quiescence, or the absence of older unregistered writes.
maintenance.post("/vaults/:id/deletion-fences", bodyLimit({ maxSize: 2048 }), async (c) => {
  const vaultId = id(c.req.param("id"));
  let input: unknown;
  try { input = await c.req.json(); } catch { throw new AppError("invalid", "expected a JSON body"); }
  const parsed = z.object({
    userId: z.string().regex(/^(?:s(?:[0-9]|1[0-5]):)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  }).strict().safeParse(input);
  if (!parsed.success) throw new AppError("invalid", "invalid diagnostic owner");
  const locations = [...allDirectories(c.env)];
  const report = await deletionFenceReport(
    () => Promise.all(locations.map((d) => d.deletionFenceMapping(vaultId, parsed.data.userId))),
    () => vault(c.env, vaultId).deletionFenceSummary(parsed.data.userId),
  );
  c.header("cache-control", "private, no-store");
  return c.json(report);
});

maintenance.post("/deletion-audits/:id", async (c) => {
  const vid = id(c.req.param("id"));
  const body = z
    .object({
      userId: z.string().min(1).max(100),
      sources: z.array(z.uuid()).max(100),
      resumes: z.array(z.uuid()).max(100),
      documents: z.array(z.uuid()).max(100).default([]),
      reembeddings: z.array(z.uuid()).max(100).default([]),
    })
    .parse(await c.req.json());
  const counts = await Promise.all(
    [...allDirectories(c.env)].map((d) => d.deletionProbe(body.userId, vid)),
  );
  const probe = await vault(c.env, vid).deletionProbe();
  let r2Objects = 0;
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await c.env.FILES.list({ prefix: `vaults/${vid}/`, cursor });
    r2Objects += page.objects.length;
    cursor = nextR2Cursor(page, seen);
  } while (cursor);
  let activeRuns: number | null = 0;
  for (const [binding, ids] of [
    [c.env.DISTILL, body.sources],
    [c.env.TAILOR, body.resumes],
    [c.env.DOCUMENTS, body.documents],
    [c.env.REEMBED, body.reembeddings],
  ] as const) {
    for (const run of ids) {
      try {
        await (await binding.get(run)).status();
        if (activeRuns !== null) activeRuns++;
      } catch (error) {
        if (!isMissingWorkflowInstance(error, run)) activeRuns = null;
      }
    }
  }
  return c.json({
    vaultId: vid,
    userId: body.userId,
    directoryRows: counts.reduce((a, b) => a + b, 0),
    // Unassociated Stripe events have a customer ID but no user ID. The
    // probe cannot attribute those events after the customer mapping is gone.
    billingEventCoverage: { scope: "user_id_only" as const, complete: false as const },
    vaultRows: probe.rows,
    r2Objects,
    oauthRecords: await oauthUserGrantCount(c.env, body.userId),
    activeRuns,
    // Only the supplied IDs were checked. The endpoint has no independent way to
    // prove that this caller-provided list covers every historical Workflow.
    workflowCoverage: {
      scope: "supplied_ids_only" as const,
      checked:
        body.sources.length +
        body.resumes.length +
        body.documents.length +
        body.reembeddings.length,
      complete: false as const,
    },
    retentionReviewed: !!c.env.RETENTION_REVIEW_ID,
  });
});

maintenance.post("/vaults/:id/billing/customer", async (c) => {
  const { customerId } = z
    .object({ customerId: z.string().regex(/^cus_[A-Za-z0-9]+$/) })
    .parse(await c.req.json());
  await vault(c.env, id(c.req.param("id"))).recoverBillingCustomer(customerId);
  return c.body(null, 204);
});

maintenance.get("/metrics", async (c) =>
  c.json(
    await operationalMetrics(c.env, {
      hours: z.coerce
        .number()
        .int()
        .min(1)
        .max(168)
        .parse(c.req.query("hours") ?? 24),
    }),
  ),
);
maintenance.post("/fleets/reembed", async (c) => {
  const body = z
    .object({
      model: z.string().startsWith("@cf/").max(200),
      dimensions: z.number().int().min(1).max(16384),
      maxVaults: z.number().int().min(1).max(300),
      cursor: z
        .object({
          directory: z.number().int().min(0).max(16),
          after: VaultId.optional(),
        })
        .optional(),
    })
    .parse(await c.req.json());
  if (body.model !== (c.env.EMBEDDING_MODEL ?? "@cf/baai/bge-m3"))
    throw new AppError("invalid", "configure the target embedding model first");
  const runId = crypto.randomUUID();
  await c.env.FLEET_REEMBED.create({ id: runId, params: body });
  return c.json({ runId }, 202);
});
maintenance.get("/fleets/reembed/:id", async (c) => {
  const run = await c.env.FLEET_REEMBED.get(z.uuid().parse(c.req.param("id")));
  const status = await run.status();
  return c.json({
    id: run.id,
    status: status.status,
    output: status.output ?? null,
  });
});
maintenance.delete("/fleets/reembed/:id", async (c) => {
  const run = await c.env.FLEET_REEMBED.get(z.uuid().parse(c.req.param("id")));
  const status = await run.status();
  if (!["complete", "terminated", "errored"].includes(status.status))
    await run.terminate();
  await run.delete();
  return c.body(null, 204);
});

// The taxonomy's vector index (docs/taxonomy.md, "The vector index"). A build is one Workflow
// instance at a time for each taxonomy, by its ID. A start is refused while any attempt is live,
// and takes the first free ID; two starts at once take the same one, and the platform itself
// refuses a second instance under an ID in use.
const IndexBuildId = z.string().regex(/^taxonomy-index-[0-9a-f]{8}-\d{1,2}$/);
const FINISHED = new Set(["complete", "errored", "terminated"]);
const RUNNING = "a build of this index is already running";
maintenance.post("/taxonomy/vectors/build", bodyLimit({ maxSize: 2048 }), async (c) => {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new AppError("invalid", "expected a JSON body"); }
  const parsed = z.object({ taxonomyVersion: z.string().regex(TAXONOMY_VERSION) }).strict().safeParse(raw);
  if (!parsed.success) throw new AppError("invalid", "a build names the taxonomy version it is for");
  const { taxonomyVersion } = parsed.data;
  const { index, taxonomy: database } = indexConfiguration(c.env);
  // A taxonomy loaded part of the way has no version: "the taxonomy is not loaded", 503.
  const info = await taxonomyFor({ TAXONOMY: database })!.info();
  if (info.version !== taxonomyVersion) throw new AppError("conflict", "the bound taxonomy is another version");
  const manifest = await readManifest(index);
  if (manifest && manifestMatches(manifest, { taxonomyVersion, kinds: TAG_KINDS })) return c.json({ state: "complete" as const });
  if (manifest && !sameBuild(manifest, taxonomyVersion)) throw new AppError("conflict", "this index holds another build; create a new index for this version");
  const params = { taxonomyVersion };
  // Every attempt is looked at before one is started. An earlier attempt can be gone, deleted by
  // the operator or by the platform's retention, while a later one is still at work: its free ID
  // must not start a second build beside it.
  let free: string | null = null;
  for (let attempt = 1; attempt <= MAX_BUILD_ATTEMPTS; attempt++) {
    const id = indexBuildId(info.contentHash, attempt);
    let status: string;
    try {
      status = (await (await c.env.TAXONOMY_INDEX.get(id)).status()).status;
    } catch (error) {
      if (!isMissingWorkflowInstance(error, id)) throw error;
      free ??= id;
      continue;
    }
    // Queued, running, paused, waiting or unknown: all are live.
    if (!FINISHED.has(status)) throw new AppError("conflict", RUNNING);
  }
  if (!free) throw new AppError("conflict", "delete earlier builds of this index first");
  try {
    await c.env.TAXONOMY_INDEX.create({ id: free, params });
  } catch (refused) {
    // Another request took this ID first.
    try { await c.env.TAXONOMY_INDEX.get(free); } catch { throw refused; }
    throw new AppError("conflict", RUNNING);
  }
  return c.json({ runId: free }, 202);
});
maintenance.get("/taxonomy/vectors", async (c) => {
  let configured: ReturnType<typeof indexConfiguration> | null = null;
  try { configured = indexConfiguration(c.env); } catch { configured = null; }
  c.header("cache-control", "private, no-store");
  if (!configured) return c.json({ configured: false, taxonomyVersion: null, manifest: null, ready: false, done: 0 });
  const taxonomy = taxonomyFor({ TAXONOMY: configured.taxonomy })!;
  const taxonomyVersion = await taxonomy.info().then((info) => info.version, () => null);
  const manifest = await readManifest(configured.index);
  // Counts, codes and IDs only: the manifest says nothing of any concept but how far a build got.
  return c.json({
    configured: true,
    taxonomyVersion,
    manifest,
    ready: manifest !== null && taxonomyVersion !== null && manifestMatches(manifest, { taxonomyVersion, kinds: TAG_KINDS }),
    done: manifest?.after ? await taxonomy.conceptCount(TAG_KINDS, manifest.after) : 0,
  });
});
maintenance.get("/taxonomy/vectors/build/:id", async (c) => {
  const run = await c.env.TAXONOMY_INDEX.get(IndexBuildId.parse(c.req.param("id")));
  const status = await run.status();
  return c.json({ id: run.id, status: status.status, output: status.output ?? null });
});
maintenance.delete("/taxonomy/vectors/build/:id", async (c) => {
  const run = await c.env.TAXONOMY_INDEX.get(IndexBuildId.parse(c.req.param("id")));
  const status = await run.status();
  if (!FINISHED.has(status.status)) await run.terminate();
  await run.delete();
  return c.body(null, 204);
});
