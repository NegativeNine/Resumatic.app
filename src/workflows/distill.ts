import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { models } from "../ai/models";
import { extractFacts } from "../pipeline/distill";
import { AppError } from "../shared/errors";
import { vault } from "../shared/stubs";
import { MODEL_STEP, STEP, once, userMessage } from "./steps";

export type DistillParams = { vaultId: string; sourceId: string };

/**
 * Distill: convert an upload to Markdown, extract quoted facts, embed them. Each step writes to
 * the vault and returns only counts, so Workflow state holds no career text.
 */
export class DistillWorkflow extends WorkflowEntrypoint<Env, DistillParams> {
  async run(event: WorkflowEvent<DistillParams>, step: WorkflowStep): Promise<{ facts: number; dropped: number } | { failed: true }> {
    const { vaultId, sourceId } = event.payload;
    const v = vault(this.env, vaultId);
    try {
      await step.do(
        "convert",
        STEP,
        once(async () => {
          const info = await v.sourceInfo(sourceId);
          const object = await this.env.FILES.get(info.r2Key);
          if (!object) throw new AppError("not_found", "the uploaded file is missing; upload it again");
          const markdown = await models(this.env).toMarkdown(info.filename, await object.blob());
          if (!markdown.trim()) throw new AppError("invalid", "no text could be read from this file");
          await v.saveSource(sourceId, { markdown });
          return { chars: markdown.length };
        }),
      );
      const extracted = await step.do(
        "extract",
        MODEL_STEP,
        once(async () => {
          const markdown = await v.sourceText(sourceId);
          const { extraction, dropped } = await extractFacts(models(this.env), markdown);
          const saved = await v.saveExtraction(sourceId, extraction);
          return { facts: saved.facts, dropped };
        }),
      );
      await step.do(
        "embed",
        MODEL_STEP,
        once(async () => {
          const pending = await v.unembeddedFacts(sourceId);
          if (pending.length === 0) return { embedded: 0 };
          const vectors = await models(this.env).embed(pending.map((f) => f.text));
          await v.saveVectors(pending.map((f, i) => ({ factId: f.id, vector: vectors[i] ?? [] })).filter((x) => x.vector.length));
          return { embedded: pending.length };
        }),
      );
      await step.do(
        "finish",
        STEP,
        once(async () => {
          await v.saveSource(sourceId, { state: "ready", error: null });
          return { ok: true };
        }),
      );
      return extracted;
    } catch (e) {
      const message = userMessage(e, "We could not read this file.");
      await step.do("fail", STEP, async () => {
        try {
          await v.saveSource(sourceId, { state: "failed", error: message });
        } catch {
          // The vault is gone; nothing left to record.
        }
        return { failed: true };
      });
      return { failed: true };
    }
  }
}
