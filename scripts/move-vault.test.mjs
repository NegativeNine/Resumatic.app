import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { moveVault } from "./move-vault.mjs";

const sourceVaultId = "a".repeat(64);
const targetVaultId = "b".repeat(64);
const options = {
  base: "https://resumatic.test",
  sourceVaultId,
  operationId: "move-test",
  accessId: "test-id",
  accessSecret: "test-secret",
};
const result = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });

function fixture({ corrupt = false, finish = "ready", targetValue = targetVaultId } = {}) {
  const calls = [];
  const progress = [];
  const page = {
    operationId: options.operationId,
    table: "profile",
    after: 0,
    lastRowid: 1,
    done: true,
    columns: ["id", "name"],
    rows: [[1, "Private Candidate"]],
  };
  const sha256 = createHash("sha256")
    .update(JSON.stringify(page))
    .digest("hex");
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({
      path,
      method: init.method,
      body: init.body ? JSON.parse(init.body) : null,
    });
    assert.equal(init.redirect, "error");
    if (path.endsWith("/replacement")) return result({ targetVaultId: targetValue });
    if (path.endsWith("/transfer"))
      return result({
        format: 1,
        operationId: options.operationId,
        sourceVaultId,
        tables: [{ name: "profile", count: 1 }],
      });
    if (path.endsWith("/profile"))
      return result({ ...page, sha256: corrupt ? "bad" : sha256 });
    if (path.endsWith("/import-finish")) return result({ state: finish });
    return result({ ok: true });
  };
  return {
    calls,
    fetcher,
    progress: (event) => progress.push(event),
    events: progress,
  };
}

test("prepare only creates the replacement and requests an external fence", async () => {
  const setup = fixture();
  assert.equal(
    (await moveVault({ ...options, ...setup })).status,
    "fence-required",
  );
  assert.equal(setup.calls.length, 1);
});

test("canonicalizes source and target IDs and rejects a same-vault replacement regardless of case", async () => {
  const setup = fixture({ targetValue: targetVaultId.toUpperCase() });
  const moved = await moveVault({ ...options, sourceVaultId: sourceVaultId.toUpperCase(), ...setup, copyAndCutover: true });
  assert.equal(moved.sourceVaultId, sourceVaultId);
  assert.equal(moved.targetVaultId, targetVaultId);
  assert.equal(setup.calls[0].path, `/admin/vaults/${sourceVaultId}/replacement`);
  let requests = 0;
  await assert.rejects(moveVault({ ...options, sourceVaultId: sourceVaultId.toUpperCase(), copyAndCutover: true,
    fetcher: async () => { requests++; return result({ targetVaultId: sourceVaultId }); },
  }), /INVALID_REPLACEMENT_VAULT/);
  assert.equal(requests, 1);
});

test("streams checked pages and only cuts over after finalization", async () => {
  const setup = fixture();
  assert.equal(
    (await moveVault({ ...options, ...setup, copyAndCutover: true })).status,
    "cutover-complete",
  );
  assert.equal(setup.calls.at(-2).path.endsWith("/import-finish"), true);
  assert.equal(setup.calls.at(-1).path.endsWith("/cutover"), true);
  assert.equal(
    setup.calls.find((call) => call.path.endsWith("/import-page")).body.page
      .rows[0][1],
    "Private Candidate",
  );
  assert.equal(
    JSON.stringify(setup.events).includes("Private Candidate"),
    false,
  );
});

test("a corrupt page cannot be imported or published", async () => {
  const setup = fixture({ corrupt: true });
  await assert.rejects(
    moveVault({ ...options, ...setup, copyAndCutover: true }),
    /CHECKSUM/,
  );
  assert.equal(
    setup.calls.some(
      (call) =>
        call.path.endsWith("/import-page") || call.path.endsWith("/cutover"),
    ),
    false,
  );
});

test("an incomplete finalization cannot cut over", async () => {
  const setup = fixture({ finish: "importing" });
  await assert.rejects(
    moveVault({ ...options, ...setup, copyAndCutover: true }),
    /IMPORT_NOT_READY/,
  );
  assert.equal(
    setup.calls.some((call) => call.path.endsWith("/cutover")),
    false,
  );
});

test("failure output does not echo response bodies or credentials", async () => {
  await assert.rejects(
    moveVault({
      ...options,
      fetcher: async () =>
        new Response("private server content", { status: 503 }),
    }),
    { message: "MOVE_HTTP_503_RERUN_SAME_OPERATION" },
  );
});
