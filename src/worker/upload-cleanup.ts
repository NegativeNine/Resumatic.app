import { errorCode } from "../shared/errors";

/**
 * A reservation key is unique and never reusable. Once its Vault is closed,
 * completion cannot publish the object, so a late acknowledged put can be
 * removed. A timeout, disconnect, signed-out session, or conflict does not
 * prove this: in those cases the original source may already be committed.
 *
 * This is best effort, not a quiescence guarantee: a Worker can crash before
 * this cleanup runs or an R2 put can have an unknown outcome.
 */
export async function completeReservedUpload<T>(
  bucket: Pick<R2Bucket, "delete">,
  key: string,
  complete: () => Promise<T>,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  try {
    return await complete();
  } catch (error) {
    if (errorCode(error) === "gone") {
      let deleted = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await bucket.delete(key);
          deleted = true;
          break;
        } catch {
          if (attempt < 2) await wait(30 * 2 ** attempt);
        }
      }
      if (!deleted)
        console.error("late upload cleanup failed", {
          code: "r2_delete_failed",
        });
    }
    throw error;
  }
}
