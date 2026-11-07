import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  contentDigest,
  TRANSFER_TABLES,
  type TransferManifest,
  type TransferPage,
} from "../../src/shared/operations";
import { vaultPrefix } from "../../src/shared/r2";
import {
  OPERATION_MIGRATIONS,
  ReembedStore,
  VaultOperations,
} from "../../src/vault/operations";
import {
  createSchema,
  hasSchema,
  SCHEMA_VERSION,
} from "../../src/vault/schema";

type Stub = ReturnType<typeof env.VAULT.get>;
const stub = () => env.VAULT.get(env.VAULT.newUniqueId());

async function storage<T>(
  target: Stub,
  test: (
    ops: VaultOperations,
    embed: ReembedStore,
    sql: SqlStorage,
    fence: { active: boolean },
  ) => T | Promise<T>,
): Promise<T> {
  return runInDurableObject(target, async (_instance, state) => {
    const sql = state.storage.sql;
    if (!hasSchema(sql)) createSchema(sql, (fn) => state.storage.transactionSync(fn));
    for (const migration of OPERATION_MIGRATIONS) sql.exec(migration);
    const transaction = <R>(callback: () => R): R =>
      state.storage.transactionSync(callback);
    const fence = { active: true };
    const ops = new VaultOperations(sql, transaction, {
      vaultId: target.id.toString(),
      userId: "owner",
      schemaVersion: SCHEMA_VERSION,
      requireMaintenanceFence: () => {
        if (!fence.active) throw new Error("vault is not fenced");
      },
    });
    return test(ops, new ReembedStore(sql, transaction), sql, fence);
  });
}

function seed(sql: SqlStorage, vaultId: string): void {
  sql.exec(`INSERT INTO profile (id, name) VALUES (1, 'Test Candidate')`);
  sql.exec(
    `INSERT INTO sources (id, filename, r2_key, markdown, state, created_at) VALUES ('source', 'resume.docx', ?, 'Built a service.', 'ready', 1)`,
    `${vaultPrefix(vaultId)}sources/source`,
  );
  sql.exec(
    `INSERT INTO source_revisions (id, source_id, markdown, created_at) VALUES ('revision', 'source', 'Built a service.', 1)`,
  );
  sql.exec(
    `INSERT INTO evidence (id, source_id, quote, start, end, source_revision_id) VALUES ('quote', 'source', 'Built a service.', 0, 16, 'revision')`,
  );
  sql.exec(
    `INSERT INTO roles (id, kind, org, state) VALUES ('role', 'job', 'Acme', 'confirmed')`,
  );
  sql.exec(
    `INSERT INTO facts (id, role_id, kind, text, evidence_id, source_id, origin, state, vector, updated_at) VALUES ('fact', 'role', 'accomplishment', 'Built a service.', 'quote', 'source', 'extracted', 'confirmed', ?, 1)`,
    new Float32Array([0.25, 0.75]).buffer,
  );
  sql.exec(
    `INSERT INTO meta (key, value) VALUES ('embedding_model', '@cf/test/embedding'), ('embedding_dimensions', '2'), ('embedding_generation', 'generation-1'), ('security_epoch', 'old-epoch')`,
  );
}

async function exported(
  source: Stub,
): Promise<{ manifest: TransferManifest; pages: TransferPage[] }> {
  return storage(source, async (ops, _embed, sql) => {
    seed(sql, source.id.toString());
    const manifest = ops.beginExport("move-1");
    const pages: TransferPage[] = [];
    for (const table of manifest.tables)
      pages.push(await ops.exportPage("move-1", table.name));
    return { manifest, pages };
  });
}

describe("fenced vault transfer", () => {
  it("continues after the page byte limit without dropping or duplicating rows", async () => {
    await storage(stub(), async (ops, _embed, sql) => {
      const text = "x".repeat(1024 * 1024);
      for (let index = 0; index < 9; index++)
        sql.exec(
          `INSERT INTO sources (id,filename,r2_key,markdown,state,created_at) VALUES (?,?,?,?,'ready',1)`,
          `source-${index}`, "resume.pdf", `vaults/test/sources/${index}`, text,
        );
      const manifest = ops.beginExport("move-large-pages");
      const first = await ops.exportPage(manifest.operationId, "sources");
      expect(first.done).toBe(false);
      expect(first.rows.length).toBe(7);
      const second = await ops.exportPage(manifest.operationId, "sources", first.lastRowid);
      expect(second.done).toBe(true);
      expect(second.rows.length).toBe(2);
      const idIndex = first.columns.indexOf("id");
      expect([...first.rows, ...second.rows].map((row) => row[idIndex])).toEqual(
        Array.from({ length: 9 }, (_, index) => `source-${index}`),
      );
    });
  });

  it("preserves content and evidence, rewrites file prefixes and installs fresh control state", async () => {
    const source = stub();
    const destination = stub();
    const { manifest, pages } = await exported(source);
    expect(manifest.tables.map((table) => table.name)).toEqual(TRANSFER_TABLES);
    expect(
      manifest.tables.some((table) => /grant|quota|run/.test(table.name)),
    ).toBe(false);
    await storage(destination, async (ops, _embed, sql) => {
      ops.beginImport(manifest);
      for (const page of pages) await ops.importPage(page);
      expect(
        ops.finishImport(manifest.operationId, "replacement-epoch", () => {
          sql.exec(
            `INSERT INTO meta (key, value) VALUES ('current_financial_checkpoint', 'checkpoint-now')`,
          );
        }),
      ).toMatchObject({
        state: "ready",
        completedTables: TRANSFER_TABLES.length,
      });
      expect(
        sql.exec<{ r2_key: string }>(`SELECT r2_key FROM sources`).one().r2_key,
      ).toBe(`${vaultPrefix(destination.id.toString())}sources/source`);
      expect(
        sql
          .exec<{ quote: string; source_revision_id: string }>(
            `SELECT quote, source_revision_id FROM evidence`,
          )
          .one(),
      ).toEqual({ quote: "Built a service.", source_revision_id: "revision" });
      const vector = sql
        .exec<{ vector: ArrayBuffer }>(`SELECT vector FROM facts`)
        .one().vector;
      expect(Array.from(new Float32Array(vector))).toEqual([0.25, 0.75]);
      const meta = Object.fromEntries(
        sql
          .exec<{ key: string; value: string }>(`SELECT key, value FROM meta`)
          .toArray()
          .map((row) => [row.key, row.value]),
      );
      expect(meta).toMatchObject({
        security_epoch: "replacement-epoch",
        session_gen: "1",
        state: "maintenance",
        embedding_model: "@cf/test/embedding",
        embedding_dimensions: "2",
        current_financial_checkpoint: "checkpoint-now",
      });
      expect(() =>
        ops.finishImport(manifest.operationId, "another-epoch", () => {
          throw new Error("must not repeat");
        }),
      ).not.toThrow();
    });
  });

  it("requires the deployment fence even if restored data says it is open", async () => {
    await storage(stub(), async (ops, _embed, sql, fence) => {
      sql.exec(`INSERT INTO meta (key, value) VALUES ('state', 'open')`);
      fence.active = false;
      expect(() => ops.beginExport("blocked")).toThrow("not fenced");
      fence.active = true;
      const manifest = ops.beginExport("allowed");
      fence.active = false;
      await expect(
        ops.exportPage(manifest.operationId, "profile"),
      ).rejects.toThrow("not fenced");
    });
  });

  it("retries imported pages safely and rejects changed checksums or out-of-order tables", async () => {
    const { manifest, pages } = await exported(stub());
    await storage(stub(), async (ops) => {
      ops.beginImport(manifest);
      await expect(ops.importPage(pages[1]!)).rejects.toThrow("manifest order");
      const page = pages[0]!;
      await expect(ops.importPage({ ...page, rows: [] })).rejects.toThrow(
        "checksum",
      );
      const first = await ops.importPage(page);
      expect(await ops.importPage(page)).toEqual(first);
      const changed = {
        ...page,
        rows: page.rows.map((row) =>
          row.map((value) => (value === "Test Candidate" ? "Changed" : value)),
        ),
      };
      const { sha256: _discard, ...payload } = changed;
      changed.sha256 = await contentDigest(payload);
      await expect(ops.importPage(changed)).rejects.toThrow(
        "cannot be changed",
      );
      expect(() =>
        ops.finishImport(manifest.operationId, "new-epoch", () => {}),
      ).toThrow("incomplete");
    });
  });

  it("rejects incomplete manifests, wrong owners and populated destinations", async () => {
    const { manifest } = await exported(stub());
    await storage(stub(), (ops, _embed, sql) => {
      expect(() =>
        ops.beginImport({ ...manifest, tables: manifest.tables.slice(1) }),
      ).toThrow("every content table");
      expect(() => ops.beginImport({ ...manifest, ownerId: "other" })).toThrow(
        "same account",
      );
      sql.exec(
        `INSERT INTO roles (id, kind, org, state) VALUES ('existing', 'job', 'Existing', 'confirmed')`,
      );
      expect(() => ops.beginImport(manifest)).toThrow("empty");
    });
  });

  it("rolls back finalization when installing the current financial checkpoint fails", async () => {
    const { manifest, pages } = await exported(stub());
    await storage(stub(), async (ops, _embed, sql) => {
      ops.beginImport(manifest);
      for (const page of pages) await ops.importPage(page);
      expect(() =>
        ops.finishImport(manifest.operationId, "new-epoch", () => {
          sql.exec(
            `INSERT INTO meta (key,value) VALUES ('checkpoint', 'partial')`,
          );
          throw new Error("checkpoint failure");
        }),
      ).toThrow("checkpoint failure");
      expect(
        sql.exec(`SELECT value FROM meta WHERE key = 'checkpoint'`).toArray(),
      ).toEqual([]);
      expect(ops.importStatus(manifest.operationId).state).toBe("importing");
    });
  });
});

describe("versioned re-embedding", () => {
  it("keeps active vectors until a complete new generation is atomically installed", async () => {
    const target = stub();
    await storage(target, (_ops, embed, sql) => {
      seed(sql, target.id.toString());
      embed.begin("reembed-1", "@cf/new/embed", 3);
      expect(embed.nextBatch("reembed-1")).toMatchObject([
        { id: "fact", revision: 1, text: "Built a service." },
      ]);
      expect(() => embed.activate("reembed-1")).toThrow("still need");
      expect(embed.status("reembed-1")).toMatchObject({
        state: "building",
        pendingFacts: 1,
      });
      embed.saveBatch("reembed-1", [
        { id: "fact", revision: 1, vector: [1, 2, 3] },
      ]);
      expect(
        Array.from(
          new Float32Array(
            sql.exec<{ vector: ArrayBuffer }>(`SELECT vector FROM facts`).one()
              .vector,
          ),
        ),
      ).toEqual([0.25, 0.75]);
      expect(embed.activate("reembed-1")).toEqual({
        model: "@cf/new/embed",
        dimensions: 3,
        facts: 1,
      });
      expect(
        Array.from(
          new Float32Array(
            sql.exec<{ vector: ArrayBuffer }>(`SELECT vector FROM facts`).one()
              .vector,
          ),
        ),
      ).toEqual([1, 2, 3]);
      expect(embed.status("reembed-1")).toMatchObject({
        state: "active",
        pendingFacts: 0,
      });
      expect(embed.activate("reembed-1").facts).toBe(1);
    });
  });

  it("rejects stale model results and discovers edits made after an earlier batch", async () => {
    const target = stub();
    await storage(target, (_ops, embed, sql) => {
      seed(sql, target.id.toString());
      embed.begin("reembed-1", "@cf/new/embed", 2);
      const old = embed.nextBatch("reembed-1")[0]!;
      sql.exec(`UPDATE facts SET text = 'Built a new service.', revision = 2`);
      expect(
        embed.saveBatch("reembed-1", [{ ...old, vector: [1, 2] }]),
      ).toEqual({ saved: 0, stale: 1 });
      embed.saveBatch("reembed-1", [
        { id: "fact", revision: 2, vector: [1, 2] },
      ]);
      sql.exec(`UPDATE facts SET revision = 3`);
      expect(() => embed.activate("reembed-1")).toThrow("still need");
      expect(embed.nextBatch("reembed-1")).toMatchObject([
        { id: "fact", revision: 3 },
      ]);
      embed.saveBatch("reembed-1", [
        { id: "fact", revision: 3, vector: [3, 4] },
      ]);
      expect(embed.activate("reembed-1").facts).toBe(1);
    });
  });

  it("rejects invalid vectors and conflicting jobs, then clears cancelled staging", async () => {
    const target = stub();
    await storage(target, (_ops, embed, sql) => {
      seed(sql, target.id.toString());
      embed.begin("reembed-1", "@cf/new/embed", 2);
      expect(() => embed.begin("reembed-2", "@cf/new/embed", 2)).toThrow(
        "another",
      );
      expect(() => embed.begin("reembed-1", "@cf/different/embed", 2)).toThrow(
        "cannot change",
      );
      for (const vector of [[0, 0], [1], [1, Infinity], [1, 1e300], [1e-100, 1e-100]])
        expect(() =>
          embed.saveBatch("reembed-1", [{ id: "fact", revision: 1, vector }]),
        ).toThrow();
      embed.saveBatch("reembed-1", [
        { id: "fact", revision: 1, vector: [1, 2] },
      ]);
      embed.cancel("reembed-1");
      expect(embed.status("reembed-1")).toMatchObject({
        state: "cancelled",
        stagedFacts: 0,
      });
      expect(() => embed.activate("reembed-1")).toThrow("cannot be activated");
      expect(() => embed.begin("reembed-2", "@cf/new/embed", 2)).not.toThrow();
    });
  });
});
