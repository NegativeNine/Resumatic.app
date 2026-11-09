import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import { vault } from "../../src/shared/stubs";
import { MIGRATIONS, migrate, SCHEMA_VERSION } from "../../src/vault/schema";
import { fromBase64url } from "../../src/worker/crypto";
import { removeSourceDigestMigration } from "../support/undo-vault-incarnation";
import { fakeModels, RESUME, signIn, waitForSource, type FakeModelOptions, type User } from "./support";

let options: FakeModelOptions;

beforeEach(() => {
  options = { calls: {} };
  setModels(() => fakeModels(options));
});
afterEach(() => setModels(null));

async function upload(user: User, filename: string, content: string, key?: string) {
  const form = new FormData();
  form.set("file", new File([content], filename, { type: "application/pdf" }));
  return user.fetch("/api/sources", {
    method: "POST",
    body: form,
    headers: key ? { "idempotency-key": key } : {},
  });
}

async function uploaded(user: User, filename: string, content: string) {
  const response = await upload(user, filename, content);
  expect(response.status, await response.clone().text()).toBe(201);
  const { sourceId } = (await response.json()) as { sourceId: string };
  return waitForSource(user, sourceId);
}

function vaultOf(user: User) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  const session = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { vid: string };
  return vault(env, session.vid);
}

describe("duplicate uploads", () => {
  it("refuses a second copy of the same file, by its contents rather than its name", async () => {
    const user = await signIn();
    expect((await uploaded(user, "sam-rivera.pdf", RESUME)).state).toBe("ready");

    const again = await upload(user, "sam-rivera.pdf", RESUME);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "conflict", message: "You've already uploaded sam-rivera.pdf." });

    const renamed = await upload(user, "cv-final.pdf", RESUME);
    expect(renamed.status).toBe(409);
    expect(((await renamed.json()) as { message: string }).message).toBe(
      "You've already uploaded this file as sam-rivera.pdf.",
    );

    // A different file with the same name is a new source.
    expect((await uploaded(user, "sam-rivera.pdf", `${RESUME}\nVolunteer: Code Club mentor, 2019`)).state).toBe("ready");
    expect((await user.json<{ sources: unknown[] }>("/api/sources")).sources).toHaveLength(2);
  });

  it("treats a retry of the same request as that request, not as a second copy", async () => {
    const user = await signIn();
    const key = crypto.randomUUID();
    const first = await upload(user, "sam-rivera.pdf", RESUME, key);
    expect(first.status).toBe(201);
    const retry = await upload(user, "sam-rivera.pdf", RESUME, key);
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(await first.json());
  });

  it("accepts a file again after it failed to read", async () => {
    const user = await signIn();
    options.toMarkdownError = "No text could be read from this file.";
    expect((await uploaded(user, "scan.pdf", RESUME)).state).toBe("failed");
    options.toMarkdownError = undefined;
    expect((await uploaded(user, "scan.pdf", RESUME)).state).toBe("ready");
  });

  it("adds the digest column to an existing vault, and older sources never block an upload", async () => {
    const user = await signIn();
    expect((await uploaded(user, "older.pdf", RESUME)).state).toBe("ready");
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      const sql = state.storage.sql;
      // Rewind this vault to the schema before upload digests, as an older vault would be.
      removeSourceDigestMigration(sql);
      const previous = MIGRATIONS.findIndex((migration) =>
        migration.some((statement) => statement.includes("ALTER TABLE sources ADD COLUMN sha256")),
      );
      expect(previous).toBeGreaterThan(-1);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      migrate(sql, <T>(fn: () => T) => state.storage.transactionSync(fn));
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(SCHEMA_VERSION));
      expect(sql.exec<{ sha256: string | null }>(`SELECT sha256 FROM sources`).toArray()).toEqual([{ sha256: null }]);
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE type='index' AND name='sources_sha256'`).toArray()).toHaveLength(1);
    });
    // The source from before the migration has no digest, so the same file is accepted once more.
    expect((await uploaded(user, "older.pdf", RESUME)).state).toBe("ready");
    expect((await upload(user, "older.pdf", RESUME)).status).toBe(409);
  });
});
