export function createPilotLedger(
  directory: string,
  budgetMicros: number,
  maxCalls: number,
): {
  file: string;
  extraction: { micros: number; calls: number };
  tailoring: { micros: number; calls: number };
};
export function reservePilotLedger(
  file: string,
  suite: string,
  configuredMicros: number,
  configuredCalls: number,
  costMicros: number,
  attemptWeight?: number,
): { calls: number; reservedUsd: number };
