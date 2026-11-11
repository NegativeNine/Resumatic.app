// Job preferences: where a person would work, the kinds of job they want, when they could start
// and the lowest pay they would consider. Their owner's form saves them and their owner's export
// holds them. Nothing else reads them: no resume, copy, connected app or model.
//
// The types and the one rule live here, apart from the profile, on purpose. A profile is copied
// whole into every resume version, document version and render, so a field added to it travels
// with them. A type that no renderer imports can't reach one through a spread.
//
// Every choice comes from a fixed list, and a list can lose a member later (a currency is
// withdrawn). So a read gives the row as it was stored, and only a save is held to today's lists.

/** The kinds of job, after schema.org's employmentType, the vocabulary job postings use. A save keeps them in this order. */
export const JOB_TYPES = ["full_time", "part_time", "contract", "temporary", "internship"] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** What a pay floor is counted over, after schema.org's unitText. */
export const PAY_PERIODS = ["year", "month", "week", "day", "hour"] as const;
export type PayPeriod = (typeof PAY_PERIODS)[number];

/**
 * The ISO 4217 codes of money people are paid in, in order. A literal on purpose: a runtime's own
 * list differs from one version to the next and keeps codes that have been withdrawn. Funds,
 * metals, units of account and withdrawn codes are left out. It changes when ISO 4217 does.
 */
export const CURRENCIES = [
  "AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BHD", "BIF",
  "BMD", "BND", "BOB", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY",
  "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD",
  "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR",
  "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW",
  "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK",
  "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR",
  "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF",
  "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP",
  "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "UYU",
  "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XCG", "XOF", "XPF", "YER", "ZAR", "ZMW", "ZWG",
] as const;
export type Currency = (typeof CURRENCIES)[number];

/** A place is one line of the person's own text. */
export const MAX_PLACE_CHARS = 120;
/** A pay floor is a whole number of the currency's main unit, up to this. */
export const MAX_PAY_AMOUNT = 999_999_999_999;
/** A month someone is available from, as "2027-03". */
export const MONTH_PATTERN = /^20\d{2}-(0[1-9]|1[0-2])$/;
/** What a stored job type or pay period looks like, whether or not it is still offered. */
export const CHOICE_SHAPE = /^[a-z][a-z_]{0,31}$/;
/** What a stored currency looks like, whether or not it is still offered. */
export const CURRENCY_SHAPE = /^[A-Z]{3}$/;

export interface PayFloor {
  amount: number;
  currency: Currency;
  period: PayPeriod;
}

/** What a save takes: every choice is one offered today. */
export interface PreferenceValues {
  /** Null when not said. */
  place: string | null;
  /** Empty when not said. */
  jobTypes: JobType[];
  /** "now", a month as "YYYY-MM", or null when not said. */
  availableFrom: string | null;
  /** All three parts or none. */
  payFloor: PayFloor | null;
}

/** What a read gives: the row as stored, so a choice may have left its list since. */
export interface Preferences {
  /** 0 until the first save. */
  revision: number;
  place: string | null;
  jobTypes: string[];
  availableFrom: string | null;
  payFloor: { amount: number; currency: string; period: string } | null;
  /** Milliseconds since the epoch; null until the first save. */
  updatedAt: number | null;
}

/** A save replaces all four values, and names the revision they were read at. */
export type PreferencesUpdate = PreferenceValues & { expectedRevision: number };

// Both sentences are shown to the person as they stand, so both are written for them. The
// apostrophe is straight, as in every sentence the server sends, and the web app curls it.
/** Said when the values aren't ones a save takes. */
export const PREFERENCES_REFUSED = "These preferences couldn't be saved as written. Check each field, then save again.";
/** Said when the saved preferences are no longer at the revision a save was made against. */
export const PREFERENCES_CHANGED = "Your preferences were changed somewhere else. Load the saved preferences, check them, then save again.";

const FIELDS = ["place", "jobTypes", "availableFrom", "payFloor"] as const;
const PAY_FIELDS = ["amount", "currency", "period"] as const;
/** Anything that would make a place more than one line of text. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
/** Half of a character pair without its other half. Storage would replace it, and the saved place would not be the one sent. */
const UNPAIRED_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** An object with exactly these keys of its own: none missing, none besides. */
function hasExactly<Key extends string>(value: unknown, keys: readonly Key[]): value is Record<Key, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const isJobType = (value: unknown): value is JobType => (JOB_TYPES as readonly unknown[]).includes(value);
const isCurrency = (value: unknown): value is Currency => (CURRENCIES as readonly unknown[]).includes(value);
const isPayPeriod = (value: unknown): value is PayPeriod => (PAY_PERIODS as readonly unknown[]).includes(value);

/** The place as stored, null when nothing is said, or undefined when it can't be taken. */
function cleanPlace(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const place = value.trim();
  if (place.length > MAX_PLACE_CHARS || CONTROL_CHARACTER.test(place) || UNPAIRED_SURROGATE.test(place)) return undefined;
  return place || null;
}

/** The job types in the list's own order, or null when one is unknown or repeated. */
function cleanJobTypes(value: unknown): JobType[] | null {
  if (!Array.isArray(value) || value.length > JOB_TYPES.length) return null;
  const chosen = new Set<JobType>();
  // By index, so a gap in the array is read as the missing value it is.
  for (let index = 0; index < value.length; index++) {
    const type: unknown = value[index];
    if (!isJobType(type) || chosen.has(type)) return null;
    chosen.add(type);
  }
  return JOB_TYPES.filter((type) => chosen.has(type));
}

/** When someone is available: now, a month, null when nothing is said, or undefined when it can't be taken. */
function cleanAvailability(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && (value === "now" || MONTH_PATTERN.test(value)) ? value : undefined;
}

/** The pay floor, null when nothing is said, or undefined when it can't be taken. */
function cleanPayFloor(value: unknown): PayFloor | null | undefined {
  if (value === null) return null;
  if (!hasExactly(value, PAY_FIELDS)) return undefined;
  const { amount, currency, period } = value;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 1 || amount > MAX_PAY_AMOUNT) return undefined;
  if (!isCurrency(currency) || !isPayPeriod(period)) return undefined;
  return { amount, currency, period };
}

/**
 * The values as stored, or null when they can't be saved. This is the one rule, run by the form,
 * the route and the Vault. It needs exactly the four fields: a missing or unknown field, a repeat
 * or a value of another type is refused, and nothing is cut short or guessed. Its own answer
 * passes unchanged.
 */
export function cleanPreferences(input: unknown): PreferenceValues | null {
  if (!hasExactly(input, FIELDS)) return null;
  const place = cleanPlace(input.place);
  const jobTypes = cleanJobTypes(input.jobTypes);
  const availableFrom = cleanAvailability(input.availableFrom);
  const payFloor = cleanPayFloor(input.payFloor);
  if (place === undefined || jobTypes === null || availableFrom === undefined || payFloor === undefined) return null;
  return { place, jobTypes, availableFrom, payFloor };
}
