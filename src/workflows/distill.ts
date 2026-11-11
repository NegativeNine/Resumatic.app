import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { runModels } from "./models";
import { modelFor } from "../ai/models";
import { ENTAILMENT_METHOD, offers } from "../pipeline/match";
import { SPLIT_METHOD, splitLines } from "../pipeline/split";
import { extractFacts } from "../pipeline/distill";
import { extractorById } from "../pipeline/extract";
import { validateTranscriptionInput } from "../ai/transcribe";
import { extractLinkedIn } from "../pipeline/linkedin-extract";
import { linkedInDocument, linkedInMarkdown } from "../pipeline/linkedin";
import { AppError, errorCode } from "../shared/errors";
import { vault } from "../shared/stubs";
import { MODEL_STEP, STEP, once, retrySafely, sourceFailureMessage } from "./steps";

export type DistillParams = { vaultId: string; sourceId: string };

/**
 * Work kept in shadow gets one short try. It is never worth holding an upload for. `limit` counts
 * the tries after the first, so it is 0: a stage that runs out of time is not run again, which
 * would repeat every model call it had made. Leaving `retries` out would allow five more.
 */
const SHADOW_STEP = { retries: { limit: 0, delay: "5 seconds" }, timeout: "3 minutes" } as const;

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
              "The uploaded file is missing. Upload it again.",
            );
          const m = runModels(this.env, vaultId, event.instanceId, "convert", "distill");
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
              "No text could be read from this file.",
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
        // Two structured-output attempts may each take three minutes.
        { ...MODEL_STEP, timeout: "7 minutes" },
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
          const m = runModels(this.env, vaultId, event.instanceId, "extract", "distill");
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
                "The uploaded file is missing. Upload it again.",
              );
            const bytes = new Uint8Array(await object.arrayBuffer());
            let document = linkedInDocument(bytes);
            // Older uploads have an immutable source with the original CSV column order.
            if (document.markdown !== markdown)
              document = linkedInDocument(bytes, "legacy");
            if (document.markdown !== markdown)
              throw new AppError(
                "conflict",
                "The import source changed. Upload it again.",
              );
            result = await extractLinkedIn(
              document,
              extractor,
              m,
              referenceDate,
              info.filename,
              this.env.ROLE_UNKNOWN_END_ENABLED === "true",
            );
          } else
            result = await extractFacts(m, markdown, {
              extractor,
              filename: info.filename,
              referenceDate,
              preserveUnknownEnd: this.env.ROLE_UNKNOWN_END_ENABLED === "true",
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
            "distill",
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
      // What an upload says again is found before anyone is shown a merge. Where this is switched
      // on, each role and fact that repeats an earlier one word for word is noted in shadow.
      // Nothing is merged, and a failure here leaves the upload exactly as it is read today.
      if (this.env.MATCH_SHADOW_ENABLED === "true")
        try {
          await step.do(
            "match",
            SHADOW_STEP,
            once(async () => {
              try {
                const found = await v.matchShadow(sourceId, event.instanceId);
                // Counts only: no role and no line is kept in the Workflow's own state.
                return { roles: found.roles, facts: found.facts, stored: found.stored };
              } catch (error) {
                return { roles: 0, facts: 0, stored: 0, failed: errorCode(error) ?? "error" };
              }
            }),
          );
        } catch {
          // The step ran out of time. Nothing was kept.
        }
      // Two lines that say the same thing in different words are only ever offered to the owner.
      // Where this is switched on, the judge is asked about the likeliest pairs and its answers
      // are kept as offers in shadow. A failure here leaves the upload as it is read today.
      if (this.env.OFFER_SHADOW_ENABLED === "true")
        try {
          await step.do(
            "offer",
            SHADOW_STEP,
            once(async () => {
              try {
                const pairs = await v.offerCandidates(sourceId, event.instanceId);
                if (pairs.length === 0) return { pairs: 0, same: 0, fuller: 0, stored: 0 };
                const found = await offers(runModels(this.env, vaultId, event.instanceId, "offer", "distill"), pairs);
                const { stored } = await v.saveShadowOffers(sourceId, event.instanceId, { model: modelFor(this.env, "judge"), method: ENTAILMENT_METHOD }, found);
                // Counts only: no line is kept in the Workflow's own state.
                return { pairs: pairs.length, same: found.filter((offer) => offer.relation === "same").length, fuller: found.filter((offer) => offer.relation === "fuller").length, stored };
              } catch (error) {
                return { pairs: 0, same: 0, fuller: 0, stored: 0, failed: errorCode(error) ?? "error" };
              }
            }),
          );
        } catch {
          // The step ran out of time. Nothing was kept.
        }
      // How lines divide is measured before anyone is shown a division. Where this is switched
      // on, whatever passes every check is kept in shadow. A failure here costs nothing: every
      // line stays whole, as it is read today, and the upload finishes as it would have.
      if (this.env.SPLIT_SHADOW_ENABLED === "true")
        try {
          await step.do(
            "split",
            SHADOW_STEP,
            once(async () => {
              try {
                const lines = await v.splitCandidates(sourceId, event.instanceId);
                if (lines.length === 0) return { lines: 0, divided: 0 };
                const decisions = await splitLines(runModels(this.env, vaultId, event.instanceId, "split", "distill"), lines);
                const text = new Map(lines.map((line) => [line.id, line.text]));
                const refused: Record<string, number> = {};
                for (const decision of decisions) if (decision.refusal) refused[decision.refusal] = (refused[decision.refusal] ?? 0) + 1;
                const { stored } = await v.saveShadowSplits(
                  sourceId,
                  event.instanceId,
                  { model: `${modelFor(this.env, "extract")}+${modelFor(this.env, "judge")}`, method: SPLIT_METHOD },
                  decisions.flatMap((decision) => (decision.parts ? [{ factId: decision.id, line: text.get(decision.id)!, parts: decision.parts }] : [])),
                );
                // Counts only: no line and no part is kept in the Workflow's own state.
                return { lines: lines.length, divided: stored, refused };
              } catch (error) {
                return { lines: 0, divided: 0, failed: errorCode(error) ?? "error" };
              }
            }),
          );
        } catch {
          // The step ran out of time. Nothing was kept, and the lines stay whole.
        }
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
      const message = sourceFailureMessage(e);
      await step.do("fail", STEP, retrySafely(async () => {
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
      }));
      return { failed: true };
    }
  }
}
