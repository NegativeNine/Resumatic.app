export interface SharedPilot {
  reserve(id: string, micros: number, calls: number): Promise<void>;
  settle(id: string, actualMicros: number | null): Promise<void>;
  freeze(): Promise<void>;
}
export const SHARED_PILOT_IDENTITY_VERIFIED: boolean;
export class SharedPilotBudget implements SharedPilot {
  constructor(origin: string, key: string, fetcher?: typeof fetch);
  reserve(id: string, micros: number, calls: number): Promise<void>;
  settle(id: string, actualMicros: number | null): Promise<void>;
  freeze(): Promise<void>;
  status(): Promise<unknown>;
  auditAttempts(): Promise<{
    totals: { maxMicros: number; maxCalls: number; reservedMicros: number; reservedCalls: number; frozen: boolean; count: number; pending: number; unknown: number; overrun: number };
    attempts: { idMac: string; reservedMicros: number; reservedCalls: number; state: "pending" | "settled" | "unknown" | "overrun"; actualMicros: number | null }[];
  }>;
  beginIdentity(path: "distill" | "tailor" | "document" | "reembed" | "vault", vaultId: string): Promise<{ nonce: string; expiresAt: number }>;
  identityStatus(nonce: string): Promise<{ state: "waiting" | "observed" }>;
  consumeIdentity(nonce: string, runId: string): Promise<{ path: string; vaultId: string; runId: string; step: string; workerVersion: string; runtimeVersion: string }>;
}
export function sharedPilotFromEnv(env?: NodeJS.ProcessEnv): SharedPilotBudget;
