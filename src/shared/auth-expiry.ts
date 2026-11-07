import { AppError } from "./errors";

/** Check the expiry authenticated by the short-lived OAuth state cookie. */
export function requireFreshAuth(expiry: unknown): asserts expiry is number {
  if (!Number.isSafeInteger(expiry) || (expiry as number) <= Date.now())
    throw new AppError("unauthenticated", "sign-in took too long; try again");
}
