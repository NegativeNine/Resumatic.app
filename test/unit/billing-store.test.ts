import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { BillingStore, BILLING_MIGRATIONS } from "../../src/directory/billing";
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
  const state = {
    subscriptions: [
      subscription("sub_old", "canceled", "in_old"),
      subscription("sub_new"),
    ],
    invoiceStatus: "paid",
    active: true,
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
        state.active && uid === "u1" ? { vaultId: "vault1" } : null,
      deliver,
    },
    fetcher,
  );
  return { db, state, fetcher, deliver, store };
}

describe("durable billing reconciliation", () => {
  it("uses the current customer subscription and its paid invoice when old events arrive", async () => {
    const f = fixture();
    try {
      f.store.accept(event("evt_current"));
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
      f.store.accept(
        event("evt_old", "customer.subscription.deleted", {
          id: "sub_old",
          customer: "cus_123",
        }),
      );
      f.store.accept(
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
      f.store.accept(event("evt_first"));
      const older = f.store.reconcile();
      await paused;
      f.state.subscriptions[1]!.status = "canceled";
      f.store.accept(event("evt_second"));
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
    try {
      f.store.accept(event("evt_initial"));
      f.state.failDelivery = true;
      await expect(f.store.reconcile()).rejects.toThrow("pending");
      expect(f.store.pending()).toBe(true);
      f.state.failDelivery = false;
      await f.store.reconcile();
      expect(f.store.pending()).toBe(false);
      f.state.subscriptions[1]!.status = "past_due";
      f.state.invoiceStatus = "open";
      f.store.accept(
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
      f.db.close();
    }
  });
  it("leaves duplicate active subscriptions pending instead of choosing an arbitrary winner", async () => {
    const f = fixture();
    try {
      f.state.subscriptions[0]!.status = "active";
      f.store.accept(event("evt_duplicate"));
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
        f.store.accept({ ...event("evt_wrong"), livemode: true }),
      ).toThrow("mode");
      f.store.accept(event("evt_duplicate"));
      f.store.accept(event("evt_duplicate"));
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
