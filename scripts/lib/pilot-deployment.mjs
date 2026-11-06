// Compare a live one-use pilot probe with Cloudflare's deployment API.
// This is diagnostic evidence, never authorization to spend.
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readConfig, httpsOrigin } from "./config.mjs";
import { SharedPilotBudget } from "../../test/evals/shared-pilot.mjs";
const API = "https://api.cloudflare.com/client/v4";
const MAX_RESPONSE_BYTES = 512 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT = /^[0-9a-f]{32}$/i;
const SCRIPT = /^[A-Za-z0-9_-]{1,63}$/;
const RUN = /^[A-Za-z0-9_-]{1,100}$/;
const STEP = /^[A-Za-z0-9 _:-]{1,100}$/;
const PATHS = new Set(["distill", "tailor", "document", "reembed", "vault"]);
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Only the metadata returned by the existing one-use identity probe. */
export function validPilotObservation(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === "path,runId,runtimeVersion,step,vaultId,workerVersion" &&
    PATHS.has(value.path) && typeof value.vaultId === "string" && /^[0-9a-f]{64}$/i.test(value.vaultId) &&
    typeof value.runId === "string" && RUN.test(value.runId) && typeof value.step === "string" && STEP.test(value.step) &&
    typeof value.workerVersion === "string" && ID.test(value.workerVersion) &&
    typeof value.runtimeVersion === "string" && ID.test(value.runtimeVersion));
}

async function providerJson(fetcher, url, token) {
  let response;
  try {
    response = await fetcher(url, {
      method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200 || !response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array) || next.value.byteLength > MAX_RESPONSE_BYTES - length)
          throw new Error();
        length += next.value.byteLength;
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || parsed.success !== true || !parsed.result || typeof parsed.result !== "object") throw new Error();
    return parsed.result;
  } catch {
    // Provider bodies, URLs and exception messages may contain credentials.
    throw new Error("provider_metadata_unavailable");
  }
}

/** Provider metadata observation only: it does not attest routing continuity or code. */
async function observedOrigin(fetcher, token, account, script, origin) {
  const url = new URL(origin);
  if (url.port || !SCRIPT.test(script)) return null;
  const host = url.hostname.toLowerCase();
  const accountBase = `${API}/accounts/${account}/workers`;
  if (host.endsWith(".workers.dev")) {
    const label = script.toLowerCase();
    if (!DNS_LABEL.test(label)) return null;
    const subdomain = await providerJson(fetcher, `${accountBase}/subdomain`, token);
    const setting = await providerJson(fetcher, `${accountBase}/scripts/${encodeURIComponent(script)}/subdomain`, token);
    const accountLabel = typeof subdomain?.subdomain === "string" ? subdomain.subdomain.toLowerCase() : "";
    if (!DNS_LABEL.test(accountLabel) || setting?.enabled !== true ||
        origin !== `https://${label}.${accountLabel}.workers.dev`) return null;
    return { kind: "workers_dev_observed", fingerprint: `workers-dev:${label}:${accountLabel}` };
  }
  // A configured custom domain does not prove that public DNS still points
  // to Cloudflare. Never send a shared key based on that metadata alone.
  return null;
}

function activeDeployment(result) {
  const deployments = result?.deployments;
  if (!Array.isArray(deployments) || deployments.length < 1 || deployments.length > 100) return null;
  const current = deployments[0];
  if (!current || !ID.test(current.id) || current.strategy !== "percentage" ||
      !Array.isArray(current.versions) || current.versions.length !== 1 ||
      !ID.test(current.versions[0]?.version_id) || current.versions[0]?.percentage !== 100) return null;
  return { id: current.id.toLowerCase(), version: current.versions[0].version_id.toLowerCase() };
}

function checkedBindings(result, version, script) {
  if (!result || typeof result.id !== "string" || result.id.toLowerCase() !== version ||
      !Array.isArray(result.resources?.bindings) || result.resources.bindings.length > 1000) return false;
  const bindings = result.resources.bindings;
  const exactlyOne = (name, predicate) => {
    const found = bindings.filter((binding) => binding && typeof binding === "object" && binding.name === name);
    return found.length === 1 && predicate(found[0]);
  };
  return exactlyOne("PILOT_BUDGET", (b) => b.type === "durable_object_namespace" && b.class_name === "PilotBudget" &&
      (b.script_name === undefined || b.script_name === script) && b.environment === undefined) &&
    exactlyOne("PILOT_VERSION_METADATA", (b) => b.type === "version_metadata") &&
    exactlyOne("PILOT_BUDGET_KEY", (b) => b.type === "secret_text") &&
    exactlyOne("PILOT_SHARED_BUDGET", (b) => b.type === "plain_text" && b.text === "true") &&
    exactlyOne("ALLOW_TEST_SIGNIN", (b) => b.type === "plain_text" && b.text === "true");
}

/**
 * Read-only first pass used before opening a probe. It does not attest code,
 * caller origin, Workflow drain, or spending limits and cannot enable a pilot.
 */
export async function preflightPilotDeployment({ env = process.env, fetcher = fetch }, testDependencies = {}) {
  const report = { status: "pending", deployment: "unverified", bindings: "unverified", origin: "unverified",
    pending: ["staging_url_account_binding_unverified", "worker_code_revision_unverified", "workflow_and_old_version_drain_unverified", "provider_spend_bound_unverified"] };
  let config, scriptName;
  try {
    const load = testDependencies.readConfig ?? readConfig;
    ({ config, name: scriptName } = await load("staging", join(fileURLToPath(new URL("../../", import.meta.url)), "wrangler.jsonc")));
  } catch {
    report.pending.push("staging_configuration_unavailable");
    return report;
  }
  const accountId = env?.CLOUDFLARE_ACCOUNT_ID, token = env?.CLOUDFLARE_API_TOKEN;
  const configuredAccountId = config?.vars?.CF_ACCOUNT_ID;
  // Never send the pilot key to an arbitrary origin supplied by an environment
  // variable; the operator must also configure the exact staging app origin.
  if (typeof accountId !== "string" || !ACCOUNT.test(accountId) || typeof configuredAccountId !== "string" ||
      configuredAccountId.toLowerCase() !== accountId.toLowerCase() || typeof scriptName !== "string" ||
      !SCRIPT.test(scriptName) || typeof token !== "string" || !token ||
      !httpsOrigin(env?.STAGING_URL) || httpsOrigin(env.STAGING_URL) !== httpsOrigin(config?.vars?.APP_ORIGIN)) {
    report.pending.push("staging_configuration_invalid");
    return report;
  }
  if (testDependencies.readConfig) report.pending.push("test_configuration_override");
  const base = `${API}/accounts/${accountId.toLowerCase()}/workers/scripts/${encodeURIComponent(scriptName)}`;
  try {
    const originBefore = await observedOrigin(fetcher, token, accountId.toLowerCase(), scriptName, httpsOrigin(env.STAGING_URL));
    if (!originBefore) { report.pending.push("staging_origin_unverified"); return report; }
    const before = activeDeployment(await providerJson(fetcher, `${base}/deployments?per_page=1`, token));
    if (!before) { report.pending.push("single_active_deployment_unverified"); return report; }
    const version = await providerJson(fetcher, `${base}/versions/${before.version}`, token);
    if (!checkedBindings(version, before.version, scriptName)) {
      report.pending.push("version_bindings_unverified");
      return report;
    }
    const after = activeDeployment(await providerJson(fetcher, `${base}/deployments?per_page=1`, token));
    if (!after || after.id !== before.id || after.version !== before.version) {
      report.pending.push("deployment_changed_or_unavailable");
      return report;
    }
    const originAfter = await observedOrigin(fetcher, token, accountId.toLowerCase(), scriptName, httpsOrigin(env.STAGING_URL));
    if (!originAfter || originAfter.kind !== originBefore.kind || originAfter.fingerprint !== originBefore.fingerprint) {
      report.pending.push("staging_origin_changed_or_unavailable"); return report;
    }
    report.deployment = "single_version_observed";
    report.bindings = "expected_bindings_observed";
    report.origin = originAfter.kind;
    report.deploymentId = before.id;
    report.versionId = before.version;
  } catch { report.pending.push("provider_metadata_unavailable"); }
  return report;
}

/**
 * Consume a previously started, observed challenge using the same Node pilot
 * instance that created it. Only the existing authenticated probe endpoint
 * supplies the observation; no saved JSON or caller-supplied version is used.
 * Cloudflare API requests are read-only. Consuming the challenge is a one-use
 * coordinator mutation and never reserves or dispatches a model request.
 *
 * The response remains pending: an HTTPS origin and a shared key do not prove
 * account ownership, a single active HTTP version does not drain old Workflow
 * instances, and provider-side billing bounds are not established here.
 */
export async function inspectPilotDeployment({ pilot, nonce, runId, env = process.env, fetcher = fetch }, testDependencies = {}) {
  const report = {
    status: "pending", deployment: "unverified", bindings: "unverified", origin: "unverified", observation: "unverified",
    pending: ["staging_url_account_binding_unverified", "worker_code_revision_unverified", "workflow_and_old_version_drain_unverified", "provider_spend_bound_unverified"],
  };
  let config, scriptName;
  try {
    // Production callers read the checked-in staging config directly. The
    // injectable loader exists only for local tests and never unlocks a gate.
    const load = testDependencies.readConfig ?? readConfig;
    ({ config, name: scriptName } = await load("staging", join(fileURLToPath(new URL("../../", import.meta.url)), "wrangler.jsonc")));
  } catch {
    report.pending.push("staging_configuration_unavailable");
    return report;
  }
  const accountId = env?.CLOUDFLARE_ACCOUNT_ID, token = env?.CLOUDFLARE_API_TOKEN;
  const configuredAccountId = config?.vars?.CF_ACCOUNT_ID;
  if (!(pilot instanceof SharedPilotBudget) || !httpsOrigin(env?.STAGING_URL) ||
      httpsOrigin(env.STAGING_URL) !== pilot.origin || httpsOrigin(env.STAGING_URL) !== httpsOrigin(config?.vars?.APP_ORIGIN) ||
      typeof nonce !== "string" || !ID.test(nonce) || typeof runId !== "string" || !RUN.test(runId) ||
      typeof accountId !== "string" || !ACCOUNT.test(accountId) || typeof configuredAccountId !== "string" ||
      configuredAccountId.toLowerCase() !== accountId.toLowerCase() || typeof scriptName !== "string" ||
      !SCRIPT.test(scriptName) || typeof token !== "string" || !token) {
    report.pending.push("configuration_or_probe_invalid");
    return report;
  }
  if (testDependencies.readConfig) report.pending.push("test_configuration_override");
  let originBefore;
  try {
    originBefore = await observedOrigin(fetcher, token, accountId.toLowerCase(), scriptName, httpsOrigin(env.STAGING_URL));
    if (!originBefore) { report.pending.push("staging_origin_unverified"); return report; }
  } catch { report.pending.push("staging_origin_unavailable"); return report; }
  try {
    if ((await pilot.identityStatus(nonce)).state !== "observed") {
      report.pending.push("probe_not_observed");
      return report;
    }
  } catch {
    report.pending.push("probe_unavailable");
    return report;
  }
  const base = `${API}/accounts/${accountId.toLowerCase()}/workers/scripts/${encodeURIComponent(scriptName)}`;
  try {
    const before = activeDeployment(await providerJson(fetcher, `${base}/deployments?per_page=1`, token));
    if (!before) { report.pending.push("single_active_deployment_unverified"); return report; }
    const version = await providerJson(fetcher, `${base}/versions/${before.version}`, token);
    if (!checkedBindings(version, before.version, scriptName)) {
      report.pending.push("version_bindings_unverified");
      return report;
    }
    report.bindings = "expected_bindings_observed";
    // This is the only non-GET operation: it consumes the already-observed
    // nonce from the actual HTTPS pilot coordinator. An ambiguous response is
    // never retried; a new diagnostic needs a fresh challenge.
    let observation;
    try { observation = await pilot.consumeIdentity(nonce, runId); }
    catch { report.pending.push("probe_consume_unavailable"); return report; }
    if (!validPilotObservation(observation)) { report.pending.push("probe_response_invalid"); return report; }
    const after = activeDeployment(await providerJson(fetcher, `${base}/deployments?per_page=1`, token));
    if (!after || after.id !== before.id || after.version !== before.version) {
      report.pending.push("deployment_changed_or_unavailable");
      return report;
    }
    const originAfter = await observedOrigin(fetcher, token, accountId.toLowerCase(), scriptName, httpsOrigin(env.STAGING_URL));
    if (!originAfter || originAfter.kind !== originBefore.kind || originAfter.fingerprint !== originBefore.fingerprint) {
      report.pending.push("staging_origin_changed_or_unavailable"); return report;
    }
    report.deployment = "single_version_observed";
    report.origin = originAfter.kind;
    report.observation = observation.workerVersion.toLowerCase() === before.version && observation.runtimeVersion.toLowerCase() === before.version
      ? "https_probe_version_matches" : "version_mismatch";
    if (report.observation === "version_mismatch") report.pending.push("observation_version_mismatch");
    // IDs are provider metadata, not payload, and help an operator compare the
    // observation with the intended deployment. Never print binding values.
    report.deploymentId = before.id;
    report.versionId = before.version;
  } catch {
    report.pending.push("provider_metadata_unavailable");
  }
  return report;
}
