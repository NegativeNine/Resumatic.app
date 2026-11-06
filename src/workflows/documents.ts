import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { runModels } from "./models";
import {
  planDocument,
  verifyDocument,
  writeDocument,
  type DocumentDraft,
  type DocumentPlan,
  type DocumentResult,
  type DocumentState,
} from "../pipeline/documents";
import { errorCode } from "../shared/errors";
import { vault } from "../shared/stubs";
import type { Candidate } from "../shared/types";
import { MODEL_STEP, once, STEP } from "./steps";

export interface DocumentParams {
  vaultId: string;
  runId: string;
}
interface DocumentVault {
  claimRun(id: string, expected: { kind: "document"; targetId: string }): Promise<unknown>;
  documentInput(id: string): Promise<DocumentState>;
  cachedRefinement(id: string): Promise<DocumentDraft | null>;
  searchFacts(
    queries: number[][],
    k: number,
    runId: string,
  ): Promise<Candidate[]>;
  saveDocumentStep(
    id: string,
    step: string,
    patch: {
      plan?: DocumentPlan;
      draft?: DocumentDraft;
      result?: DocumentResult;
    },
  ): Promise<void>;
  finishDocument(id: string, result: DocumentResult): Promise<void>;
  failDocument(id: string, code: string): Promise<void>;
}

/** Content lives in the vault; every persisted Workflow step result contains counts only. */
export class DocumentWorkflow extends WorkflowEntrypoint<Env, DocumentParams> {
  async run(
    event: WorkflowEvent<DocumentParams>,
    step: WorkflowStep,
  ): Promise<{ units: number; questions: number } | { failed: true }> {
    const { vaultId, runId } = event.payload;
    // Do not let a foreign instance's failure handler mutate the target run.
    if (event.instanceId !== runId) return { failed: true };
    const v = vault(this.env, vaultId) as unknown as DocumentVault;
    try {
      await step.do(
        "plan",
        MODEL_STEP,
        once(async () => {
          await v.claimRun(event.instanceId, { kind: "document", targetId: runId });
          const input = await v.documentInput(runId);
          const plan =
            input.plan ??
            (await planDocument(
              runModels(this.env, vaultId, runId, "plan", "document"),
              input,
              (queries, k) => v.searchFacts(queries, k, runId),
            ));
          await v.saveDocumentStep(runId, "plan", { plan });
          return {
            facts:
              plan.selection.factIds.length + plan.selection.skillIds.length,
            questions: plan.questions.length,
          };
        }),
      );
      await step.do(
        "write",
        MODEL_STEP,
        once(async () => {
          const input = await v.documentInput(runId);
          if (!input.plan) throw new Error("document plan is missing");
          const draft =
            input.draft ??
            (await v.cachedRefinement(runId)) ??
            (await writeDocument(
              runModels(this.env, vaultId, runId, "write", "document"),
              input,
              input.plan,
            ));
          await v.saveDocumentStep(runId, "write", { draft });
          return { units: draft.units.length };
        }),
      );
      await step.do(
        "verify",
        MODEL_STEP,
        once(async () => {
          const input = await v.documentInput(runId);
          if (!input.plan || !input.draft)
            throw new Error("document draft is missing");
          const result =
            input.result ??
            (await verifyDocument(
              runModels(this.env, vaultId, runId, "verify", "document"),
              input,
              input.plan,
              input.draft,
            ));
          await v.saveDocumentStep(runId, "verify", { result });
          return { units: result.units.length, dropped: result.report.dropped };
        }),
      );
      return await step.do(
        "finish",
        STEP,
        once(async () => {
          const input = await v.documentInput(runId);
          if (!input.result) throw new Error("verified document is missing");
          await v.finishDocument(runId, input.result);
          return {
            units: input.result.units.length,
            questions: input.result.questions.length,
          };
        }),
      );
    } catch (error) {
      const code = errorCode(error) ?? "generation_failed";
      await step.do("fail", STEP, async () => {
        try {
          await v.failDocument(runId, code);
        } catch (failure) {
          if (
            errorCode(failure) !== "gone" &&
            errorCode(failure) !== "not_found"
          )
            throw failure;
        }
        return { failed: true };
      });
      return { failed: true };
    }
  }
}
