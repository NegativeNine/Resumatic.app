import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEvaluationSecrets } from "./check-evaluation-secrets.mjs";

test("empty staging secrets pass and named shadows stay pending", () => {
  assert.deepEqual(checkEvaluationSecrets(() => ({ status: 0, stdout: "[]" })), { status: "passed" });
  assert.deepEqual(checkEvaluationSecrets(() => ({ status: 0, stdout: '[{"name":"TEST_SIGNIN_KEY"}]' })), { status: "passed" });
  assert.deepEqual(checkEvaluationSecrets(() => ({ status: 0, stdout: '[{"name":"ROLE_UNKNOWN_END_ENABLED"}]' })), { status: "pending", reason: "STAGING_SECRET_SHADOWS_CONFIGURATION" });
});
test("unavailable permissions, malformed responses, and exceptions stay pending without echoing output", () => {
  for (const run of [
    () => ({ status: 1, stdout: "synthetic-private-output", stderr: "synthetic-private-output" }),
    () => ({ status: 0, stdout: "synthetic-private-output" }),
    () => { throw new Error("synthetic-private-output"); },
  ]) {
    const result = checkEvaluationSecrets(run);
    assert.deepEqual(result, { status: "pending", reason: "STAGING_SECRET_NAMES_UNAVAILABLE" });
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private-output/);
  }
});
