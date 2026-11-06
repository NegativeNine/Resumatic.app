import { env } from "cloudflare:workers";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";
import { fromBase64url } from "../../src/worker/crypto";
import { call, signIn, type User } from "./support";

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
});
