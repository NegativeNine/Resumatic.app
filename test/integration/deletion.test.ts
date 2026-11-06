import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModels } from "../../src/ai/models";
import { Vault } from "../../src/vault/vault";
import { vaultPrefix } from "../../src/shared/r2";
import { directory, vault } from "../../src/shared/stubs";
import {
  JOB_DESCRIPTION,
  RESUME,
  eventually,
  fakeModels,
  signIn,
  testLogin,
  waitForSource,
  type FakeModelOptions,
  type User,
} from "./support";

let options: FakeModelOptions;

beforeEach(() => {
  options = {};
  setModels(() => fakeModels(options));
});

afterEach(() => {
  setModels(null);
});

function sessionOf(user: User): { uid: string; vid: string } {
  const body = user.cookie
    .slice("__Host-session=".length)
    .split(".")[0]!
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return JSON.parse(atob(body + "===".slice((body.length + 3) % 4)));
}

/** The Directory's row for a vault, walking listVaults page by page. */
async function vaultRow(
  vaultId: string,
): Promise<{ vaultId: string; state: string } | null> {
  let after: string | undefined;
  for (;;) {
    const page: { vaultId: string; state: string }[] = await directory(
      env,
    ).listVaults({ after, limit: 200 });
    const found = page.find((r) => r.vaultId === vaultId);
    if (found) return found;
    if (page.length < 200) return null;
    after = page.at(-1)!.vaultId;
  }
}

describe("account deletion", () => {
  it("stops runs, erases files and the vault, then forgets the account", async () => {
    let release!: () => void;
    options.hold = new Promise<void>((r) => (release = r));

    const user = await signIn();
    const { vid } = sessionOf(user);
    const { sourceId } = (await (
      await user.upload("jane-doe.pdf", RESUME)
    ).json()) as { sourceId: string };
    await waitForSource(user, sourceId);
    const facts = (await user.json("/api/facts")).facts.map(
      (f: { id: string }) => f.id,
    );
    const roles = (await user.json("/api/roles")).roles.map(
      (r: { id: string }) => r.id,
    );
    await user.send("POST", "/api/review", {
      confirm: [...facts, ...roles],
      reject: [],
    });
    const { applicationId } = (await (
      await user.send("POST", "/api/applications", { jdText: JOB_DESCRIPTION })
    ).json()) as { applicationId: string };
    const { resumeId } = (await (
      await user.send("POST", `/api/applications/${applicationId}/resumes`)
    ).json()) as { resumeId: string };
    expect(
      (await env.FILES.list({ prefix: vaultPrefix(vid) })).objects.length,
    ).toBeGreaterThan(0);

    const res = await user.send("DELETE", "/auth/account");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ deleting: true });
    expect(
      res.headers.getSetCookie().some((h) => h.startsWith("__Host-session=;")),
    ).toBe(true);

    // The alarm is due at once; run it now rather than waiting for the runtime to.
    await runDurableObjectAlarm(directory(env));
    await eventually(
      async () => (await vaultRow(vid)) === null,
      "the account rows to be removed",
    );

    expect(
      (await env.FILES.list({ prefix: vaultPrefix(vid) })).objects,
    ).toEqual([]);
    await expect(env.TAILOR.get(resumeId)).rejects.toThrow(
      "instance.not_found",
    );
    const tables = await runInDurableObject(
      vault(env, vid),
      (_instance, state) =>
        state.storage.sql
          .exec<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'table'`,
          )
          .toArray()
          .map((t) => t.name)
          .filter(
            (name) => !name.startsWith("_cf_") && !name.startsWith("sqlite_"),
          ),
    );
    expect(tables).toEqual([]);

    // The old cookie now reaches an empty vault, which refuses it.
    expect((await user.fetch("/api/me")).status).toBe(410);
    release();

    // Signing in again starts a new, empty account.
    const again = await signIn(user.email);
    expect(sessionOf(again).vid).not.toBe(vid);
    expect((await again.json("/api/sources")).sources).toEqual([]);
  });

  it("retries a deletion that failed part-way, and refuses sign-in meanwhile", async () => {
    const user = await signIn();
    const { vid } = sessionOf(user);
    const { sourceId } = (await (
      await user.upload("jane-doe.pdf", RESUME)
    ).json()) as { sourceId: string };
    await waitForSource(user, sourceId);

    let attempts = 0;
    const close = vi
      .spyOn(Vault.prototype, "close")
      .mockImplementation(async () => {
        attempts += 1;
        throw new Error("simulated outage");
      });
    try {
      expect((await user.send("DELETE", "/auth/account")).status).toBe(202);
      await runDurableObjectAlarm(directory(env));
      await eventually(async () => attempts > 0, "the first deletion attempt");
      expect((await vaultRow(vid))?.state).toBe("deleting");
      expect(
        (await env.FILES.list({ prefix: vaultPrefix(vid) })).objects.length,
      ).toBeGreaterThan(0);
      const refused = await testLogin(user.email);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: "forbidden" });
    } finally {
      close.mockRestore();
    }

    // The failed attempt scheduled a retry; run it now.
    await runDurableObjectAlarm(directory(env));
    await eventually(
      async () => (await vaultRow(vid)) === null,
      "the retried deletion",
    );
    expect(
      (await env.FILES.list({ prefix: vaultPrefix(vid) })).objects,
    ).toEqual([]);
  });

  it("deletes every Workflow attempt when an upload is retried", async () => {
    options.toMarkdownError = "the file could not be read";
    const user = await signIn();
    const { vid } = sessionOf(user);
    const uploaded = await user.upload("resume.pdf", RESUME);
    expect(uploaded.status).toBe(201);
    const { sourceId } = (await uploaded.json()) as { sourceId: string };
    expect((await waitForSource(user, sourceId)).state).toBe("failed");
    await eventually(async () => {
      const status = await (await env.DISTILL.get(sourceId)).status();
      return ["complete", "errored", "terminated"].includes(status.status);
    }, "the original Workflow to stop");
    options.toMarkdownError = undefined;
    const retry = await user.send("POST", `/api/runs/${sourceId}/retry`);
    expect(retry.status, await retry.clone().text()).toBe(202);
    const { runId } = (await retry.json()) as { runId: string };
    expect(runId).not.toBe(sourceId);
    expect((await waitForSource(user, sourceId)).state).toBe("ready");
    await eventually(async () => {
      const status = await (await env.DISTILL.get(runId)).status();
      return ["complete", "errored", "terminated"].includes(status.status);
    }, "the retry Workflow to stop");
    expect(await env.DISTILL.get(sourceId)).toBeTruthy();
    expect(await env.DISTILL.get(runId)).toBeTruthy();
    expect((await user.send("DELETE", "/auth/account")).status).toBe(202);
    await runDurableObjectAlarm(directory(env));
    await eventually(
      async () => (await vaultRow(vid)) === null,
      "the deletion to finish",
    );
    await expect(env.DISTILL.get(sourceId)).rejects.toThrow(
      "instance.not_found",
    );
    await expect(env.DISTILL.get(runId)).rejects.toThrow("instance.not_found");
  });

  it("needs a current session", async () => {
    const email = (await signIn()).email;
    const laptop = await signIn(email);
    const phone = await signIn(email);
    await phone.send("POST", "/api/account/sign-out-everywhere");
    expect((await laptop.send("DELETE", "/auth/account")).status).toBe(401);
    const current = await signIn(email);
    expect((await current.fetch("/api/me")).status).toBe(200);
  });
});
