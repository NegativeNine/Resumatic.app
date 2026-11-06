import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { BillingStore, BILLING_MIGRATIONS, BILLING_DEFERRED_MIGRATIONS, BILLING_DELIVERY_RETRY_MIGRATIONS } from "../../src/directory/billing";
import {
  cleanupBillingCustomer,
  type BillingEvent,
} from "../../src/worker/billing";

const billingEnv = {
  BILLING_ENABLED: "true",
  BILLING_PLANS_JSON: JSON.stringify({
    free: { generationLimit: 3 },
    paid: [{ id: "pro", priceId: "price_pro", generationLimit: 50 }],
  }),
  STRIPE_SECRET_KEY: "sk_test_secret",
  STRIPE_WEBHOOK_SECRET: "whsec_secret",
  STRIPE_API_VERSION: "2026-10-28.endive",
  APP_ORIGIN: "https://app.example.com",
};
const start = Math.floor(Date.now() / 1000) - 1000;
const end = start + 2_592_000;
const subscription = (id: string, status = "active", invoice = "in_new") => ({
  id,
  customer: "cus_123",
  metadata: { account_uid: "u1" },
  status,
  latest_invoice: invoice,
  cancel_at_period_end: false,
  items: {
    data: [
      {
        price: { id: "price_pro" },
        current_period_start: start,
        current_period_end: end,
      },
    ],
    has_more: false,
  },
});
const invoice = (id = "in_new", sub = "sub_new", status = "paid") => ({
  id,
  status,
  parent: { subscription_details: { subscription: sub } },
  lines: {
    has_more: false,
    data: [
      {
        parent: {
          type: "subscription_item_details",
          subscription_item_details: { subscription: sub },
        },
        pricing: { price_details: { price: "price_pro" } },
        period: { start, end },
      },
    ],
  },
});
const event = (
  id: string,
  type = "customer.subscription.updated",
  object = { id: "sub_new", customer: "cus_123" },
): BillingEvent => ({
  id,
  type,
  created: 1,
  livemode: false,
  data: { object },
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(statement: string, ...bindings: (string | number | null)[]) {
      const rows = db.prepare(statement).all(...bindings);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
  for (const statement of BILLING_MIGRATIONS) db.exec(statement);
  for (const statement of BILLING_DEFERRED_MIGRATIONS) db.exec(statement);
  for (const statement of BILLING_DELIVERY_RETRY_MIGRATIONS) db.exec(statement);
  const state = {
    subscriptions: [
      subscription("sub_old", "canceled", "in_old"),
      subscription("sub_new"),
    ],
    invoiceStatus: "paid",
    active: true,
    vaultId: "vault1",
    failDelivery: false,
  };
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/customers/cus_123")
      return Response.json({ id: "cus_123", metadata: { account_uid: "u1" } });
    if (url.pathname === "/v1/subscriptions")
      return Response.json({ data: state.subscriptions, has_more: false });
    if (url.pathname === "/v1/invoices/in_new")
      return Response.json(invoice("in_new", "sub_new", state.invoiceStatus));
    if (url.pathname === "/v1/invoices/in_old")
      return Response.json(invoice("in_old", "sub_old"));
    throw new Error("unexpected test request");
  });
  const deliver = vi.fn(async () => {
    if (state.failDelivery) throw new Error("retry");
  });
  const store = new BillingStore(
    sql,
    billingEnv as Env,
    {
      transaction: (fn) => fn(),
      account: (uid) =>
        state.active && uid === "u1" ? { vaultId: state.vaultId } : null,
      deliver,
    },
    fetcher,
  );
  return { db, sql, state, fetcher, deliver, store };
}

describe("durable billing reconciliation", () => {
  it.each([true, false])("redelivers when the old RPC completes %s before the new delivery", async (oldCompletesFirst) => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    try {
      f.db.prepare("INSERT INTO billing_accounts(user_id,customer_id,entitlement,revision,delivered_revision) VALUES ('u1','cus_123','{}',1,0)").run();
      f.deliver.mockImplementationOnce(async () => { entered(); await held; });
      const first = f.store.reconcile();
      await ready;
      f.state.vaultId = "vault2";
      f.store.redeliverAfterReplacement("u1");
      if (oldCompletesFirst) {
        release();
        await first;
        expect(f.db.prepare("SELECT delivered_revision FROM billing_accounts WHERE user_id='u1'").get()!.delivered_revision).toBe(0);
        await f.store.reconcile();
      } else {
        await f.store.reconcile();
        expect(f.db.prepare("SELECT delivered_revision FROM billing_accounts WHERE user_id='u1'").get()!.delivered_revision).toBe(1);
        release();
        await first;
      }
      expect(f.deliver).toHaveBeenNthCalledWith(1, "vault1", 1, {});
      expect(f.deliver).toHaveBeenNthCalledWith(2, "vault2", 1, {});
      expect(f.db.prepare("SELECT delivered_revision FROM billing_accounts WHERE user_id='u1'").get()!.delivered_revision).toBe(1);
    } finally { release(); f.db.close(); }
  });

  it("does not acknowledge an entitlement when its active Vault is temporarily unavailable", async () => {
    const f = fixture();
    try {
      f.db.prepare("INSERT INTO billing_accounts(user_id,customer_id,entitlement,revision,delivered_revision) VALUES ('u1','cus_123','{}',1,0)").run();
      f.state.active = false;
      await f.store.reconcile();
      expect(f.deliver).not.toHaveBeenCalled();
      expect(f.db.prepare("SELECT delivered_revision FROM billing_accounts WHERE user_id='u1'").get()!.delivered_revision).toBe(0);
      f.state.active = true;
      await f.store.reconcile();
      expect(f.deliver).toHaveBeenCalledOnce();
      expect(f.db.prepare("SELECT delivered_revision FROM billing_accounts WHERE user_id='u1'").get()!.delivered_revision).toBe(1);
    } finally { f.db.close(); }
  });

  it("attributes a first event before a customer account row exists and reconciles it", async () => {
    const f = fixture();
    try {
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM billing_accounts").get()!.n).toBe(0);
      f.store.accept("u1", event("evt_firstlink"));
      expect(f.db.prepare("SELECT customer_id,user_id,state FROM billing_events WHERE id=?").get("evt_firstlink"))
        .toMatchObject({ customer_id: "cus_123", user_id: "u1", state: "pending" });
      await f.store.reconcile();
      expect(f.db.prepare("SELECT customer_id FROM billing_accounts WHERE user_id=?").get("u1"))
        .toMatchObject({ customer_id: "cus_123" });
      expect(f.deliver).toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it("rejects an old unattributed caller and ignores a delayed delivery after deletion starts", () => {
    const f = fixture();
    try {
      expect(() => f.store.accept(undefined, event("evt_oldworker"))).toThrow("attribution");
      f.store.accept("u1", event("evt_before"));
      f.state.active = false;
      f.store.erase("u1", "cus_123");
      // The Worker resolved Stripe metadata before deletion, but the RPC
      // arrived only after the account stopped being active.
      f.store.accept("u1", event("evt_late"));
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM billing_events").get()!.n).toBe(0);
    } finally { f.db.close(); }
  });

  it("keeps an attributed event pending when Stripe metadata changes owner", async () => {
    const f = fixture();
    try {
      f.store.accept("u1", event("evt_changedowner"));
      f.fetcher.mockImplementation(async () => Response.json({ id: "cus_123", metadata: { account_uid: "u2" } }));
      await expect(f.store.reconcile()).rejects.toThrow("pending");
      expect(f.db.prepare("SELECT user_id,state FROM billing_events WHERE id=?").get("evt_changedowner"))
        .toMatchObject({ user_id: "u1", state: "pending" });
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM billing_accounts").get()!.n).toBe(0);
      expect(f.deliver).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it.each([null, ""])("does not overwrite another reconciliation's attribution of a legacy event with owner %s", async (initialOwner) => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    try {
      f.db.prepare("INSERT INTO billing_events(id,customer_id,user_id,created_at) VALUES(?,?,?,?)")
        .run("evt_legacy", "cus_123", initialOwner, Date.now());
      f.fetcher.mockImplementation(async () => {
        entered();
        await holding;
        return Response.json({ id: "cus_123", metadata: { account_uid: "u1" } });
      });
      const attempt = f.store.reconcile();
      const outcome = attempt.then(() => null, (error: Error) => error);
      await ready;
      f.db.prepare("UPDATE billing_events SET user_id=? WHERE id=?").run("u2", "evt_legacy");
      release();
      expect(await outcome).toBeInstanceOf(Error);
      expect(f.db.prepare("SELECT user_id,state FROM billing_events WHERE id=?").get("evt_legacy"))
        .toMatchObject({ user_id: "u2", state: "pending" });
      expect(f.deliver).not.toHaveBeenCalled();
    } finally { release(); f.db.close(); }
  });

  it("reconciles an empty legacy owner only after Stripe resolves its active account", async () => {
    const f = fixture();
    try {
      f.db.prepare("INSERT INTO billing_events(id,customer_id,user_id,created_at) VALUES('evt_empty','cus_123','',?)").run(Date.now());
      await f.store.reconcile();
      expect(f.db.prepare("SELECT user_id,state FROM billing_events WHERE id='evt_empty'").get())
        .toMatchObject({ user_id: "u1", state: "applied" });
      expect(f.db.prepare("SELECT customer_id FROM billing_accounts WHERE user_id='u1'").get())
        .toMatchObject({ customer_id: "cus_123" });
      expect(f.deliver).toHaveBeenCalledOnce();
    } finally { f.db.close(); }
  });

  it.each(["missing_uid", "unknown_uid", "wrong_customer", "conflicting_account", "conflicting_customer", "deleting"])(
    "keeps an empty legacy owner pending when Stripe attribution is %s",
    async (scenario) => {
      const f = fixture();
      try {
        f.db.prepare("INSERT INTO billing_events(id,customer_id,user_id,created_at) VALUES('evt_empty','cus_123','',?)").run(Date.now());
        if (scenario === "deleting") f.state.active = false;
        if (scenario === "conflicting_account") f.db.prepare("INSERT INTO billing_accounts(user_id,customer_id) VALUES('u1','cus_other')").run();
        if (scenario === "conflicting_customer") f.db.prepare("INSERT INTO billing_accounts(user_id,customer_id) VALUES('u2','cus_123')").run();
        if (scenario !== "deleting") f.fetcher.mockImplementation(async () => Response.json({
          id: scenario === "wrong_customer" ? "cus_other" : "cus_123",
          metadata: scenario === "missing_uid" ? {} : { account_uid: scenario === "unknown_uid" ? "u2" : "u1" },
        }));
        await expect(f.store.reconcile()).rejects.toThrow("pending");
        expect(f.db.prepare("SELECT user_id,state FROM billing_events WHERE id='evt_empty'").get())
          .toMatchObject({ user_id: "", state: "pending" });
        expect(f.db.prepare("SELECT COUNT(*) AS n FROM billing_accounts").get()!.n).toBe(scenario.startsWith("conflicting_") ? 1 : 0);
        expect(f.deliver).not.toHaveBeenCalled();
        if (scenario === "deleting") {
          // An independently known customer may still be erased by the
          // account-deletion path; metadata alone did not authorize it here.
          f.store.erase("u1", "cus_123");
          expect(f.db.prepare("SELECT COUNT(*) AS n FROM billing_events").get()!.n).toBe(0);
        }
      } finally { f.db.close(); }
    },
  );

  it("delivers a cancellation when a full batch of other vault deliveries fails", async () => {
    const f = fixture();
    let failBad = true;
    const deliver = vi.fn(async (vaultId: string) => {
      if (vaultId.startsWith("bad") && failBad) throw new Error("unavailable");
    });
    const store = new BillingStore(f.sql, billingEnv as Env, {
      transaction: (fn) => fn(),
      account: (uid) => ({ vaultId: uid }),
      deliver,
    }, f.fetcher);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const insert = f.db.prepare("INSERT INTO billing_accounts(user_id,customer_id,entitlement,revision) VALUES (?,?,?,1)");
      for (let i = 0; i < 20; i++) insert.run(`bad${String(i).padStart(2, "0")}`, `cus_bad${i}`, JSON.stringify({ planId: "pro" }));
      insert.run("good", "cus_good", JSON.stringify({ planId: "free" }));
      await expect(store.reconcile()).rejects.toThrow("pending");
      expect(store.nextPendingAt()).toBe(now);
      clock.mockReturnValue(now + 60_000);
      await expect(store.reconcile()).rejects.toThrow("pending");
      expect(deliver).toHaveBeenCalledWith("good", 1, { planId: "free" });
      expect(f.db.prepare("SELECT delivered_revision FROM billing_accounts WHERE user_id='good'").get()!.delivered_revision).toBe(1);
      failBad = false;
      clock.mockReturnValue(now + 120_000);
      await store.reconcile();
      expect(store.pending()).toBe(false);
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM billing_delivery_retries").get()!.n).toBe(0);
    } finally {
      clock.mockRestore();
      f.db.close();
    }
  });

  it("does not back off a newer entitlement after an older delivery fails", async () => {
    const f = fixture();
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const unblock = new Promise<void>((resolve) => { release = resolve; });
    let failFirst = true;
    const deliver = vi.fn(async () => {
      if (failFirst) { reached(); await unblock; throw new Error("lost reply"); }
    });
    const store = new BillingStore(f.sql, billingEnv as Env, {
      transaction: (fn) => fn(), account: (uid) => ({ vaultId: uid }), deliver,
    }, f.fetcher);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      f.db.prepare("INSERT INTO billing_accounts(user_id,customer_id,entitlement,revision) VALUES ('u1','cus_1',?,1)").run(JSON.stringify({ planId: "pro" }));
      f.db.prepare("INSERT INTO billing_delivery_retries(user_id,revision,next_attempt_at) VALUES ('u1',1,?)").run(now);
      const old = store.reconcile();
      await paused;
      f.db.prepare("UPDATE billing_accounts SET entitlement=?,revision=2 WHERE user_id='u1'").run(JSON.stringify({ planId: "free" }));
      release();
      await expect(old).rejects.toThrow("pending");
      expect(f.db.prepare("SELECT revision,next_attempt_at FROM billing_delivery_retries WHERE user_id='u1'").get()).toMatchObject({ revision: 1, next_attempt_at: now });
      expect(store.nextPendingAt()).toBe(now);
      failFirst = false;
      await store.reconcile();
      expect(deliver).toHaveBeenLastCalledWith("u1", 2, { planId: "free" });
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM billing_delivery_retries").get()!.n).toBe(0);
    } finally {
      release();
      clock.mockRestore();
      f.db.close();
    }
  });

  it("does not recreate retry state when a vault is erased during delivery", async () => {
    const f = fixture();
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const unblock = new Promise<void>((resolve) => { release = resolve; });
    const store = new BillingStore(f.sql, billingEnv as Env, {
      transaction: (fn) => fn(), account: (uid) => ({ vaultId: uid }),
      deliver: async () => { reached(); await unblock; throw new Error("lost reply"); },
    }, f.fetcher);
    try {
      f.db.prepare("INSERT INTO billing_accounts(user_id,customer_id,entitlement,revision) VALUES ('u1','cus_1','{}',1)").run();
      const attempt = store.reconcile();
      await paused;
      store.erase("u1");
      release();
      await expect(attempt).rejects.toThrow("pending");
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM billing_delivery_retries").get()!.n).toBe(0);
      expect(store.pending()).toBe(false);
    } finally {
      release();
      f.db.close();
    }
  });

  it("does not postpone a newer retry after an older duplicate RPC fails", async () => {
    const f = fixture();
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const unblock = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const store = new BillingStore(f.sql, billingEnv as Env, {
      transaction: (fn) => fn(), account: (uid) => ({ vaultId: uid }),
      deliver: async () => {
        if (first) { first = false; reached(); await unblock; }
        throw new Error("lost reply");
      },
    }, f.fetcher);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      f.db.prepare("INSERT INTO billing_accounts(user_id,customer_id,entitlement,revision) VALUES ('u1','cus_1','{}',1)").run();
      const older = store.reconcile();
      await paused;
      await expect(store.reconcile()).rejects.toThrow("pending");
      expect(store.nextPendingAt()).toBe(now + 60_000);
      clock.mockReturnValue(now + 10_000);
      release();
      await expect(older).rejects.toThrow("pending");
      expect(store.nextPendingAt()).toBe(now + 60_000);
    } finally {
      release();
      clock.mockRestore();
      f.db.close();
    }
  });
  it("lets a cancellation through when a full batch of older events fails repeatedly", async () => {
    const f = fixture();
    const original = f.fetcher.getMockImplementation()!;
    let failingCustomer = true;
    f.fetcher.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === "/v1/customers/cus_bad") {
        if (failingCustomer) throw new Error("temporary Stripe error");
        return Response.json({ id: "cus_bad", metadata: {} });
      }
      return original(input, init);
    });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      f.store.accept("u1", event("evt_initial"));
      await f.store.reconcile();
      expect(JSON.parse(String(f.db.prepare("SELECT entitlement FROM billing_accounts").get()!.entitlement)).planId).toBe("pro");
      for (let i = 0; i < 20; i++)
        f.db.prepare("INSERT INTO billing_events(id,customer_id,created_at) VALUES(?,?,?)")
          .run(`evt_bad${String(i).padStart(2, "0")}`, "cus_bad", now);
      f.state.subscriptions[1]!.status = "canceled";
      f.store.accept("u1", event("evt_cancel"));
      await expect(f.store.reconcile()).rejects.toThrow("pending");
      expect(f.db.prepare("SELECT state FROM billing_events WHERE id='evt_cancel'").get()!.state).toBe("pending");
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM billing_events WHERE id LIKE 'evt_bad%' AND next_attempt_at=?").get(now + 60_000)!.n).toBe(20);
      // Even after the old failures are due again, untouched events sort
      // before them by their original due time, not by event creation time.
      clock.mockReturnValue(now + 60_000);
      await expect(f.store.reconcile()).rejects.toThrow("pending");
      expect(JSON.parse(String(f.db.prepare("SELECT entitlement FROM billing_accounts").get()!.entitlement)).planId).toBe("free");
      expect(f.db.prepare("SELECT state FROM billing_events WHERE id='evt_cancel'").get()!.state).toBe("applied");
      failingCustomer = false;
      clock.mockReturnValue(now + 120_000);
      await f.store.reconcile();
      expect(f.store.pending()).toBe(false);
    } finally {
      clock.mockRestore();
      f.db.close();
    }
  });
  it("does not postpone an event whose retry was rescheduled during Stripe I/O", async () => {
    const f = fixture();
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const unblock = new Promise<void>((resolve) => { release = resolve; });
    f.fetcher.mockImplementation(async () => {
      reached();
      await unblock;
      throw new Error("temporary Stripe error");
    });
    try {
      f.store.accept("u1", event("evt_race"));
      const attempt = f.store.reconcile();
      await paused;
      f.db.prepare("UPDATE billing_events SET next_attempt_at=? WHERE id='evt_race'").run(123);
      release();
      await expect(attempt).rejects.toThrow("pending");
      expect(f.db.prepare("SELECT next_attempt_at FROM billing_events WHERE id='evt_race'").get()!.next_attempt_at).toBe(123);
    } finally {
      release();
      f.db.close();
    }
  });
  it("retains current paid access, queues future invoices by ID, and processes other events", async () => {
    const f = fixture();
    const original = f.fetcher.getMockImplementation()!;
    const futureStart = end;
    const futureEnd = end + 2_592_000;
    f.fetcher.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === "/v1/invoices/in_future") {
        const value = invoice("in_future");
        value.lines.data[0]!.period = { start: futureStart, end: futureEnd };
        return Response.json(value);
      }
      return original(input, init);
    });
    const clock = vi.spyOn(Date, "now");
    try {
      f.store.accept("u1", event("evt_initial"));
      await f.store.reconcile();
      f.store.accept("u1", event("evt_future", "invoice.paid", { id: "in_future", customer: "cus_123" }));
      await f.store.reconcile();
      let account = f.db.prepare("SELECT entitlement FROM billing_accounts").get()!;
      expect(JSON.parse(String(account.entitlement))).toMatchObject({ planId: "pro", bucket: `paid:sub_new:${start}` });
      expect(f.store.nextPendingAt()).toBe(futureStart * 1000);
      f.store.accept("u1", event("evt_unrelated"));
      await f.store.reconcile();
      expect(f.db.prepare("SELECT state FROM billing_events WHERE id='evt_unrelated'").get()!.state).toBe("applied");
      clock.mockReturnValue(futureStart * 1000);
      // The invoice may be paid before the subscription snapshot rolls over.
      await f.store.reconcile();
      expect(JSON.parse(String(f.db.prepare("SELECT entitlement FROM billing_accounts").get()!.entitlement)).planId).toBe("free");
      expect(f.store.nextPendingAt()).toBe(futureStart * 1000 + 60_000);
      f.state.subscriptions[1]!.items.data[0]!.current_period_start = futureStart;
      f.state.subscriptions[1]!.items.data[0]!.current_period_end = futureEnd;
      clock.mockReturnValue(futureStart * 1000 + 60_000);
      await f.store.reconcile();
      account = f.db.prepare("SELECT entitlement FROM billing_accounts").get()!;
      expect(JSON.parse(String(account.entitlement))).toMatchObject({ planId: "pro", bucket: `paid:sub_new:${futureStart}` });
      expect(f.store.pending()).toBe(false);
    } finally {
      clock.mockRestore();
      f.db.close();
    }
  });
  it("rechecks the subscription at a deferred invoice boundary after cancellation", async () => {
    const f = fixture();
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === "/v1/invoices/in_future") {
        const value = invoice("in_future");
        value.lines.data[0]!.period = { start: end, end: end + 2_592_000 };
        return Response.json(value);
      }
      return original(input, init);
    });
    const clock = vi.spyOn(Date, "now");
    try {
      f.store.accept("u1", event("evt_initial"));
      await f.store.reconcile();
      f.store.accept("u1", event("evt_future", "invoice.paid", { id: "in_future", customer: "cus_123" }));
      await f.store.reconcile();
      f.state.subscriptions[1]!.status = "canceled";
      f.store.accept("u1", event("evt_cancel"));
      await f.store.reconcile();
      expect(JSON.parse(String(f.db.prepare("SELECT entitlement FROM billing_accounts").get()!.entitlement)).planId).toBe("free");
      clock.mockReturnValue(end * 1000);
      await f.store.reconcile();
      expect(JSON.parse(String(f.db.prepare("SELECT entitlement FROM billing_accounts").get()!.entitlement)).planId).toBe("free");
    } finally {
      clock.mockRestore();
      f.db.close();
    }
  });
  it("uses the current customer subscription and its paid invoice when old events arrive", async () => {
    const f = fixture();
    try {
      f.store.accept("u1", event("evt_current"));
      await f.store.reconcile();
      expect(f.deliver.mock.calls[0]).toEqual([
        "vault1",
        1,
        expect.objectContaining({
          subscriptionId: "sub_new",
          planId: "pro",
          bucket: `paid:sub_new:${start}`,
        }),
      ]);
      f.store.accept("u1",
        event("evt_old", "customer.subscription.deleted", {
          id: "sub_old",
          customer: "cus_123",
        }),
      );
      f.store.accept("u1",
        event("evt_oldinvoice", "invoice.paid", {
          id: "in_old",
          customer: "cus_123",
        }),
      );
      await f.store.reconcile();
      expect(f.deliver).toHaveBeenCalledTimes(1);
      expect(
        f.db
          .prepare("SELECT subscription_id,revision FROM billing_accounts")
          .get(),
      ).toMatchObject({ subscription_id: "sub_new", revision: 1 });
      expect(f.store.pending()).toBe(false);
    } finally {
      f.db.close();
    }
  });
  it("does not overwrite newer state when concurrent alarms finish out of order", async () => {
    const f = fixture();
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const unblock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.fetcher.getMockImplementation()!;
    let first = true;
    f.fetcher.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === "/v1/subscriptions" && first) {
        first = false;
        const old = Response.json({
          data: structuredClone(f.state.subscriptions),
          has_more: false,
        });
        reached();
        await unblock;
        return old;
      }
      return original(input, init);
    });
    try {
      f.store.accept("u1", event("evt_first"));
      const older = f.store.reconcile();
      await paused;
      f.state.subscriptions[1]!.status = "canceled";
      f.store.accept("u1", event("evt_second"));
      await f.store.reconcile();
      release();
      await older;
      const plan = JSON.parse(
        String(
          f.db.prepare("SELECT entitlement FROM billing_accounts").get()!
            .entitlement,
        ),
      );
      expect(plan.planId).toBe("free");
      expect(f.store.pending()).toBe(false);
    } finally {
      release();
      f.db.close();
    }
  });
  it("does not grant a new quota period on failed renewal and retries outbox delivery", async () => {
    const f = fixture();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      f.store.accept("u1", event("evt_initial"));
      f.state.failDelivery = true;
      await expect(f.store.reconcile()).rejects.toThrow("pending");
      expect(f.store.pending()).toBe(true);
      f.state.failDelivery = false;
      clock.mockReturnValue(now + 60_000);
      await f.store.reconcile();
      expect(f.store.pending()).toBe(false);
      f.state.subscriptions[1]!.status = "past_due";
      f.state.invoiceStatus = "open";
      f.store.accept("u1",
        event("evt_failed", "invoice.payment_failed", {
          id: "in_new",
          customer: "cus_123",
        }),
      );
      await f.store.reconcile();
      const plan = JSON.parse(
        String(
          f.db.prepare("SELECT entitlement FROM billing_accounts").get()!
            .entitlement,
        ),
      );
      expect(plan).toMatchObject({
        planId: "pro",
        bucket: `paid:sub_new:${start}`,
        validUntil: end * 1000,
      });
    } finally {
      clock.mockRestore();
      f.db.close();
    }
  });
  it("leaves duplicate active subscriptions pending instead of choosing an arbitrary winner", async () => {
    const f = fixture();
    try {
      f.state.subscriptions[0]!.status = "active";
      f.store.accept("u1", event("evt_duplicate"));
      await expect(f.store.reconcile()).rejects.toThrow("pending");
      expect(f.deliver).not.toHaveBeenCalled();
      expect(f.store.pending()).toBe(true);
    } finally {
      f.db.close();
    }
  });
  it("deduplicates deliveries, rejects live/test mixups and drops events for deleted accounts", async () => {
    const f = fixture();
    try {
      expect(() =>
        f.store.accept("u1", { ...event("evt_wrong"), livemode: true }),
      ).toThrow("mode");
      f.store.accept("u1", event("evt_duplicate"));
      f.store.accept("u1", event("evt_duplicate"));
      expect(
        f.db.prepare("SELECT COUNT(*) AS n FROM billing_events").get()!.n,
      ).toBe(1);
      f.state.active = false;
      await f.store.reconcile();
      expect(
        f.db.prepare("SELECT COUNT(*) AS n FROM billing_events").get()!.n,
      ).toBe(0);
      expect(
        f.db.prepare("SELECT COUNT(*) AS n FROM billing_accounts").get()!.n,
      ).toBe(0);
    } finally {
      f.db.close();
    }
  });
});

describe("billing account cleanup", () => {
  it("cancels a list-discovered checkout that completes during expiry even when subscription listing lags", async () => {
    let active = true;
    let completed = false;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const session = () => ({ id: "cs_test_race", customer: "cus_123", mode: "subscription", payment_status: completed ? "paid" : "unpaid", status: completed ? "complete" : "open", expires_at: end, url: null, subscription: completed ? "sub_new" : null });
      if (url.pathname === "/v1/checkout/sessions") return Response.json({ data: [session()], has_more: false });
      if (url.pathname === "/v1/checkout/sessions/cs_test_race/expire") { completed = true; return new Response("already completed", { status: 400 }); }
      if (url.pathname === "/v1/checkout/sessions/cs_test_race") return Response.json(session());
      if (url.pathname === "/v1/subscriptions") return Response.json({ data: [], has_more: false });
      if (url.pathname === "/v1/subscriptions/sub_new") {
        if (init?.method === "DELETE") { active = false; return Response.json({}); }
        return Response.json(subscription("sub_new", active ? "active" : "canceled"));
      }
      throw new Error(`unexpected ${init?.method} ${url.pathname}`);
    });
    await cleanupBillingCustomer(billingEnv, "cus_123", fetcher);
    expect(completed).toBe(true);
    expect(active).toBe(false);
  });
  it("leaves a newly listed completed session pending until its subscription is checked", async () => {
    let active = true, lists = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/checkout/sessions") return Response.json({ data: ++lists === 1 ? [] : [{ id: "cs_test_new", customer: "cus_123", mode: "subscription", payment_status: "paid", status: "complete", expires_at: end, url: null, subscription: "sub_new" }], has_more: false });
      if (url.pathname === "/v1/subscriptions") return Response.json({ data: [], has_more: false });
      if (url.pathname === "/v1/subscriptions/sub_new") {
        if (init?.method === "DELETE") { active = false; return Response.json({}); }
        return Response.json(subscription("sub_new", active ? "active" : "canceled"));
      }
      throw new Error(`unexpected ${init?.method} ${url.pathname}`);
    });
    await expect(cleanupBillingCustomer(billingEnv, "cus_123", fetcher)).rejects.toThrow("cleanup remains pending");
    expect(active).toBe(true);
    await cleanupBillingCustomer(billingEnv, "cus_123", fetcher);
    expect(active).toBe(false);
  });
  it.each(["cus_other", null])("never expires a known checkout with an unverified customer %s", async (customer) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: "cs_test_other", customer, mode: "subscription", status: "open", expires_at: end, url: null }));
    await expect(cleanupBillingCustomer(billingEnv, "cus_123", fetcher, ["cs_test_other"])).rejects.toThrow("association requires review");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("never cancels a subscription from another customer returned by a listing", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/checkout/sessions") return Response.json({ data: [], has_more: false });
      if (url.pathname === "/v1/subscriptions") return Response.json({ data: [{ ...subscription("sub_new", "active"), customer: "cus_other" }], has_more: false });
      throw new Error(`unexpected ${url.pathname}`);
    });
    await expect(cleanupBillingCustomer(billingEnv, "cus_123", fetcher)).rejects.toThrow("association requires review");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("checks a completed checkout on a later list page", async () => {
    let active = true;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/checkout/sessions") {
        if (!url.searchParams.has("starting_after")) return Response.json({ data: [{ id: "cs_test_first", customer: "cus_123", mode: "subscription", status: "expired", expires_at: end, url: null }], has_more: true });
        expect(url.searchParams.get("starting_after")).toBe("cs_test_first");
        return Response.json({ data: [{ id: "cs_test_second", customer: "cus_123", mode: "subscription", payment_status: "paid", status: "complete", expires_at: end, url: null, subscription: "sub_new" }], has_more: false });
      }
      if (url.pathname === "/v1/subscriptions") return Response.json({ data: [], has_more: false });
      if (url.pathname === "/v1/subscriptions/sub_new") {
        if (init?.method === "DELETE") { active = false; return Response.json({}); }
        return Response.json(subscription("sub_new", active ? "active" : "canceled"));
      }
      throw new Error(`unexpected ${init?.method} ${url.pathname}`);
    });
    await cleanupBillingCustomer(billingEnv, "cus_123", fetcher);
    expect(active).toBe(false);
  });
  it("handles completed non-subscription sessions while rejecting missing mode or subscription", async () => {
    let mode: string | undefined = "payment";
    let subscriptionId: string | null = null;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/checkout/sessions") return Response.json({ data: [{ id: "cs_test_other", customer: "cus_123", mode, payment_status: "paid", status: "complete", expires_at: end, url: null, subscription: subscriptionId }], has_more: false });
      if (url.pathname === "/v1/subscriptions") return Response.json({ data: [], has_more: false });
      throw new Error(`unexpected ${url.pathname}`);
    });
    await cleanupBillingCustomer(billingEnv, "cus_123", fetcher);
    mode = "setup";
    await cleanupBillingCustomer(billingEnv, "cus_123", fetcher);
    mode = undefined;
    await expect(cleanupBillingCustomer(billingEnv, "cus_123", fetcher)).rejects.toThrow("requires review");
    mode = "subscription";
    await expect(cleanupBillingCustomer(billingEnv, "cus_123", fetcher)).rejects.toThrow("cleanup remains pending");
    mode = "payment";
    subscriptionId = "sub_new";
    await expect(cleanupBillingCustomer(billingEnv, "cus_123", fetcher)).rejects.toThrow("mode requires review");
  });
  it.each(["payment", "subscription"] as const)("keeps a completed %s checkout pending while its payment is unresolved", async (mode) => {
    let active = true;
    let paymentStatus: string | undefined = "unpaid";
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/checkout/sessions") return Response.json({ data: [{ id: "cs_test_processing", customer: "cus_123", mode, payment_status: paymentStatus, status: "complete", expires_at: end, url: null, subscription: mode === "subscription" ? "sub_new" : null }], has_more: false });
      if (url.pathname === "/v1/subscriptions") return Response.json({ data: [], has_more: false });
      if (url.pathname === "/v1/subscriptions/sub_new") {
        if (init?.method === "DELETE") { active = false; return Response.json({}); }
        return Response.json(subscription("sub_new", active ? "active" : "canceled"));
      }
      throw new Error(`unexpected ${init?.method} ${url.pathname}`);
    });
    await expect(cleanupBillingCustomer(billingEnv, "cus_123", fetcher)).rejects.toThrow("cleanup remains pending");
    if (mode === "subscription") expect(active).toBe(false);
    paymentStatus = undefined;
    await expect(cleanupBillingCustomer(billingEnv, "cus_123", fetcher)).rejects.toThrow("cleanup remains pending");
    paymentStatus = "paid";
    await cleanupBillingCustomer(billingEnv, "cus_123", fetcher);
  });
  it.each(["unpaid", "missing-subscription"] as const)("still cancels other subscriptions when a checkout has %s", async (problem) => {
    let extraActive = true, firstActive = true;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/checkout/sessions") return Response.json({ data: [{ id: "cs_test_pending", customer: "cus_123", mode: "subscription", payment_status: problem === "unpaid" ? "unpaid" : "paid", status: "complete", expires_at: end, url: null, subscription: problem === "unpaid" ? "sub_new" : null }], has_more: false });
      if (url.pathname === "/v1/subscriptions") return Response.json({ data: [subscription("sub_extra", extraActive ? "active" : "canceled")], has_more: false });
      if (url.pathname === "/v1/subscriptions/sub_new") {
        if (init?.method === "DELETE") { firstActive = false; return Response.json({}); }
        return Response.json(subscription("sub_new", firstActive ? "active" : "canceled"));
      }
      if (url.pathname === "/v1/subscriptions/sub_extra") {
        if (init?.method === "DELETE") { extraActive = false; return Response.json({}); }
        return Response.json(subscription("sub_extra", extraActive ? "active" : "canceled"));
      }
      throw new Error(`unexpected ${init?.method} ${url.pathname}`);
    });
    await expect(cleanupBillingCustomer(billingEnv, "cus_123", fetcher)).rejects.toThrow("cleanup remains pending");
    expect(extraActive).toBe(false);
  });
  it("expires a known checkout by ID even when the list has not exposed it", async () => {
    let open = true;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/checkout/sessions/cs_test_late/expire") {
        open = false;
        return Response.json({});
      }
      if (url.pathname === "/v1/checkout/sessions/cs_test_late")
        return Response.json({ id: "cs_test_late", customer: "cus_123", mode: "subscription", status: open ? "open" : "expired", expires_at: end, url: null });
      if (["/v1/checkout/sessions", "/v1/subscriptions"].includes(url.pathname))
        return Response.json({ data: [], has_more: false });
      throw new Error(`unexpected ${init?.method} ${url.pathname}`);
    });
    await cleanupBillingCustomer(billingEnv, "cus_123", fetcher, ["cs_test_late"]);
    expect(open).toBe(false);
  });

  it("cancels a known completed checkout's subscription even when absent from lists", async () => {
    let active = true;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/checkout/sessions/cs_test_paid")
        return Response.json({ id: "cs_test_paid", customer: "cus_123", mode: "subscription", payment_status: "paid", status: "complete", expires_at: end, url: null, subscription: "sub_new" });
      if (url.pathname === "/v1/subscriptions/sub_new") {
        if (init?.method === "DELETE") { active = false; return Response.json({}); }
        return Response.json(subscription("sub_new", active ? "active" : "canceled"));
      }
      if (["/v1/checkout/sessions", "/v1/subscriptions"].includes(url.pathname))
        return Response.json({ data: [], has_more: false });
      throw new Error(`unexpected ${init?.method} ${url.pathname}`);
    });
    await cleanupBillingCustomer(billingEnv, "cus_123", fetcher, ["cs_test_paid"]);
    expect(active).toBe(false);
  });
  it("expires pending checkouts before cancellation and verifies remote state, even with new billing disabled", async () => {
    let open = true;
    let active = true;
    const paths: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      paths.push(`${init?.method} ${url.pathname}`);
      if (url.pathname === "/v1/checkout/sessions")
        return Response.json({
          data: [
            {
              id: "cs_test_123",
              customer: "cus_123",
              mode: "subscription",
              status: open ? "open" : "expired",
              expires_at: end,
              url: null,
            },
          ],
          has_more: false,
        });
      if (url.pathname === "/v1/checkout/sessions/cs_test_123/expire") {
        open = false;
        return Response.json({});
      }
      if (url.pathname === "/v1/checkout/sessions/cs_test_123")
        return Response.json({ id: "cs_test_123", customer: "cus_123", mode: "subscription", status: open ? "open" : "expired", expires_at: end, url: null });
      if (url.pathname === "/v1/subscriptions")
        return Response.json({
          data: [subscription("sub_new", active ? "active" : "canceled")],
          has_more: false,
        });
      if (
        url.pathname === "/v1/subscriptions/sub_new" &&
        init?.method === "DELETE"
      ) {
        expect(url.searchParams.get("prorate")).toBe("false");
        active = false;
        return Response.json({});
      }
      if (url.pathname === "/v1/subscriptions/sub_new")
        return Response.json(subscription("sub_new", active ? "active" : "canceled"));
      throw new Error("unexpected test request");
    });
    await cleanupBillingCustomer(
      { ...billingEnv, BILLING_ENABLED: "false" },
      "cus_123",
      fetcher,
    );
    expect(
      paths.indexOf("POST /v1/checkout/sessions/cs_test_123/expire"),
    ).toBeLessThan(paths.indexOf("DELETE /v1/subscriptions/sub_new"));
    expect(open).toBe(false);
    expect(active).toBe(false);
  });
});
