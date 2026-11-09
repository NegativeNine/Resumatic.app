/** A run is one execution attempt. Its output and its provider charges have separate ledgers. */
export const RUN_KINDS = [
  "distill",
  "tailor",
  "refine",
  "letter",
  "prep",
  "questions",
  "fit",
  "reembed",
  "embed",
] as const;
export type RunKind = (typeof RUN_KINDS)[number];
/** Runs that make an application document. A fit preview is one: it reads the posting and writes nothing. */
export const DOCUMENT_RUN_KINDS: readonly RunKind[] = ["refine", "letter", "prep", "questions", "fit"];
/** Runs that read a posting and work from the person's facts: one at a time. */
export const GENERATION_RUN_KINDS: readonly RunKind[] = ["tailor", ...DOCUMENT_RUN_KINDS];
/** Document kinds that use no output: they write nothing a person would send. */
export const FREE_DOCUMENT_KINDS: readonly RunKind[] = ["questions", "fit"];
export type RunState =
  | "starting"
  | "running"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "cancelled";
export type CreditState = "none" | "reserved" | "consumed" | "released";

export interface QuotaBucket {
  key: string;
  startAt: number;
  endAt: number;
  limit: number;
}

export interface QuotaBalance extends QuotaBucket {
  used: number;
  reserved: number;
  available: number;
}

export interface RunRecord {
  id: string;
  kind: RunKind;
  targetId: string;
  requestKey: string;
  inputDigest: string;
  state: RunState;
  steps: string[];
  nextStep: number;
  bucketKey: string | null;
  creditState: CreditState;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BeginRun {
  id: string;
  kind: RunKind;
  targetId: string;
  requestKey: string;
  inputDigest: string;
  /** Ordered durable steps before publication; do not include the final publication operation. */
  steps: string[];
  /** Supplying a bucket reserves one output unit. Omit for uploads and maintenance. */
  quota?: QuotaBucket;
}

export interface ReserveModelAttempt {
  id: string;
  runId: string;
  step: string;
  attempt: number;
  model: string;
  /** Upper bound for this one outbound request, in millionths of a US dollar. */
  maxCostMicros: number;
}

export interface ModelAttempt extends ReserveModelAttempt {
  spendDay: string;
  state: "reserved" | "unknown" | "settled";
  actualCostMicros: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface SpendBalance {
  day: string;
  spentMicros: number;
  reservedMicros: number;
  unknownMicros: number;
}

export function freeQuotaBucket(now: number, limit: number): QuotaBucket {
  const date = new Date(now);
  const startAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  return {
    key: `free:${new Date(startAt).toISOString().slice(0, 7)}`,
    startAt,
    endAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
    limit,
  };
}

/** Period timestamps are milliseconds, taken from the canonical paid subscription snapshot. */
export function paidQuotaBucket(
  subscriptionId: string,
  startAt: number,
  endAt: number,
  limit: number,
): QuotaBucket {
  return { key: `paid:${subscriptionId}:${startAt}`, startAt, endAt, limit };
}

export function isTerminalRun(state: RunState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}
