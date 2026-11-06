import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { vault } from "../../src/shared/stubs";
import { readSession } from "../../src/worker/session";
import { app } from "../../src/worker/routes";
import { signIn } from "./support";

it("keeps new and replayed reservation results stable when nothing changes", async () => {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  const who = { userId: "upload-owner", gen: 1 };
  await stub.init(who.userId);
  const input = {
    requestKey: "upload-replay",
    descriptorDigest: "a".repeat(64),
    filename: "synthetic.pdf",
    r2Key: `vaults/${stub.id}/sources/upload-replay`,
    byteLength: 4,
    contentType: "application/pdf",
  };
  const first = await stub.reserveUpload(who, input);
  const retry = await stub.reserveUpload(who, input);
  expect(first.replay).toBe(false);
  expect(retry.replay).toBe(true);
  expect(retry.intent).toEqual(first.intent);
});

it.each(["close", "sign-out", "destroy"] as const)(
  "does not return a put authorization when the vault changes during alarm scheduling: %s",
  async (change) => {
    const stub = env.VAULT.get(env.VAULT.newUniqueId());
    const who = { userId: "upload-owner", gen: 1 };
    await stub.init(who.userId);
    await runInDurableObject(stub, async (instance) => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const internal = instance as unknown as { scheduleRunAlarm(at: number): Promise<void> };
      const schedule = vi.spyOn(internal, "scheduleRunAlarm").mockImplementation(async () => {
        entered();
        await held;
      });
      const input = {
        requestKey: "upload-race",
        descriptorDigest: "a".repeat(64),
        filename: "synthetic.pdf",
        r2Key: `vaults/${stub.id}/sources/upload-race`,
        byteLength: 4,
        contentType: "application/pdf",
      };
      const result = instance.reserveUpload(who, input).then(() => null, (error: Error) => error);
      try {
        await started;
        if (change === "close") instance.quiesce();
        else if (change === "sign-out") await instance.signOutEverywhere(who);
        else await instance.destroy();
        release();
        expect((await result)?.message).toMatch(change === "sign-out" ? /signed out/ : /gone:/);
      } finally {
        release();
        await result;
        schedule.mockRestore();
      }
    });
  },
);

it.each(["close", "expired", "completed"] as const)("does not dispatch an upload put when the reservation changes before it returns: %s", async (change) => {
  const user = await signIn();
  const session = await readSession(env.SESSION_KEY, user.cookie.slice("__Host-session=".length));
  if (!session) throw new Error("missing session");
  const stub = vault(env, session.vid);
  await runInDurableObject(stub, async (instance, state) => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const internal = instance as unknown as { scheduleRunAlarm(at: number): Promise<void> };
    const schedule = vi.spyOn(internal, "scheduleRunAlarm").mockImplementation(async () => {
      entered();
      await held;
    });
    const put = vi.fn(async () => null);
    const local = (instance as unknown as { env: Env }).env;
    const originalFiles = local.FILES;
    local.FILES = { put } as unknown as R2Bucket;
    const form = new FormData();
    form.set("file", new File(["synthetic"], "resume.pdf", { type: "application/pdf" }));
    const request = Promise.resolve(app.fetch(new Request("https://resumatic.test/api/sources", {
      method: "POST",
      headers: { cookie: user.cookie },
      body: form,
    }), env));
    try {
      await Promise.race([
        started,
        request.then((response) => { throw new Error(`upload finished before scheduling: ${response.status}`); }),
      ]);
      if (change === "close") instance.quiesce();
      else if (change === "expired")
        state.storage.sql.exec(`UPDATE upload_intents SET expires_at=0 WHERE state='pending'`);
      else state.storage.transactionSync(() => {
        // Model a concurrent retry's atomic source and intent commit while the
        // first reservation is waiting to finish scheduling its alarm.
        state.storage.sql.exec(`INSERT INTO sources(id,filename,r2_key,state,created_at)
          SELECT source_id,filename,r2_key,'queued',created_at FROM upload_intents WHERE state='pending'`);
        state.storage.sql.exec(`UPDATE upload_intents SET state='complete' WHERE state='pending'`);
      });
      release();
      expect((await request).status).toBe(change === "close" ? 410 : change === "expired" ? 409 : 201);
      expect(put).not.toHaveBeenCalled();
    } finally {
      release();
      await request.catch(() => {});
      schedule.mockRestore();
      local.FILES = originalFiles;
    }
  });
}, 20_000);
