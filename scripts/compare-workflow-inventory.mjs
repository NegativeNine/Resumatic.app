#!/usr/bin/env node
// Diagnostic provider comparison. This never changes a Workflow or clears an erasure fence.
import { readFile, writeFile } from "node:fs/promises";
import { readConfig, httpsOrigin } from "./lib/config.mjs";
import { compareWorkflowInventory } from "./lib/workflow-provider-inventory.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
try {
  const environment = value("--environment");
  const path = value("--manifest");
  const reportPath = value("--report");
  if (!path || !["staging", "production"].includes(environment)) throw new Error("INVALID_INVENTORY_CONFIGURATION");
  const { config } = await readConfig(environment);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const appOrigin = environment === "staging" ? process.env.STAGING_URL : process.env.APP_ORIGIN;
  if (!httpsOrigin(manifest.base) || httpsOrigin(manifest.base) !== manifest.base ||
      httpsOrigin(appOrigin) !== manifest.base ||
      !config.vars?.CF_ACCOUNT_ID || config.vars.CF_ACCOUNT_ID !== process.env.CLOUDFLARE_ACCOUNT_ID)
    throw new Error("INVALID_INVENTORY_CONFIGURATION");
  const report = await compareWorkflowInventory({
    manifest,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
    workflows: config.workflows,
    maxInstances: Number(value("--max-instances") ?? 250),
  });
  const output = JSON.stringify({ ...report, environment, checkedAt: new Date().toISOString() }, null, 2) + "\n";
  if (reportPath) await writeFile(reportPath, output, { mode: 0o600, flag: "wx" });
  process.stdout.write(output);
  process.exitCode = 2; // A diagnostic comparison never satisfies the deletion gate.
} catch (error) {
  const reason = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
    ? error.message : "INVENTORY_COMPARISON_FAILED";
  process.stdout.write(JSON.stringify({ status: "pending", reasons: [reason] }) + "\n");
  process.exitCode = 2;
}
