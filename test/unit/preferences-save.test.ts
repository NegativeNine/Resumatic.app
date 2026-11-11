import { describe, expect, it } from "vitest";
import { MAX_PAY_AMOUNT, cleanPreferences, type PreferenceValues, type Preferences } from "../../src/shared/preferences";
import { availabilityOptions, isPreferencesSnapshot, preferencesWriteObserved, retiredChoices } from "../../src/web/preferences-save";

const submission: PreferenceValues = {
  place: "Toronto, Ontario",
  jobTypes: ["full_time", "contract"],
  availableFrom: "2027-03",
  payFloor: { amount: 140000, currency: "CAD", period: "year" },
};
const nothing: PreferenceValues = { place: null, jobTypes: [], availableFrom: null, payFloor: null };
/** A saved row holding these values. */
const at = <Values extends object = PreferenceValues>(revision: number, values: Values = submission as unknown as Values, updatedAt: number | null = 1_800_000_000_000) => ({ ...values, revision, updatedAt });
const unsaid = { ...nothing, revision: 0, updatedAt: null };

describe("job preferences save recovery", () => {
  it("accepts only the exact submitted values at the next revision, from 0 too", () => {
    expect(preferencesWriteObserved(at(4), 3, submission)).toBe(true);
    // A first save is made against revision 0, and lands as revision 1.
    expect(preferencesWriteObserved(at(1), 0, submission)).toBe(true);
    expect(preferencesWriteObserved(at(1, nothing), 0, nothing)).toBe(true);
    // The revision it was made against, one further on, or one that was never read.
    expect(preferencesWriteObserved(at(3), 3, submission)).toBe(false);
    expect(preferencesWriteObserved(at(5), 3, submission)).toBe(false);
    expect(preferencesWriteObserved(unsaid, 0, nothing)).toBe(false);
    expect(preferencesWriteObserved(at(4), undefined, submission)).toBe(false);
    for (const revision of [-1, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) expect(preferencesWriteObserved(at(revision + 1), revision, submission), String(revision)).toBe(false);

    // Any one value different, and it is someone else's save.
    for (const [why, changed] of Object.entries({
      "another place": { place: "Leeds" },
      "no place": { place: null },
      "one job type fewer": { jobTypes: ["full_time"] },
      "one job type more": { jobTypes: ["full_time", "contract", "internship"] },
      "the job types in another order": { jobTypes: ["contract", "full_time"] },
      "another month": { availableFrom: "2027-04" },
      "now": { availableFrom: "now" },
      "no availability": { availableFrom: null },
      "another amount": { payFloor: { ...submission.payFloor!, amount: 140001 } },
      "another currency": { payFloor: { ...submission.payFloor!, currency: "USD" } },
      "another period": { payFloor: { ...submission.payFloor!, period: "month" } },
      "no pay floor": { payFloor: null },
    }))
      expect(preferencesWriteObserved(at(4, { ...submission, ...changed }), 3, submission), why).toBe(false);
    // A pay floor that appeared where none was sent is not this save either.
    expect(preferencesWriteObserved(at(4, { ...nothing, payFloor: submission.payFloor }), 3, nothing)).toBe(false);
    expect(preferencesWriteObserved(at(4, nothing), 3, nothing)).toBe(true);

    // What isn't a saved row settles nothing.
    for (const reply of [undefined, null, "", {}, [], { ...submission }, at(4, { ...submission, jobTypes: "full_time" })]) expect(preferencesWriteObserved(reply, 3, submission), JSON.stringify(reply)).toBe(false);
    // What the rule stores is what a read gives back, so a landed save is always recognised.
    const typed = { place: "  Leeds ", jobTypes: ["internship", "part_time"], availableFrom: "now", payFloor: null };
    const stored = cleanPreferences(typed)!;
    expect(preferencesWriteObserved(at(8, stored), 7, stored)).toBe(true);
  });

  it("rejects an incomplete or misshapen snapshot before it replaces the draft", () => {
    expect(isPreferencesSnapshot(at(2))).toBe(true);
    expect(isPreferencesSnapshot(unsaid)).toBe(true);
    expect(isPreferencesSnapshot(at(1, nothing))).toBe(true);
    expect(isPreferencesSnapshot(at(Number.MAX_SAFE_INTEGER))).toBe(true);
    expect(isPreferencesSnapshot(at(2, { ...submission, payFloor: { ...submission.payFloor!, amount: MAX_PAY_AMOUNT } }))).toBe(true);
    expect(isPreferencesSnapshot(at(2, { ...submission, place: "x".repeat(120) }))).toBe(true);

    for (const reply of [undefined, null, "", 7, true, [], {}, "Toronto"]) expect(isPreferencesSnapshot(reply), JSON.stringify(reply)).toBe(false);
    // Each field has to be there.
    for (const field of ["revision", "place", "jobTypes", "availableFrom", "payFloor", "updatedAt"] as const) {
      const { [field]: _dropped, ...rest } = at(2);
      expect(isPreferencesSnapshot(rest), field).toBe(false);
    }
    for (const [why, wrong] of Object.entries({
      "a revision in words": { revision: "2" },
      "a negative revision": { revision: -1 },
      "a fractional revision": { revision: 1.5 },
      "a revision past the last safe integer": { revision: 2 ** 53 },
      "no time of saving on a saved row": { updatedAt: null },
      "a time of saving in words": { updatedAt: "2026-11-11" },
      "a fractional time of saving": { updatedAt: 1.5 },
      "a time of saving that is no number": { updatedAt: NaN },
      "an empty place, which is said as none": { place: "" },
      "an oversized place": { place: "x".repeat(121) },
      "a place that is not text": { place: 7 },
      "job types that are no list": { jobTypes: "full_time" },
      "a job type twice": { jobTypes: ["full_time", "full_time"] },
      "a job type that is no token": { jobTypes: ["Full time"] },
      "a job type that is markup": { jobTypes: ["<b>bold</b>"] },
      "a job type that is not text": { jobTypes: [1] },
      "an availability that is no month": { availableFrom: "soon" },
      "a day where a month goes": { availableFrom: "2027-03-01" },
      "an availability that is not text": { availableFrom: 202703 },
      "a pay floor that is no object": { payFloor: "140000 CAD" },
      "a pay floor without its amount": { payFloor: { currency: "CAD", period: "year" } },
      "a pay floor without its currency": { payFloor: { amount: 140000, period: "year" } },
      "a pay floor without its period": { payFloor: { amount: 140000, currency: "CAD" } },
      "an amount of nothing": { payFloor: { amount: 0, currency: "CAD", period: "year" } },
      "a fractional amount": { payFloor: { amount: 1.5, currency: "CAD", period: "year" } },
      "an amount over the cap": { payFloor: { amount: MAX_PAY_AMOUNT + 1, currency: "CAD", period: "year" } },
      "an amount in words": { payFloor: { amount: "140000", currency: "CAD", period: "year" } },
      "a currency that is no code": { payFloor: { amount: 140000, currency: "dollars", period: "year" } },
      "a currency in lower case": { payFloor: { amount: 140000, currency: "cad", period: "year" } },
      "a period that is no token": { payFloor: { amount: 140000, currency: "CAD", period: "Per year" } },
    }))
      expect(isPreferencesSnapshot({ ...at(2), ...wrong }), why).toBe(false);
    // Never saved is the one state without a time of saving, and it has none.
    expect(isPreferencesSnapshot({ ...unsaid, updatedAt: 1_800_000_000_000 })).toBe(false);
  });

  it("reads a saved choice that is no longer offered by its shape, and names it as retired", () => {
    // Saved when a seasonal job type, a fortnightly period and the kuna were all offered.
    const saved: Preferences = at(7, { place: "Zagreb", jobTypes: ["full_time", "seasonal", "per_diem"], availableFrom: "2021-06", payFloor: { amount: 9000, currency: "HRK", period: "biweekly" } });
    // It still loads: turning a withdrawn currency into a card that won't open would leave nothing to fix it with.
    expect(isPreferencesSnapshot(saved)).toBe(true);
    expect(retiredChoices(saved)).toEqual({ jobTypes: ["seasonal", "per_diem"], currency: "HRK", period: "biweekly" });
    // And a save does not take it: it has to be replaced first.
    const { revision: _revision, updatedAt: _updatedAt, ...values } = saved;
    expect(cleanPreferences(values)).toBeNull();

    expect(retiredChoices(at(2))).toEqual({ jobTypes: [], currency: null, period: null });
    expect(retiredChoices(unsaid)).toEqual({ jobTypes: [], currency: null, period: null });
    // Each of the three is told apart from the others.
    expect(retiredChoices(at(2, { ...submission, payFloor: { amount: 1, currency: "HRK", period: "year" } }))).toEqual({ jobTypes: [], currency: "HRK", period: null });
    expect(retiredChoices(at(2, { ...submission, payFloor: { amount: 1, currency: "CAD", period: "biweekly" } }))).toEqual({ jobTypes: [], currency: null, period: "biweekly" });
    expect(retiredChoices(at(2, { ...submission, jobTypes: ["seasonal"] }))).toEqual({ jobTypes: ["seasonal"], currency: null, period: null });
  });

  it("offers Now and the next 24 months, and keeps a saved month outside them", () => {
    const today = new Date(2026, 10, 11);
    const options = availabilityOptions(today, null);
    expect(options).toHaveLength(25);
    expect(options[0]).toEqual({ value: "now", label: "Now" });
    expect(options.slice(1, 4)).toEqual([
      { value: "2026-12", label: "Dec 2026" },
      { value: "2027-01", label: "Jan 2027" },
      { value: "2027-02", label: "Feb 2027" },
    ]);
    expect(options.at(-1)).toEqual({ value: "2028-11", label: "Nov 2028" });
    // This month is not offered as a month: it is what Now says.
    expect(options.map((option) => option.value)).not.toContain("2026-11");
    // Every month offered is one a save takes.
    for (const { value } of options) expect(cleanPreferences({ ...nothing, availableFrom: value }), value).not.toBeNull();
    // A saved value that is already offered changes nothing.
    for (const saved of ["now", "2026-12", "2028-11", null]) expect(availabilityOptions(today, saved), String(saved)).toEqual(options);

    // A saved month that has passed, or is further off than the list goes, stays where its date puts it.
    const passed = availabilityOptions(today, "2025-03");
    expect(passed).toHaveLength(26);
    expect(passed.slice(0, 3).map((option) => option.label)).toEqual(["Now", "Mar 2025", "Dec 2026"]);
    const current = availabilityOptions(today, "2026-11");
    expect(current.slice(0, 3).map((option) => option.label)).toEqual(["Now", "Nov 2026", "Dec 2026"]);
    const distant = availabilityOptions(today, "2031-07");
    expect(distant).toHaveLength(26);
    expect(distant.slice(-2).map((option) => option.label)).toEqual(["Nov 2028", "Jul 2031"]);
    // What was never a month is not made into a choice.
    for (const saved of ["soon", "2027-13", "2027-03-01", ""]) expect(availabilityOptions(today, saved), saved).toEqual(options);

    // The months follow the person's own calendar, over a year's end and from a month's last day.
    expect(availabilityOptions(new Date(2026, 11, 31, 23, 59), null).slice(1, 3).map((option) => option.value)).toEqual(["2027-01", "2027-02"]);
    expect(availabilityOptions(new Date(2027, 0, 31), null).slice(1, 3).map((option) => option.value)).toEqual(["2027-02", "2027-03"]);
    expect(availabilityOptions(new Date(2027, 0, 1), null).at(-1)).toEqual({ value: "2029-01", label: "Jan 2029" });
  });
});
