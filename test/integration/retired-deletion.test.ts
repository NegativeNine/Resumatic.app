import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { vaultPrefix } from "../../src/shared/r2";
import { stopVaultRuns } from "../../src/directory/directory";

describe("retired vault deletion", () => {
  it("uses the matching binding for every supported run kind", async () => {
    const binding = () => ({ get: vi.fn(async (_id: string) => ({
      status: async () => ({ status: "complete" }),
      delete: async () => {},
    })) });
    const distill = binding(), tailor = binding(), documents = binding(), reembed = binding();
    const bindings = { DISTILL: distill, TAILOR: tailor, DOCUMENTS: documents, REEMBED: reembed } as unknown as Env;
    await stopVaultRuns(bindings, {
      distill: ["distill-primary"], tailor: ["tailor-primary"],
      other: [
        { kind: "distill", id: "distill-legacy" }, { kind: "tailor", id: "tailor-legacy" },
        ...["refine", "letter", "prep", "questions", "reembed"].map((kind) => ({ kind, id: kind })),
      ],
    });
    expect(distill.get.mock.calls.map(([id]) => id)).toEqual(["distill-primary", "distill-legacy"]);
    expect(tailor.get.mock.calls.map(([id]) => id)).toEqual(["tailor-primary", "tailor-legacy"]);
    expect(documents.get.mock.calls.map(([id]) => id)).toEqual(["refine", "letter", "prep", "questions"]);
    expect(reembed.get.mock.calls.map(([id]) => id)).toEqual(["reembed"]);
  });

  it("preserves the vault and files until every Workflow kind is understood", async () => {
    const directory = env.DIRECTORY.getByName(`retirement-${crypto.randomUUID()}`);
    const id = env.VAULT.newUniqueId();
    const vid = id.toString();
    const vault = env.VAULT.get(id);
    const userId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const key = `${vaultPrefix(vid)}sources/test`;
    await vault.init(userId);
    await env.FILES.put(key, "synthetic file");
    await runInDurableObject(vault, (_instance, ctx) => {
      ctx.storage.sql.exec(
        `INSERT INTO runs (id,kind,target_id,request_key,input_digest,state,steps,credit_state,created_at,updated_at)
         VALUES (?, 'future_kind', ?, ?, 'digest', 'succeeded', '[]', 'none', 1, 1)`,
        runId, runId, runId,
      );
    });
    await runInDurableObject(directory, async (instance, ctx) => {
      ctx.storage.sql.exec(`INSERT INTO retired_vaults (vault_id,user_id) VALUES (?,?)`, vid, userId);
      await instance.alarm();
      expect(ctx.storage.sql.exec<{ state: string }>(`SELECT state FROM retired_vaults WHERE vault_id=?`, vid).one().state).toBe("deleting");
    });
    expect(await env.FILES.get(key)).not.toBeNull();
    expect(await runInDurableObject(vault, (_instance, ctx) =>
      ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE id=?`, runId).one().n,
    )).toBe(1);

    // Simulate a future deployment migrating the unsupported run before retrying.
    await runInDurableObject(vault, (_instance, ctx) => ctx.storage.sql.exec(`DELETE FROM runs WHERE id=?`, runId));
    await runInDurableObject(directory, async (instance, ctx) => {
      await instance.alarm();
      expect(ctx.storage.sql.exec<{ state: string }>(`SELECT state FROM retired_vaults WHERE vault_id=?`, vid).one().state).toBe("swept");
    });
    expect(await env.FILES.get(key)).toBeNull();
  });
});
