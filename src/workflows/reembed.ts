import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { vault } from "../shared/stubs";
import { errorCode } from "../shared/errors";
import { runModels } from "./models";
import { MODEL_STEP, STEP, once } from "./steps";
export type ReembedParams = { vaultId: string; runId: string };
/** Every batch returns counts only; facts and staged vectors remain in the vault. */
export class ReembedWorkflow extends WorkflowEntrypoint<Env, ReembedParams> {
  async run(event: WorkflowEvent<ReembedParams>, step: WorkflowStep) {
    const { vaultId, runId } = event.payload;
    const v = vault(this.env, vaultId);
    try {
      for (let page = 0; page < 10000; page++) {
        const batch = await step.do(
          `batch ${page}`,
          MODEL_STEP,
          once(async () => {
            const { model, items } = await v.reembedBatch(runId);
            if (!items.length) return { done: true, saved: 0 };
            const vectors = await runModels(
              this.env,
              vaultId,
              runId,
              `batch ${page}`,
            ).embed(
              items.map((i) => i.text),
              { model },
            );
            if (vectors.length !== items.length)
              throw new Error("embedding_count_mismatch");
            const saved = await v.saveReembedBatch(
              runId,
              items.map((i, n) => ({ ...i, vector: vectors[n]! })),
            );
            return { done: false, saved: saved.saved };
          }),
        );
        if (batch.done) {
          await step.do(
            "activate",
            STEP,
            once(() => v.finishReembed(runId)),
          );
          return { complete: true };
        }
      }
      throw new Error("embedding_batch_limit");
    } catch (error) {
      await step.do("fail", STEP, async () => {
        try {
          await v.failReembed(runId);
        } catch (e) {
          if (errorCode(e) !== "gone") throw e;
        }
        return { failed: true };
      });
      return { failed: true };
    }
  }
}
