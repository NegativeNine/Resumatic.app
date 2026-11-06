import { describe, expect, it, vi } from "vitest";
import { CheckoutCoordinator } from "../../src/vault/checkout";
import type {
  BillingCheckoutSession,
  stripeClient,
} from "../../src/worker/billing";

function fixture() {
  const state = {
    intent: null as string | null,
    customer: null as string | null,
    now: 1_800_000_000_000,
    closed: false,
    calls: 0,
    dispatches: 0,
    customerDispatches: 0,
  };
  const sessions = new Map<string, BillingCheckoutSession>();
  let holdFirst: Promise<void> | null = null;
  const checkout = vi.fn(
    async (_customer: string, _uid: string, _plan: string, key: string) => {
      state.calls++;
      let session = [...sessions.values()].find((s) => s.checkoutKey === key);
      if (!session) {
        const id = `cs_test_${sessions.size + 1}`;
        session = {
          id,
          customerId: "cus_test",
          mode: "subscription",
          paymentStatus: "unpaid",
          status: "open",
          expiresAt: state.now + 86_400_000,
          url: `https://checkout.stripe.com/${id}`,
          checkoutKey: key,
          subscriptionId: null,
        };
        sessions.set(id, session);
      }
      if (state.calls === 1 && holdFirst) await holdFirst;
      return {
        id: session.id,
        url: session.url!,
        expiresAt: session.expiresAt,
      };
    },
  );
  const stripe = {
    createCustomer: vi.fn(async () => ({ id: "cus_test" })),
    subscriptions: vi.fn(async () => []),
    checkoutSessions: vi.fn(async () =>
      [...sessions.values()].map((s) => ({ ...s })),
    ),
    checkoutSession: vi.fn(async (id: string) => ({ ...sessions.get(id)! })),
    checkout,
    expireCheckout: vi.fn(async (id: string) => {
      sessions.get(id)!.status = "expired";
    }),
  } as unknown as ReturnType<typeof stripeClient>;
  const coordinator = new CheckoutCoordinator(
    "user",
    stripe,
    {
      readIntent: () => state.intent,
      writeIntent: (value) => {
        state.intent = value;
      },
      clearIntent: () => {
        state.intent = null;
      },
      customerId: () => state.customer,
      markCustomerRequested() {},
      requireOwner() {
        if (state.closed) throw new Error("closed");
      },
      beginCustomerDispatch() {
        if (state.closed) throw new Error("closed");
        state.customerDispatches++;
      },
      settleCustomerDispatch(id) {
        state.customer = id;
        state.customerDispatches--;
      },
      beginCheckoutDispatch() {
        if (state.closed) throw new Error("closed");
        state.dispatches++;
      },
      settleCheckoutDispatch(_sessionId) { state.dispatches--; },
    },
    () => state.now,
  );
  return {
    coordinator,
    state,
    sessions,
    checkout,
    stripe,
    hold(promise: Promise<void>) {
      holdFirst = promise;
    },
  };
}

describe("durable checkout intent", () => {
  it("does not return or expire a session attached to another customer", async () => {
    const f = fixture();
    await f.coordinator.open("pro");
    const session = [...f.sessions.values()][0]!;
    session.customerId = "cus_other";
    await expect(f.coordinator.open("pro")).rejects.toThrow("association requires review");
    await expect(f.coordinator.cancel()).rejects.toThrow("association requires review");
    expect(f.stripe.expireCheckout).not.toHaveBeenCalled();
    expect(session.status).toBe("open");
    const intent = JSON.parse(f.state.intent!);
    intent.canceling = false;
    intent.sessionId = null; // Recovering a lost create response uses the listing.
    f.state.intent = JSON.stringify(intent);
    await expect(f.coordinator.open("pro")).rejects.toThrow("association requires review");
    expect(f.checkout).toHaveBeenCalledTimes(1);
  });
  it("does not expire a different session belonging to the same customer", async () => {
    const f = fixture();
    await f.coordinator.open("pro");
    const session = [...f.sessions.values()][0]!;
    session.checkoutKey = "checkout:another-intent";
    await expect(f.coordinator.cancel()).rejects.toThrow("checkout identity requires review");
    expect(f.stripe.expireCheckout).not.toHaveBeenCalled();
    expect(session.status).toBe("open");
  });
  it("shares one server-generated Stripe key across concurrent and repeated requests", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([
      f.coordinator.open("pro"),
      f.coordinator.open("pro"),
    ]);
    expect(a.url).toBe(b.url);
    expect(f.sessions.size).toBe(1);
    expect(new Set(f.checkout.mock.calls.map((call) => call[3])).size).toBe(1);
    expect(await f.coordinator.open("pro")).toEqual(a);
    await expect(f.coordinator.open("another")).rejects.toThrow(
      "cancel your existing checkout",
    );
  });
  it("uses a fresh key after confirmed expiry and permits changing plans then", async () => {
    const f = fixture();
    await f.coordinator.open("pro");
    const old = [...f.sessions.values()][0]!;
    old.status = "expired";
    await f.coordinator.open("another");
    expect(f.sessions.size).toBe(2);
    expect(f.checkout.mock.calls[0]![3]).not.toBe(f.checkout.mock.calls[1]![3]);
    expect(f.checkout.mock.calls[1]![2]).toBe("another");
  });
  it("blocks unresolved creation after the idempotency retention window", async () => {
    const f = fixture();
    f.state.intent = JSON.stringify({
      key: "lost",
      planId: "pro",
      sessionId: null,
      createdAt: f.state.now - 86_400_000,
      expiresAt: f.state.now,
      canceling: false,
    });
    await expect(f.coordinator.open("pro")).rejects.toThrow("uncertain");
    expect(f.checkout).not.toHaveBeenCalled();
    expect(f.stripe.createCustomer).not.toHaveBeenCalled();
    await expect(f.coordinator.cancel()).rejects.toThrow("uncertain");
    expect(f.state.intent).not.toBeNull();
  });
  it("only replaces an expired intent once when two checkout requests race", async () => {
    const f = fixture();
    await f.coordinator.open("pro");
    [...f.sessions.values()][0]!.status = "expired";
    const results = await Promise.allSettled([
      f.coordinator.open("pro"),
      f.coordinator.open("pro"),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(f.sessions.size).toBe(2);
    expect(
      [...f.sessions.values()].filter((session) => session.status === "open"),
    ).toHaveLength(1);
  });
  it("cancels while a creation response is in flight and rejects that stale result", async () => {
    const f = fixture();
    let release!: () => void;
    f.hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const opening = f.coordinator.open("pro");
    while (f.sessions.size === 0) await Promise.resolve();
    await f.coordinator.cancel();
    expect([...f.sessions.values()][0]!.status).toBe("expired");
    expect(f.state.intent).toBeNull();
    release();
    await expect(opening).rejects.toThrow("checkout changed");
    expect(f.state.intent).toBeNull();
  });
  it("never clears a completed payment or returns checkout after account closure", async () => {
    const f = fixture();
    await f.coordinator.open("pro");
    [...f.sessions.values()][0]!.status = "complete";
    await expect(f.coordinator.cancel()).rejects.toThrow("payment is complete");
    expect(f.state.intent).not.toBeNull();
    f.state.closed = true;
    await expect(f.coordinator.open("pro")).rejects.toThrow("closed");
  });
  it("keeps a checkout dispatch fenced until its create response arrives after closure", async () => {
    const f = fixture();
    let release!: () => void;
    f.hold(new Promise<void>((resolve) => { release = resolve; }));
    const opening = f.coordinator.open("pro");
    while (f.sessions.size === 0) await Promise.resolve();
    expect(f.state.dispatches).toBe(1);
    f.state.closed = true;
    release();
    await expect(opening).rejects.toThrow("closed");
    expect(f.state.dispatches).toBe(0);
  });
  it("keeps a failed checkout create fenced even if a later retry succeeds", async () => {
    const f = fixture();
    f.checkout.mockRejectedValueOnce(new Error("response lost"));
    await expect(f.coordinator.open("pro")).rejects.toThrow("response lost");
    expect(f.state.dispatches).toBe(1);
    await f.coordinator.open("pro");
    expect(f.state.dispatches).toBe(1);
  });
  it("keeps a failed customer create fenced after a later successful retry", async () => {
    const f = fixture();
    vi.mocked(f.stripe.createCustomer).mockRejectedValueOnce(new Error("response lost"));
    await expect(f.coordinator.open("pro")).rejects.toThrow("response lost");
    expect(f.state.customerDispatches).toBe(1);
    await f.coordinator.open("pro");
    expect(f.state.customer).toBe("cus_test");
    expect(f.state.customerDispatches).toBe(1);
  });
});
