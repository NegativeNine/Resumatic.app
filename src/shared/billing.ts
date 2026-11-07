import { z } from "zod";
import { AppError } from "./errors";

const limit = z.number().int().min(0).max(100_000);
const Plans = z
  .object({
    free: z.object({ generationLimit: limit }).strict(),
    paid: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(/^[a-z][a-z0-9_-]{0,39}$/)
              .refine((id) => id !== "free"),
            priceId: z.string().regex(/^price_[A-Za-z0-9]+$/),
            generationLimit: limit,
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export interface BillingEnvironment {
  BILLING_ENABLED?: string;
  BILLING_PLANS_JSON?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_API_VERSION?: string;
  APP_ORIGIN?: string;
}

export interface BillingConfig extends z.infer<typeof Plans> {
  secretKey: string;
  webhookSecret: string;
  apiVersion: string;
  origin: string;
}

/** Missing deployment configuration disables purchases; invalid enabled configuration fails closed. */
export function billingConfig(env: BillingEnvironment): BillingConfig | null {
  if (
    env.BILLING_ENABLED === undefined ||
    env.BILLING_ENABLED === "" ||
    env.BILLING_ENABLED === "false"
  )
    return null;
  if (env.BILLING_ENABLED !== "true")
    throw new AppError("unavailable", "billing configuration is invalid");
  try {
    const plans = Plans.parse(JSON.parse(env.BILLING_PLANS_JSON ?? ""));
    if (
      new Set(plans.paid.map((p) => p.id)).size !== plans.paid.length ||
      new Set(plans.paid.map((p) => p.priceId)).size !== plans.paid.length
    )
      throw new Error();
    if (
      !/^sk_(test|live)_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY ?? "") ||
      !/^whsec_[A-Za-z0-9]+$/.test(env.STRIPE_WEBHOOK_SECRET ?? "")
    )
      throw new Error();
    if (!/^\d{4}-\d{2}-\d{2}(?:\.[a-z]+)?$/.test(env.STRIPE_API_VERSION ?? ""))
      throw new Error();
    const origin = new URL(env.APP_ORIGIN ?? "");
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new Error();
    return {
      ...plans,
      secretKey: env.STRIPE_SECRET_KEY!,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET!,
      apiVersion: env.STRIPE_API_VERSION!,
      origin: origin.origin,
    };
  } catch {
    // Never include the source JSON or a secret in a deployment error.
    throw new AppError("unavailable", "billing configuration is invalid");
  }
}

export function freeQuotaBucket(nowMs = Date.now()): string {
  if (!Number.isFinite(nowMs))
    throw new AppError("invalid", "invalid quota time");
  return `free:${new Date(nowMs).toISOString().slice(0, 7)}`;
}

export function paidQuotaBucket(
  subscriptionId: string,
  periodStart: number,
): string {
  if (
    !/^sub_[A-Za-z0-9]+$/.test(subscriptionId) ||
    !Number.isSafeInteger(periodStart) ||
    periodStart <= 0
  )
    throw new AppError("invalid", "invalid billing period");
  return `paid:${subscriptionId}:${periodStart}`;
}
