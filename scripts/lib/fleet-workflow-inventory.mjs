const VAULT = /^[a-f0-9]{64}$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STATES = new Set(["queued", "running", "paused", "errored", "terminated", "complete", "waitingForPause", "waiting", "rollingBack"]);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_FULL_STEPS = 100;
// Fleet creates these names from integer loop indexes only. The suffix form is
// based on the local runtime and must be confirmed against staging; unknown
// names are never sent in a URL or treated as fully inspected.
const FLEET_STEP = /^(?:(?:list|start) (?:[0-9]|1[0-6]) (?:0|[1-9][0-9]{0,2})|poll (?:[0-9]|1[0-6]) (?:0|[1-9][0-9]{0,2}) (?:[0-9]|1[0-9]))-[1-9][0-9]{0,3}$/;

/** Read provider responses without buffering an unbounded log or echoing it. */
async function readJson(response, budget) {
  if (!response.ok || !response.body) throw new Error("PROVIDER_REQUEST_FAILED");
  const reader = response.body.getReader();
  const parts = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("INVALID_PROVIDER_RESPONSE");
      length += value.byteLength;
      budget.used += value.byteLength;
      if (length > MAX_RESPONSE_BYTES || budget.used > MAX_SCAN_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("PROVIDER_RESPONSE_LIMIT");
      }
      parts.push(value);
    }
  } catch (error) {
    if (error instanceof Error && ["INVALID_PROVIDER_RESPONSE", "PROVIDER_RESPONSE_LIMIT"].includes(error.message)) throw error;
    throw new Error("PROVIDER_REQUEST_FAILED");
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { data.set(part, offset); offset += part.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
    if (!parsed || parsed.success !== true || parsed.result === undefined ||
        (parsed.errors !== undefined && (!Array.isArray(parsed.errors) || parsed.errors.length))) throw new Error();
    return parsed;
  } catch { throw new Error("INVALID_PROVIDER_RESPONSE"); }
}

/**
 * Find positive evidence that fleet Workflow state contains a vault ID. This
 * never clears an erasure fence or proves absence: the provider may return a
 * partial, redacted or changing view, and a running instance may write later.
 * No provider payload, step name or other vault ID leaves this function.
 */
export async function inspectFleetWorkflowInventory({ vaultId, accountId, token, workflows, maxInstances = 50, maxFullSteps = 0, fetcher = fetch }) {
  if (!VAULT.test(vaultId ?? "") || !/^[a-f0-9]{32}$/i.test(accountId ?? "") ||
      typeof token !== "string" || !token || !Array.isArray(workflows) ||
      !Number.isSafeInteger(maxInstances) || maxInstances < 1 || maxInstances > 250 ||
      !Number.isSafeInteger(maxFullSteps) || maxFullSteps < 0 || maxFullSteps > MAX_FULL_STEPS)
    throw new Error("INVALID_FLEET_INVENTORY_CONFIGURATION");
  const entries = workflows.filter((entry) => entry?.binding === "FLEET_REEMBED");
  if (entries.length !== 1 || typeof entries[0].name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(entries[0].name))
    throw new Error("INVALID_FLEET_INVENTORY_CONFIGURATION");
  const root = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workflows/${encodeURIComponent(entries[0].name)}/instances`;
  const budget = { used: 0 };
  async function get(url, jsonOnly = false) {
    let response;
    try {
      response = await fetcher(url, { method: "GET", headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15000) });
    } catch { throw new Error("PROVIDER_REQUEST_FAILED"); }
    // Full-step responses can be binary streams. Do not interpret binary
    // content as JSON or retain it when this diagnostic only handles JSON.
    if (jsonOnly && !/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel().catch(() => {});
      throw new Error("INVALID_PROVIDER_RESPONSE");
    }
    return readJson(response, budget);
  }
  let cursor;
  let attempted = 0, inspected = 0, uninspectable = 0, scanLimited = false, paginationUncertain = false, pages = 0;
  let fullStepsRequested = 0, fullStepsInspected = 0, fullStepScanLimited = false;
  const seenCursors = new Set(), seenIds = new Set(), references = [];
  do {
    if (++pages > 200) throw new Error("PROVIDER_SCAN_LIMIT");
    const query = new URLSearchParams({ per_page: "100" });
    if (cursor) query.set("cursor", cursor);
    const page = await get(`${root}?${query}`);
    const info = page.result_info;
    // Cloudflare documents result_info as optional. Its absence, or a full
    // page without a continuation cursor, leaves pagination uncertain; the
    // available instances can still provide useful positive evidence.
    if (!Array.isArray(page.result) || page.result.length > 100 ||
        (info !== undefined && (info === null || typeof info !== "object" || Array.isArray(info))) ||
        (info?.cursor !== undefined && info.cursor !== null && typeof info.cursor !== "string"))
      throw new Error("INVALID_PROVIDER_RESPONSE");
    if (info === undefined || (page.result.length === 100 && !info.cursor)) paginationUncertain = true;
    for (const item of page.result) {
      const id = item?.id;
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || seenIds.has(id))
        throw new Error("INVALID_PROVIDER_RESPONSE");
      seenIds.add(id);
      if (attempted >= maxInstances) { scanLimited = true; break; }
      attempted++;
      // Only report our own fixed-format instance IDs. Other provider data can
      // contain arbitrary text and must not be copied into the report.
      if (!UUID.test(id)) { uninspectable++; continue; }
      let detail;
      try { detail = await get(`${root}/${encodeURIComponent(id)}?simple=false`); }
      catch (error) {
        if (error instanceof Error && error.message === "PROVIDER_RESPONSE_LIMIT") {
          uninspectable++;
          if (budget.used > MAX_SCAN_BYTES) { scanLimited = true; break; }
          continue;
        }
        throw error;
      }
      const result = detail.result;
      if (!result || typeof result !== "object" || Array.isArray(result) || !STATES.has(result.status) ||
          (result.step_count !== undefined && (!Number.isSafeInteger(result.step_count) || result.step_count < 0)))
        throw new Error("INVALID_PROVIDER_RESPONSE");
      inspected++;
      // The search is positive evidence only. Provider strings include JSON
      // step results; substring matching deliberately does not claim an
      // exhaustive parse of every version or redacted output representation.
      let matched = JSON.stringify(result).toLowerCase().includes(vaultId.toLowerCase());
      let incomplete = !Array.isArray(result.steps) ||
        (Number.isSafeInteger(result.step_count) && result.step_count > result.steps.length);
      const seenStepNames = new Set();
      for (const step of Array.isArray(result.steps) ? result.steps : []) {
        if (!step || typeof step !== "object" || Array.isArray(step)) { incomplete = true; continue; }
        if (step.type !== "step") { if (step.type !== "sleep" && step.type !== "termination") incomplete = true; continue; }
        if (step.success !== true) { incomplete = true; continue; }
        // Instance detail output can be a truncated preview. Fetching full
        // output is opt-in; malformed or unknown names never leave the client.
        if (step.config?.sensitive === "output" || typeof step.name !== "string" ||
            !FLEET_STEP.test(step.name) || seenStepNames.has(step.name)) { incomplete = true; continue; }
        seenStepNames.add(step.name);
        if (fullStepsRequested >= maxFullSteps) {
          incomplete = true;
          if (maxFullSteps > 0) fullStepScanLimited = true;
          continue;
        }
        fullStepsRequested++;
        const query = new URLSearchParams({ name: step.name, type: "step" });
        try {
          const full = await get(`${root}/${encodeURIComponent(id)}/step?${query}`, true);
          const value = full.result;
          if (!value || typeof value !== "object" || Array.isArray(value) ||
              value.status !== "complete" || !("output" in value) || value.output === null || value.output === "[REDACTED]") {
            incomplete = true;
            continue;
          }
          fullStepsInspected++;
          if (JSON.stringify(value.output).toLowerCase().includes(vaultId.toLowerCase())) matched = true;
        } catch {
          // An unavailable, oversized, non-JSON or otherwise ambiguous step
          // is not evidence of absence. Never echo its name or response.
          incomplete = true;
          if (budget.used > MAX_SCAN_BYTES) { scanLimited = true; break; }
        }
      }
      if (matched) references.push({ id, status: result.status });
      if (incomplete) uninspectable++;
      if (scanLimited) break;
    }
    if (scanLimited || paginationUncertain) break;
    cursor = info.cursor || undefined;
    if (cursor && (cursor.length > 4096 || seenCursors.has(cursor))) throw new Error("INVALID_PROVIDER_PAGINATION");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return {
    status: "pending", inspected, uninspectable, scanLimited, paginationUncertain, fullStepsRequested, fullStepsInspected, fullStepScanLimited, references,
    reasons: ["FLEET_SNAPSHOT_NOT_PROVEN", "DELAYED_FLEET_EXECUTION_NOT_EXCLUDED", "STEP_OUTPUT_MAY_BE_REDACTED", "STEP_PREVIEWS_MAY_BE_TRUNCATED", ...(paginationUncertain ? ["PROVIDER_PAGINATION_UNCERTAIN"] : [])],
  };
}
