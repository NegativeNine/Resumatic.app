import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import { sourceKey } from "../../src/shared/r2";
import { vault } from "../../src/shared/stubs";
import { UPLOAD_INTENT_TTL_MS, uploadBodyDigest, uploadDescriptorDigest, type UploadDescriptor } from "../../src/vault/uploads";
import { readSession } from "../../src/worker/session";
import { RESUME, fakeModels, signIn, waitForSource, type FakeModelOptions, type User } from "./support";

// Stage 4 of the redesign: every refusal the Facts room shows a person speaks of their files in the
// interface's words, never of sources, uploads or extraction. Each is reached as the web app
// reaches it, over HTTP, and its status is the one the client already sorts by.

let options: FakeModelOptions;
beforeEach(() => {
  options = { calls: {} };
  setModels(() => fakeModels(options));
});
afterEach(() => {
  setModels(null);
});

async function refused(response: Response, status: number, error: string, message: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error, message });
}

async function upload(user: User, filename = "jane-doe.pdf", content = RESUME): Promise<string> {
  const response = await user.upload(filename, content);
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { sourceId: string }).sourceId;
}

async function session(user: User) {
  const s = await readSession(env.SESSION_KEY, user.cookie.slice("__Host-session=".length));
  if (!s) throw new Error("test session is missing");
  return { vid: s.vid, who: { userId: s.uid, gen: s.gen, epoch: s.epoch } };
}

describe("the Facts room's refusals", () => {
  it("speaks of files in every refusal Facts shows", async () => {
    // The text of a file still being read.
    let release!: () => void;
    options.holdConvert = new Promise<void>((resolve) => (release = resolve));
    const user = await signIn();
    const queued = await upload(user);
    await refused(
      await user.fetch(`/api/sources/${queued}/text`),
      409,
      "conflict",
      "This file hasn't been read yet. Wait for it to finish, then try again.",
    );
    release();
    expect((await waitForSource(user, queued)).state).toBe("ready");

    // Cancelling a file that has been read.
    await refused(await user.send("POST", `/api/sources/${queued}/cancel`), 409, "conflict", "This file is no longer being read.");

    // The original of a file that isn't there.
    await refused(
      await user.fetch(`/api/sources/${crypto.randomUUID()}/file`),
      404,
      "not_found",
      "This file can't be found. It may have been deleted.",
    );

    // Moving a fact to a role that was left out.
    const { roles } = await user.json<{ roles: { id: string; org: string }[] }>("/api/roles");
    const { facts } = await user.json<{ facts: { id: string; roleId: string | null; revision?: number }[] }>("/api/facts");
    const role = roles.find((r) => r.org === "Acme Corp")!;
    const other = facts.find((f) => f.roleId !== role.id)!;
    expect((await user.send("POST", "/api/review", { confirm: [], reject: [role.id] })).status).toBe(204);
    await refused(
      await user.send("PATCH", `/api/facts/${other.id}`, { roleId: role.id, expectedRevision: other.revision ?? 1 }),
      422,
      "invalid",
      "That role was left out. Choose another role for this fact.",
    );

    // Retrying a file that is already being read again.
    options.toMarkdownError = "No text could be read from this file.";
    const failed = await upload(user, "unreadable.pdf", `${RESUME}\nAnother version`);
    const source = await waitForSource(user, failed);
    expect(source.state).toBe("failed");
    const [listed] = (await user.json<{ sources: { id: string; retryRunId?: string }[] }>("/api/sources")).sources.filter((s) => s.id === failed);
    const runId = listed!.retryRunId!;
    expect(runId).toBeTruthy();
    const retry = (key: string) => user.fetch(`/api/runs/${runId}/retry`, { method: "POST", headers: { "idempotency-key": key } });
    expect((await retry(crypto.randomUUID())).status).toBe(202);
    await refused(await retry(crypto.randomUUID()), 409, "conflict", "This file is already being read again.");
    options.toMarkdownError = undefined;
    await waitForSource(user, failed);

    // A file whose upload was reserved a day ago and never finished.
    const { vid, who } = await session(user);
    const key = crypto.randomUUID();
    const bytes = new TextEncoder().encode(`${RESUME}\nA third version`).slice().buffer;
    const digest = await uploadDescriptorDigest({ filename: "late.pdf", contentType: "application/pdf" }, bytes);
    const descriptor: UploadDescriptor = {
      requestKey: key,
      descriptorDigest: digest,
      filename: "late.pdf",
      contentType: "application/pdf",
      byteLength: bytes.byteLength,
      r2Key: sourceKey(vid, `${key}-${digest}`),
      sha256: await uploadBodyDigest(bytes),
    };
    await vault(env, vid).reserveUpload(who, descriptor);
    await runInDurableObject(vault(env, vid), (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE upload_intents SET created_at = created_at - ?, expires_at = expires_at - ?`,
        UPLOAD_INTENT_TTL_MS + 1,
        UPLOAD_INTENT_TTL_MS + 1,
      );
    });
    const form = new FormData();
    form.set("file", new File([bytes], "late.pdf", { type: "application/pdf" }));
    await refused(
      await user.fetch("/api/sources", { method: "POST", body: form, headers: { "idempotency-key": key } }),
      409,
      "conflict",
      "This file wasn't added. Upload it again.",
    );
  });
});
