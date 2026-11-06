import { deletionProbeInput } from "./deletion-audit.mjs";

const VAULT = /^[a-f0-9]{64}$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const BINDING = { distill: "DISTILL", tailor: "TAILOR", refine: "DOCUMENTS", letter: "DOCUMENTS", prep: "DOCUMENTS", questions: "DOCUMENTS", reembed: "REEMBED" };
const BINDINGS = ["DISTILL", "TAILOR", "DOCUMENTS", "REEMBED"];
const STATES = new Set(["queued", "running", "paused", "errored", "terminated", "complete", "waitingForPause", "waiting", "rollingBack"]);

/**
 * Compare a pre-deletion ledger with provider-visible per-vault Workflow instances.
 * This is diagnostic only: an API scan cannot prove a complete snapshot, exclude
 * delayed creates, cover expired instances, or inspect the fleet Workflow's state.
 * Provider responses may contain sensitive data; return only IDs and counts.
 */
export async function compareWorkflowInventory({ manifest, accountId, token, workflows, maxInstances = 250, fetcher = fetch }) {
  if (!manifest || !VAULT.test(manifest.vaultId ?? "") ||
      !/^[a-f0-9]{32}$/i.test(accountId ?? "") || typeof token !== "string" || !token ||
      !Array.isArray(workflows) ||
      !Number.isSafeInteger(maxInstances) || maxInstances < 1 || maxInstances > 5000)
    throw new Error("INVALID_INVENTORY_CONFIGURATION");
  const base = manifest.base;
  deletionProbeInput({ ...manifest, deletionRequested: true }, base);
  const configured = new Map();
  for (const binding of BINDINGS) {
    const entries = workflows?.filter((w) => w.binding === binding) ?? [];
    if (entries.length !== 1 || typeof entries[0].name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(entries[0].name))
      throw new Error("INVALID_WORKFLOW_BINDINGS");
    configured.set(binding, entries[0].name);
  }
  if (new Set(configured.values()).size !== BINDINGS.length) throw new Error("INVALID_WORKFLOW_BINDINGS");

  const expected = new Map();
  for (const run of manifest.runs) {
    if (run.kind === "embed") continue;
    const binding = BINDING[run.kind];
    expected.set(`${binding}:${run.id}`, run);
  }
  const found = new Set();
  const untracked = [];
  const mismatched = [];
  let inspected = 0, unattributed = 0, pages = 0;
  const root = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workflows`;
  async function get(url) {
    let response;
    try {
      response = await fetcher(url, {
        method: "GET", headers: { Authorization: `Bearer ${token}` },
        redirect: "error", signal: AbortSignal.timeout(15000),
      });
    } catch { throw new Error("PROVIDER_REQUEST_FAILED"); }
    if (!response.ok) throw new Error("PROVIDER_REQUEST_FAILED");
    try {
      const body = await response.json();
      if (body?.success !== true || body.result === undefined ||
          (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length))) throw new Error();
      return body;
    } catch { throw new Error("INVALID_PROVIDER_RESPONSE"); }
  }
  for (const binding of BINDINGS) {
    const url = `${root}/${encodeURIComponent(configured.get(binding))}/instances`;
    let cursor;
    const cursors = new Set(), ids = new Set();
    do {
      if (++pages > 200) throw new Error("PROVIDER_SCAN_LIMIT");
      const query = new URLSearchParams({ per_page: "100" });
      if (cursor) query.set("cursor", cursor);
      const body = await get(`${url}?${query}`);
      if (!Array.isArray(body.result) || body.result.length > 100 || !body.result_info ||
          typeof body.result_info !== "object" || Array.isArray(body.result_info) ||
          (body.result_info.cursor !== undefined && body.result_info.cursor !== null && typeof body.result_info.cursor !== "string"))
        throw new Error("INVALID_PROVIDER_RESPONSE");
      if (body.result.length === 100 && !body.result_info.cursor)
        throw new Error("PROVIDER_PAGINATION_AMBIGUOUS");
      for (const item of body.result) {
        const id = item?.id;
        if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || ids.has(id)) throw new Error("INVALID_PROVIDER_RESPONSE");
        ids.add(id);
        if (++inspected > maxInstances) throw new Error("PROVIDER_SCAN_LIMIT");
        const detail = await get(`${url}/${encodeURIComponent(id)}?simple=true`);
        const result = detail.result;
        if (!result || typeof result !== "object" || !STATES.has(result.status)) throw new Error("INVALID_PROVIDER_RESPONSE");
        const params = result.params;
        if (!params || typeof params !== "object" || Array.isArray(params) ||
            typeof params.vaultId !== "string" || !VAULT.test(params.vaultId)) {
          unattributed++;
          continue;
        }
        if (params.vaultId.toLowerCase() !== manifest.vaultId.toLowerCase()) continue;
        // Do not echo arbitrary provider-controlled strings into the report.
        if (!UUID.test(id)) { unattributed++; continue; }
        const key = `${binding}:${id}`;
        const run = expected.get(key);
        if (!run) { untracked.push({ binding, id }); continue; }
        found.add(key);
        const valid = binding === "DISTILL" ? params.sourceId === run.targetId
          : binding === "TAILOR" ? params.resumeId === run.targetId
          : params.runId === id;
        if (!valid) mismatched.push({ binding, id });
      }
      cursor = body.result_info.cursor || undefined;
      if (cursor && (cursor.length > 4096 || cursors.has(cursor))) throw new Error("INVALID_PROVIDER_PAGINATION");
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }
  const ledgerNotObserved = [...expected.keys()].filter((key) => !found.has(key)).map((key) => {
    const [binding, id] = key.split(":");
    return { binding, id };
  });
  return {
    status: "pending", inspected, unattributed, ledgerNotObserved,
    visibleNotInLedger: untracked, payloadMismatch: mismatched,
    reasons: ["PROVIDER_SNAPSHOT_NOT_PROVEN", "DELAYED_CREATES_NOT_EXCLUDED", "RETAINED_AND_FLEET_WORKFLOWS_NOT_AUDITED"],
  };
}
