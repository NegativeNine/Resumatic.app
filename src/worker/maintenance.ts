import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { allDirectories, vault } from "../shared/stubs";
import { operationalMetrics } from "./metrics";
import { oauthUserGrantCount } from "./mcp";
import { AppError } from "../shared/errors";
import { isMissingWorkflowInstance } from "../shared/workflow-errors";
import { nextR2Cursor } from "../shared/r2";
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
const id = (value: string) => VaultId.parse(value);
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
        if (!isMissingWorkflowInstance(error)) activeRuns = null;
      }
    }
  }
  return c.json({
    vaultId: vid,
    userId: body.userId,
    directoryRows: counts.reduce((a, b) => a + b, 0),
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
