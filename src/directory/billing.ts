import { billingConfig } from "../shared/billing";
import { AppError } from "../shared/errors";
import {
  entitlementFor,
  settledInvoice,
  stripeClient,
  subscriptionIsOpen,
  type BillingEvent,
  type Entitlement,
  type PaidPeriod,
} from "../worker/billing";

export const BILLING_MIGRATIONS = [
  `CREATE TABLE billing_events (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, subscription_id TEXT, invoice_id TEXT, user_id TEXT, state TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL)`,
  `CREATE TABLE billing_accounts (user_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL UNIQUE, subscription_id TEXT, paid_period TEXT, entitlement TEXT, revision INTEGER NOT NULL DEFAULT 0, delivered_revision INTEGER NOT NULL DEFAULT 0)`,
];
export const BILLING_DEFERRED_MIGRATIONS = [
  `ALTER TABLE billing_events ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0`,
  `CREATE INDEX billing_pending_by_time ON billing_events (state, next_attempt_at, created_at)`,
];
export const BILLING_DELIVERY_RETRY_MIGRATIONS = [
  `CREATE TABLE billing_delivery_retries (user_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL)`,
];
export const BILLING_EVENT_INCARNATION_MIGRATIONS = [
  `ALTER TABLE billing_events ADD COLUMN incarnation TEXT`,
];
// A global, non-identifying sequence gives every account incarnation and
// state update a fresh token, including writes from older SQL code. The clock
// also distinguishes absent -> inserted -> deleted while a lookup is in flight.
export const BILLING_ACCOUNT_STATE_MIGRATIONS = [
  `ALTER TABLE billing_accounts ADD COLUMN state_token INTEGER`,
  `CREATE TABLE billing_state_clock (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL CHECK(value>=0 AND value<=9007199254740991))`,
  `INSERT INTO billing_state_clock(id,value) VALUES (1,0)`,
  `CREATE TRIGGER billing_account_insert_token AFTER INSERT ON billing_accounts BEGIN
     SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM billing_state_clock WHERE id=1) THEN RAISE(ABORT,'billing_state_clock_missing') END;
     UPDATE billing_state_clock SET value=value+1 WHERE id=1;
     UPDATE billing_accounts SET state_token=(SELECT value FROM billing_state_clock WHERE id=1) WHERE user_id=NEW.user_id;
   END`,
  `CREATE TRIGGER billing_account_update_token AFTER UPDATE OF user_id,customer_id,subscription_id,paid_period,entitlement,revision ON billing_accounts BEGIN
     SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM billing_state_clock WHERE id=1) THEN RAISE(ABORT,'billing_state_clock_missing') END;
     UPDATE billing_state_clock SET value=value+1 WHERE id=1;
     UPDATE billing_accounts SET state_token=(SELECT value FROM billing_state_clock WHERE id=1) WHERE user_id=NEW.user_id;
   END`,
  `CREATE TRIGGER billing_account_delete_token AFTER DELETE ON billing_accounts BEGIN
     SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM billing_state_clock WHERE id=1) THEN RAISE(ABORT,'billing_state_clock_missing') END;
     UPDATE billing_state_clock SET value=value+1 WHERE id=1;
   END`,
];

const RETRY_DELAY_MS = 60_000;

/** Durable inbox and entitlement outbox. Webhooks trigger a read of current customer state. */
export class BillingStore {
  constructor(
    private sql: SqlStorage,
    private env: Env,
    private hooks: {
      transaction<T>(fn: () => T): T;
      account(userId: string): { vaultId: string } | null;
      deliver(
        vaultId: string,
        revision: number,
        entitlement: Entitlement,
      ): Promise<void>;
    },
    private fetcher: typeof fetch = fetch,
  ) {}

  accept(userId: string | undefined, event: BillingEvent): void {
    const cfg = billingConfig(this.env);
    if (!cfg) throw new AppError("unavailable", "billing is not configured");
    if (event.livemode !== cfg.secretKey.startsWith("sk_live_"))
      throw new AppError(
        "invalid",
        "billing event mode does not match this environment",
      );
    const object = event.data.object;
    if (
      ![
        "invoice.paid",
        "invoice.payment_failed",
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
      ].includes(event.type)
    )
      return;
    const customer =
      typeof object.customer === "string" ? object.customer : null;
    if (!customer || !/^cus_[A-Za-z0-9]+$/.test(customer))
      throw new AppError("invalid", "billing event has no customer");
    const subscription = event.type.startsWith("customer.subscription.")
      ? String(object.id)
      : typeof object.subscription === "string"
        ? object.subscription
        : null;
    const invoice = event.type.startsWith("invoice.")
      ? String(object.id)
      : null;
    if (
      (subscription && !/^sub_[A-Za-z0-9]+$/.test(subscription)) ||
      (invoice && !/^in_[A-Za-z0-9]+$/.test(invoice))
    )
      throw new AppError("invalid", "billing event has an invalid identifier");
    // The Worker already read this UID from Stripe's customer metadata to
    // select this Directory. Do not persist a newly delivered event without
    // that attribution: older Workers must retry after the rollout instead.
    if (typeof userId !== "string" || !userId || userId.length > 200)
      throw new AppError("unavailable", "billing event attribution is unavailable");
    // The Directory handles this synchronously, so a delayed webhook RPC
    // cannot insert a new customer-only row after deletion begins.
    if (!this.hooks.account(userId)) return;
    this.sql.exec(
      `INSERT OR IGNORE INTO billing_events (id, customer_id, subscription_id, invoice_id, user_id, created_at, incarnation) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      event.id,
      customer,
      subscription,
      invoice,
      userId,
      Date.now(),
      crypto.randomUUID(),
    );
  }

  pending(): boolean {
    return (
      !!this.sql
        .exec(`SELECT id FROM billing_events WHERE state = 'pending' LIMIT 1`)
        .toArray()[0] ||
      !!this.sql
        .exec(
          `SELECT user_id FROM billing_accounts WHERE delivered_revision < revision LIMIT 1`,
        )
        .toArray()[0]
    );
  }

  /** Called in the same Directory transaction that publishes a replacement Vault. */
  redeliverAfterReplacement(userId: string): void {
    this.sql.exec(`UPDATE billing_accounts SET delivered_revision = 0 WHERE user_id = ?`, userId);
    this.sql.exec(`DELETE FROM billing_delivery_retries WHERE user_id = ?`, userId);
  }

  /** Earliest queued attempt, or now for an undelivered entitlement. */
  nextPendingAt(now = Date.now()): number | null {
    const delivery = this.sql.exec<{ at: number | null }>(
      `SELECT MIN(COALESCE(r.next_attempt_at, 0)) AS at FROM billing_accounts a LEFT JOIN billing_delivery_retries r ON r.user_id = a.user_id AND r.revision = a.revision WHERE a.delivered_revision < a.revision`,
    ).toArray()[0]?.at;
    const event = this.sql.exec<{ at: number | null }>(`SELECT MIN(next_attempt_at) AS at FROM billing_events WHERE state = 'pending'`).toArray()[0]?.at;
    const due = [delivery, event].filter((value): value is number => value != null);
    return due.length ? Math.max(now, Math.min(...due)) : null;
  }

  async reconcile(): Promise<void> {
    const cfg = billingConfig(this.env);
    if (!cfg) return;
    const stripe = stripeClient(cfg, this.fetcher);
    const events = this.sql
      .exec<{ id: string; customer_id: string; invoice_id: string | null; user_id: string | null; created_at: number; next_attempt_at: number; incarnation: string | null }>(
        `SELECT id, customer_id, invoice_id, user_id, created_at, next_attempt_at, incarnation FROM billing_events WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, created_at, id LIMIT 20`,
        Date.now(),
      )
      .toArray();
    // Older inbox rows and old Workers may omit this field. Assign each
    // selected row a fresh incarnation before any provider I/O so a deleted
    // and reinserted event cannot match an earlier reconciliation, even when
    // every other field and millisecond timestamp is identical.
    for (const event of events) {
      if (event.incarnation === null) {
        const incarnation = crypto.randomUUID();
        this.sql.exec(`UPDATE billing_events SET incarnation=? WHERE id=? AND incarnation IS NULL`, incarnation, event.id);
        event.incarnation = incarnation;
      }
    }
    let failed = false;
    for (const event of events) {
      let attributedUserId: string | null = null;
      try {
        if (!event.incarnation || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.incarnation))
          throw new AppError("unavailable", "billing event identity requires review");
        const customer = await stripe.customer(event.customer_id);
        const uid = customer.metadata.account_uid;
        // Some legacy pending events stored an empty owner rather than NULL.
        // Do not assign or discard those rows unless Stripe identifies the
        // requested customer and its owner is currently active here.
        if (event.user_id === "" && (customer.id !== event.customer_id || !uid || !this.hooks.account(uid)))
          throw new AppError("unavailable", "billing customer attribution is unavailable");
        if (event.user_id === "" && this.sql.exec(
          `SELECT user_id FROM billing_accounts WHERE (user_id=? AND customer_id<>?) OR (customer_id=? AND user_id<>?) LIMIT 1`,
          uid, event.customer_id, event.customer_id, uid,
        ).toArray().length)
          throw new AppError("unavailable", "billing customer attribution changed");
        // Once attributed, an event may never move to another user merely
        // because Stripe metadata changed while reconciliation was pending.
        if (event.user_id && event.user_id !== uid)
          throw new AppError("unavailable", "billing customer attribution changed");
        if (!uid || !this.hooks.account(uid)) {
          // The event may have been erased and replaced while Stripe was in
          // flight. Do not remove a different customer's newly received row.
          this.sql.exec(
            `DELETE FROM billing_events WHERE id=? AND incarnation=? AND customer_id=? AND user_id IS ? AND created_at=? AND state='pending' AND next_attempt_at=?`,
            event.id, event.incarnation, event.customer_id, event.user_id, event.created_at, event.next_attempt_at,
          );
          continue;
        }
        this.sql.exec(
          `UPDATE billing_events SET user_id = ? WHERE id = ? AND incarnation = ? AND customer_id = ? AND created_at = ? AND state = 'pending' AND next_attempt_at = ? AND (user_id IS NULL OR user_id = '' OR user_id = ?)`,
          uid,
          event.id,
          event.incarnation,
          event.customer_id,
          event.created_at,
          event.next_attempt_at,
          uid,
        );
        const attributed = this.sql.exec<{ user_id: string | null }>(
          `SELECT user_id FROM billing_events WHERE id = ? AND incarnation = ? AND customer_id = ? AND created_at = ? AND state = 'pending' AND next_attempt_at = ?`,
          event.id, event.incarnation, event.customer_id, event.created_at, event.next_attempt_at,
        ).toArray()[0];
        if (!attributed) continue; // An account erasure removed the event during I/O.
        if (attributed.user_id !== uid)
          throw new AppError("unavailable", "billing customer attribution changed");
        attributedUserId = uid;
        // Existing pre-migration rows have no token. Touch only such a row;
        // the trigger assigns a token synchronously before any dependent I/O.
        this.sql.exec(`UPDATE billing_accounts SET customer_id=customer_id WHERE user_id=? AND state_token IS NULL`, uid);
        const row = this.sql
          .exec<{
            customer_id: string;
            subscription_id: string | null;
            paid_period: string | null;
            entitlement: string | null;
            state_token: number | null;
          }>(
            `SELECT customer_id, subscription_id, paid_period, entitlement, state_token FROM billing_accounts WHERE user_id = ?`,
            uid,
          )
          .toArray()[0];
        const clock = this.sql.exec<{ value: number }>(`SELECT value FROM billing_state_clock WHERE id=1`).toArray()[0]?.value;
        if (!Number.isSafeInteger(clock) || clock! < 0 || (row && (!Number.isSafeInteger(row.state_token) || row.state_token! < 1)))
          throw new AppError("unavailable", "billing state identity requires review");
        if (row && row.customer_id !== event.customer_id)
          throw new AppError(
            "forbidden",
            "billing customer association is invalid",
          );
        const all = await stripe.subscriptions(event.customer_id);
        if (
          all.some(
            (subscription) =>
              (typeof subscription.customer === "string"
                ? subscription.customer
                : subscription.customer.id) !== event.customer_id ||
              subscription.metadata.account_uid !== uid,
          )
        )
          throw new AppError(
            "forbidden",
            "billing subscription association is invalid",
          );
        const open = all.filter(subscriptionIsOpen);
        if (open.length > 1)
          throw new AppError(
            "unavailable",
            "multiple subscriptions require billing review",
          );
        const subscription =
          open[0] ?? all.find((sub) => sub.id === row?.subscription_id) ?? null;
        let paid: (PaidPeriod & { invoiceId?: string }) | null = row?.paid_period
          ? JSON.parse(row.paid_period)
          : null;
        if (
          !subscription ||
          paid?.subscriptionId !== subscription.id ||
          paid.priceId !== subscription.items.data[0]!.price.id
        )
          paid = null;
        const now = Date.now();
        let nextAttempt: number | null = null;
        const future = new Map<string, number>();
        if (paid && paid.periodStart * 1000 > now) {
          if (paid.invoiceId && /^in_[A-Za-z0-9]+$/.test(paid.invoiceId)) {
            future.set(paid.invoiceId, paid.periodStart * 1000);
            paid = null;
          } else {
            // A legacy row without the invoice ID cannot be independently
            // re-fetched later. Keep it, and retry this event at its boundary.
            nextAttempt = paid.periodStart * 1000;
          }
        }
        const invoiceIds = new Set<string>();
        if (event.invoice_id) invoiceIds.add(event.invoice_id);
        const latestInvoice = subscription?.latest_invoice;
        if (latestInvoice)
          invoiceIds.add(
            typeof latestInvoice === "string"
              ? latestInvoice
              : latestInvoice.id,
          );
        for (const id of invoiceIds) {
          const settled = settledInvoice(await stripe.invoice(id));
          if (
            settled &&
            subscription &&
            settled.subscriptionId === subscription.id &&
            settled.priceId === subscription.items.data[0]!.price.id
          ) {
            const begins = settled.periodStart * 1000;
            if (begins > now) future.set(settled.invoiceId, begins);
            else if (!paid || settled.paidThrough > paid.paidThrough) paid = settled;
          }
        }
        if (subscription?.status !== "active" && subscription?.status !== "past_due") {
          nextAttempt = null;
          future.clear();
        }
        const entitlement = entitlementFor(subscription, cfg, paid, now);
        // Stripe's subscription snapshot may lag the newly paid invoice at
        // the boundary. Keep retrying while its paid coverage is live.
        if (subscription?.status === "active" && paid && paid.periodStart * 1000 <= now && paid.paidThrough > now && entitlement.planId === "free")
          nextAttempt = now + 60_000;
        // Account deletion may have interleaved with the Stripe reads.
        if (!this.hooks.account(uid)) {
          this.sql.exec(
            `DELETE FROM billing_events WHERE id=? AND incarnation=? AND customer_id=? AND user_id=? AND created_at=? AND state='pending' AND next_attempt_at=?`,
            event.id, event.incarnation, event.customer_id, uid, event.created_at, event.next_attempt_at,
          );
          continue;
        }
        this.hooks.transaction(() => {
          // Other alarm invocations can reconcile while Stripe requests are in flight.
          // Never overwrite a newer snapshot with a response fetched before it.
          const currentEvent = this.sql
            .exec<{ state: string; next_attempt_at: number }>(
              `SELECT state, next_attempt_at FROM billing_events WHERE id = ? AND incarnation = ? AND customer_id = ? AND user_id = ? AND created_at = ?`,
              event.id, event.incarnation, event.customer_id, uid, event.created_at,
            )
            .toArray()[0];
          if (!currentEvent || currentEvent.state !== "pending" || currentEvent.next_attempt_at !== event.next_attempt_at) return;
          const currentRow = this.sql
            .exec<{
              customer_id: string;
              subscription_id: string | null;
              paid_period: string | null;
              entitlement: string | null;
              state_token: number | null;
            }>(
              `SELECT customer_id, subscription_id, paid_period, entitlement, state_token FROM billing_accounts WHERE user_id = ?`,
              uid,
            )
            .toArray()[0];
          if (
            JSON.stringify(currentRow ?? null) !== JSON.stringify(row ?? null) ||
            (!row && this.sql.exec<{ value: number }>(`SELECT value FROM billing_state_clock WHERE id=1`).toArray()[0]?.value !== clock)
          ) {
            throw new AppError(
              "unavailable",
              "billing state changed during reconciliation",
            );
          }
          for (const [invoiceId, begins] of future) {
            // This internal inbox entry retains the invoice ID even if
            // Stripe's latest_invoice changes before the service period.
            const deferredId = `deferred:${invoiceId}`;
            if (deferredId === event.id) nextAttempt = begins;
            else this.sql.exec(
              `INSERT OR IGNORE INTO billing_events (id, customer_id, subscription_id, invoice_id, user_id, state, created_at, next_attempt_at, incarnation) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
              deferredId, event.customer_id, subscription!.id, invoiceId, uid, now, begins, crypto.randomUUID(),
            );
          }
          this.sql.exec(
            `INSERT INTO billing_accounts (user_id, customer_id, subscription_id, paid_period, entitlement, revision) VALUES (?, ?, ?, ?, ?, 1)
ON CONFLICT(user_id) DO UPDATE SET subscription_id = excluded.subscription_id, paid_period = excluded.paid_period, entitlement = excluded.entitlement,
revision = billing_accounts.revision + CASE WHEN billing_accounts.entitlement != excluded.entitlement THEN 1 ELSE 0 END`,
            uid,
            event.customer_id,
            subscription?.id ?? null,
            paid ? JSON.stringify(paid) : null,
            JSON.stringify(entitlement),
          );
          if (nextAttempt !== null)
            this.sql.exec(`UPDATE billing_events SET next_attempt_at = ? WHERE id = ?`, nextAttempt, event.id);
          else
            this.sql.exec(`UPDATE billing_events SET state = 'applied' WHERE id = ?`, event.id);
        });
      } catch {
        failed = true;
        // A malformed or temporarily unavailable customer must not occupy
        // the oldest batch forever and prevent other customers' events,
        // including cancellations, from being reconciled. Do not postpone a
        // concurrent reconciliation that already changed this event.
        this.sql.exec(
          `UPDATE billing_events SET next_attempt_at = ? WHERE id = ? AND incarnation IS ? AND customer_id = ? AND created_at = ? AND state = 'pending' AND next_attempt_at = ? AND (user_id IS ? OR user_id IS ?)`,
          Date.now() + RETRY_DELAY_MS,
          event.id,
          event.incarnation,
          event.customer_id,
          event.created_at,
          event.next_attempt_at,
          event.user_id,
          attributedUserId,
        );
      }
    }
    for (const row of this.sql
      .exec<{ user_id: string; revision: number; entitlement: string; retry_at: number | null; state_token: number | null }>(
        `SELECT a.user_id, a.revision, a.entitlement, a.state_token, r.next_attempt_at AS retry_at FROM billing_accounts a LEFT JOIN billing_delivery_retries r ON r.user_id = a.user_id AND r.revision = a.revision WHERE a.delivered_revision < a.revision AND COALESCE(r.next_attempt_at, 0) <= ? ORDER BY COALESCE(r.next_attempt_at, 0), a.user_id LIMIT 20`,
        Date.now(),
      )
      .toArray()) {
      if (row.state_token === null) {
        this.sql.exec(`UPDATE billing_accounts SET customer_id=customer_id WHERE user_id=? AND revision=? AND state_token IS NULL`, row.user_id, row.revision);
        row.state_token = this.sql.exec<{ state_token: number | null }>(`SELECT state_token FROM billing_accounts WHERE user_id=? AND revision=? AND entitlement=? AND delivered_revision<revision`, row.user_id, row.revision, row.entitlement).toArray()[0]?.state_token ?? null;
      }
      try {
        if (!Number.isSafeInteger(row.state_token) || row.state_token! < 1)
          throw new AppError("unavailable", "billing state identity requires review");
        // Earlier rows in the batch may have yielded. Do not dispatch a
        // snapshot that was replaced or already delivered while they ran.
        if (!this.sql.exec(
          `SELECT 1 FROM billing_accounts a LEFT JOIN billing_delivery_retries r ON r.user_id=a.user_id AND r.revision=a.revision
           WHERE a.user_id=? AND a.revision=? AND a.state_token=? AND a.entitlement=? AND a.delivered_revision<a.revision
             AND r.next_attempt_at IS ? AND COALESCE(r.next_attempt_at,0)<=?`,
          row.user_id, row.revision, row.state_token, row.entitlement, row.retry_at, Date.now(),
        ).toArray().length)
          continue;
        const account = this.hooks.account(row.user_id);
        if (account)
          await this.hooks.deliver(
            account.vaultId,
            row.revision,
            JSON.parse(row.entitlement),
          );
        // A replacement can publish a new Vault while the old RPC is in
        // flight. Its acknowledgement says nothing about the new Vault.
        if (!account || this.hooks.account(row.user_id)?.vaultId !== account.vaultId)
          continue;
        this.sql.exec(
          `UPDATE billing_accounts SET delivered_revision = ? WHERE user_id = ? AND revision = ? AND state_token = ?`,
          row.revision,
          row.user_id,
          row.revision,
          row.state_token,
        );
        // Do not erase a retry recorded for a newer revision while the RPC
        // was in flight.
        this.sql.exec(`DELETE FROM billing_delivery_retries WHERE user_id = ? AND revision <= ? AND EXISTS (SELECT 1 FROM billing_accounts WHERE user_id=? AND revision=? AND state_token=? AND delivered_revision=?)`, row.user_id, row.revision, row.user_id, row.revision, row.state_token, row.revision);
      } catch {
        failed = true;
        // Store backoff only if this exact entitlement is still undelivered.
        // A newer revision, successful concurrent delivery, or account
        // erasure must not be delayed or resurrected by a stale failure.
        this.sql.exec(
          `INSERT INTO billing_delivery_retries (user_id, revision, next_attempt_at)
           SELECT user_id, revision, ? FROM billing_accounts WHERE user_id = ? AND revision = ? AND state_token IS ? AND delivered_revision < revision
           ON CONFLICT(user_id) DO UPDATE SET revision = excluded.revision, next_attempt_at = excluded.next_attempt_at
           WHERE billing_delivery_retries.revision < excluded.revision OR (billing_delivery_retries.revision = excluded.revision AND billing_delivery_retries.next_attempt_at = ?)`,
          Date.now() + RETRY_DELAY_MS,
          row.user_id,
          row.revision,
          row.state_token,
          row.retry_at,
        );
      }
    }
    if (failed)
      throw new AppError(
        "unavailable",
        "billing reconciliation remains pending",
      );
  }

  erase(userId: string, customerId?: string | null): void {
    const row = this.sql
      .exec<{ customer_id: string }>(
        `SELECT customer_id FROM billing_accounts WHERE user_id = ?`,
        userId,
      )
      .toArray()[0];
    this.sql.exec(
      `DELETE FROM billing_events WHERE user_id = ? OR customer_id = ?`,
      userId,
      customerId ?? row?.customer_id ?? "",
    );
    this.sql.exec(`DELETE FROM billing_accounts WHERE user_id = ?`, userId);
    this.sql.exec(`DELETE FROM billing_delivery_retries WHERE user_id = ?`, userId);
  }
}
