import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { directory, vault } from "../../src/shared/stubs";

describe("Worker", () => {
  it("serves /api/health", async () => {
    const res = await exports.default.fetch("https://resumatic.test/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("answers routes that later milestones build with 501", async () => {
    for (const path of ["/api/facts", "/auth/login", "/admin/vaults"]) {
      const res = await exports.default.fetch(`https://resumatic.test${path}`);
      expect(res.status, path).toBe(501);
    }
  });
});

describe("Durable Objects", () => {
  it("reaches the Directory by name", async () => {
    expect(await directory(env).ping()).toBe("directory");
  });

  it("reaches a Vault by its random ID", async () => {
    const id = env.VAULT.newUniqueId().toString();
    expect(await vault(env, id).ping()).toBe("vault");
  });
});

describe("Workflows", () => {
  it("can start Distill and Tailor runs", async () => {
    const distill = await env.DISTILL.create({ id: crypto.randomUUID(), params: { vaultId: "v", sourceId: "s" } });
    const tailor = await env.TAILOR.create({ id: crypto.randomUUID(), params: { vaultId: "v", resumeId: "r" } });
    expect(distill.id).toBeTruthy();
    expect(tailor.id).toBeTruthy();
  });
});
