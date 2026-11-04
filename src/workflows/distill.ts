import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export type DistillParams = { vaultId: string; sourceId: string };

/**
 * Distill: convert an upload to Markdown, extract quoted facts, embed them.
 * Steps write to the vault and return only IDs and counts. Built in M2.
 */
export class DistillWorkflow extends WorkflowEntrypoint<Env, DistillParams> {
  async run(_event: WorkflowEvent<DistillParams>, _step: WorkflowStep): Promise<void> {}
}
