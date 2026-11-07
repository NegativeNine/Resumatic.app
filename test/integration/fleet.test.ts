import type { WorkflowStep } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/shared/errors";
import { runFleet, type FleetServices } from "../../src/workflows/fleet";

const id = (n: number) => n.toString(16).padStart(64, "0");
const params = { model: "@cf/baai/bge-m3", dimensions: 1024, maxVaults: 10 };
function stepper(retry = false) {
  const saved: unknown[] = [];
  const sleeps: string[] = [];
  const step = {
    async do(_name: string, _config: unknown, body: () => Promise<unknown>) {
      let value: unknown;
      try {
        value = await body();
      } catch (error) {
        if (!retry) throw error;
        value = await body();
      }
      saved.push(value);
      return value;
    },
    async sleep(name: string) {
      sleeps.push(name);
    },
  } as unknown as WorkflowStep;
  return { step, saved, sleeps };
}
function services(rows: Record<number, { vaultId: string; state: string }[]>) {
  const requests = new Map<string, { runId: string; vaultId: string }>();
  const active = new Set<string>();
  let peak = 0;
  const api: FleetServices = {
    async list(directory, after, limit) {
      return (rows[directory] ?? [])
        .filter((row) => row.vaultId > (after ?? ""))
        .slice(0, limit);
    },
    async start(vaultId, _model, _dimensions, requestKey) {
      if (!requests.has(requestKey)) {
        requests.set(requestKey, { vaultId, runId: `run-${vaultId}` });
        active.add(vaultId);
        peak = Math.max(peak, active.size);
      }
      return { runId: requests.get(requestKey)!.runId };
    },
    async status(vaultId) {
      active.delete(vaultId);
      return { state: "active" };
    },
  };
  return { api, requests, active, peak: () => peak };
}

describe("bounded fleet re-embedding", () => {
  it("walks all Directory homes and never starts more than three unfinished children", async () => {
    const data = services({
      0: [1, 2, 3, 4, 5].map((n) => ({ vaultId: id(n), state: "active" })),
      16: [{ vaultId: id(9), state: "active" }],
    });
    const s = stepper();
    const result = await runFleet(
      {} as Env,
      "fleet-test",
      params,
      s.step,
      data.api,
    );
    expect(result).toEqual({
      started: 6,
      succeeded: 6,
      failed: 0,
      skipped: 0,
      pendingRuns: [],
      limited: false,
      nextCursor: null,
    });
    expect(data.peak()).toBe(3);
    expect(
      [...data.requests.keys()].every((key) =>
        key.startsWith("fleet:fleet-test:"),
      ),
    ).toBe(true);
    expect(JSON.stringify(s.saved)).not.toMatch(/email|quote|markdown/);
  });

  it("enforces its explicit count budget and resumes after the last selected vault", async () => {
    const data = services({
      0: [1, 2, 3, 4, 5].map((n) => ({ vaultId: id(n), state: "active" })),
    });
    const first = await runFleet(
      {} as Env,
      "first",
      { ...params, maxVaults: 4 },
      stepper().step,
      data.api,
    );
    expect(first).toMatchObject({
      started: 4,
      limited: true,
      nextCursor: { directory: 0, after: id(4) },
    });
    const second = await runFleet(
      {} as Env,
      "second",
      { ...params, cursor: first.nextCursor! },
      stepper().step,
      data.api,
    );
    expect(second).toMatchObject({ started: 1, succeeded: 1, limited: false });
    expect(data.requests.size).toBe(5);
  });

  it("replays a partly successful start step using stable child idempotency keys", async () => {
    const data = services({
      0: [1, 2, 3].map((n) => ({ vaultId: id(n), state: "active" })),
    });
    const start = data.api.start;
    let fail = true;
    data.api.start = async (...args) => {
      const run = await start(...args);
      if (args[0] === id(2) && fail) {
        fail = false;
        throw new Error("temporary_rpc_fault");
      }
      return run;
    };
    const result = await runFleet(
      {} as Env,
      "retry",
      params,
      stepper(true).step,
      data.api,
    );
    expect(result.succeeded).toBe(3);
    expect(data.requests.size).toBe(3);
    expect(data.peak()).toBe(3);
  });

  it("stops launching new work if three child runs are still pending after the polling budget", async () => {
    const data = services({
      0: [1, 2, 3, 4].map((n) => ({ vaultId: id(n), state: "active" })),
    });
    data.api.status = async () => ({ state: "building" });
    const s = stepper();
    const result = await runFleet({} as Env, "slow", params, s.step, data.api);
    expect(result).toMatchObject({
      started: 3,
      succeeded: 0,
      limited: true,
      nextCursor: { directory: 0, after: id(3) },
    });
    expect(result.pendingRuns).toHaveLength(3);
    expect(s.sleeps).toHaveLength(19);
    expect(data.requests.size).toBe(3);
  });

  it("counts terminal failures without retrying deleted vaults or consuming non-active rows", async () => {
    const data = services({
      0: [
        { vaultId: id(1), state: "deleting" },
        { vaultId: id(2), state: "active" },
        { vaultId: id(3), state: "active" },
      ],
    });
    const start = data.api.start;
    data.api.start = async (...args) => {
      if (args[0] === id(2)) throw new AppError("gone", "deleted");
      return start(...args);
    };
    data.api.status = async () => ({ state: "cancelled" });
    const result = await runFleet(
      {} as Env,
      "terminal",
      params,
      stepper().step,
      data.api,
    );
    expect(result).toMatchObject({
      started: 1,
      succeeded: 0,
      failed: 1,
      skipped: 1,
    });
  });

  it("rejects missing, excessive and malformed budgets before any work", async () => {
    const data = services({});
    await expect(
      runFleet(
        {} as Env,
        "invalid",
        { ...params, maxVaults: 0 },
        stepper().step,
        data.api,
      ),
    ).rejects.toThrow("budget");
    await expect(
      runFleet(
        {} as Env,
        "invalid",
        { ...params, maxVaults: 301 },
        stepper().step,
        data.api,
      ),
    ).rejects.toThrow("budget");
    await expect(
      runFleet(
        {} as Env,
        "invalid",
        { ...params, cursor: { directory: 17 } },
        stepper().step,
        data.api,
      ),
    ).rejects.toThrow("cursor");
    expect(data.requests.size).toBe(0);
  });
});
