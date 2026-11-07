/**
 * The Node evaluator and Workflow Worker do not yet prove they use the same
 * deployed ledger, and provider-side billing bounds are not yet verified.
 * This is deliberately code-owned: environment variables cannot enable a
 * potentially paid call while either guarantee remains missing.
 */
export function sharedPilotSafetyReady(): boolean {
  return false;
}
