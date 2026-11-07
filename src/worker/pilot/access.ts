import { AppError } from "../../shared/errors";
import { PILOT_LEDGER_NAME } from "./ledger";

/** Shared access point for Worker callers. The ledger's name is never caller-supplied. */
export function stagingPilotBudget(env: Env) {
  if (env.ALLOW_TEST_SIGNIN !== "true" || !env.PILOT_BUDGET)
    throw new AppError("unavailable", "the staging pilot ledger is unavailable");
  return env.PILOT_BUDGET.getByName(PILOT_LEDGER_NAME);
}
