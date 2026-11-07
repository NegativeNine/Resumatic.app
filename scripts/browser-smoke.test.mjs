import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./browser-smoke.mjs", import.meta.url));
test("browser smoke remains pending without a browser", () => {
  const env = { ...process.env }; delete env.LOCAL_CHROME_BIN;
  const result = spawnSync(process.execPath, [script], { env, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), { status: "pending", reason: "LOCAL_CHROME_REQUIRED", promotionEligible: false });
});
test("browser smoke fails promptly with a missing executable", () => {
  const result = spawnSync(process.execPath, [script], { env: { ...process.env, LOCAL_CHROME_BIN: "/nonexistent/resumatic-browser" }, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { status: "failed", reason: "BROWSER_SMOKE_FAILED", stage: "setup", promotionEligible: false });
});
