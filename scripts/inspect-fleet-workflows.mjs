#!/usr/bin/env node
// Read-only diagnostic. A positive match needs operator review; absence does
// not authorize Workflow deletion, fence clearing or an erasure claim.
import { readFile, writeFile } from "node:fs/promises";
import { readConfig, httpsOrigin } from "./lib/config.mjs";
import { inspectFleetWorkflowInventory } from "./lib/fleet-workflow-inventory.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
try {
  const environment = value("--environment");
  const path = value("--manifest");
  const reportPath = value("--report");
  if (!path || !["staging", "production"].includes(environment)) throw new Error("INVALID_FLEET_INVENTORY_CONFIGURATION");
  const { config } = await readConfig(environment);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const appOrigin = environment === "staging" ? process.env.STAGING_URL : process.env.APP_ORIGIN;
  if (!httpsOrigin(manifest.base) || httpsOrigin(manifest.base) !== manifest.base ||
      httpsOrigin(appOrigin) !== manifest.base || !config.vars?.CF_ACCOUNT_ID ||
      config.vars.CF_ACCOUNT_ID !== process.env.CLOUDFLARE_ACCOUNT_ID)
    throw new Error("INVALID_FLEET_INVENTORY_CONFIGURATION");
  const report = await inspectFleetWorkflowInventory({
    vaultId: manifest.vaultId,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
    workflows: config.workflows,
    maxInstances: Number(value("--max-instances") ?? 50),
    maxFullSteps: Number(value("--max-full-steps") ?? 0),
  });
  const output = JSON.stringify({ ...report, environment, checkedAt: new Date().toISOString() }, null, 2) + "\n";
  if (reportPath) await writeFile(reportPath, output, { mode: 0o600, flag: "wx" });
  process.stdout.write(output);
  process.exitCode = 2;
} catch (error) {
  const reasons = new Set(["INVALID_FLEET_INVENTORY_CONFIGURATION", "PROVIDER_REQUEST_FAILED", "INVALID_PROVIDER_RESPONSE", "PROVIDER_RESPONSE_LIMIT", "PROVIDER_PAGINATION_AMBIGUOUS", "INVALID_PROVIDER_PAGINATION", "PROVIDER_SCAN_LIMIT"]);
  const reason = error instanceof Error && reasons.has(error.message) ? error.message : "FLEET_INVENTORY_INSPECTION_FAILED";
  process.stdout.write(JSON.stringify({ status: "pending", reasons: [reason] }) + "\n");
  process.exitCode = 2;
}
