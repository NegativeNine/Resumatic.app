import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { runModels } from "./models";
import {
  analyzeJob,
  composeBody,
  selectFacts,
  verifyDraft,
  writeDraft,
} from "../pipeline/tailor";
import { AppError, errorCode } from "../shared/errors";
import { vault } from "../shared/stubs";
import { MODEL_STEP, STEP, once, retrySafely, userMessage } from "./steps";

export type TailorParams = { vaultId: string; resumeId: string };

/**
 * Tailor: analyze the job, select facts, write, verify, finish. Each step reads what it needs
 * from the vault, writes its result back, and returns only counts.
 */
export class TailorWorkflow extends WorkflowEntrypoint<Env, TailorParams> {
  async run(
    event: WorkflowEvent<TailorParams>,
    step: WorkflowStep,
  ): Promise<{ lines: number } | { failed: true }> {
    const { vaultId, resumeId } = event.payload;
    const v = vault(this.env, vaultId);
    const m = (step: string) =>
      runModels(this.env, vaultId, event.instanceId, step, "tailor");
    try {
      await step.do(
        "claim",
        STEP,
        once(async () => {
          await v.claimRun(event.instanceId, { kind: "tailor", targetId: resumeId });
          return { ok: true };
        }),
      );
      await step.do(
        "analyze",
        MODEL_STEP,
        once(async () => {
          const input = await v.tailorInput(resumeId, event.instanceId);
          const analysis =
            input.analysis ?? (await analyzeJob(m("analyze"), input.jdText));
          if (!input.analysis)
            await v.saveAnalysis(input.applicationId, analysis, resumeId, event.instanceId);
          await v.saveStep(resumeId, "analyze", {}, event.instanceId);
          return { requirements: analysis.requirements.length };
        }),
      );
      await step.do(
        "select",
        MODEL_STEP,
        once(async () => {
          const input = await v.tailorInput(resumeId, event.instanceId);
          if (input.facts.length === 0)
            throw new AppError(
              "invalid",
              "confirm some facts before tailoring a resume",
            );
          const selection =
            input.selection ??
            (await selectFacts(
              m("select"),
              (q, k) => v.searchFacts(q, k, event.instanceId),
              input.analysis!,
              input.facts,
            ));
          await v.saveStep(resumeId, "select", { selection }, event.instanceId);
          return {
            facts: selection.factIds.length,
            gaps: selection.gaps.length,
          };
        }),
      );
      await step.do(
        "write",
        MODEL_STEP,
        once(async () => {
          const input = await v.tailorInput(resumeId, event.instanceId);
          if (input.selection!.factIds.length === 0) {
            throw new AppError(
              "invalid",
              "none of your confirmed facts match this job yet",
            );
          }
          const draft =
            input.draft ??
            (await writeDraft(
              m("write"),
              input.analysis!,
              input.selection!,
              input.facts,
              input.roles,
            ));
          await v.saveStep(resumeId, "write", { draft }, event.instanceId);
          return { lines: draft.lines.length };
        }),
      );
      await step.do(
        "verify",
        MODEL_STEP,
        once(async () => {
          const input = await v.tailorInput(resumeId, event.instanceId);
          const verified =
            input.verified ??
            (await verifyDraft(
              m("verify"),
              input.draft!,
              input.selection!,
              input.facts,
            ));
          await v.saveStep(resumeId, "verify", { verified }, event.instanceId);
          const { kept, repaired, replaced, dropped, gaps } = verified.report;
          return { kept, repaired, replaced, dropped, gaps: gaps.length };
        }),
      );
      return await step.do(
        "finish",
        STEP,
        once(async () => {
          const input = await v.tailorInput(resumeId, event.instanceId);
          const body = composeBody(
            input.verified!,
            input.roles,
            input.facts,
            input.selection!,
          );
          await v.saveStep(
            resumeId,
            "finish",
            { body, report: input.verified!.report, state: "ready" },
            event.instanceId,
          );
          return { lines: input.verified!.lines.length };
        }),
      );
    } catch (e) {
      const message = userMessage(
        e,
        "Tailoring stopped unexpectedly. Try again.",
      );
      await step.do("fail", STEP, retrySafely(async () => {
        try {
          await v.failResume(resumeId, message, event.instanceId);
        } catch (error) {
          if (errorCode(error) !== "gone") throw error;
        }
        return { failed: true };
      }));
      return { failed: true };
    }
  }
}
