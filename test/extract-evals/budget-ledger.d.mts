export function createPilotLedger(
  directory: string,
  budgetMicros: number,
  maxCalls: number,
  extractionCallLimit?: number,
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
  attemptId?: string,
): { calls: number; reservedUsd: number };

export function settlePilotAttempt(
  file: string,
  suite: string,
  attemptId: string,
  actualMicros: number | null,
): void;
export function finishPilotSuite(
  file: string,
  suite: string,
  succeeded: boolean,
): boolean;
export function freezePilotLedger(file: string): void;
