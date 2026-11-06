import { describe, expect, it } from "vitest";
import {
  billingConfig,
  freeQuotaBucket,
  paidQuotaBucket,
} from "../../src/shared/billing";
import {
  entitlementFor,
  parseStripeEvent,
  parseSubscription,
  settledInvoice,
  stripeClient,
  verifyStripe,
} from "../../src/worker/billing";

const env = {
  BILLING_ENABLED: "true",
  BILLING_PLANS_JSON: JSON.stringify({
    free: { generationLimit: 3 },
    paid: [{ id: "pro", priceId: "price_pro", generationLimit: 50 }],
  }),
  STRIPE_SECRET_KEY: "sk_test_secret",
  STRIPE_WEBHOOK_SECRET: "whsec_secret",
  STRIPE_API_VERSION: "2026-09-30.endive",
  APP_ORIGIN: "https://app.example.com",
};
const cfg = billingConfig(env)!;
const start = 1_800_000_000;
const end = start + 2_592_000;
const now = (start + 1_000) * 1_000;
const paidPeriod = {
  subscriptionId: "sub_123",
  priceId: "price_pro",
  periodStart: start,
  paidThrough: end * 1000,
};
function subscription(status = "active") {
  return parseSubscription({
    id: "sub_123",
    customer: "cus_123",
    status,
    items: {
      data: [
        {
          price: { id: "price_pro" },
          current_period_start: start,
          current_period_end: end,
        },
      ],
    },
    cancel_at_period_end: true,
    trial_end: start + 10_000,
  });
}
async function signature(
  body: string,
  timestamp: number,
  secret = "whsec_secret",
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

describe("Stripe authenticity", () => {
  it("accepts any matching v1 during rotation, preserving exact UTF-8 body", async () => {
    const body = '{"name":"José ☕"}';
    const mac = await signature(body, start);
    expect(
      await verifyStripe(
        body,
        `t=${start},v1=${mac},v1=${"0".repeat(64)}`,
        "whsec_secret",
        start * 1000,
      ),
    ).toBe(true);
    expect(
      await verifyStripe(
        body,
        `t=${start},v1=${"0".repeat(64)},v1=${mac}`,
        "whsec_secret",
        start * 1000,
      ),
    ).toBe(true);
    expect(
      await verifyStripe(
        body + " ",
        `t=${start},v1=${mac}`,
        "whsec_secret",
        start * 1000,
      ),
    ).toBe(false);
  });
  it("rejects stale, future, duplicate timestamps, wrong schemes and wrong keys", async () => {
    const mac = await signature("{}", start);
    for (const header of [
      `t=${start},v0=${mac}`,
      `t=${start},t=${start},v1=${mac}`,
      `t=NaN,v1=${mac}`,
      `t=${start},v1=nothex`,
    ])
      expect(
        await verifyStripe("{}", header, "whsec_secret", start * 1000),
      ).toBe(false);
    expect(
      await verifyStripe("{}", `t=${start},v1=${mac}`, "other", start * 1000),
    ).toBe(false);
    for (const delta of [-301_000, 301_000])
      expect(
        await verifyStripe(
          "{}",
          `t=${start},v1=${mac}`,
          "whsec_secret",
          start * 1000 + delta,
        ),
      ).toBe(false);
  });
});

describe("billing deployment and entitlements", () => {
  it("disables unconfigured billing and rejects unsafe enabled configurations", () => {
    expect(billingConfig({})).toBeNull();
    expect(billingConfig({ BILLING_ENABLED: "false" })).toBeNull();
    for (const patch of [
      { APP_ORIGIN: "https://app.example.com/redirect" },
      { APP_ORIGIN: "http://app.example.com" },
      { BILLING_ENABLED: "yes" },
      { STRIPE_API_VERSION: "" },
      { BILLING_PLANS_JSON: "{secret:leak}" },
    ])
      expect(() => billingConfig({ ...env, ...patch })).toThrow(
        "billing configuration is invalid",
      );
  });
  it("retains paid period-end cancellations while excluding trials and unsettled invoices", () => {
    expect(entitlementFor(subscription(), cfg, paidPeriod, now)).toMatchObject({
      planId: "pro",
      validUntil: end * 1000,
      cancelAtPeriodEnd: true,
    });
    expect(entitlementFor(subscription(), cfg, null, now).planId).toBe("free");
    for (const status of [
      "trialing",
      "incomplete",
      "incomplete_expired",
      "unpaid",
      "canceled",
      "paused",
    ])
      expect(
        entitlementFor(subscription(status), cfg, paidPeriod, now).planId,
      ).toBe("free");
    expect(
      entitlementFor(subscription(), cfg, paidPeriod, end * 1000).planId,
    ).toBe("free");
    expect(
      entitlementFor(
        subscription(),
        cfg,
        { ...paidPeriod, priceId: "price_other" },
        now,
      ).planId,
    ).toBe("free");
  });
  it("does not grant a new paid bucket for an unpaid renewal or another subscription's invoice", () => {
    const past = subscription("past_due");
    const paid = {
      subscriptionId: past.id,
      priceId: "price_pro",
      periodStart: start - 100,
      paidThrough: now + 1000,
    };
    expect(entitlementFor(past, cfg, paid, now).bucket).toBe(
      paidQuotaBucket(past.id, paid.periodStart),
    );
    expect(
      entitlementFor(past, cfg, { ...paid, subscriptionId: "sub_other" }, now)
        .planId,
    ).toBe("free");
    expect(entitlementFor(past, cfg, null, now).planId).toBe("free");
    expect(freeQuotaBucket(Date.UTC(2026, 11, 31, 23, 59))).toBe(
      "free:2026-12",
    );
    expect(freeQuotaBucket(Date.UTC(2027, 0, 1))).toBe("free:2027-01");
  });
  it("settles only complete paid recurring invoices, excluding prorations and one-offs", () => {
    const invoice = {
      id: "in_1",
      status: "paid",
      subscription: "sub_123",
      lines: {
        has_more: false,
        data: [
          {
            type: "subscription",
            subscription: "sub_123",
            price: { id: "price_pro" },
            period: { start, end },
          },
        ],
      },
    };
    expect(settledInvoice(invoice)).toEqual({
      invoiceId: "in_1",
      subscriptionId: "sub_123",
      priceId: "price_pro",
      periodStart: start,
      paidThrough: end * 1000,
    });
    expect(settledInvoice({ ...invoice, status: "open" })).toBeNull();
    expect(
      settledInvoice({
        ...invoice,
        lines: { ...invoice.lines, has_more: true },
      }),
    ).toBeNull();
    expect(
      settledInvoice({
        ...invoice,
        lines: {
          has_more: false,
          data: [{ ...invoice.lines.data[0], proration: true }],
        },
      }),
    ).toBeNull();
  });
});

describe("Stripe transport", () => {
  it("sets metadata, pinned API version and idempotency without caller-controlled redirects", async () => {
    const calls: RequestInit[] = [];
    const client = stripeClient(cfg, (async (_url, init) => {
      calls.push(init!);
      return Response.json({ id: "cus_123" });
    }) as typeof fetch);
    expect(await client.createCustomer("s03.user", "customer-user")).toEqual({
      id: "cus_123",
    });
    const fields = new URLSearchParams(String(calls[0]!.body));
    expect(fields.get("metadata[account_uid]")).toBe("s03.user");
    expect(calls[0]!.headers).toMatchObject({
      "stripe-version": cfg.apiVersion,
      "idempotency-key": "customer-user",
    });
    await expect(client.createCustomer("u", "")).rejects.toThrow(
      "idempotency key",
    );
  });
  it("rejects an unexpected checkout host and never exposes provider error bodies", async () => {
    const bad = stripeClient(cfg, (async () =>
      Response.json({
        id: "cs_123",
        url: "https://evil.example/",
      })) as typeof fetch);
    await expect(
      bad.checkout("cus_123", "user", "pro", "checkout1"),
    ).rejects.toThrow("invalid billing redirect");
    const failed = stripeClient(
      cfg,
      (async () =>
        new Response("secret data", { status: 500 })) as typeof fetch,
    );
    await expect(failed.subscription("sub_123")).rejects.toThrow(
      "billing service rejected the operation",
    );
    expect(() => parseStripeEvent('{"secret":"text"}')).toThrow(
      "invalid billing event",
    );
  });
});
