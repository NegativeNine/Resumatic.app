import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { models } from "../ai/models";
import { analyzeJob, composeBody, selectFacts, verifyDraft, writeDraft } from "../pipeline/tailor";
import { AppError } from "../shared/errors";
import { vault } from "../shared/stubs";
import { MODEL_STEP, STEP, once, userMessage } from "./steps";

export type TailorParams = { vaultId: string; resumeId: string };

/**
 * Tailor: analyze the job, select facts, write, verify, finish. Each step reads what it needs
 * from the vault, writes its result back, and returns only counts.
 */
export class TailorWorkflow extends WorkflowEntrypoint<Env, TailorParams> {
  async run(event: WorkflowEvent<TailorParams>, step: WorkflowStep): Promise<{ lines: number } | { failed: true }> {
    const { vaultId, resumeId } = event.payload;
    const v = vault(this.env, vaultId);
    const m = () => models(this.env);
    try {
      await step.do(
        "analyze",
        MODEL_STEP,
        once(async () => {
          const input = await v.tailorInput(resumeId);
          const analysis = input.analysis ?? (await analyzeJob(m(), input.jdText));
          if (!input.analysis) await v.saveAnalysis(input.applicationId, analysis);
          await v.saveStep(resumeId, "analyze", {});
          return { requirements: analysis.requirements.length };
        }),
      );
      await step.do(
        "select",
        MODEL_STEP,
        once(async () => {
          const input = await v.tailorInput(resumeId);
          if (input.facts.length === 0) throw new AppError("invalid", "confirm some facts before tailoring a resume");
          const selection = await selectFacts(m(), (q, k) => v.searchFacts(q, k), input.analysis!, input.facts);
          await v.saveStep(resumeId, "select", { selection });
          return { facts: selection.factIds.length, gaps: selection.gaps.length };
        }),
      );
      await step.do(
        "write",
        MODEL_STEP,
        once(async () => {
          const input = await v.tailorInput(resumeId);
          if (input.selection!.factIds.length === 0) {
            throw new AppError("invalid", "none of your confirmed facts match this job yet");
          }
          const draft = await writeDraft(m(), input.analysis!, input.selection!, input.facts, input.roles);
          await v.saveStep(resumeId, "write", { draft });
          return { lines: draft.lines.length };
        }),
      );
      await step.do(
        "verify",
        MODEL_STEP,
        once(async () => {
          const input = await v.tailorInput(resumeId);
          const verified = await verifyDraft(m(), input.draft!, input.selection!, input.facts);
          await v.saveStep(resumeId, "verify", { verified });
          const { kept, repaired, replaced, dropped, gaps } = verified.report;
          return { kept, repaired, replaced, dropped, gaps: gaps.length };
        }),
      );
      return await step.do(
        "finish",
        STEP,
        once(async () => {
          const input = await v.tailorInput(resumeId);
          const body = composeBody(input.verified!, input.roles, input.facts, input.selection!);
          await v.saveStep(resumeId, "finish", { body, report: input.verified!.report, state: "ready" });
          return { lines: input.verified!.lines.length };
        }),
      );
    } catch (e) {
      const message = userMessage(e, "Tailoring stopped unexpectedly. Try again.");
      await step.do("fail", STEP, async () => {
        try {
          await v.failResume(resumeId, message);
        } catch {
          // The vault is gone; nothing left to record.
        }
        return { failed: true };
      });
      return { failed: true };
    }
  }
}
