import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { runModels } from "./models";
import { extractFacts } from "../pipeline/distill";
import { extractorById } from "../pipeline/extract";
import { validateTranscriptionInput } from "../ai/transcribe";
import { linkedInMarkdown } from "../pipeline/linkedin";
import { AppError, errorCode } from "../shared/errors";
import { vault } from "../shared/stubs";
import { MODEL_STEP, STEP, once, userMessage } from "./steps";

export type DistillParams = { vaultId: string; sourceId: string };

/**
 * Distill: convert an upload to Markdown, extract quoted facts, embed them. Each step writes to
 * the vault and returns only counts, so Workflow state holds no career text.
 */
export class DistillWorkflow extends WorkflowEntrypoint<Env, DistillParams> {
  async run(
    event: WorkflowEvent<DistillParams>,
    step: WorkflowStep,
  ): Promise<{ facts: number; dropped: number } | { failed: true }> {
    const { vaultId, sourceId } = event.payload;
    const v = vault(this.env, vaultId);
    try {
      await step.do(
        "claim",
        STEP,
        once(async () => {
          await v.claimRun(event.instanceId);
          return { ok: true };
        }),
      );
      await step.do(
        "convert",
        STEP,
        once(async () => {
          const progress = await v.sourceProgress(sourceId, event.instanceId);
          if (progress.convertedChars !== null) {
            await v.completeSourceStep(sourceId, "convert", event.instanceId);
            return { chars: progress.convertedChars };
          }
          const info = await v.sourceInfo(sourceId);
          const object = await this.env.FILES.get(info.r2Key);
          if (!object)
            throw new AppError(
              "not_found",
              "the uploaded file is missing; upload it again",
            );
          const m = runModels(this.env, vaultId, event.instanceId, "convert");
          const markdown =
            info.origin === "ocr"
              ? (
                  await m.transcribePages!(
                    validateTranscriptionInput(await object.json()),
                  )
                ).markdown
              : info.filename.toLowerCase().endsWith(".zip")
                ? linkedInMarkdown(new Uint8Array(await object.arrayBuffer()))
                : await m.toMarkdown(info.filename, await object.blob());
          if (!markdown.trim())
            throw new AppError(
              "invalid",
              "no text could be read from this file",
            );
          await v.saveSource(sourceId, { markdown }, event.instanceId);
          return { chars: markdown.length };
        }),
      );
      const extracted = await step.do(
        "extract",
        MODEL_STEP,
        once(async () => {
          const progress = await v.sourceProgress(sourceId, event.instanceId);
          if (progress.extraction) {
            await v.completeSourceStep(sourceId, "extract", event.instanceId);
            return {
              facts: progress.extraction.facts,
              dropped: progress.extraction.dropped,
            };
          }
          const markdown = await v.sourceText(sourceId);
          const info = await v.sourceInfo(sourceId);
          const extractor = extractorById(progress.extractor);
          const { extraction, dropped } = await extractFacts(
            runModels(this.env, vaultId, event.instanceId, "extract"),
            markdown,
            {
              extractor,
              filename: info.filename,
              referenceDate: new Date(info.createdAt)
                .toISOString()
                .slice(0, 10),
            },
          );
          const saved = await v.saveExtraction(
            sourceId,
            extraction,
            event.instanceId,
            extractor.id,
            dropped,
          );
          await v.completeSourceStep(sourceId, "extract", event.instanceId);
          return { facts: saved.facts, dropped };
        }),
      );
      await step.do(
        "embed",
        MODEL_STEP,
        once(async () => {
          const embeddingModel = await v.embeddingModel();
          const pending = await v.unembeddedFacts(sourceId);
          if (pending.length === 0) {
            await v.completeSourceStep(sourceId, "embed", event.instanceId);
            return { embedded: 0 };
          }
          const vectors = await runModels(
            this.env,
            vaultId,
            event.instanceId,
            "embed",
          ).embed(
            pending.map((f) => f.text),
            { model: embeddingModel },
          );
          await v.saveVectors(
            pending
              .map((f, i) => ({
                factId: f.id,
                revision: f.revision,
                vector: vectors[i] ?? [],
              }))
              .filter((x) => x.vector.length),
            embeddingModel,
          );
          await v.completeSourceStep(sourceId, "embed", event.instanceId);
          return { embedded: pending.length };
        }),
      );
      await step.do(
        "finish",
        STEP,
        once(async () => {
          await v.saveSource(
            sourceId,
            { state: "ready", error: null },
            event.instanceId,
          );
          return { ok: true };
        }),
      );
      return extracted;
    } catch (e) {
      const message = userMessage(e, "We could not read this file.");
      await step.do("fail", STEP, async () => {
        try {
          await v.saveSource(
            sourceId,
            { state: "failed", error: message },
            event.instanceId,
          );
        } catch (error) {
          if (errorCode(error) !== "gone") throw error;
        }
        return { failed: true };
      });
      return { failed: true };
    }
  }
}
