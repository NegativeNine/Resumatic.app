import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { directoryForSignIn, settleRoutedPlacement } from "../../src/directory/routing";
import type { Directory } from "../../src/directory/directory";
import { allDirectories, directory, directoryForUser, vault } from "../../src/shared/stubs";
import type { SignInInput } from "../../src/shared/types";
import { eventually } from "./support";
import { app } from "../../src/worker/routes";
import { nowSeconds, rsaSigner } from "../support/keys";

const input = (): SignInInput => {
  const email = `placement-${crypto.randomUUID()}@placement.invalid`;
  return { provider: "test", subject: email, email, hint: "enam" };
};
const configured = (shards: "1" | "16"): Env => ({ ...env, DIRECTORY_SHARDS: shards, PLACEMENT_FENCE_ENABLED: "true" });

async function signIn(p: SignInInput, shards: "1" | "16") {
  const bindings = configured(shards);
  const routed = await directoryForSignIn(bindings, p);
  let account: { userId: string; vaultId: string };
  try { account = await routed.directory.signIn(routed.input); }
  finally { await settleRoutedPlacement(bindings, routed.directory, routed.input); }
  await directory(env).bindIdentityHome(p.provider, p.subject, account.userId);
  return { ...account, routed };
}

describe("experimental synthetic placement fencing", () => {
  it.each([["1", "16"], ["16", "1"]] as const)("seals a held creation before deletion across %s to %s placement", async (oldShards, newShards) => {
    const p = input();
    const held = await directoryForSignIn(configured(oldShards), p);
    const old = await signIn(p, oldShards);
    const home = directoryForUser(env, old.userId);
    await home.deleteAccount(old.userId, old.vaultId);
    await runDurableObjectAlarm(home);
    await eventually(async () => !(await home.existingIdentity(p.provider, p.subject)), "old synthetic account erasure");
    const replacement = await signIn(p, newShards);
    expect(replacement.userId).not.toBe(old.userId);
    await runInDurableObject(held.directory, async (instance) => {
      await expect((instance as Directory).signIn(held.input)).rejects.toThrow("placement attempt was closed");
    });
    const locations = await Promise.all([...allDirectories(env)].map((d) => d.existingIdentity(p.provider, p.subject)));
    expect(locations.filter(Boolean)).toEqual([{ userId: replacement.userId, vaultId: replacement.vaultId }]);
    expect(await home.deletionProbe(old.userId, old.vaultId)).toBe(0);
    const receipt = await runInDurableObject(held.directory, (_instance, state) => state.storage.sql.exec<{ state: string; user_id: string | null }>(`SELECT state,user_id FROM placement_receipts WHERE attempt_id=?`, held.input.placementAttempt!.id).one());
    expect(receipt).toEqual({ state: "sealed", user_id: null });
  }, 30_000);

  it("seals an accepted dispatch whose acknowledgement was lost before deleting", async () => {
    const p = input();
    const held = await directoryForSignIn(configured("16"), p);
    const accepted = await held.directory.signIn(held.input);
    // A second sign-in can bind the account even though the first caller died.
    const retry = await signIn(p, "16");
    expect(retry.userId).toBe(accepted.userId);
    const home = directoryForUser(env, accepted.userId);
    await home.deleteAccount(accepted.userId, accepted.vaultId);
    await runDurableObjectAlarm(home);
    await eventually(async () => !(await home.existingIdentity(p.provider, p.subject)), "accepted synthetic account erasure");
    await runInDurableObject(held.directory, async (instance) => {
      await expect((instance as Directory).signIn(held.input)).rejects.toThrow("placement attempt was closed");
    });
    expect(await home.deletionProbe(accepted.userId, accepted.vaultId)).toBe(0);
    const receipt = await runInDurableObject(held.directory, (_instance, state) => state.storage.sql.exec<{ state: string; user_id: string | null }>(`SELECT state,user_id FROM placement_receipts WHERE attempt_id=?`, held.input.placementAttempt!.id).one());
    expect(receipt).toEqual({ state: "sealed", user_id: null });
  }, 30_000);

  it("reconciles an unstarted dispatch without allowing its later arrival", async () => {
    const p = input();
    const held = await directoryForSignIn(configured("1"), p);
    expect(await directory(env).reconcileSyntheticPlacement(p.provider, p.subject)).toEqual({ remaining: 0 });
    await runInDurableObject(held.directory, async (instance) => {
      await expect((instance as Directory).signIn(held.input)).rejects.toThrow("placement attempt was closed");
    });
    const account = await signIn(p, "1");
    expect(account.userId).toBeTruthy();
  }, 30_000);

  it("bounds unresolved attempts and can reconcile the whole synthetic backlog", async () => {
    const p = input();
    const global = directory(env);
    for (let i = 0; i < 128; i++) await global.reservePlacementAttempt(p.provider, p.subject, null);
    await runInDurableObject(global, async (instance) => {
      await expect((instance as Directory).reservePlacementAttempt(p.provider, p.subject, null)).rejects.toThrow("too many pending sign-in attempts");
    });
    expect(await global.reconcileSyntheticPlacement(p.provider, p.subject)).toEqual({ remaining: 0 });
    expect(await global.reservePlacementAttempt(p.provider, p.subject, null)).toMatchObject({ shard: null });
    expect(await global.reconcileSyntheticPlacement(p.provider, p.subject)).toEqual({ remaining: 0 });
  }, 30_000);

  it("closes and releases an orphan only after sealing pending dispatches, with safe retry", async () => {
    const p = input();
    const held = await directoryForSignIn(configured("16"), p);
    const global = directory(env);
    const generation = held.input.placementAttempt!.generation;
    expect(await global.inspectSyntheticPlacement(p.provider, p.subject)).toMatchObject({ generation, bound: false, pending: 1 });
    expect(await global.cleanupSyntheticOrphan(p.provider, p.subject, generation)).toEqual({ status: "released" });
    await runInDurableObject(held.directory, async (instance) => {
      await expect((instance as Directory).signIn(held.input)).rejects.toThrow("placement attempt was closed");
    });
    const replacement = await signIn(p, "1");
    expect(replacement.routed.input.placementAttempt!.generation).not.toBe(generation);
    // A lost cleanup acknowledgement must not delete the replacement claim.
    expect(await global.cleanupSyntheticOrphan(p.provider, p.subject, generation)).toEqual({ status: "released" });
    expect(await global.inspectSyntheticPlacement(p.provider, p.subject)).toMatchObject({ generation: replacement.routed.input.placementAttempt!.generation, bound: true, state: "open" });
    expect((await signIn(p, "1")).userId).toBe(replacement.userId);
  }, 30_000);

  it("keeps and reopens an account that was accepted before orphan cleanup", async () => {
    const p = input();
    const held = await directoryForSignIn(configured("16"), p);
    const account = await held.directory.signIn(held.input);
    const generation = held.input.placementAttempt!.generation;
    const global = directory(env);
    expect(await global.inspectSyntheticPlacement(p.provider, p.subject)).toMatchObject({ generation, bound: false, pending: 1 });
    expect(await global.cleanupSyntheticOrphan(p.provider, p.subject, generation)).toEqual({ status: "account-present" });
    expect(await global.inspectSyntheticPlacement(p.provider, p.subject)).toMatchObject({ generation, bound: true, state: "open", pending: 0 });
    expect((await signIn(p, "16")).userId).toBe(account.userId);
    const home = directoryForUser(env, account.userId);
    await home.deleteAccount(account.userId, account.vaultId);
    await runDurableObjectAlarm(home);
    await eventually(async () => !(await home.existingIdentity(p.provider, p.subject)), "orphan recovery account deletion");
    expect(await home.deletionProbe(account.userId, account.vaultId)).toBe(0);
  }, 30_000);

  it("resumes orphan cleanup after a sealed target acknowledgement is lost", async () => {
    const p = input();
    const held = await directoryForSignIn(configured("1"), p);
    const generation = held.input.placementAttempt!.generation;
    const global = directory(env);
    // Model a crash after atomically closing the global generation and sealing
    // the target but before the coordinator receives the seal acknowledgement.
    await runInDurableObject(global, (_instance, state) => state.storage.sql.exec(`UPDATE identity_homes SET placement_state='orphan' WHERE provider=? AND subject=? AND generation=?`, p.provider, p.subject, generation));
    await held.directory.sealPlacementAttempt(held.input.placementAttempt!);
    expect(await global.cleanupSyntheticOrphan(p.provider, p.subject, generation)).toEqual({ status: "released" });
    expect(await global.inspectSyntheticPlacement(p.provider, p.subject)).toBeNull();
  }, 30_000);

  it("never reopens orphan cleanup after account deletion closes the generation", async () => {
    const p = input();
    const held = await directoryForSignIn(configured("16"), p);
    const account = await held.directory.signIn(held.input);
    const attempt = held.input.placementAttempt!;
    const global = directory(env);
    await runInDurableObject(global, (instance) => {
      const placement = (instance as unknown as { placement: { beginOrphanCleanup: (provider: string, subject: string, generation: string) => unknown } }).placement;
      placement.beginOrphanCleanup(p.provider, p.subject, attempt.generation);
    });
    const sealed = await held.directory.sealPlacementAttempt(attempt);
    await global.settlePlacementAttempt(p.provider, p.subject, attempt, sealed.userId);
    expect(await global.closePlacementHome(p.provider, p.subject, attempt.generation, account.userId)).toEqual([]);
    await runInDurableObject(global, async (instance) => {
      await expect((instance as Directory).cleanupSyntheticOrphan(p.provider, p.subject, attempt.generation)).rejects.toThrow("deletion is in progress");
      const placement = (instance as unknown as { placement: { finishOrphanCleanup: (provider: string, subject: string, generation: string) => unknown } }).placement;
      expect(() => placement.finishOrphanCleanup(p.provider, p.subject, attempt.generation)).toThrow("placement generation changed");
    });
    expect(await global.inspectSyntheticPlacement(p.provider, p.subject)).toMatchObject({ state: "closing", bound: true });
    const home = directoryForUser(env, account.userId);
    await home.deleteAccount(account.userId, account.vaultId);
    await runDurableObjectAlarm(home);
    await eventually(async () => !(await home.existingIdentity(p.provider, p.subject)), "orphan interleaving deletion");
    expect(await home.deletionProbe(account.userId, account.vaultId)).toBe(0);
  }, 30_000);

  it("retries lost target-seal and coordinator-settlement acknowledgements", async () => {
    const p = input();
    const held = await directoryForSignIn(configured("16"), p);
    const attempt = held.input.placementAttempt!;
    const firstSeal = await held.directory.sealPlacementAttempt(attempt);
    expect(firstSeal).toEqual({ userId: null });
    // The first response may be lost; the same durable tombstone is returned.
    expect(await held.directory.sealPlacementAttempt(attempt)).toEqual(firstSeal);
    await directory(env).settlePlacementAttempt(p.provider, p.subject, attempt, firstSeal.userId);
    await directory(env).settlePlacementAttempt(p.provider, p.subject, attempt, firstSeal.userId);
    expect(await directory(env).reconcileSyntheticPlacement(p.provider, p.subject)).toEqual({ remaining: 0 });
    await runInDurableObject(held.directory, async (instance) => {
      await expect((instance as Directory).signIn(held.input)).rejects.toThrow("placement attempt was closed");
    });
  }, 30_000);

  it("retries a lost generation-close acknowledgement without reopening creation", async () => {
    const p = input();
    const held = await directoryForSignIn(configured("16"), p);
    const account = await signIn(p, "16");
    const gen = held.input.placementAttempt!.generation;
    const global = directory(env);
    const first = await global.closePlacementHome(p.provider, p.subject, gen, account.userId);
    expect(first).toEqual([held.input.placementAttempt]);
    expect(await global.closePlacementHome(p.provider, p.subject, gen, account.userId)).toEqual(first);
    await runInDurableObject(global, async (instance) => {
      await expect((instance as Directory).reservePlacementAttempt(p.provider, p.subject, held.input.placementAttempt!.shard)).rejects.toThrow("deletion is in progress");
    });
    const sealed = await held.directory.sealPlacementAttempt(held.input.placementAttempt!);
    await global.settlePlacementAttempt(p.provider, p.subject, held.input.placementAttempt!, sealed.userId);
    const home = directoryForUser(env, account.userId);
    await home.deleteAccount(account.userId, account.vaultId);
    await runDurableObjectAlarm(home);
    await eventually(async () => !(await home.existingIdentity(p.provider, p.subject)), "closed generation deletion");
    expect(await home.deletionProbe(account.userId, account.vaultId)).toBe(0);
  }, 30_000);

  it("refuses an old direct bind until a registered target receipt is sealed", async () => {
    const p = input();
    const routed = await directoryForSignIn(configured("16"), p);
    const global = directory(env);
    const staleUser = `s${routed.input.placementAttempt!.shard}:obsolete`;
    await runInDurableObject(global, async (instance) => {
      await expect((instance as Directory).bindIdentityHome(p.provider, p.subject, staleUser)).rejects.toThrow("registered placement must be settled");
    });
    const account = await routed.directory.signIn(routed.input);
    await settleRoutedPlacement(configured("16"), routed.directory, routed.input);
    await global.bindIdentityHome(p.provider, p.subject, account.userId);
    expect((await signIn(p, "16")).userId).toBe(account.userId);
  }, 30_000);

  it("does not let raw protocol methods modify real identities", async () => {
    const global = directory(env);
    await runInDurableObject(global, async (instance) => {
      await expect((instance as Directory).reservePlacementAttempt("google", "real-subject", null)).rejects.toThrow("restricted to synthetic");
      await expect((instance as Directory).reconcileSyntheticPlacement("google", "real-subject")).rejects.toThrow("restricted to synthetic");
    });
  });

  it("does not leave a legacy claim when the experimental gate is off", async () => {
    const p = input();
    await expect(directoryForSignIn({ ...env, PLACEMENT_FENCE_ENABLED: "false" }, p)).rejects.toThrow("requires the experimental staging gate");
    const rows = await runInDurableObject(directory(env), (_instance, state) => state.storage.sql.exec(`SELECT subject FROM identity_homes WHERE provider=? AND subject=?`, p.provider, p.subject).toArray());
    expect(rows).toEqual([]);
  });

  it("protects reconciliation with Access and reports malformed input as invalid", async () => {
    const bindings = configured("1");
    const request = (body: string, token?: string, path = "reconcile") => app.fetch(new Request(`https://resumatic.test/admin/placement/${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(token ? { "cf-access-jwt-assertion": token } : {}) }, body,
    }), bindings);
    expect((await request("{}" )).status).toBe(403);
    const signer = await rsaSigner();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      return url === `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs` ? Response.json(signer.jwks) : new Response("unexpected", { status: 599 });
    });
    try {
      const token = await signer.sign({ iss: env.ACCESS_TEAM_DOMAIN, aud: [env.ACCESS_AUD], email: "admin@example.com", exp: nowSeconds() + 600 });
      for (const body of ["{", JSON.stringify({ subject: "real-person@example.com" })]) {
        const response = await request(body, token);
        expect(response.status).toBe(422);
        expect((await response.json()) as { error: string }).toMatchObject({ error: "invalid" });
      }
      const p = input();
      const held = await directoryForSignIn(bindings, p);
      const response = await request(JSON.stringify({ subject: p.subject.toUpperCase() }), token);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ remaining: 0 });
      await runInDurableObject(held.directory, async (instance) => {
        await expect((instance as Directory).signIn(held.input)).rejects.toThrow("placement attempt was closed");
      });
      const status = await request(JSON.stringify({ subject: p.subject }), token, "inspect");
      expect(status.status).toBe(200);
      const { generation } = await status.json() as { generation: string };
      const cleanup = await request(JSON.stringify({ subject: p.subject, generation }), token, "cleanup-orphan");
      expect(cleanup.status).toBe(200);
      expect(await cleanup.json()).toEqual({ status: "released" });
    } finally { vi.unstubAllGlobals(); }
  });

  it("recovers a reservation whose response was lost before dispatch", async () => {
    const p = input();
    const shard = 3;
    // The caller loses this reservation response and never dispatches it.
    const lost = await directory(env).reservePlacementAttempt(p.provider, p.subject, shard);
    const account = await signIn(p, "16");
    expect(account.routed.input.homeShard).toBe(shard);
    const home = directoryForUser(env, account.userId);
    await home.deleteAccount(account.userId, account.vaultId);
    await runDurableObjectAlarm(home);
    await eventually(async () => !(await home.existingIdentity(p.provider, p.subject)), "synthetic reservation erasure");
    await runInDurableObject(home, async (instance) => {
      await expect((instance as Directory).signIn({ ...p, homeShard: shard, inviteAuthorized: true, placementAttempt: lost })).rejects.toThrow("placement attempt was closed");
    });
    expect(await home.deletionProbe(account.userId, account.vaultId)).toBe(0);
  }, 30_000);

  it.each(["1", "16"] as const)("retries a lost global release acknowledgement on %s-shard placement", async (shards) => {
    const p = input();
    const account = await signIn(p, shards);
    const home = directoryForUser(env, account.userId);
    const generation = account.routed.input.placementAttempt!.generation;
    await home.deleteAccount(account.userId, account.vaultId);
    // Model completed vault erasure and an outbox commit before the process
    // lost its global release response. The opaque release receipt is durable.
    await vault(env, account.vaultId).quiesce();
    await vault(env, account.vaultId).destroy();
    expect(await directory(env).closePlacementHome(p.provider, p.subject, generation, account.userId)).toEqual([]);
    await runInDurableObject(home, (_instance, state) => {
      const sql = state.storage.sql;
      state.storage.transactionSync(() => {
        sql.exec(`UPDATE vaults SET state='swept',swept_at=0 WHERE vault_id=?`, account.vaultId);
        sql.exec(`INSERT INTO placement_finalizations(user_id,vault_id,provider,subject,generation) VALUES (?,?,?,?,?)`, account.userId, account.vaultId, p.provider, p.subject, generation);
        sql.exec(`DELETE FROM placement_identities WHERE provider=? AND subject=?`, p.provider, p.subject);
        sql.exec(`DELETE FROM identities WHERE user_id=?`, account.userId);
        sql.exec(`UPDATE placement_receipts SET user_id=NULL WHERE user_id=? AND state='sealed'`, account.userId);
      });
    });
    await directory(env).releasePlacementHome(p.provider, p.subject, generation, account.userId);
    const replacement = await signIn(p, shards === "1" ? "16" : "1");
    await runDurableObjectAlarm(home);
    expect(await home.deletionProbe(account.userId, account.vaultId)).toBe(0);
    const locations = await Promise.all([...allDirectories(env)].map((d) => d.existingIdentity(p.provider, p.subject)));
    expect(locations.filter(Boolean)).toEqual([{ userId: replacement.userId, vaultId: replacement.vaultId }]);
  }, 30_000);

  it("quarantines an untracked synthetic creation and resumes legacy cleanup only after opting out", async () => {
    const p = input();
    const stub = env.DIRECTORY.getByName(`placement-test-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance, state) => {
      const local = (instance as unknown as { env: Env }).env;
      const prior = local.PLACEMENT_FENCE_ENABLED;
      try {
        local.PLACEMENT_FENCE_ENABLED = "true";
        await expect((instance as Directory).signIn(p)).rejects.toThrow("registered placement attempt");
        local.PLACEMENT_FENCE_ENABLED = "false";
        await expect((instance as Directory).signIn(p)).rejects.toThrow("registered placement attempt");
        // Simulate a legacy test identity created by code predating this gate.
        const legacy = { ...p, subject: `legacy-${crypto.randomUUID()}@example.test`, email: `legacy-${crypto.randomUUID()}@example.test` };
        const account = await (instance as Directory).signIn(legacy);
        state.storage.sql.exec(`UPDATE identities SET subject=? WHERE provider=? AND subject=?`, p.subject, legacy.provider, legacy.subject);
        state.storage.sql.exec(`UPDATE users SET email=? WHERE user_id=?`, p.email, account.userId);
        local.PLACEMENT_FENCE_ENABLED = "true";
        await (instance as Directory).deleteAccount(account.userId, account.vaultId);
        await (instance as Directory).alarm();
        expect(await (instance as Directory).hasVault(account.vaultId)).toBe(true);
        local.PLACEMENT_FENCE_ENABLED = "false";
        await (instance as Directory).alarm();
        expect(await (instance as Directory).hasVault(account.vaultId)).toBe(false);
        expect(await (instance as Directory).deletionProbe(account.userId, account.vaultId)).toBe(0);
      } finally {
        local.PLACEMENT_FENCE_ENABLED = prior;
      }
    });
  }, 30_000);
});
