import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { stopRuns } from "../../src/directory/directory";
import { AppError } from "../../src/shared/errors";
import {
  freeQuotaBucket,
  paidQuotaBucket,
  type BeginRun,
} from "../../src/shared/runs";
import { RUN_MIGRATIONS, RunStore } from "../../src/vault/runs";

const NOVEMBER = Date.UTC(2026, 10, 5);

async function withStore(
  test: (store: RunStore, sql: SqlStorage, clock: { now: number }) => void,
): Promise<void> {
  const stub = env.VAULT.get(env.VAULT.newUniqueId());
  await runInDurableObject(stub, (_instance, state) => {
    for (const statement of RUN_MIGRATIONS) state.storage.sql.exec(statement);
    const clock = { now: NOVEMBER };
    const store = new RunStore(
      state.storage.sql,
      (callback) => state.storage.transactionSync(callback),
      () => clock.now,
    );
    test(store, state.storage.sql, clock);
  });
}

function run(id = "run-1", overrides: Partial<BeginRun> = {}): BeginRun {
  return {
    id,
    kind: "tailor",
    targetId: `output-${id}`,
    requestKey: `request-${id}`,
    inputDigest: "digest-1",
    steps: ["write", "verify"],
    quota: freeQuotaBucket(NOVEMBER, 2),
    ...overrides,
  };
}

describe("durable run lifecycle", () => {
  it("reserves once on a replay and rejects reusing a request key with other input", async () => {
    await withStore((store) => {
      expect(store.begin(run()).replay).toBe(false);
      expect(store.begin(run()).replay).toBe(true);
      expect(store.quota(run().quota!.key)).toMatchObject({
        reserved: 1,
        used: 0,
        available: 1,
      });
      expect(() =>
        store.begin(run("run-1", { inputDigest: "changed" })),
      ).toThrow("different input");
    });
  });

  it("rolls back both the reservation and related output row when creation fails", async () => {
    await withStore((store, sql) => {
      sql.exec(`CREATE TABLE outputs (id TEXT PRIMARY KEY)`);
      expect(() =>
        store.begin(run(), () => {
          sql.exec(`INSERT INTO outputs VALUES ('draft')`);
          throw new Error("storage fault");
        }),
      ).toThrow("storage fault");
      expect(store.get("run-1")).toBeNull();
      expect(store.quota(run().quota!.key)).toBeNull();
      expect(sql.exec(`SELECT * FROM outputs`).toArray()).toHaveLength(0);
    });
  });

  it("keeps ambiguous creation active and reserved instead of refunding it", async () => {
    await withStore((store) => {
      store.begin(run());
      store.noteUncertain("run-1", "create_response_lost");
      expect(store.listPending()).toMatchObject([
        {
          state: "starting",
          creditState: "reserved",
          errorCode: "create_response_lost",
        },
      ]);
      expect(store.claim("run-1").state).toBe("running");
    });
  });

  it("orders steps, skips repeat writes and atomically consumes one unit at publication", async () => {
    await withStore((store, sql) => {
      sql.exec(`CREATE TABLE output_values (value TEXT)`);
      store.begin(run());
      store.claim("run-1");
      expect(() => store.commitStep("run-1", "verify", () => {})).toThrow(
        "in order",
      );
      store.commitStep("run-1", "write", () =>
        sql.exec(`INSERT INTO output_values VALUES ('draft')`),
      );
      expect(
        store.commitStep("run-1", "write", () => {
          throw new Error("must not repeat");
        }),
      ).toEqual({ applied: false });
      expect(() => store.finish("run-1", () => {})).toThrow("unfinished");
      store.commitStep("run-1", "verify", () => {});
      expect(() =>
        store.finish("run-1", () => {
          sql.exec(`INSERT INTO output_values VALUES ('ready')`);
          throw new Error("stale citation");
        }),
      ).toThrow("stale citation");
      expect(store.quota(run().quota!.key)).toMatchObject({
        reserved: 1,
        used: 0,
      });
      store.finish("run-1", () =>
        sql.exec(`INSERT INTO output_values VALUES ('ready')`),
      );
      expect(
        store.finish("run-1", () => {
          throw new Error("must not repeat");
        }),
      ).toEqual({ applied: false });
      expect(sql.exec(`SELECT * FROM output_values`).toArray()).toHaveLength(2);
      expect(store.quota(run().quota!.key)).toMatchObject({
        reserved: 0,
        used: 1,
      });
      expect(store.fail("run-1", "late_failure").state).toBe("succeeded");
    });
  });

  it("fences cancelled and failed runs and releases each reservation once", async () => {
    await withStore((store) => {
      store.begin(run());
      store.requestCancel("run-1");
      expect(() => store.claim("run-1")).toThrow("no longer accepts");
      expect(() => store.commitStep("run-1", "write", () => {})).toThrow(
        "no longer accepts",
      );
      expect(store.fail("run-1", "late_failure").state).toBe(
        "cancel_requested",
      );
      store.cancel("run-1");
      store.cancel("run-1");
      expect(store.quota(run().quota!.key)).toMatchObject({
        used: 0,
        reserved: 0,
      });
      store.begin(run("run-2"));
      store.fail("run-2", "model_failed");
      store.fail("run-2", "model_failed");
      expect(() => store.finish("run-2", () => {})).toThrow(
        "no longer accepts",
      );
      expect(store.quota(run().quota!.key)).toMatchObject({
        used: 0,
        reserved: 0,
      });
    });
  });

  it("does not charge uploads or maintenance without an output bucket", async () => {
    await withStore((store) => {
      store.begin(
        run("upload", { kind: "distill", quota: undefined, steps: [] }),
      );
      store.finish("upload", () => {});
      expect(store.get("upload")).toMatchObject({
        state: "succeeded",
        creditState: "none",
        bucketKey: null,
      });
    });
  });

  it("releases a no-op refinement reservation without charging or reopening it on replay", async () => {
    await withStore((store) => {
      store.begin(run("noop", { kind: "refine", steps: [] }));
      store.finish("noop", () => {}, false);
      expect(store.get("noop")).toMatchObject({
        state: "succeeded",
        creditState: "released",
      });
      expect(store.quota(run().quota!.key)).toMatchObject({
        used: 0,
        reserved: 0,
      });
      expect(store.finish("noop", () => {}, true)).toEqual({ applied: false });
      expect(store.quota(run().quota!.key)).toMatchObject({
        used: 0,
        reserved: 0,
      });
    });
  });
});

describe("quota periods", () => {
  it("honors zero and reserves against concurrent outstanding outputs", async () => {
    await withStore((store) => {
      expect(() =>
        store.begin(run("zero", { quota: freeQuotaBucket(NOVEMBER, 0) })),
      ).toThrow("used all your documents");
      store.begin(run());
      store.begin(run("run-2"));
      expect(() => store.begin(run("run-3"))).toThrow("used all your documents");
    });
  });

  it("pins in-flight credits to their original period across renewals", async () => {
    await withStore((store, _sql, clock) => {
      store.begin(run("old", { steps: [] }));
      clock.now = Date.UTC(2026, 11, 3);
      const december = freeQuotaBucket(clock.now, 2);
      store.begin(run("new", { steps: [], quota: december }));
      store.finish("old", () => {});
      expect(store.quota(run().quota!.key)).toMatchObject({
        used: 1,
        reserved: 0,
      });
      expect(store.quota(december.key)).toMatchObject({ used: 0, reserved: 1 });
    });
  });

  it("preserves free usage and paid reservations when publishing changed limits", async () => {
    await withStore((store) => {
      const free = freeQuotaBucket(NOVEMBER, 2);
      const paid = paidQuotaBucket(
        "sub_123",
        NOVEMBER,
        Date.UTC(2026, 11, 5),
        10,
      );
      store.begin(run("free", { steps: [], quota: free }));
      store.finish("free", () => {});
      store.begin(run("paid", { quota: paid }));
      store.setBucket({ ...paid, limit: 20 });
      expect(store.quota(paid.key)).toMatchObject({
        reserved: 1,
        used: 0,
        available: 19,
      });
      expect(store.setBucket(free)).toMatchObject({ used: 1, available: 1 });
      expect(() => store.setBucket({ ...paid, startAt: NOVEMBER - 1 })).toThrow(
        "boundaries",
      );
    });
  });
});

describe("provider spend", () => {
  it("retains unknown charges and meters retries separately from output credits", async () => {
    await withStore((store) => {
      store.begin(run());
      store.claim("run-1");
      const input = {
        id: "attempt-1",
        runId: "run-1",
        step: "write",
        attempt: 1,
        model: "test-model",
        maxCostMicros: 80,
      };
      store.reserveAttempt(input, 100);
      store.reserveAttempt(input, 100);
      store.markAttemptUnknown("attempt-1");
      expect(store.dailySpend()).toMatchObject({
        spentMicros: 0,
        reservedMicros: 80,
        unknownMicros: 80,
      });
      expect(() =>
        store.reserveAttempt(
          { ...input, id: "attempt-2", attempt: 2, maxCostMicros: 30 },
          100,
        ),
      ).toThrow("exhausted");
      store.settleAttempt("attempt-1", 40, {
        inputTokens: 10,
        outputTokens: 2,
      });
      store.reserveAttempt(
        { ...input, id: "attempt-2", attempt: 2, maxCostMicros: 50 },
        100,
      );
      store.fail("run-1", "model_failed");
      store.settleAttempt("attempt-2", 30);
      expect(store.quota(run().quota!.key)).toMatchObject({
        used: 0,
        reserved: 0,
      });
      expect(store.dailySpend()).toMatchObject({
        spentMicros: 70,
        reservedMicros: 0,
      });
      store.settleAttempt("attempt-2", 30);
      expect(() => store.settleAttempt("attempt-2", 25)).toThrow(
        "already settled",
      );
    });
  });

  it("enforces lifetime test spend and call limits across UTC days and keeps retries idempotent", async () => {
    await withStore((store, _sql, clock) => {
      store.begin(run());
      store.claim("run-1");
      const first = {
        id: "lifetime-1",
        runId: "run-1",
        step: "write",
        attempt: 1,
        model: "test-model",
        maxCostMicros: 40,
      };
      const cap = { maxCostMicros: 100, maxCalls: 2 };
      store.reserveAttempt(first, 100, cap);
      store.reserveAttempt(first, 100, cap);
      clock.now += 24 * 60 * 60 * 1000;
      expect(() =>
        store.reserveAttempt(
          { ...first, id: "too-costly", maxCostMicros: 61 },
          100,
          cap,
        ),
      ).toThrow("test model budget");
      store.settleAttempt(first.id, 30);
      store.reserveAttempt(
        { ...first, id: "lifetime-2", maxCostMicros: 70 },
        100,
        cap,
      );
      expect(() =>
        store.reserveAttempt(
          { ...first, id: "third", maxCostMicros: 1 },
          100,
          cap,
        ),
      ).toThrow("test model budget");
    });
  });

  it("refuses unconfigured budgets and records unexpected overcharges honestly", async () => {
    await withStore((store) => {
      store.begin(run());
      store.claim("run-1");
      const input = {
        id: "attempt-1",
        runId: "run-1",
        step: "write",
        attempt: 1,
        model: "test-model",
        maxCostMicros: 80,
      };
      expect(() => store.reserveAttempt(input, 0)).toThrow("exhausted");
      expect(() => store.reserveAttempt(input, NaN)).toThrow("safe integer");
      store.reserveAttempt(input, 100);
      store.settleAttempt(input.id, 120);
      expect(store.dailySpend()).toMatchObject({ spentMicros: 120 });
      expect(() =>
        store.reserveAttempt({ ...input, id: "attempt-2" }, 100),
      ).toThrow("exhausted");
    });
  });
});

describe("deletion workflow failures", () => {
  it("propagates status outages rather than claiming erasure succeeded", async () => {
    const workflow = {
      get: vi.fn().mockResolvedValue({
        status: vi.fn().mockRejectedValue(new Error("temporary outage")),
      }),
    } as unknown as Workflow;
    await expect(stopRuns(workflow, ["run"])).rejects.toThrow(
      "temporary outage",
    );
  });

  it("treats explicit absence as complete", async () => {
    const workflow = {
      get: vi
        .fn()
        .mockRejectedValue(new Error("instance.not_found")),
    } as unknown as Workflow;
    await expect(stopRuns(workflow, ["run"])).resolves.toBeUndefined();
  });

  it("does not mistake a different instance's absence for the requested run", async () => {
    const failure = new Error("Workflow instance other-run not found");
    const workflow = { get: vi.fn().mockRejectedValue(failure) } as unknown as Workflow;
    await expect(stopRuns(workflow, ["run"])).rejects.toBe(failure);
    await expect(stopRuns({ get: vi.fn().mockRejectedValue(new Error("Workflow instance run not found")) } as unknown as Workflow, ["run"]))
      .resolves.toBeUndefined();
  });

  it.each([
    Object.assign(new Error("workflow.not_found"), { code: 10200 }),
    Object.assign(new Error("instance.not_found"), { code: 10200 }),
    Object.assign(new Error("missing resource"), { status: 404 }),
    new AppError("not_found", "no such workflow"),
    { code: 10404 },
  ])("preserves inventory on a non-instance or ambiguous absence", async (failure) => {
    const workflow = { get: vi.fn().mockRejectedValue(failure) } as unknown as Workflow;
    await expect(stopRuns(workflow, ["run"])).rejects.toBe(failure);
  });

  it("rechecks a termination race but propagates genuine termination failure", async () => {
    const instance = {
      delete: vi.fn().mockResolvedValue(undefined),
      status: vi
        .fn()
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValueOnce({ status: "complete" }),
      terminate: vi.fn().mockRejectedValue(new Error("finished meanwhile")),
    };
    await expect(
      stopRuns({ get: async () => instance } as unknown as Workflow, ["run"]),
    ).resolves.toBeUndefined();
    instance.status.mockResolvedValue({ status: "running" });
    await expect(
      stopRuns({ get: async () => instance } as unknown as Workflow, ["run"]),
    ).rejects.toThrow("finished meanwhile");
  });
});
