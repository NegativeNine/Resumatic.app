import { describe, expect, it } from "vitest";
import {
  CHOICE_SHAPE,
  CURRENCIES,
  CURRENCY_SHAPE,
  JOB_TYPES,
  MAX_PAY_AMOUNT,
  MAX_PLACE_CHARS,
  MONTH_PATTERN,
  PAY_PERIODS,
  PREFERENCES_CHANGED,
  PREFERENCES_REFUSED,
  cleanPreferences,
  type PreferenceValues,
} from "../../src/shared/preferences";

// The one rule a save is held to, wherever it runs: the form, the route and the Vault.

const nothing: PreferenceValues = { place: null, jobTypes: [], availableFrom: null, payFloor: null };
const floor = { amount: 140000, currency: "CAD", period: "year" } as const;
/** The rule's answer for one field changed, the others left unsaid. */
const withField = (field: keyof PreferenceValues, value: unknown) => cleanPreferences({ ...nothing, [field]: value });

describe("what a save of job preferences takes", () => {
  it("takes each choice only from its set, with job types in one order and no repeats", () => {
    // Whatever order they were ticked in, they are kept in the list's own.
    expect(withField("jobTypes", ["internship", "full_time", "contract"])?.jobTypes).toEqual(["full_time", "contract", "internship"]);
    expect(withField("jobTypes", [...JOB_TYPES].reverse())?.jobTypes).toEqual([...JOB_TYPES]);
    expect(withField("jobTypes", [])?.jobTypes).toEqual([]);
    for (const type of JOB_TYPES) expect(withField("jobTypes", [type])?.jobTypes, type).toEqual([type]);
    for (const refused of [
      ["full_time", "full_time"],
      ["permanent"],
      ["Full time"],
      ["FULL_TIME"],
      ["full_time "],
      ["full_time", "seasonal"],
      [...JOB_TYPES, "full_time"],
      [null],
      [1],
      [["full_time"]],
      // A gap is a missing value, not nothing.
      Object.assign(new Array(2), { 1: "full_time" }),
      "full_time",
      { 0: "full_time", length: 1 },
      null,
      undefined,
    ])
      expect(withField("jobTypes", refused), JSON.stringify(refused)).toBeNull();

    for (const period of PAY_PERIODS) expect(withField("payFloor", { ...floor, period })?.payFloor, period).toEqual({ ...floor, period });
    for (const period of ["fortnight", "Year", "annual", "", null, 1, ["year"]])
      expect(withField("payFloor", { ...floor, period }), String(period)).toBeNull();
    for (const currency of ["CAD", "USD", "EUR", "JPY", "XOF", "ZWG"])
      expect(withField("payFloor", { ...floor, currency })?.payFloor, currency).toEqual({ ...floor, currency });
    // A withdrawn code, a metal, a made-up code and a name are all refused.
    for (const currency of ["HRK", "XAU", "ZZZ", "cad", "Cad", "CA", "CADX", "$", "Canadian dollars", "", null, 124, ["CAD"]])
      expect(withField("payFloor", { ...floor, currency }), String(currency)).toBeNull();
  });

  it("keeps place to one capped line, and reads white space as not said", () => {
    expect(withField("place", "Toronto, Ontario")?.place).toBe("Toronto, Ontario");
    expect(withField("place", "  Montréal\u00a0")?.place).toBe("Montréal");
    expect(withField("place", "São Paulo — or anywhere in 東京")?.place).toBe("São Paulo — or anywhere in 東京");
    // A line break around the words is white space like any other. One inside them is a second line.
    expect(withField("place", "\n Leeds \t\r\n")?.place).toBe("Leeds");
    for (const unsaid of ["", " ", "\t", " \n\r\n ", "\u00a0\u2003"]) expect(withField("place", unsaid), JSON.stringify(unsaid)).toEqual(nothing);
    expect(withField("place", null)).toEqual(nothing);
    for (const refused of ["Leeds\nYork", "Leeds\r\nYork", "Leeds\tYork", "Leeds\u0000", "Le\u001feds", "Leeds\u007fYork", "\u0001Leeds"])
      expect(withField("place", refused), JSON.stringify(refused)).toBeNull();

    // The cap is counted after trimming, and nothing longer is cut to fit.
    const longest = "x".repeat(MAX_PLACE_CHARS);
    expect(MAX_PLACE_CHARS).toBe(120);
    expect(withField("place", longest)?.place).toBe(longest);
    expect(withField("place", `  ${longest}  `)?.place).toBe(longest);
    expect(withField("place", `${longest}x`)).toBeNull();
    // Counted as the form's maxlength counts: a character outside the basic plane is two.
    expect(withField("place", "😀".repeat(60))?.place).toBe("😀".repeat(60));
    expect(withField("place", `${"😀".repeat(60)}x`)).toBeNull();
    // Half of such a character would be replaced when stored, so the place saved would not be the one sent.
    for (const broken of ["Leeds \ud83d", "\ude00 Leeds", "Le\ud83deds", "Leeds \ud83d😀"])
      expect(withField("place", broken), JSON.stringify(broken)).toBeNull();

    for (const refused of [7, true, ["Leeds"], { city: "Leeds" }, undefined]) expect(withField("place", refused), String(refused)).toBeNull();
  });

  it("takes availability as now or a month, and nothing else", () => {
    expect(withField("availableFrom", "now")?.availableFrom).toBe("now");
    // A month that has passed is taken: it means available, and refusing it would hold up every later save.
    for (const month of ["2000-01", "2024-02", "2026-12", "2027-03", "2099-12"]) {
      expect(MONTH_PATTERN.test(month), month).toBe(true);
      expect(withField("availableFrom", month)?.availableFrom, month).toBe(month);
    }
    expect(withField("availableFrom", null)?.availableFrom).toBeNull();
    for (const refused of [
      "Now", "NOW", "now ", "soon", "asap", "",
      "2027", "2027-3", "2027-00", "2027-13", "2027-03-01", "2027/03", "03-2027", "27-03", "1999-12", "2100-01", " 2027-03", "2027-03\n",
      "March 2027", 202703, 0, true, ["2027-03"], { month: "2027-03" }, undefined,
    ])
      expect(withField("availableFrom", refused), JSON.stringify(refused)).toBeNull();
  });

  it("takes a pay floor whole or not at all, in whole units up to the cap", () => {
    expect(withField("payFloor", floor)?.payFloor).toEqual(floor);
    expect(withField("payFloor", null)?.payFloor).toBeNull();
    expect(MAX_PAY_AMOUNT).toBe(999_999_999_999);
    for (const amount of [1, 25, 140000, MAX_PAY_AMOUNT]) expect(withField("payFloor", { ...floor, amount })?.payFloor, String(amount)).toEqual({ ...floor, amount });
    // Nothing is read out of a number written some other way: no cents, no words, no separators.
    for (const amount of [0, -1, -140000, 0.5, 1.5, 140000.5, MAX_PAY_AMOUNT + 1, Number.MAX_SAFE_INTEGER, 1e21, Infinity, -Infinity, NaN, "140000", "140,000", "140k", "", null, true, [140000], { value: 140000 }])
      expect(withField("payFloor", { ...floor, amount }), String(amount)).toBeNull();

    // Any one part missing, or any part besides the three, and it is no pay floor.
    for (const part of ["amount", "currency", "period"] as const) {
      const { [part]: _dropped, ...rest } = floor;
      expect(withField("payFloor", rest), part).toBeNull();
      expect(withField("payFloor", { ...floor, [part]: null }), part).toBeNull();
      expect(withField("payFloor", { ...floor, [part]: undefined }), part).toBeNull();
    }
    for (const refused of [{}, { ...floor, cents: 50 }, { ...floor, max: 200000 }, [140000, "CAD", "year"], "140000 CAD a year", 140000, true, undefined])
      expect(withField("payFloor", refused), JSON.stringify(refused)).toBeNull();
  });

  it("needs exactly its four fields, and refuses any other, work authorisation and remote work included", () => {
    expect(cleanPreferences(nothing)).toEqual(nothing);
    for (const field of ["place", "jobTypes", "availableFrom", "payFloor"] as const) {
      const { [field]: _dropped, ...rest } = nothing;
      expect(cleanPreferences(rest), field).toBeNull();
      // A field that is there but undefined isn't a value either.
      expect(cleanPreferences({ ...nothing, [field]: undefined }), field).toBeNull();
    }
    for (const extra of [
      { workAuthorisation: "citizen" },
      { workAuthorization: true },
      { remote: "remote" },
      { remoteWork: ["hybrid"] },
      { location: "Toronto" },
      { expectedRevision: 3 },
      { revision: 3 },
      { updatedAt: 1 },
      { userId: "someone-else" },
      { vaultId: "a".repeat(64) },
      { "": null },
      { [Symbol("hidden")]: null },
    ])
      expect(cleanPreferences({ ...nothing, ...extra }), Reflect.ownKeys(extra).map(String).join()).toBeNull();
    // A field that doesn't list itself is still a field.
    const hidden = Object.defineProperty({ ...nothing }, "workAuthorisation", { value: "citizen", enumerable: false });
    expect(cleanPreferences(hidden)).toBeNull();
    // The four are its own, not something it inherits.
    expect(cleanPreferences(Object.create(nothing))).toBeNull();
    expect(cleanPreferences(Object.assign(Object.create({ payFloor: null }), { place: null, jobTypes: [], availableFrom: null }))).toBeNull();

    for (const refused of [null, undefined, "", "{}", 0, true, [], [null, [], null, null], Object.values(nothing), new Map(Object.entries(nothing)), JSON.stringify(nothing)])
      expect(cleanPreferences(refused), JSON.stringify(refused)).toBeNull();
    // One bad field refuses the whole save, and the fields that were fine are not kept.
    expect(cleanPreferences({ place: "Toronto", jobTypes: ["full_time"], availableFrom: "now", payFloor: { ...floor, currency: "HRK" } })).toBeNull();
  });

  it("gives its own answer back unchanged", () => {
    const typed = { payFloor: { period: "hour", currency: "GBP", amount: 25 }, availableFrom: "2027-03", jobTypes: ["temporary", "part_time"], place: "  Leeds  " };
    const first = cleanPreferences(typed);
    expect(first).toEqual({ place: "Leeds", jobTypes: ["part_time", "temporary"], availableFrom: "2027-03", payFloor: { amount: 25, currency: "GBP", period: "hour" } });
    // As stored: its fields in one order, so two saves of the same choices read the same.
    expect(JSON.stringify(first)).toBe('{"place":"Leeds","jobTypes":["part_time","temporary"],"availableFrom":"2027-03","payFloor":{"amount":25,"currency":"GBP","period":"hour"}}');
    expect(cleanPreferences(first)).toEqual(first);
    expect(JSON.stringify(cleanPreferences(first))).toBe(JSON.stringify(first));
    expect(cleanPreferences(JSON.parse(JSON.stringify(first)))).toEqual(first);
    expect(cleanPreferences(cleanPreferences(nothing))).toEqual(nothing);
    // It answers with values of its own, and leaves what it was given as it was.
    expect(first).not.toBe(typed);
    expect(typed.place).toBe("  Leeds  ");
    expect(typed.jobTypes).toEqual(["temporary", "part_time"]);
  });

  it("lists each currency once, in order, without funds, metals or withdrawn codes", () => {
    expect(CURRENCIES).toHaveLength(154);
    expect(new Set(CURRENCIES).size).toBe(CURRENCIES.length);
    expect([...CURRENCIES].sort()).toEqual([...CURRENCIES]);
    expect(CURRENCIES[0]).toBe("AED");
    expect(CURRENCIES.at(-1)).toBe("ZWG");
    for (const code of CURRENCIES) expect(CURRENCY_SHAPE.test(code), code).toBe(true);
    const offered = new Set<string>(CURRENCIES);
    // Written out here, and not asked of the runtime: its list changes from one version to the next.
    const withdrawn = ["ANG", "BGN", "CUC", "HRK", "SLL", "ZWL", "VEF", "MRO", "STD", "BYR", "ZMK", "LTL", "LVL", "EEK", "DEM", "FRF"];
    const metals = ["XAU", "XAG", "XPT", "XPD"];
    const funds = ["XDR", "XSU", "XUA", "XBA", "XBB", "XBC", "XBD", "XTS", "XXX", "USN", "CHE", "CHW", "COU", "MXV", "UYI", "UYW", "BOV", "CLF"];
    for (const code of [...withdrawn, ...metals, ...funds]) expect(offered.has(code), code).toBe(false);
    // The only X codes are money people are paid in: the two CFA francs, the Eastern Caribbean dollar, the Caribbean guilder and the CFP franc.
    expect(CURRENCIES.filter((code) => code.startsWith("X"))).toEqual(["XAF", "XCD", "XCG", "XOF", "XPF"]);
    for (const code of ["USD", "EUR", "GBP", "CAD", "JPY", "INR", "CNY", "BRL", "NGN", "ZAR", "SLE", "VES"]) expect(offered.has(code), code).toBe(true);
  });

  it("keeps a stored choice's shape apart from whether it is offered, and words its two sentences for the person", () => {
    for (const type of JOB_TYPES) expect(CHOICE_SHAPE.test(type), type).toBe(true);
    for (const period of PAY_PERIODS) expect(CHOICE_SHAPE.test(period), period).toBe(true);
    for (const shaped of ["seasonal", "per_diem", "a", `a${"_".repeat(31)}`]) expect(CHOICE_SHAPE.test(shaped), shaped).toBe(true);
    for (const misshapen of ["", "Seasonal", "_seasonal", "per diem", "per-diem", "9to5", `a${"b".repeat(32)}`, "<b>", "full_time\n"]) expect(CHOICE_SHAPE.test(misshapen), misshapen).toBe(false);
    for (const misshapen of ["hrk", "HR", "HRKX", "H1K", " HRK", "HRK\n"]) expect(CURRENCY_SHAPE.test(misshapen), misshapen).toBe(false);
    // Fixed sentences, with a straight apostrophe as every sentence the server sends has.
    expect(PREFERENCES_REFUSED).toBe("These preferences couldn't be saved as written. Check each field, then save again.");
    expect(PREFERENCES_CHANGED).toBe("Your preferences were changed somewhere else. Load the saved preferences, check them, then save again.");
  });
});
