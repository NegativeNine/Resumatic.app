import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export type TailorParams = { vaultId: string; resumeId: string };

/**
 * Tailor: analyze the job description, select facts, write, verify, finish.
 * Steps write to the vault and return only IDs and counts. Built in M3.
 */
export class TailorWorkflow extends WorkflowEntrypoint<Env, TailorParams> {
  async run(_event: WorkflowEvent<TailorParams>, _step: WorkflowStep): Promise<void> {}
}
