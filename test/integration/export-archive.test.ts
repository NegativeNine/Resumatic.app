import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";
import { fromBase64url } from "../../src/worker/crypto";
import { call, signIn, type User } from "./support";
import { app } from "../../src/worker/routes";

function identity(user: User) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  return JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { uid: string; vid: string; gen: number; epoch?: string };
}

async function source(user: User) {
  const response = await user.upload("../../resume.pdf", "original synthetic bytes");
  expect(response.status).toBe(201);
  const { sourceId } = await response.json() as { sourceId: string };
  const s = identity(user);
  const object = await vault(env, s.vid).sourceFile({ userId: s.uid, gen: s.gen, epoch: s.epoch }, sourceId);
  return { sourceId, key: object.r2Key };
}

describe("portable vault archive", () => {
  it("fails closed if a mixed-version Vault lacks the archive stream RPC", async () => {
    const user = await signIn();
    let legacyCalled = false;
    const legacyVault = { exportArchiveSnapshot: async () => { legacyCalled = true; return {}; } };
    const oldNamespace = { idFromString: (id: string) => id, get: () => legacyVault };
    const response = await app.fetch(new Request("https://resumatic.test/api/export/archive", {
      headers: { cookie: user.cookie },
    }), { ...env, VAULT: oldNamespace } as unknown as Env);
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.headers.get("content-type")).not.toContain("application/zip");
    expect(legacyCalled).toBe(false);
  });

  it("cancels the captured snapshot when the request aborts during R2 preflight", async () => {
    const user = await signIn(), session = identity(user), controller = new AbortController();
    let cancelled = false, began!: () => void;
    const entered = new Promise<void>((resolve) => { began = resolve; });
    const metadata = new TextEncoder().encode(JSON.stringify({
      exportedAt: new Date().toISOString(), jsonBytes: 2,
      files: [{ id: "file", key: `vaults/${session.vid}/sources/file`, path: "sources/file.pdf", origin: "upload" }],
    }));
    const prefix = new Uint8Array(4 + metadata.length);
    new DataView(prefix.buffer).setUint32(0, metadata.length, false);
    prefix.set(metadata, 4);
    const fakeVault = {
      exportArchiveStream: async () => {
        let first = true;
        return new Response(new ReadableStream<Uint8Array>({
          pull(out) { if (first) { first = false; out.enqueue(prefix); } else return new Promise<void>(() => {}); },
          cancel() { cancelled = true; },
        }, { highWaterMark: 0 }));
      },
      checkSession: async () => {},
    };
    const mockEnv = { ...env,
      VAULT: { idFromString: (id: string) => id, get: () => fakeVault },
      FILES: { head: () => { began(); return new Promise(() => {}); } },
    } as unknown as Env;
    const pending = app.fetch(new Request("https://resumatic.test/api/export/archive", {
      headers: { cookie: user.cookie }, signal: controller.signal,
    }), mockEnv);
    await entered;
    controller.abort();
    await pending;
    expect(cancelled).toBe(true);
  }, 10_000);

  it("withholds a ZIP header held across a failed session recheck", async () => {
    const user = await signIn();
    let cancelled = false, revoked = false, calls = 0, entered!: () => void, release!: () => void;
    const checking = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const metadata = new TextEncoder().encode(JSON.stringify({ exportedAt: new Date().toISOString(), jsonBytes: 2, files: [] }));
    const prefix = new Uint8Array(4 + metadata.length);
    new DataView(prefix.buffer).setUint32(0, metadata.length, false);
    prefix.set(metadata, 4);
    const fakeVault = {
      exportArchiveStream: async () => {
        let first = true;
        return new Response(new ReadableStream<Uint8Array>({
          pull(out) { if (first) { first = false; out.enqueue(prefix); } else return new Promise<void>(() => {}); },
          cancel() { cancelled = true; },
        }, { highWaterMark: 0 }));
      },
      checkSession: async () => {
        // One preflight check, then a check before and after the ZIP header.
        if (++calls === 3) { entered(); await held; }
        if (revoked) throw new Error("session revoked");
      },
    };
    const mockEnv = { ...env, VAULT: { idFromString: (id: string) => id, get: () => fakeVault } } as unknown as Env;
    const response = await app.fetch(new Request("https://resumatic.test/api/export/archive", {
      headers: { cookie: user.cookie },
    }), mockEnv);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const next = reader.read();
    await checking;
    revoked = true;
    release();
    await expect(next).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(calls).toBe(3);
  }, 10_000);

  it("exports an authenticated snapshot and the matching original in a safe ZIP path", async () => {
    const user = await signIn();
    await user.send("PUT", "/api/profile", { name: "Synthetic Person" });
    const file = await source(user);
    const response = await user.fetch("/api/export/archive");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const data = JSON.parse(new TextDecoder().decode(entries["vault.json"]!));
    expect(data.profile.name).toBe("Synthetic Person");
    const path = `sources/${file.sourceId}.pdf`;
    expect(data.sources[0].file).toBe(path);
    expect(new TextDecoder().decode(entries[path]!)).toBe("original synthetic bytes");
    expect(Object.keys(entries).sort()).toEqual([path, "vault.json"].sort());
    // Older Workers can still consume the legacy object RPC from a new Vault.
    const s = identity(user);
    const legacy = await vault(env, s.vid).exportArchiveSnapshot({ userId: s.uid, gen: s.gen, epoch: s.epoch });
    expect(legacy.data.sources[0]!.file).toBe(`/api/sources/${file.sourceId}/file`);
    expect((await (await signIn()).fetch(`/api/sources/${file.sourceId}/file`)).status).toBe(404);
    expect((await user.fetch("/api/export")).headers.get("content-type")).toContain("application/json");
  });

  it("gives derived OCR records JSON names, including when two records share a storage key", async () => {
    const user = await signIn();
    const file = await source(user);
    await env.FILES.put(file.key, '{"images":[]}');
    const s = identity(user);
    const derived = await vault(env, s.vid).addSource({ userId: s.uid, gen: s.gen, epoch: s.epoch }, {
      filename: "resume.pdf (image transcription)", r2Key: file.key, origin: "ocr", parentSourceId: file.sourceId,
    });
    const response = await user.fetch("/api/export/archive");
    expect(response.status).toBe(200);
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const data = JSON.parse(new TextDecoder().decode(entries["vault.json"]!));
    const originalPath = `sources/${file.sourceId}.pdf`;
    const derivedPath = `sources/${derived.sourceId}.json`;
    expect(data.sources.find((item: { id: string }) => item.id === derived.sourceId).file).toBe(derivedPath);
    expect(new TextDecoder().decode(entries[originalPath]!)).toBe('{"images":[]}');
    expect(new TextDecoder().decode(entries[derivedPath]!)).toBe('{"images":[]}');
  });

  it("keeps JSON and file metadata from the same captured snapshot", async () => {
    const user = await signIn();
    await user.send("PUT", "/api/profile", { name: "Before snapshot" });
    const file = await source(user);
    const response = await user.fetch("/api/export/archive");
    expect(response.status).toBe(200);
    await user.send("PUT", "/api/profile", { name: "After snapshot" });
    const later = await source(user);
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const data = JSON.parse(new TextDecoder().decode(entries["vault.json"]!));
    expect(data.profile.name).toBe("Before snapshot");
    expect(data.sources).toHaveLength(1);
    expect(data.sources[0].file).toBe(`sources/${file.sourceId}.pdf`);
    expect(new TextDecoder().decode(entries[data.sources[0].file]!)).toBe("original synthetic bytes");
    expect(entries[`sources/${later.sourceId}.pdf`]).toBeUndefined();
  });

  it("fails before sending an archive when a source is missing", async () => {
    const user = await signIn();
    const file = await source(user);
    await env.FILES.delete(file.key);
    const response = await user.fetch("/api/export/archive");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "conflict" });
  });

  it("rejects an original that exceeds its per-file limit", async () => {
    const user = await signIn();
    const file = await source(user);
    await env.FILES.put(file.key, new Uint8Array(10 * 1024 * 1024 + 1));
    expect((await user.fetch("/api/export/archive")).status).toBe(413);
  });

  it("rejects more than 128 sources before R2 preflight", async () => {
    const user = await signIn(), s = identity(user);
    await runInDurableObject(vault(env, s.vid), (_instance, state) => {
      state.storage.transactionSync(() => {
        for (let i = 0; i < 129; i++) state.storage.sql.exec(
          `INSERT INTO sources(id,filename,r2_key,state,created_at) VALUES (?,?,?,'ready',?)`,
          `source-${i}`, `synthetic-${i}.pdf`, `vaults/${s.vid}/sources/${i}`, Date.now(),
        );
      });
    });
    const response = await user.fetch("/api/export/archive");
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "too_large" });
  });

  it("does not produce a valid archive when a source changes after metadata preflight", async () => {
    const user = await signIn();
    const file = await source(user);
    const response = await user.fetch("/api/export/archive");
    expect(response.status).toBe(200);
    await env.FILES.put(file.key, "changed after preflight");
    await expect(response.arrayBuffer()).rejects.toThrow();
  });

  it("fails an in-progress archive when the session is revoked", async () => {
    const user = await signIn();
    await source(user);
    const response = await user.fetch("/api/export/archive");
    expect(response.status).toBe(200);
    expect((await user.send("POST", "/api/account/sign-out-everywhere")).status).toBe(204);
    await expect(response.arrayBuffer()).rejects.toThrow();
  });

  it("refuses to stream the JSON after revocation even when there are no sources", async () => {
    const user = await signIn();
    const response = await user.fetch("/api/export/archive");
    expect(response.status).toBe(200);
    expect((await user.send("POST", "/api/account/sign-out-everywhere")).status).toBe(204);
    await expect(response.arrayBuffer()).rejects.toThrow();
  });

  it("fails an unconsumed archive after account deletion starts", async () => {
    const user = await signIn();
    const response = await user.fetch("/api/export/archive");
    expect(response.status).toBe(200);
    expect((await user.send("DELETE", "/auth/account")).status).toBe(202);
    await expect(response.arrayBuffer()).rejects.toThrow();
  });

  it("requires a session", async () => {
    const response = await call("/api/export/archive");
    expect(response.ok).toBe(false);
  });

  it("stops an unconsumed original-file download when the session is revoked", async () => {
    const user = await signIn();
    const file = await source(user);
    const response = await user.fetch(`/api/sources/${file.sourceId}/file`);
    expect(response.status).toBe(200);
    expect((await user.send("POST", "/api/account/sign-out-everywhere")).status).toBe(204);
    await expect(response.arrayBuffer()).rejects.toThrow();
  });
});
