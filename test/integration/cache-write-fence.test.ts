import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { vault } from "../../src/shared/stubs";
import { readSession } from "../../src/worker/session";
import { sha256 } from "../../src/worker/crypto";
import { putExportCache } from "../../src/worker/cache-write";
import { maintenance } from "../../src/worker/maintenance";
import { app } from "../../src/worker/routes";
import { setModels } from "../../src/ai/models";
import { setPdfRenderer } from "../../src/render/pdf";
import { JOB_DESCRIPTION, RESUME, fakeModels, signIn, waitForResume, waitForSource } from "./support";

beforeEach(() => setModels(() => fakeModels()));
afterEach(() => { setModels(null); setPdfRenderer(null); });

async function within<T>(promise: Promise<T>, what: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function account() {
  const user = await signIn();
  const session = await readSession(env.SESSION_KEY, user.cookie.slice("__Host-session=".length));
  if (!session) throw new Error("missing synthetic session");
  const who = { userId: session.uid, gen: session.gen, epoch: session.epoch };
  return { who, vid: session.vid, stub: vault(env, session.vid) };
}

it("waits for each concurrent acknowledged cache put before closing the vault", async () => {
  const { who, stub } = await account();
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const waitFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const waitSecond = new Promise<void>((resolve) => { releaseSecond = resolve; });
  let arrivals = 0;
  let entered!: () => void;
  const bothStarted = new Promise<void>((resolve) => { entered = resolve; });
  const bucket = (wait: Promise<void>) => ({ put: async () => {
    arrivals++;
    if (arrivals === 2) entered();
    await wait;
    return null;
  } } as unknown as Pick<R2Bucket, "put">);
  const first = putExportCache(bucket(waitFirst), stub, who, "one", new Uint8Array([1]), "pdf", true);
  const second = putExportCache(bucket(waitSecond), stub, who, "two", new Uint8Array([2]), "docx", true);
  try {
    await within(Promise.race([bothStarted, first.then(() => { throw new Error("first put ended early"); }), second.then(() => { throw new Error("second put ended early"); })]), "both puts");
    await stub.quiesce();
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.close()).rejects.toThrow("export cache write is unresolved");
      await expect(instance.destroy()).rejects.toThrow("export cache write is unresolved");
    });
    releaseFirst();
    await within(first, "first put");
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.close()).rejects.toThrow("export cache write is unresolved");
    });
    releaseSecond();
    await within(second, "second put");
    expect(await stub.close()).toEqual({ distill: [], tailor: [] });
    await stub.destroy();
    expect(await stub.deletionProbe()).toEqual({ rows: 0 });
  } finally {
    releaseFirst();
    releaseSecond();
    await within(Promise.allSettled([first, second]), "put cleanup", 5000).catch(() => {});
  }
}, 30_000);

it("retains an uncertain put marker through closure and rejects another owner", async () => {
  const { who, vid, stub } = await account();
  const bucket = { put: async () => { throw new Error("unknown R2 outcome"); } } as unknown as Pick<R2Bucket, "put">;
  await expect(putExportCache(bucket, stub, who, "private-resume-name.pdf", new Uint8Array([1]), "pdf", true)).rejects.toThrow("unknown R2 outcome");
  const id = await runInDurableObject(stub, (_instance, state) => state.storage.sql
    .exec<{ attempt_id: string }>(`SELECT attempt_id FROM r2_cache_dispatches`).one().attempt_id);
  const diagnostic = await maintenance.request(`/vaults/${vid}/cache-write-fences`, {}, env);
  expect(diagnostic.status).toBe(200);
  const diagnosticBody = await diagnostic.json();
  expect(diagnosticBody).toMatchObject({ status: "available", total: 1, attempts: [{ id, kind: "pdf" }] });
  expect(JSON.stringify(diagnosticBody)).not.toContain("private-resume-name");
  const denied = await app.fetch(new Request(`https://resumatic.test/admin/vaults/${vid}/cache-write-fences`), env);
  expect(denied.status).toBe(403);
  expect(await denied.text()).not.toContain(id);
  await stub.quiesce();
  await runInDurableObject(stub, async (instance) => {
    expect(() => instance.finishCacheWrite("another-user", id)).toThrow("not this user's vault");
    await expect(instance.close()).rejects.toThrow("export cache write is unresolved");
    await expect(instance.destroy()).rejects.toThrow("export cache write is unresolved");
  });
});

it("settles an acknowledged attempt after sign-out without reopening the old session", async () => {
  const { who, stub } = await account();
  const id = crypto.randomUUID();
  await stub.beginCacheWrite(who, id, "pdf");
  await stub.signOutEverywhere(who);
  await stub.finishCacheWrite(who.userId, id);
  expect(await stub.cacheWriteFences()).toMatchObject({ status: "available", total: 0, attempts: [] });
  await runInDurableObject(stub, async (instance) => {
    await expect(instance.checkSession(who)).rejects.toThrow("signed out");
  });
  expect((await stub.openSession(who.userId)).gen).toBe(who.gen + 1);
});

it("rejects raw object names as correlation metadata before recording an attempt", async () => {
  const { who, stub } = await account();
  await runInDurableObject(stub, (instance) => {
    expect(() => instance.beginCacheWrite(who, crypto.randomUUID(), "pdf", "private-resume-name.pdf")).toThrow("invalid cache write attempt");
  });
  expect(await stub.cacheWriteFences()).toMatchObject({ status: "available", total: 0 });
});

it("correlates unknown puts without treating overwritten metadata as proof", async () => {
  const { who, vid, stub } = await account();
  const key = `vaults/${vid}/exports/private-resume-name.pdf`;
  const digest = Array.from(new Uint8Array(await sha256(key)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  // Simulate the provider accepting bytes while the Worker loses each reply.
  const bucket = { put: async (name: string, value: Uint8Array, options: R2PutOptions) => {
    await env.FILES.put(name, value, options);
    throw new Error("acknowledgement lost");
  } } as unknown as Pick<R2Bucket, "put">;
  try {
    for (const data of [new Uint8Array([1]), new Uint8Array([2])])
      await expect(putExportCache(bucket, stub, who, key, data, "pdf", true)).rejects.toThrow("acknowledgement lost");
    const result = await stub.cacheWriteFences();
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("missing diagnostic");
    expect(result.total).toBe(2);
    expect(result.attempts.every((item) => item.keyDigest === digest)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-resume-name");
    const current = await env.FILES.head(key);
    expect(current).not.toBeNull();
    const observed = current?.customMetadata?.resumatic_cache_attempt;
    expect(result.attempts.filter((item) => item.id === observed)).toHaveLength(1);
    // The second put overwrites metadata from the first. Neither marker may be
    // cleared based on this object or a list result; either put may be delayed.
    await stub.quiesce();
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.close()).rejects.toThrow("export cache write is unresolved");
    });
    expect(await stub.cacheWriteFences()).toMatchObject({ status: "available", total: 2 });
  } finally {
    await env.FILES.delete(key);
  }
});

it.each(["pdf", "docx"] as const)("does not write or return a new %s cache after closure during the legacy R2 lookup", async (kind) => {
  const user = await signIn();
  const session = await readSession(env.SESSION_KEY, user.cookie.slice("__Host-session=".length));
  if (!session) throw new Error("missing synthetic session");
  const stub = vault(env, session.vid);
  const upload = await user.upload("resume.pdf", RESUME);
  const { sourceId } = await upload.json() as { sourceId: string };
  await waitForSource(user, sourceId);
  const { facts } = await user.json("/api/facts");
  const { roles } = await user.json("/api/roles");
  expect((await user.send("POST", "/api/review", { confirm: [...facts, ...roles].map((x: { id: string }) => x.id), reject: [] })).status).toBe(204);
  const created = await user.send("POST", "/api/applications", { jdText: JOB_DESCRIPTION });
  const { applicationId } = await created.json() as { applicationId: string };
  const start = await user.send("POST", `/api/applications/${applicationId}/resumes`);
  const { resumeId } = await start.json() as { resumeId: string };
  await waitForResume(user, resumeId);
  setPdfRenderer(async () => new TextEncoder().encode("%PDF-1.7 synthetic"));
  let release!: () => void;
  let notify!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { notify = resolve; });
  const put = vi.fn(async () => null);
  const files = { get: async () => { notify(); await waiting; return null; }, put, delete: async () => {} };
  const bindings = { ...env, FILES: files, R2_CACHE_FENCE_ENABLED: "true" } as unknown as Env;
  const request = Promise.resolve(app.fetch(new Request(`https://resumatic.test/api/resumes/${resumeId}/${kind}`, { headers: { cookie: user.cookie } }), bindings));
  try {
    await within(Promise.race([entered, request.then((response) => { throw new Error(`request finished before lookup: ${response.status}`); })]), "legacy cache lookup");
    await stub.quiesce();
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM r2_cache_dispatches`).one().n).toBe(0);
      expect(state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM export_cache`).one().n).toBe(0);
    });
    release();
    expect((await within(request, "cache response")).status).toBe(410);
    expect(put).not.toHaveBeenCalled();
    expect(await stub.close()).toEqual({ distill: [sourceId], tailor: [resumeId] });
  } finally {
    release();
    await within(request, "route cleanup", 5000).catch(() => {});
  }
}, 30_000);
