import { errorCode } from "../shared/errors";

/**
 * A reservation key is unique and never reusable. Once its Vault is closed,
 * completion cannot publish the object, so a late acknowledged put can be
 * removed. A conflict is safe only if the Vault separately confirms that the
 * exact reservation is permanently expired. A timeout, disconnect, signed-out
 * session, or conflict alone does not prove the source was not committed.
 *
 * This is best effort, not a quiescence guarantee: a Worker can crash before
 * this cleanup runs or an R2 put can have an unknown outcome.
 */
export async function completeReservedUpload<T>(
  bucket: Pick<R2Bucket, "delete">,
  key: string,
  complete: () => Promise<T>,
  options: {
    expired?: () => Promise<boolean>;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  try {
    return await complete();
  } catch (error) {
    const code = errorCode(error);
    let safeToDelete = code === "gone";
    if (code === "conflict" && options.expired) {
      try {
        safeToDelete = (await options.expired()) === true;
      } catch {
        // Unknown state, including a lost or revoked session, is not evidence.
      }
    }
    if (safeToDelete) {
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
