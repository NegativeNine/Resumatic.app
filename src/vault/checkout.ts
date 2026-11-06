import { AppError } from "../shared/errors";
import {
  subscriptionIsOpen,
  type BillingCheckoutSession,
  type stripeClient,
} from "../worker/billing";

interface Intent {
  key: string;
  planId: string;
  sessionId: string | null;
  createdAt: number;
  expiresAt: number;
  canceling: boolean;
}
type Stripe = ReturnType<typeof stripeClient>;
export interface CheckoutHooks {
  readIntent(): string | null;
  writeIntent(value: string): void;
  clearIntent(): void;
  customerId(): string | null;
  setCustomer(id: string): void;
  markCustomerRequested(): void;
  requireOwner(): void;
}

/** Durable intent transitions surround every Stripe await. A cancel invalidates in-flight open calls. */
export class CheckoutCoordinator {
  constructor(
    private readonly userId: string,
    private readonly stripe: Stripe,
    private readonly hooks: CheckoutHooks,
    private readonly now = () => Date.now(),
  ) {}

  private read(): Intent | null {
    const value = this.hooks.readIntent();
    if (!value) return null;
    const raw = JSON.parse(value) as Intent;
    if (
      typeof raw.key !== "string" ||
      typeof raw.planId !== "string" ||
      !Number.isFinite(raw.expiresAt)
    )
      throw new AppError(
        "unavailable",
        "checkout state requires operator review",
      );
    return {
      ...raw,
      createdAt: raw.createdAt ?? raw.expiresAt - 86_400_000,
      canceling: raw.canceling ?? false,
    };
  }
  private write(intent: Intent): void {
    this.hooks.writeIntent(JSON.stringify(intent));
  }
  private current(intent: Intent): Intent {
    this.hooks.requireOwner();
    const current = this.read();
    if (
      !current ||
      current.key !== intent.key ||
      current.canceling !== intent.canceling
    )
      throw new AppError("conflict", "checkout changed; try again");
    return current;
  }
  private fresh(planId: string): Intent {
    const intent = {
      key: crypto.randomUUID(),
      planId,
      sessionId: null,
      createdAt: this.now(),
      expiresAt: this.now() + 86_400_000,
      canceling: false,
    };
    this.write(intent);
    return intent;
  }
  private stripeKey(intent: Intent): string {
    return `checkout:${this.userId}:${intent.key}`;
  }
  private async customer(intent: Intent): Promise<string> {
    this.hooks.markCustomerRequested();
    let customer = this.hooks.customerId();
    if (!customer) {
      if (this.now() - intent.createdAt >= 23 * 60 * 60 * 1000)
        throw new AppError(
          "conflict",
          "billing customer confirmation is uncertain; contact support before starting another payment",
        );
      const created = await this.stripe.createCustomer(
        this.userId,
        `customer:${this.userId}`,
      );
      // Preserve the identifier even if deletion began while creating it; cleanup needs it.
      this.hooks.setCustomer(created.id);
      customer = created.id;
    }
    this.current(intent);
    return customer;
  }
  private async session(
    customer: string,
    intent: Intent,
  ): Promise<BillingCheckoutSession | null> {
    if (intent.sessionId) {
      const session = await this.stripe.checkoutSession(intent.sessionId);
      this.current(intent);
      return session;
    }
    const sessions = await this.stripe.checkoutSessions(customer);
    this.current(intent);
    const matching = sessions.filter(
      (session) => session.checkoutKey === this.stripeKey(intent),
    );
    if (matching.length > 1)
      throw new AppError(
        "unavailable",
        "checkout state requires operator review",
      );
    if (matching[0]) {
      intent.sessionId = matching[0].id;
      intent.expiresAt = matching[0].expiresAt;
      this.write(intent);
      return matching[0];
    }
    if (sessions.some((session) => session.status === "open"))
      throw new AppError(
        "conflict",
        "another checkout requires operator review before continuing",
      );
    // Stripe may prune idempotency keys after 24h. Never retry an unresolved creation past that window.
    if (this.now() - intent.createdAt >= 23 * 60 * 60 * 1000)
      throw new AppError(
        "conflict",
        "checkout confirmation is uncertain; contact support before starting another payment",
      );
    return null;
  }

  async open(planId: string): Promise<{ url: string }> {
    this.hooks.requireOwner();
    let intent = this.read() ?? this.fresh(planId);
    if (intent.canceling)
      throw new AppError(
        "conflict",
        "finish cancelling the pending checkout first",
      );
    const customer = await this.customer(intent);
    const subscriptions = await this.stripe.subscriptions(customer);
    this.current(intent);
    if (subscriptions.some(subscriptionIsOpen))
      throw new AppError(
        "conflict",
        "manage your existing subscription in the billing portal",
      );
    const session = await this.session(customer, intent);
    // Another caller may have replaced this expired intent after session() resolved.
    this.current(intent);
    if (session?.status === "open") {
      if (intent.planId !== planId)
        throw new AppError(
          "conflict",
          "cancel your existing checkout before choosing another plan",
        );
      if (!session.url)
        throw new AppError(
          "unavailable",
          "checkout is temporarily unavailable",
        );
      return { url: session.url };
    }
    if (
      session?.status === "complete" &&
      (!session.subscriptionId ||
        !subscriptions.some(
          (subscription) =>
            subscription.id === session.subscriptionId &&
            !subscriptionIsOpen(subscription),
        ))
    )
      throw new AppError("conflict", "your payment is being confirmed");
    if (session) intent = this.fresh(planId); // Confirmed expired/terminal session: always a fresh server key.
    if (intent.planId !== planId)
      throw new AppError(
        "conflict",
        "cancel your existing checkout before choosing another plan",
      );
    const result = await this.stripe.checkout(
      customer,
      this.userId,
      planId,
      this.stripeKey(intent),
    );
    const current = this.current(intent);
    if (current.sessionId && current.sessionId !== result.id)
      throw new AppError(
        "unavailable",
        "checkout state requires operator review",
      );
    this.write({
      ...intent,
      sessionId: result.id,
      expiresAt: result.expiresAt ?? intent.expiresAt,
    });
    return { url: result.url };
  }

  async cancel(): Promise<void> {
    this.hooks.requireOwner();
    const intent = this.read();
    if (!intent) return;
    intent.canceling = true;
    this.write(intent);
    const customer = await this.customer(intent);
    let session = await this.session(customer, intent);
    this.current(intent);
    if (!session) {
      // Recover an in-flight/lost creation with the original Stripe key, then immediately expire it.
      const recovered = await this.stripe.checkout(
        customer,
        this.userId,
        intent.planId,
        this.stripeKey(intent),
      );
      this.current(intent);
      intent.sessionId = recovered.id;
      this.write(intent);
      session = await this.stripe.checkoutSession(recovered.id);
      this.current(intent);
    }
    if (session.status === "complete") {
      this.current(intent);
      this.write({ ...intent, canceling: false });
      throw new AppError(
        "conflict",
        "payment is complete; manage the subscription in the billing portal",
      );
    }
    if (session.status === "open") {
      try {
        await this.stripe.expireCheckout(
          session.id,
          `cancel:${this.userId}:${intent.key}`,
        );
      } catch (error) {
        if ((await this.stripe.checkoutSession(session.id)).status === "open")
          throw error;
      }
      this.current(intent);
      const after = await this.stripe.checkoutSession(session.id);
      this.current(intent);
      if (after.status !== "expired") {
        this.write({ ...intent, canceling: false });
        throw new AppError(
          "conflict",
          "payment is complete; manage the subscription in the billing portal",
        );
      }
    }
    this.current(intent);
    this.hooks.clearIntent();
  }
}
