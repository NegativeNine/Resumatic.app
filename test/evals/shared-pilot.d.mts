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
}
export function sharedPilotFromEnv(env?: NodeJS.ProcessEnv): SharedPilotBudget;
