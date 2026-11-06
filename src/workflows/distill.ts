import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { runModels } from "./models";
import { extractFacts } from "../pipeline/distill";
import { extractorById } from "../pipeline/extract";
import { validateTranscriptionInput } from "../ai/transcribe";
import { extractLinkedIn } from "../pipeline/linkedin-extract";
import { linkedInDocument, linkedInMarkdown } from "../pipeline/linkedin";
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
          await v.claimRun(event.instanceId, { kind: "distill", targetId: sourceId });
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
          let markdown: string;
          let ocrImageCount: number | undefined;
          if (info.origin === "ocr") {
            const input = validateTranscriptionInput(await object.json());
            ocrImageCount = input.images.length;
            markdown = (await m.transcribePages!(input)).markdown;
          } else {
            markdown = info.filename.toLowerCase().endsWith(".zip")
              ? linkedInMarkdown(new Uint8Array(await object.arrayBuffer()))
              : await m.toMarkdown(info.filename, await object.blob());
          }
          if (!markdown.trim())
            throw new AppError(
              "invalid",
              "no text could be read from this file",
            );
          await v.saveSource(
            sourceId,
            {
              markdown,
              ...(ocrImageCount === undefined ? {} : { ocrImageCount }),
            },
            event.instanceId,
          );
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
          const m = runModels(this.env, vaultId, event.instanceId, "extract");
          const referenceDate = new Date(info.createdAt)
            .toISOString()
            .slice(0, 10);
          let result;
          if (
            info.origin !== "ocr" &&
            info.filename.toLowerCase().endsWith(".zip")
          ) {
            const object = await this.env.FILES.get(info.r2Key);
            if (!object)
              throw new AppError(
                "not_found",
                "the uploaded file is missing; upload it again",
              );
            const bytes = new Uint8Array(await object.arrayBuffer());
            let document = linkedInDocument(bytes);
            // Older uploads have an immutable source with the original CSV column order.
            if (document.markdown !== markdown)
              document = linkedInDocument(bytes, "legacy");
            if (document.markdown !== markdown)
              throw new AppError(
                "conflict",
                "the import source changed; upload it again",
              );
            result = await extractLinkedIn(
              document,
              extractor,
              m,
              referenceDate,
              info.filename,
            );
          } else
            result = await extractFacts(m, markdown, {
              extractor,
              filename: info.filename,
              referenceDate,
            });
          const { extraction, dropped } = result;
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
          const pending = await v.unembeddedFacts(sourceId, event.instanceId);
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
            { runId: event.instanceId, sourceId },
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
          if (errorCode(error) !== "gone" && errorCode(error) !== "not_found") throw error;
        }
        return { failed: true };
      });
      return { failed: true };
    }
  }
}
