import { z } from "zod";
import { AppError } from "../shared/errors";

type Mapping =
  | { status: "absent" | "unavailable" }
  | { status: "matched"; token: string; initializationPending: boolean };

const boundedIds = z.object({ ids: z.array(z.uuid()).max(64), truncated: z.boolean() }).strict();
const boundedCount = z.object({ count: z.number().int().min(0).max(1000), truncated: z.boolean() }).strict();
const vaultSnapshot = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unavailable") }).strict(),
  z.object({
    status: z.literal("available"),
    workflow: z.object({ dispatches: boundedIds, redispatches: boundedIds }).strict(),
    r2: z.object({ sourceWrites: boundedCount, otherWrites: boundedCount }).strict(),
    billing: z.object({
      customerCreation: z.enum(["absent", "present", "invalid"]),
      checkoutCreation: z.enum(["absent", "present", "invalid"]),
    }).strict(),
  }).strict(),
]);

/** A diagnostic snapshot only. The mapping checks are not a distributed transaction. */
export async function deletionFenceReport(
  readMappings: () => Promise<Mapping[]>,
  readVault: () => Promise<unknown>,
) {
  const within = async <T>(read: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        read(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 5000); }),
      ]);
    } catch {
      throw new AppError("unavailable", "deletion diagnostic is unavailable");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const match = (rows: Mapping[]) => {
    if (!Array.isArray(rows) || rows.length !== 17 || rows.some((row) =>
      !row || !["absent", "matched"].includes(row.status)))
      throw new AppError("unavailable", "deletion mapping is unavailable");
    const found = rows.flatMap((row, index) => row.status === "matched" ? [{ ...row, index }] : []);
    const value = found[0];
    if (found.length !== 1 || !value || typeof value.token !== "string" ||
        !/^(?:account:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:(?:deleting|swept)|retired:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:(?:deleting|awaiting_final_sweep))$/i.test(value.token) ||
        typeof value.initializationPending !== "boolean")
      throw new AppError("unavailable", "deletion mapping is unavailable");
    return value;
  };
  const before = match(await within(readMappings));
  const snapshot = vaultSnapshot.safeParse(await within(readVault));
  if (!snapshot.success) throw new AppError("unavailable", "vault diagnostic is unavailable");
  const after = match(await within(readMappings));
  if (before.index !== after.index || before.token !== after.token)
    throw new AppError("unavailable", "deletion mapping changed; retry the diagnostic");
  return {
    status: "pending" as const,
    complete: false as const,
    scope: "observed_current_fences_only" as const,
    directory: { initializationPending: after.initializationPending },
    vault: snapshot.data,
    limitations: ["snapshots_are_not_atomic", "legacy_or_unregistered_writes", "provider_operations_and_retention"],
  };
}
