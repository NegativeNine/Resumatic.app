import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkStagingSecrets } from "./check-staging-secrets.mjs";
import { readConfig } from "./lib/config.mjs";

const vars = { PILOT_SHARED_BUDGET: "true", DAILY_SPEND_CAP_USD: "0", INVITE_ONLY: "true" };
const listed = (names) => () => ({ status: 0, stdout: JSON.stringify(names.map((name) => ({ name }))) });

test("staging secrets that only hold secret values pass", () => {
  assert.deepEqual(checkStagingSecrets(vars, listed([])), { status: "passed" });
  assert.deepEqual(checkStagingSecrets(vars, listed(["SESSION_KEY", "TEST_SIGNIN_KEY", "PILOT_BUDGET_KEY"])), { status: "passed" });
});

test("a secret that shadows a staging variable or an evaluation setting stays pending", () => {
  for (const name of ["PILOT_SHARED_BUDGET", "DAILY_SPEND_CAP_USD", "MODEL_WRITE", "ROLE_UNKNOWN_END_ENABLED"])
    assert.deepEqual(checkStagingSecrets(vars, listed([name])), { status: "pending", reason: "STAGING_SECRET_SHADOWS_CONFIGURATION" });
});

test("unavailable permissions, malformed responses and missing variables stay pending without echoing output", () => {
  for (const run of [
    () => ({ status: 1, stdout: "synthetic-private-output", stderr: "synthetic-private-output" }),
    () => ({ status: 0, stdout: "synthetic-private-output" }),
    () => { throw new Error("synthetic-private-output"); },
  ]) {
    const result = checkStagingSecrets(vars, run);
    assert.deepEqual(result, { status: "pending", reason: "STAGING_SECRET_NAMES_UNAVAILABLE" });
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private-output/);
  }
  assert.deepEqual(checkStagingSecrets(undefined, listed([])), { status: "pending", reason: "STAGING_SECRET_SHADOWS_CONFIGURATION" });
});

test("the committed staging configuration is ready for a model-free deploy apart from its account", async () => {
  const { config } = await readConfig("staging");
  for (const [name, value] of Object.entries({
    PILOT_SHARED_BUDGET: "true", DAILY_SPEND_CAP_USD: "0", INVITE_ONLY: "true",
    BILLING_ENABLED: "false", MCP_ENABLED: "false", ALLOW_TEST_SIGNIN: "true", OIDC_CLIENT_ID: "",
  })) assert.equal(config.vars[name], value, name);
});

test("the CI smoke deploy checks before it deploys and never starts paid work", () => {
  const yaml = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const job = yaml.slice(yaml.indexOf("  deploy-staging-smoke:"));
  assert.ok(job.startsWith("  deploy-staging-smoke:"));
  const at = (text) => job.indexOf(text);
  assert.ok(at("vars.STAGING_SMOKE_ONLY == 'true'") > 0);
  assert.ok(at("--purpose deploy --smoke-only") > 0 && at("--purpose deploy --smoke-only") < at("run: npx wrangler deploy"));
  assert.ok(at("run: node scripts/check-staging-secrets.mjs") > 0 && at("run: node scripts/check-staging-secrets.mjs") < at("run: npx wrangler deploy"));
  for (const paid of ["e2e:staging", "npm run evals", "TEST_SIGNIN_KEY", "EVAL_BUDGET_USD"]) assert.equal(at(paid), -1, paid);
  // The full staging job stands aside when the smoke deploy is chosen.
  assert.match(yaml, /deploy-staging:\n {4}needs: \[test, security-audit\]\n {4}if: .*vars\.STAGING_SMOKE_ONLY != 'true'/);
});
