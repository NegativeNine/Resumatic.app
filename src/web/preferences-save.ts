import {
  CHOICE_SHAPE,
  CURRENCIES,
  CURRENCY_SHAPE,
  JOB_TYPES,
  MAX_PAY_AMOUNT,
  MAX_PLACE_CHARS,
  MONTH_PATTERN,
  PAY_PERIODS,
  type PreferenceValues,
  type Preferences,
} from "../shared/preferences";
import { formatMonth } from "./format";

// What the job preferences form works out without the page: whether a reply is a whole saved
// row, whether a save landed when its reply was lost, which months to offer, and which saved
// choices are no longer offered.

/** How many months ahead the form offers to be available from. */
const MONTHS_AHEAD = 24;

/**
 * A reply with every field a saved row has, each of the right shape. A choice is checked by its
 * shape and not against today's lists, so one saved while it was offered still loads.
 */
export function isPreferencesSnapshot(value: unknown): value is Preferences {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<Record<keyof Preferences, unknown>>;
  if (!Number.isSafeInteger(p.revision) || (p.revision as number) < 0) return false;
  // Never saved is the one state with no time of saving.
  if (p.revision === 0 ? p.updatedAt !== null : !Number.isSafeInteger(p.updatedAt) || (p.updatedAt as number) < 0) return false;
  if (p.place !== null && (typeof p.place !== "string" || p.place.length < 1 || p.place.length > MAX_PLACE_CHARS)) return false;
  if (!Array.isArray(p.jobTypes) || new Set(p.jobTypes).size !== p.jobTypes.length) return false;
  for (let index = 0; index < p.jobTypes.length; index++) if (!isChoice(p.jobTypes[index])) return false;
  if (p.availableFrom !== null && p.availableFrom !== "now" && !(typeof p.availableFrom === "string" && MONTH_PATTERN.test(p.availableFrom))) return false;
  if (p.payFloor === null) return true;
  if (!p.payFloor || typeof p.payFloor !== "object") return false;
  const pay = p.payFloor as Partial<Record<"amount" | "currency" | "period", unknown>>;
  return Number.isSafeInteger(pay.amount) && (pay.amount as number) >= 1 && (pay.amount as number) <= MAX_PAY_AMOUNT &&
    typeof pay.currency === "string" && CURRENCY_SHAPE.test(pay.currency) && isChoice(pay.period);
}

const isChoice = (value: unknown): value is string => typeof value === "string" && CHOICE_SHAPE.test(value);

/** A fresh read can settle a lost reply only at the next revision, from 0 too, with all four submitted values exactly. */
export function preferencesWriteObserved(current: unknown, previousRevision: number | undefined, submitted: PreferenceValues): current is Preferences {
  return Number.isSafeInteger(previousRevision) && previousRevision! >= 0 && previousRevision! < Number.MAX_SAFE_INTEGER &&
    isPreferencesSnapshot(current) && current.revision === previousRevision! + 1 &&
    current.place === submitted.place && current.availableFrom === submitted.availableFrom &&
    current.jobTypes.length === submitted.jobTypes.length && current.jobTypes.every((type, index) => type === submitted.jobTypes[index]) &&
    (current.payFloor === null
      ? submitted.payFloor === null
      : submitted.payFloor !== null && current.payFloor.amount === submitted.payFloor.amount &&
        current.payFloor.currency === submitted.payFloor.currency && current.payFloor.period === submitted.payFloor.period);
}

/**
 * What "Available from" offers after "Not said": now, then the months that follow today's. A saved
 * month outside those (one that has passed, say) stays listed in its place by date, so opening the
 * form never changes what was saved.
 */
export function availabilityOptions(today: Date, saved: string | null): { value: string; label: string }[] {
  const months: string[] = [];
  for (let ahead = 1; ahead <= MONTHS_AHEAD; ahead++) {
    // The person's own calendar month, as every date in the app is theirs.
    const month = new Date(today.getFullYear(), today.getMonth() + ahead, 1);
    months.push(`${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`);
  }
  // Only what a save would take is offered.
  const offered = months.filter((month) => MONTH_PATTERN.test(month));
  if (saved !== null && MONTH_PATTERN.test(saved) && !offered.includes(saved)) offered.push(saved);
  // "YYYY-MM" sorts by date as text.
  offered.sort();
  return [{ value: "now", label: "Now" }, ...offered.map((month) => ({ value: month, label: formatMonth(month) }))];
}

/** The saved choices that today's lists no longer hold. Each stays in the form until it is replaced. */
export function retiredChoices(saved: Preferences): { jobTypes: string[]; currency: string | null; period: string | null } {
  const pay = saved.payFloor;
  return {
    jobTypes: saved.jobTypes.filter((type) => !(JOB_TYPES as readonly string[]).includes(type)),
    currency: pay && !(CURRENCIES as readonly string[]).includes(pay.currency) ? pay.currency : null,
    period: pay && !(PAY_PERIODS as readonly string[]).includes(pay.period) ? pay.period : null,
  };
}
