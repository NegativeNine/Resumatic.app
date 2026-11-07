import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setModels } from "../../src/ai/models";
import { directory } from "../../src/shared/stubs";
import { vaultPrefix } from "../../src/shared/r2";
import { Vault } from "../../src/vault/vault";
import { eventually, fakeModels, RESUME, signIn } from "./support";

beforeEach(() => setModels(() => fakeModels()));
afterEach(() => {
  vi.restoreAllMocks();
  setModels(null);
});

it("removes a late acknowledged upload after both account deletion sweeps", async () => {
  const user = await signIn();
  const body = user.cookie
    .slice("__Host-session=".length)
    .split(".")[0]!
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const payload = JSON.parse(atob(body + "===".slice((body.length + 3) % 4)));
  let release!: () => void;
  let arrived!: (key: string) => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<string>((resolve) => {
    arrived = resolve;
  });
  const original = Vault.prototype.completeUpload;
  vi.spyOn(Vault.prototype, "completeUpload").mockImplementation(
    async function (this: Vault, who, descriptor) {
      arrived(descriptor.r2Key);
      await held;
      return original.call(this, who, descriptor);
    },
  );

  const upload = user.upload("late.pdf", RESUME);
  try {
    const key = await entered; // The Worker has put the object but not yet committed the reservation.
    expect((await user.send("DELETE", "/auth/account")).status).toBe(202);
    // Another alarm may already be running under the full suite. Wait for the
    // Directory to forget this vault, which happens only after both sweeps.
    await eventually(async () => {
      await runDurableObjectAlarm(directory(env));
      return (
        !(await directory(env).hasVault(payload.vid)) &&
        (await env.FILES.list({ prefix: vaultPrefix(payload.vid) })).objects
          .length === 0
      );
    }, "both deletion sweeps");
    // Model an R2 put whose acknowledgement arrives only after both sweeps.
    await env.FILES.put(key, RESUME);
    expect(await env.FILES.head(key)).not.toBeNull();
    release();
    const result = await upload;
    expect(result.status).toBe(410);
    expect(await env.FILES.head(key)).toBeNull();
  } finally {
    release();
    await upload.catch(() => {});
  }
});
