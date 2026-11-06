export interface CandidateForKey {
  caseId: string;
  strategy: string;
  roleKey: string | null;
  kind: string;
  level: string | null;
  span: readonly [number, number];
  text: string;
  quote: string;
}
export function candidateKey(candidate: CandidateForKey): string;
export function assessPromotion(
  root: string,
  runId: string,
  auditPath?: string,
): {
  version: number;
  mode: string;
  profile: "round-1" | "full";
  runId: string;
  environment: "staging" | "production";
  strategies: string[];
  manifestHash: string;
  snapshotSha256: string;
  configurationHash: string;
  results: {
    strategy: string;
    status: "pending" | "failed" | "eligible";
    pending: string[];
    failed: string[];
    sampleKeys: string[];
    metrics: Record<string, number | null>;
  }[];
  winner: string | null;
  rankingPending: boolean;
};
