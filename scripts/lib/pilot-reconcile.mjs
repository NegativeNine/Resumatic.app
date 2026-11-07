import { createHmac } from "node:crypto";
import { auditPilotLedger } from "../../test/extract-evals/budget-ledger.mjs";

/** Compare separately captured accounting snapshots; this never settles a reservation. */
export function reconcilePilotAttempts(file, key, shared) {
  if (typeof key !== "string" || new TextEncoder().encode(key).length < 32 || !Array.isArray(shared))
    throw new Error("pilot_local_ledger_unavailable");
  const local = auditPilotLedger(file);
  const byMac = new Map(shared.map((attempt) => [attempt.idMac, attempt]));
  const localMacs = new Set();
  const attempts = local.attempts.map(({ id, ...row }) => {
    const idMac = createHmac("sha256", key).update(`resumatic-pilot-attempt-v1:${id}`, "utf8").digest("hex");
    localMacs.add(idMac);
    const remote = byMac.get(idMac);
    const comparison = !remote ? "local_only" : remote.reservedMicros !== row.reservedMicros ||
      (row.reservedCalls !== null && remote.reservedCalls !== row.reservedCalls) ||
      remote.state !== row.state || remote.actualMicros !== row.actualMicros ? "different" :
      row.reservedCalls === null ? "matching_amount_and_state_calls_unknown" : "matching_reservation_and_state";
    return { idMac, suite: row.suite, reservedMicros: row.reservedMicros, reservedCalls: row.reservedCalls,
      state: row.state, actualMicros: row.actualMicros, comparison };
  });
  return { status: "pending", totalMicros: local.totalMicros, totalCalls: local.totalCalls,
    frozen: local.frozen, budgets: local.budgets, attempts,
    sharedOnly: shared.filter((attempt) => !localMacs.has(attempt.idMac)).length,
    limitations: ["snapshots_not_atomic", ...(local.attempts.some((row) => row.reservedCalls === null) ? ["local_attempt_call_weights_unavailable"] : []), "provider_outcomes_unverified"] };
}
