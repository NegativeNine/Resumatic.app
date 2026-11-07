import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directoryForSignIn } from "../../src/directory/routing";
import { directory } from "../../src/shared/stubs";
import type { SignInInput } from "../../src/shared/types";
import { eventually } from "./support";

// A callback issued before deletion cannot recreate or attach to a later global account.
// All identities and Durable Objects are local and disposable.
it("does not recreate a global account when an old public sign-in resumes after deletion", async () => {
  const nonce = crypto.randomUUID();
  const input: SignInInput = {
    provider: "google",
    subject: `global-open-${nonce}`,
    email: `global-open-${nonce}@example.test`,
    hint: "enam",
    // Model a Google authorization that is still valid at every step.
    authExpiryMs: Date.now() + 10 * 60_000,
    authEpoch: await directory(env).googleAuthEpoch(),
  };
  const global = directory(env);
  let previous: string | undefined;
  await runInDurableObject(global, async (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    previous = local.INVITE_ONLY;
    local.INVITE_ONLY = "false";
  });
  try {
    const publicBindings = { ...env, INVITE_ONLY: "false", DIRECTORY_SHARDS: "1" };
    // The first authorization already chose the global home, but has not yet
    // reached its signIn RPC when a later sign-in and deletion complete.
    const held = await directoryForSignIn(publicBindings, input);
    const first = await directoryForSignIn(publicBindings, input);
    expect(held.input.expectedUserId).toBeUndefined();
    const account = await first.directory.signIn(first.input);
    await global.bindIdentityHome(input.provider, input.subject, account.userId, input.authEpoch);
    await global.deleteAccount(account.userId, account.vaultId);
    await runDurableObjectAlarm(global);
    await eventually(async () => !(await global.existingIdentity(input.provider, input.subject)), "global identity erasure");
    await runInDurableObject(held.directory, async (instance) => {
      await expect((instance as Directory).signIn(held.input)).rejects.toThrow("sign-in is stale");
    });
    expect(await global.existingIdentity(input.provider, input.subject)).toBeNull();
    const freshInput = { ...input, authEpoch: await global.googleAuthEpoch() };
    const fresh = await directoryForSignIn(publicBindings, freshInput);
    const replacement = await fresh.directory.signIn(fresh.input);
    await global.bindIdentityHome(input.provider, input.subject, replacement.userId, freshInput.authEpoch);
    await runInDurableObject(held.directory, async (instance) => {
      await expect((instance as Directory).signIn(held.input)).rejects.toThrow("sign-in is stale");
    });
    expect(await global.existingIdentity(input.provider, input.subject)).toEqual(replacement);
  } finally {
    await runInDurableObject(global, async (instance) => {
      (instance as unknown as { env: Env }).env.INVITE_ONLY = previous!;
    });
  }
}, 30_000);

it("rejects legacy writes and keeps guarded marker transaction-local", async () => {
  const global = directory(env);
  const id = crypto.randomUUID();
  const input: SignInInput = { provider: "google", subject: `legacy-${id}`, email: `legacy-${id}@example.test`, hint: "enam", authEpoch: await global.googleAuthEpoch() };
  await global.addInvite(input.email);
  await runInDurableObject(global, async (instance, state) => {
    // Older code has no transaction marker even if it remains callable.
    expect(() => state.storage.sql.exec(`INSERT INTO identities(provider,subject,user_id) VALUES ('google',?,'legacy')`, input.subject)).toThrow(/global_auth_required/);
    expect(() => state.storage.sql.exec(`INSERT INTO identity_homes(provider,subject,shard) VALUES ('google',?,NULL)`, input.subject)).toThrow(/global_auth_required/);
    expect(() => state.storage.sql.exec(`INSERT OR IGNORE INTO identity_homes(provider,subject,shard) VALUES ('google',?,NULL)`, input.subject)).toThrow(/global_auth_required/);
    await expect(instance.claimIdentityHome(input.provider, input.subject, null, input.email)).rejects.toThrow("sign-in is stale");
    expect(state.storage.sql.exec(`SELECT slot FROM global_auth_marker`).toArray()).toHaveLength(0);
  });
  const target = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, input);
  const account = await target.directory.signIn(target.input);
  await global.bindIdentityHome(input.provider, input.subject, account.userId, input.authEpoch);
  await runInDurableObject(global, (_instance, state) => {
    expect(state.storage.sql.exec(`SELECT slot FROM global_auth_marker`).toArray()).toHaveLength(0);
    expect(() => state.storage.sql.exec(`UPDATE identity_homes SET user_id='other' WHERE provider=? AND subject=?`, input.provider, input.subject)).toThrow(/global_auth_required/);
  });
});

it("rejects stale home claims and bindings before they change placement", async () => {
  const global = directory(env);
  const nonce = crypto.randomUUID();
  const epoch = await global.googleAuthEpoch();
  const input: SignInInput = {
    provider: "google",
    subject: `bind-${nonce}`,
    email: `bind-${nonce}@example.test`,
    hint: "enam",
    authEpoch: epoch,
  };
  await global.addInvite(input.email);
  await global.claimIdentityHome(input.provider, input.subject, null, input.email, undefined, epoch);
  const account = await global.signIn(input);
  const other = await global.signIn({
    provider: "test", subject: `other-${nonce}`, email: `other-${nonce}@example.test`, hint: "enam",
  });
  await global.deleteAccount(other.userId, other.vaultId);
  const newSubject = `new-${nonce}`;
  const newEmail = `new-${nonce}@example.test`;
  await global.addInvite(newEmail);
  await runInDurableObject(global, async (instance, state) => {
    await expect(instance.claimIdentityHome("google", newSubject, null, newEmail, undefined, epoch))
      .rejects.toThrow("sign-in is stale");
    await expect(instance.bindIdentityHome(input.provider, input.subject, account.userId, epoch))
      .rejects.toThrow("sign-in is stale");
    expect(state.storage.sql.exec(`SELECT subject FROM identity_homes WHERE provider='google' AND subject=?`, newSubject).toArray()).toHaveLength(0);
    expect(state.storage.sql.exec<{user_id: string | null}>(`SELECT user_id FROM identity_homes WHERE provider=? AND subject=?`, input.provider, input.subject).one().user_id).toBeNull();
  });
  const current = await global.googleAuthEpoch();
  await global.claimIdentityHome("google", newSubject, null, newEmail, undefined, current);
  await global.bindIdentityHome(input.provider, input.subject, account.userId, current);
  await runInDurableObject(global, (_instance, state) => {
    expect(state.storage.sql.exec<{user_id: string | null}>(`SELECT user_id FROM identity_homes WHERE provider=? AND subject=?`, input.provider, input.subject).one().user_id).toBe(account.userId);
  });
});

it("does not start deletion when the epoch is missing, malformed or overflowed", async () => {
  const global = directory(env);
  const id = crypto.randomUUID();
  const input: SignInInput = { provider: "google", subject: `corrupt-${id}`, email: `corrupt-${id}@example.test`, hint: "enam", authEpoch: await global.googleAuthEpoch() };
  await global.addInvite(input.email);
  const account = await global.signIn(input);
  await runInDurableObject(global, async (instance, state) => {
    const sql = state.storage.sql;
    const original = sql.exec<{value: string}>(`SELECT value FROM meta WHERE key='global_auth_epoch'`).one().value;
    const alarm = await state.storage.getAlarm();
    try {
      for (const invalid of [null, "invalid", "9007199254740991"]) {
        sql.exec(`DELETE FROM meta WHERE key='global_auth_epoch'`);
        if (invalid !== null) sql.exec(`INSERT INTO meta(key,value) VALUES ('global_auth_epoch',?)`, invalid);
        await expect(instance.deleteAccount(account.userId, account.vaultId)).rejects.toThrow(/global_auth_epoch_invalid/);
        expect(sql.exec<{state:string}>(`SELECT state FROM users WHERE user_id=?`, account.userId).one().state).toBe("active");
        expect(await state.storage.getAlarm()).toBe(alarm);
      }
    } finally {
      sql.exec(`INSERT INTO meta(key,value) VALUES ('global_auth_epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, original);
    }
  });
});

it("invalidates authorizations issued while a pre-migration deletion is still pending", async () => {
  const global = directory(env);
  const id = crypto.randomUUID();
  const input: SignInInput = { provider: "google", subject: `inflight-${id}`, email: `inflight-${id}@example.test`, hint: "enam", authEpoch: await global.googleAuthEpoch() };
  await global.addInvite(input.email);
  const account = await global.signIn(input);
  // Model an account that entered deletion before the new migration existed.
  await runInDurableObject(global, async (instance, state) => {
    state.storage.sql.exec(`UPDATE meta SET value='0' WHERE key='global_auth_guard'`);
    try { await instance.deleteAccount(account.userId, account.vaultId); }
    finally { state.storage.sql.exec(`UPDATE meta SET value='1' WHERE key='global_auth_guard'`); }
  });
  const held = { ...input, authEpoch: await global.googleAuthEpoch() };
  await runDurableObjectAlarm(global);
  await eventually(async () => !(await global.existingIdentity(input.provider, input.subject)), "identity erasure");
  await runInDurableObject(global, async (instance) => {
    await expect(instance.signIn(held)).rejects.toThrow("sign-in is stale");
  });
});

it("keeps an invalidated unbound home claim recoverable without guessing about in-flight shard work", async () => {
  const global = directory(env);
  const id = crypto.randomUUID();
  const p: SignInInput = { provider: "google", subject: `pending-${id}`, email: `pending-${id}@example.test`, hint: "enam", authEpoch: await global.googleAuthEpoch() };
  const other: SignInInput = { provider: "google", subject: `other-${id}`, email: `other-${id}@example.test`, hint: "enam", authEpoch: p.authEpoch };
  await global.addInvite(p.email);
  await global.addInvite(other.email);
  const old = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, p);
  const otherAccount = await global.signIn(other);
  await global.deleteAccount(otherAccount.userId, otherAccount.vaultId);
  await runInDurableObject(old.directory, async (instance) => {
    await expect((instance as Directory).signIn(old.input)).rejects.toThrow("sign-in is stale");
  });
  const pending = await runInDurableObject(global, (_instance, state) => state.storage.sql.exec<{user_id: string | null}>(`SELECT user_id FROM identity_homes WHERE provider=? AND subject=?`, p.provider, p.subject).toArray());
  expect(pending).toEqual([{ user_id: null }]);
  const current = { ...p, authEpoch: await global.googleAuthEpoch() };
  const retry = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, current);
  const recovered = await retry.directory.signIn(retry.input);
  await global.bindIdentityHome(p.provider, p.subject, recovered.userId, current.authEpoch);
  expect(await global.existingIdentity(p.provider, p.subject)).toEqual(recovered);
});
