import { describe, expect, it, vi } from "vitest";
import { durableReadResult, retryDurableRead } from "../../src/worker/rpc-read";
import { AppError } from "../../src/shared/errors";
import { unwrapResult } from "../../src/shared/result";

describe("Durable Object read retry", () => {
  it("recreates the stub after a retryable error and backs off before reading again", async () => {
    let generation = 0;
    const create = () => ({ generation: ++generation });
    const wait = vi.fn(async (_ms: number) => {});
    const read = vi.fn(async (stub: { generation: number }) => {
      if (stub.generation < 3)
        throw Object.assign(new Error("temporary"), { retryable: true });
      return "ready";
    });
    expect(await retryDurableRead(create, read, wait)).toBe("ready");
    expect(read.mock.calls.map(([stub]) => stub.generation)).toEqual([1, 2, 3]);
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([30, 60]);
  });

  it("does not retry overload, even when marked retryable", async () => {
    const error = Object.assign(new Error("overloaded"), {
      retryable: true,
      overloaded: true,
    });
    const read = vi.fn(async () => {
      throw error;
    });
    await expect(retryDurableRead(() => ({}), read)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not retry ordinary errors and caps repeated transient failures at three attempts", async () => {
    const ordinary = new Error("invalid");
    const read = vi.fn(async () => {
      throw ordinary;
    });
    await expect(retryDurableRead(() => ({}), read)).rejects.toBe(ordinary);
    expect(read).toHaveBeenCalledTimes(1);
    const transient = Object.assign(new Error("temporary"), {
      retryable: true,
    });
    const retry = vi.fn(async () => {
      throw transient;
    });
    const wait = vi.fn(async (_ms: number) => {});
    await expect(retryDurableRead(() => ({}), retry, wait)).rejects.toBe(
      transient,
    );
    expect(retry).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });
});

it("returns expected RPC errors as typed results and keeps the original HTTP mapping", async () => {
  const outcome = await durableReadResult(
    () => ({}),
    async () => {
      throw new AppError("not_found", "no such item");
    },
  );
  expect(outcome).toEqual({
    ok: false,
    code: "not_found",
    message: "no such item",
  });
  expect(() => unwrapResult(outcome)).toThrow("not_found: no such item");
  const unexpected = new Error("transport");
  await expect(
    durableReadResult(
      () => ({}),
      async () => {
        throw unexpected;
      },
    ),
  ).rejects.toBe(unexpected);
});

it("does not retry expected application errors even if they carry a retryable flag", async () => {
  const expected = Object.assign(new AppError("quota", "limit reached"), {
    retryable: true,
    overloaded: true,
  });
  const read = vi.fn(async () => {
    throw expected;
  });
  expect(await durableReadResult(() => ({}), read)).toEqual({
    ok: false,
    code: "quota",
    message: "limit reached",
  });
  expect(read).toHaveBeenCalledTimes(1);
  const expectedWithoutOverload = Object.assign(
    new AppError("conflict", "refresh"),
    { retryable: true },
  );
  const readWithoutOverload = vi.fn(async () => {
    throw expectedWithoutOverload;
  });
  expect(await durableReadResult(() => ({}), readWithoutOverload)).toEqual({
    ok: false,
    code: "conflict",
    message: "refresh",
  });
  expect(readWithoutOverload).toHaveBeenCalledTimes(1);
});
