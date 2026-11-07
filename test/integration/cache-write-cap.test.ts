import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { putExportCache } from "../../src/worker/cache-write";
import { eventually } from "./support";

it("bounds concurrent unresolved cache writes before any excess R2 dispatch", async () => {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  const who = { userId: `cache-cap-${crypto.randomUUID()}`, gen: 1 };
  await stub.init(who.userId);
  const release: (() => void)[] = [];
  let releaseAll = false;
  const bucket = {
    put: vi.fn(async () => {
      if (!releaseAll) await new Promise<void>((resolve) => release.push(resolve));
      return null;
    }),
  } as unknown as Pick<R2Bucket, "put">;
  let rejected = 0;
  const attempts = Array.from({ length: 80 }, () =>
    putExportCache(bucket, stub, who, "synthetic", new Uint8Array([1]), "pdf", true)
      .then(() => null, (error: unknown) => { rejected++; return error; }),
  );
  let extra: Promise<void> | undefined;
  try {
    await eventually(async () => rejected === 16 && release.length === 64 ? true : null, "cache write capacity");
    expect((await stub.cacheWriteFences())).toMatchObject({ status: "available", total: 64 });
    await expect(putExportCache(bucket, stub, who, "excess", new Uint8Array([1]), "pdf", true))
      .rejects.toThrow("too many export cache writes are unresolved");
    expect(bucket.put).toHaveBeenCalledTimes(64);
    expect((await stub.cacheWriteFences())).toMatchObject({ status: "available", total: 64 });

    release[0]!();
    await eventually(async () => {
      const status = await stub.cacheWriteFences();
      return status.status === "available" && status.total === 63 ? true : null;
    }, "cache write settlement");
    extra = putExportCache(bucket, stub, who, "after-settlement", new Uint8Array([1]), "docx", true);
    await eventually(async () => release.length === 65 ? true : null, "replacement cache write");
    expect(bucket.put).toHaveBeenCalledTimes(65);
    expect((await stub.cacheWriteFences())).toMatchObject({ status: "available", total: 64 });
  } finally {
    releaseAll = true;
    for (const resolve of release) resolve();
    await Promise.allSettled([...attempts, ...(extra ? [extra] : [])]);
  }
  expect((await stub.cacheWriteFences())).toMatchObject({ status: "available", total: 0 });
}, 30_000);
