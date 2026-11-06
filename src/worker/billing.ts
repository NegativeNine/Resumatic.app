import { z } from "zod";
import { AppError } from "../shared/errors";
import {
  billingConfig,
  freeQuotaBucket,
  paidQuotaBucket,
  type BillingConfig,
  type BillingEnvironment,
} from "../shared/billing";

const encoder = new TextEncoder();

/** Verify the unmodified body. Repeated v1 signatures are required for secret rotation. */
export async function verifyStripe(
  payload: string | Uint8Array<ArrayBuffer>,
  header: string,
  secret: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!secret || header.length > 4096 || !Number.isFinite(nowMs)) return false;
  const timestamps: string[] = [];
  const signatures: string[] = [];
  for (const item of header.split(",")) {
    const part = item.trim();
    const separator = part.indexOf("=");
    const name = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (name === "t") timestamps.push(value);
    if (name === "v1" && /^[a-f0-9]{64}$/i.test(value)) signatures.push(value);
  }
  if (
    timestamps.length !== 1 ||
    !/^\d+$/.test(timestamps[0]!) ||
    signatures.length === 0
  )
    return false;
  const timestamp = Number(timestamps[0]);
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    Math.abs(nowMs / 1000 - timestamp) > 300
  )
    return false;
  const prefix = encoder.encode(`${timestamps[0]}.`);
  const body = typeof payload === "string" ? encoder.encode(payload) : payload;
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  let valid = false;
  for (const hex of signatures) {
    const mac = Uint8Array.from(hex.match(/../g)!, (pair) =>
      Number.parseInt(pair, 16),
    );
    valid = (await crypto.subtle.verify("HMAC", key, mac, signed)) || valid;
  }
  return valid;
}

const Id = z.string().min(1).max(255);
const StripeEvent = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9]+$/),
  type: z.string().min(1).max(100),
  created: z.number().int().nonnegative(),
  livemode: z.boolean(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});
export type BillingEvent = z.infer<typeof StripeEvent>;

/** Call only after signature verification. Event.created must never be used as an ordering key. */
export function parseStripeEvent(payload: string): BillingEvent {
  try {
    return StripeEvent.parse(JSON.parse(payload));
  } catch {
    throw new AppError("invalid", "invalid billing event");
  }
}

const Period = z.number().int().positive();
const Subscription = z.object({
  id: z.string().regex(/^sub_[A-Za-z0-9]+$/),
  customer: z.union([Id, z.object({ id: Id })]),
  status: z.enum([
    "active",
    "trialing",
    "past_due",
    "incomplete",
    "incomplete_expired",
    "unpaid",
    "canceled",
    "paused",
  ]),
  metadata: z.record(z.string(), z.string()).default({}),
  created: Period.optional(),
  latest_invoice: z
    .union([Id, z.object({ id: Id })])
    .nullable()
    .optional(),
  cancel_at_period_end: z.boolean().default(false),
  trial_end: Period.nullable().optional(),
  current_period_start: Period.optional(),
  current_period_end: Period.optional(),
  items: z.object({
    data: z
      .array(
        z.object({
          price: z.object({
            id: z.string(),
            recurring: z.unknown().optional(),
          }),
          current_period_start: Period.optional(),
          current_period_end: Period.optional(),
        }),
      )
      .length(1),
    has_more: z.literal(false).optional(),
  }),
});
export type BillingSubscription = z.infer<typeof Subscription>;
export const subscriptionIsOpen = (
  subscription: BillingSubscription,
): boolean => !["canceled", "incomplete_expired"].includes(subscription.status);
export interface BillingCheckoutSession {
  id: string;
  status: "open" | "complete" | "expired";
  expiresAt: number;
  url: string | null;
  checkoutKey: string | null;
  subscriptionId: string | null;
}

export function parseSubscription(value: unknown): BillingSubscription {
  const parsed = Subscription.safeParse(value);
  if (!parsed.success)
    throw new AppError("unavailable", "unsupported subscription response");
  return parsed.data;
}

export interface Entitlement {
  planId: string;
  generationLimit: number;
  bucket: string;
  validUntil: number | null; // milliseconds
  subscriptionId: string | null;
  status: BillingSubscription["status"] | "free";
  cancelAtPeriodEnd: boolean;
}

export interface PaidPeriod {
  subscriptionId: string;
  priceId: string;
  periodStart: number;
  paidThrough: number;
}

/** previousPaidPeriod comes from settled invoice records, never an unpaid subscription period. */
export function entitlementFor(
  subscription: BillingSubscription | null,
  cfg: BillingConfig,
  previousPaidPeriod: PaidPeriod | null = null,
  nowMs = Date.now(),
): Entitlement {
  const free: Entitlement = {
    planId: "free",
    generationLimit: cfg.free.generationLimit,
    bucket: freeQuotaBucket(nowMs),
    validUntil: null,
    subscriptionId: subscription?.id ?? null,
    status: subscription?.status ?? "free",
    cancelAtPeriodEnd: subscription?.cancel_at_period_end ?? false,
  };
  if (!subscription) return free;
  if (subscription.status !== "active" && subscription.status !== "past_due")
    return free;
  const item = subscription.items.data[0]!;
  const plan = cfg.paid.find((p) => p.priceId === item.price.id);
  const start = item.current_period_start ?? subscription.current_period_start;
  const end = item.current_period_end ?? subscription.current_period_end;
  if (!plan || !start || !end || end <= start)
    throw new AppError(
      "unavailable",
      "subscription does not match a configured plan",
    );
  if (subscription.status === "active" && start * 1000 > nowMs) return free;
  // This product has no trials. A paid invoice must match both this subscription and price.
  let until = 0;
  const paid =
    previousPaidPeriod?.subscriptionId === subscription.id &&
    previousPaidPeriod.priceId === item.price.id
      ? previousPaidPeriod
      : null;
  if (paid && (
    !Number.isSafeInteger(paid.periodStart) || paid.periodStart <= 0 ||
    !Number.isSafeInteger(paid.paidThrough) || paid.paidThrough <= paid.periodStart * 1000 ||
    paid.periodStart * 1000 > nowMs
  )) return free;
  if (subscription.status === "active" && paid)
    until = Math.min(end * 1000, paid.paidThrough);
  if (subscription.status === "past_due" && paid) until = paid.paidThrough;
  if (until <= nowMs) return free;
  const bucketStart = paid!.periodStart;
  return {
    ...free,
    planId: plan.id,
    generationLimit: plan.generationLimit,
    bucket: paidQuotaBucket(subscription.id, bucketStart),
    validUntil: until,
  };
}

/** A stable invoice ID lets the Directory settle each paid period exactly once. Amounts may be zero. */
export function settledInvoice(
  value: unknown,
): ({ invoiceId: string } & PaidPeriod) | null {
  const parsed = z
    .object({
      id: z.string().regex(/^in_[A-Za-z0-9]+$/),
      status: z.literal("paid"),
      paid: z.literal(true).optional(),
      subscription: Id.nullable().optional(),
      parent: z
        .object({
          subscription_details: z
            .object({ subscription: Id })
            .nullable()
            .optional(),
        })
        .nullable()
        .optional(),
      lines: z.object({
        has_more: z.literal(false),
        data: z
          .array(
            z.object({
              period: z.object({ start: Period, end: Period }),
              subscription: Id.nullable().optional(),
              type: z.string().optional(),
              proration: z.boolean().optional(),
              price: z.object({ id: Id }).nullable().optional(),
              pricing: z
                .object({
                  price_details: z.object({ price: Id }).nullable().optional(),
                })
                .nullable()
                .optional(),
              parent: z
                .object({
                  type: z.string(),
                  subscription_item_details: z
                    .object({
                      subscription: Id,
                      proration: z.boolean().optional(),
                    })
                    .nullable()
                    .optional(),
                })
                .nullable()
                .optional(),
            }),
          )
          .min(1),
      }),
    })
    .safeParse(value);
  if (!parsed.success) return null;
  const invoice = parsed.data;
  const subscriptionId =
    invoice.parent?.subscription_details?.subscription ?? invoice.subscription;
  if (!subscriptionId || !/^sub_[A-Za-z0-9]+$/.test(subscriptionId))
    return null;
  const lines = invoice.lines.data.filter(
    (line) =>
      (line.parent?.subscription_item_details?.subscription ??
        line.subscription) === subscriptionId &&
      (line.parent?.type === "subscription_item_details" ||
        line.type === "subscription") &&
      line.period.end > line.period.start &&
      !line.proration &&
      !line.parent?.subscription_item_details?.proration &&
      /^price_[A-Za-z0-9]+$/.test(
        line.pricing?.price_details?.price ?? line.price?.id ?? "",
      ),
  );
  if (!lines.length) return null;
  const last = lines.reduce((a, b) => (a.period.end >= b.period.end ? a : b));
  return {
    invoiceId: invoice.id,
    subscriptionId,
    priceId: (last.pricing?.price_details?.price ?? last.price?.id)!,
    periodStart: last.period.start,
    paidThrough: last.period.end * 1000,
  };
}

/** Small Stripe REST adapter: explicit version, timeouts, fixed origin, no response bodies in errors. */
export function stripeClient(
  cfg: BillingConfig,
  fetcher: typeof fetch = fetch,
) {
  async function request(
    path: string,
    fields?: Record<string, string>,
    idempotencyKey?: string,
    method?: "DELETE",
  ): Promise<unknown> {
    if (fields && (!idempotencyKey || idempotencyKey.length > 255))
      throw new AppError(
        "invalid",
        "billing operation needs an idempotency key",
      );
    let response: Response;
    try {
      response = await fetcher(`https://api.stripe.com/v1${path}`, {
        method: method ?? (fields ? "POST" : "GET"),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${cfg.secretKey}`,
          "stripe-version": cfg.apiVersion,
          ...(fields
            ? {
                "content-type": "application/x-www-form-urlencoded",
                "idempotency-key": idempotencyKey!,
              }
            : {}),
        },
        ...(fields ? { body: new URLSearchParams(fields).toString() } : {}),
      });
    } catch {
      throw new AppError("unavailable", "billing service is unavailable");
    }
    if (!response.ok)
      throw new AppError(
        "unavailable",
        "billing service rejected the operation",
      );
    try {
      return await response.json();
    } catch {
      throw new AppError("unavailable", "invalid billing service response");
    }
  }
  function safeId(id: string, prefix: string): string {
    if (!new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(id))
      throw new AppError("invalid", "invalid billing identifier");
    return id;
  }
  async function hosted(
    path: string,
    fields: Record<string, string>,
    key: string,
    hostname: string,
  ) {
    const result = z
      .object({ id: Id, url: z.url(), expires_at: Period.optional() })
      .safeParse(await request(path, fields, key));
    if (!result.success)
      throw new AppError("unavailable", "invalid billing service response");
    const url = new URL(result.data.url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== hostname ||
      url.username ||
      url.password
    )
      throw new AppError("unavailable", "invalid billing redirect");
    return {
      id: result.data.id,
      url: result.data.url,
      ...(result.data.expires_at
        ? { expiresAt: result.data.expires_at * 1000 }
        : {}),
    };
  }
  async function list(path: string): Promise<unknown[]> {
    const out: unknown[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const response = z
        .object({
          data: z.array(z.record(z.string(), z.unknown())).max(100),
          has_more: z.boolean(),
        })
        .safeParse(
          await request(
            `${path}&limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
          ),
        );
      if (!response.success)
        throw new AppError("unavailable", "invalid billing list response");
      out.push(...response.data.data);
      if (!response.data.has_more) return out;
      const last = response.data.data.at(-1)?.id;
      if (typeof last !== "string" || last === after)
        throw new AppError("unavailable", "incomplete billing list response");
      after = last;
    }
    throw new AppError(
      "unavailable",
      "billing history requires operator review",
    );
  }
  function checkoutView(value: unknown): BillingCheckoutSession {
    const parsed = z
      .object({
        id: z.string().regex(/^cs_[A-Za-z0-9_]+$/),
        status: z.enum(["open", "complete", "expired"]),
        expires_at: Period,
        url: z.url().nullable().optional(),
        metadata: z.record(z.string(), z.string()).default({}),
        subscription: z
          .union([Id, z.object({ id: Id })])
          .nullable()
          .optional(),
      })
      .safeParse(value);
    if (!parsed.success)
      throw new AppError("unavailable", "invalid checkout session response");
    if (parsed.data.url) {
      const url = new URL(parsed.data.url);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "checkout.stripe.com" ||
        url.username ||
        url.password
      )
        throw new AppError("unavailable", "invalid billing redirect");
    }
    return {
      id: parsed.data.id,
      status: parsed.data.status,
      expiresAt: parsed.data.expires_at * 1000,
      url: parsed.data.url ?? null,
      checkoutKey: parsed.data.metadata.checkout_key ?? null,
      subscriptionId:
        typeof parsed.data.subscription === "string"
          ? parsed.data.subscription
          : (parsed.data.subscription?.id ?? null),
    };
  }
  return {
    async customer(
      id: string,
    ): Promise<{ id: string; metadata: Record<string, string> }> {
      const parsed = z
        .object({
          id: Id,
          metadata: z.record(z.string(), z.string()).default({}),
        })
        .safeParse(await request(`/customers/${safeId(id, "cus")}`));
      if (!parsed.success)
        throw new AppError("unavailable", "invalid billing customer response");
      return parsed.data;
    },
    async createCustomer(userId: string, key: string): Promise<{ id: string }> {
      if (!userId || userId.length > 200)
        throw new AppError("invalid", "invalid account identifier");
      const result = z
        .object({ id: z.string().regex(/^cus_[A-Za-z0-9]+$/) })
        .safeParse(
          await request("/customers", { "metadata[account_uid]": userId }, key),
        );
      if (!result.success)
        throw new AppError("unavailable", "invalid billing service response");
      return result.data;
    },
    async checkout(
      customerId: string,
      userId: string,
      planId: string,
      key: string,
    ) {
      const plan = cfg.paid.find((p) => p.id === planId);
      if (!plan) throw new AppError("invalid", "unknown billing plan");
      return hosted(
        "/checkout/sessions",
        {
          mode: "subscription",
          customer: safeId(customerId, "cus"),
          client_reference_id: userId,
          "line_items[0][price]": plan.priceId,
          "line_items[0][quantity]": "1",
          "subscription_data[metadata][account_uid]": userId,
          "metadata[checkout_key]": key,
          success_url: `${cfg.origin}/#/account`,
          cancel_url: `${cfg.origin}/#/account`,
        },
        key,
        "checkout.stripe.com",
      );
    },
    portal(customerId: string, key: string) {
      return hosted(
        "/billing_portal/sessions",
        {
          customer: safeId(customerId, "cus"),
          return_url: `${cfg.origin}/#/account`,
        },
        key,
        "billing.stripe.com",
      );
    },
    async subscription(id: string) {
      return parseSubscription(
        await request(`/subscriptions/${safeId(id, "sub")}`),
      );
    },
    async subscriptions(customerId: string) {
      return (
        await list(
          `/subscriptions?customer=${safeId(customerId, "cus")}&status=all`,
        )
      ).map(parseSubscription);
    },
    async checkoutSessions(customerId: string) {
      return (
        await list(`/checkout/sessions?customer=${safeId(customerId, "cus")}`)
      ).map(checkoutView);
    },
    async checkoutSession(id: string) {
      return checkoutView(
        await request(`/checkout/sessions/${safeId(id, "cs")}`),
      );
    },
    async expireCheckout(id: string, key: string): Promise<void> {
      await request(`/checkout/sessions/${safeId(id, "cs")}/expire`, {}, key);
    },
    async cancelSubscription(id: string): Promise<void> {
      await request(
        `/subscriptions/${safeId(id, "sub")}?invoice_now=false&prorate=false`,
        undefined,
        undefined,
        "DELETE",
      );
    },
    invoice(id: string) {
      return request(`/invoices/${safeId(id, "in")}`);
    },
  };
}

/** Called only from an account-deletion alarm after closing the Vault. Repeat failures, never ignore them. */
export async function cleanupBillingCustomer(
  env: BillingEnvironment,
  customerId: string,
  fetcher: typeof fetch = fetch,
  knownSessionIds: string[] = [],
): Promise<void> {
  const cfg = billingConfig({ ...env, BILLING_ENABLED: "true" });
  if (!cfg)
    throw new AppError("unavailable", "billing cleanup is not configured");
  const stripe = stripeClient(cfg, fetcher);
  // Listing can lag a successful create. Check IDs recorded from create
  // responses directly and handle subscriptions even if absent from a list.
  for (const id of new Set(knownSessionIds)) {
    let session = await stripe.checkoutSession(id);
    if (session.id !== id) throw new AppError("unavailable", "checkout identity requires review");
    if (session.status === "open") {
      try {
        await stripe.expireCheckout(id, `delete:${customerId}:${id}`);
      } catch (error) {
        if ((await stripe.checkoutSession(id)).status === "open") throw error;
      }
      session = await stripe.checkoutSession(id);
    }
    if (session.id !== id) throw new AppError("unavailable", "checkout identity requires review");
    if (session.status === "open") throw new AppError("unavailable", "checkout cleanup remains pending");
    if (session.status === "complete") {
      if (!session.subscriptionId) throw new AppError("unavailable", "completed checkout subscription is unresolved");
      const sub = await stripe.subscription(session.subscriptionId);
      const owner = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      if (sub.id !== session.subscriptionId || owner !== customerId)
        throw new AppError("unavailable", "checkout subscription association requires review");
      if (subscriptionIsOpen(sub)) await stripe.cancelSubscription(sub.id);
      const after = await stripe.subscription(sub.id);
      const afterOwner = typeof after.customer === "string" ? after.customer : after.customer.id;
      if (after.id !== sub.id || afterOwner !== customerId || subscriptionIsOpen(after))
        throw new AppError("unavailable", "checkout subscription cleanup remains pending");
    }
  }
  // Expire links first so a still-open checkout cannot create a new subscription during cancellation.
  for (const session of await stripe.checkoutSessions(customerId)) {
    if (session.status !== "open") continue;
    try {
      await stripe.expireCheckout(
        session.id,
        `delete:${customerId}:${session.id}`,
      );
    } catch (error) {
      if ((await stripe.checkoutSession(session.id)).status === "open")
        throw error;
    }
  }
  for (const subscription of await stripe.subscriptions(customerId)) {
    if (!subscriptionIsOpen(subscription)) continue;
    try {
      await stripe.cancelSubscription(subscription.id);
    } catch (error) {
      if (subscriptionIsOpen(await stripe.subscription(subscription.id)))
        throw error;
    }
  }
  if (
    (await stripe.checkoutSessions(customerId)).some(
      (session) => session.status === "open",
    ) ||
    (await stripe.subscriptions(customerId)).some(subscriptionIsOpen)
  )
    throw new AppError("unavailable", "billing cleanup remains pending");
}
