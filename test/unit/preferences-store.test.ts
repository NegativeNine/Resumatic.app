import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { PREFERENCES_CHANGED, PREFERENCES_REFUSED, type PreferenceValues } from "../../src/shared/preferences";
import { PREFERENCES_MIGRATIONS, PreferencesStore } from "../../src/vault/preferences";

const now = 1_800_000_000_000;
const nothing: PreferenceValues = { place: null, jobTypes: [], availableFrom: null, payFloor: null };
const chosen: PreferenceValues = {
  place: "Toronto, Ontario",
  jobTypes: ["full_time", "contract"],
  availableFrom: "2027-03",
  payFloor: { amount: 140000, currency: "CAD", period: "year" },
};
const unsaid = { revision: 0, ...nothing, updatedAt: null };

function store() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(statement: string, ...bindings: (string | number | null)[]) {
      const values = db.prepare(statement).all(...bindings);
      return {
        toArray: () => values,
        one: () => {
          if (values.length !== 1) throw new Error("expected exactly one row");
          return values[0];
        },
      };
    },
  } as unknown as SqlStorage;
  for (const migration of PREFERENCES_MIGRATIONS) sql.exec(migration);
  /** Every row as the table holds it, so a refusal can be shown to have written nothing. */
  const rows = () => db.prepare(`SELECT * FROM preferences ORDER BY id`).all() as Record<string, string | number | null>[];
  return { preferences: new PreferencesStore(sql), db, rows };
}

/** What a call threw, as its message: the code and the sentence an AppError carries. */
function refusal(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return (error as Error).message;
  }
  return "nothing";
}

const CHANGED = `conflict: ${PREFERENCES_CHANGED}`;
const REFUSED = `invalid: ${PREFERENCES_REFUSED}`;

describe("job preferences in a vault", () => {
  it("says nothing at revision 0, then counts up from the first save", () => {
    const { preferences, db, rows } = store();
    try {
      // No row is made until the owner first saves.
      expect(preferences.read()).toEqual(unsaid);
      expect(rows()).toEqual([]);

      const first = preferences.save(chosen, 0, now);
      expect(first).toEqual({ revision: 1, ...chosen, updatedAt: now });
      expect(preferences.read()).toEqual(first);
      expect(rows()).toEqual([
        { id: 1, revision: 1, place: "Toronto, Ontario", job_types: '["full_time","contract"]', available_from: "2027-03", pay_amount: 140000, pay_currency: "CAD", pay_period: "year", updated_at: now },
      ]);

      // A save replaces all four values, and what it was given is stored as the rule cleans it.
      const second = preferences.save({ place: "  Leeds ", jobTypes: ["internship", "part_time"], availableFrom: "now", payFloor: null }, 1, now + 5);
      expect(second).toEqual({ revision: 2, place: "Leeds", jobTypes: ["part_time", "internship"], availableFrom: "now", payFloor: null, updatedAt: now + 5 });
      // The same values again are still a save: the next revision, and the time of it.
      const third = preferences.save({ place: "Leeds", jobTypes: ["part_time", "internship"], availableFrom: "now", payFloor: null }, 2, now + 9);
      expect(third).toEqual({ ...second, revision: 3, updatedAt: now + 9 });
      expect(preferences.read()).toEqual(third);
      expect(rows()).toHaveLength(1);
    } finally { db.close(); }
  });

  it("refuses a stale, future or malformed revision, and values outside the rules, without writing", () => {
    const { preferences, db, rows } = store();
    try {
      // Before the first save only revision 0 is current.
      for (const revision of [1, 2, -1]) expect(refusal(() => preferences.save(chosen, revision, now)), String(revision)).toBe(CHANGED);
      expect(rows()).toEqual([]);

      preferences.save(chosen, 0, now);
      preferences.save(chosen, 1, now + 1);
      const held = rows();
      expect(held).toMatchObject([{ revision: 2, updated_at: now + 1 }]);
      const other = { ...chosen, place: "Leeds" };
      // Stale, then ahead of what is stored.
      for (const revision of [0, 1, 3, 4]) expect(refusal(() => preferences.save(other, revision, now + 2)), String(revision)).toBe(CHANGED);
      // Not a revision at all. Each is said as the same conflict, and none reaches the table.
      for (const revision of [-1, 1.5, 2.000001, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 2 ** 60, "2", null, undefined, [2], { revision: 2 }, true])
        expect(refusal(() => preferences.save(other, revision as number, now + 2)), String(revision)).toBe(CHANGED);
      expect(rows()).toEqual(held);

      // Values a save doesn't take, at the current revision.
      for (const bad of [
        { ...chosen, place: "Leeds\nYork" },
        { ...chosen, place: "x".repeat(121) },
        { ...chosen, jobTypes: ["full_time", "full_time"] },
        { ...chosen, jobTypes: ["seasonal"] },
        { ...chosen, availableFrom: "soon" },
        { ...chosen, payFloor: { amount: 140000, currency: "CAD" } },
        { ...chosen, payFloor: { amount: 1.5, currency: "CAD", period: "year" } },
        { ...chosen, payFloor: { amount: 140000, currency: "HRK", period: "year" } },
        { ...chosen, workAuthorisation: "citizen" },
        { ...chosen, remote: "hybrid" },
        { place: "Leeds" },
        null,
        undefined,
        "Leeds",
        [],
      ])
        expect(refusal(() => preferences.save(bad, 2, now + 2)), JSON.stringify(bad)).toBe(REFUSED);
      expect(rows()).toEqual(held);

      // What is asked first is answered first: a revision that is no revision, then the values, then whether the revision is current.
      expect(refusal(() => preferences.save({ ...chosen, place: "Leeds\nYork" }, -1, now + 2))).toBe(CHANGED);
      expect(refusal(() => preferences.save({ ...chosen, place: "Leeds\nYork" }, 1, now + 2))).toBe(REFUSED);
      expect(rows()).toEqual(held);

      // The last revision there can be is reached, and nothing is saved after it.
      db.prepare(`UPDATE preferences SET revision = ?`).run(Number.MAX_SAFE_INTEGER - 1);
      expect(preferences.save(other, Number.MAX_SAFE_INTEGER - 1, now + 3).revision).toBe(Number.MAX_SAFE_INTEGER);
      const last = rows();
      expect(refusal(() => preferences.save(chosen, Number.MAX_SAFE_INTEGER, now + 4))).toBe(CHANGED);
      expect(rows()).toEqual(last);
    } finally { db.close(); }
  });

  it("keeps one row, and clearing every field leaves nothing said", () => {
    const { preferences, db, rows } = store();
    try {
      preferences.save(chosen, 0, now);
      preferences.save({ ...chosen, place: "Leeds" }, 1, now + 1);
      const cleared = preferences.save({ place: "   ", jobTypes: [], availableFrom: null, payFloor: null }, 2, now + 2);
      // Nothing is said, and it is still a save: the row stays, at the next revision.
      expect(cleared).toEqual({ revision: 3, ...nothing, updatedAt: now + 2 });
      expect(rows()).toEqual([
        { id: 1, revision: 3, place: null, job_types: "[]", available_from: null, pay_amount: null, pay_currency: null, pay_period: null, updated_at: now + 2 },
      ]);
      // And what was cleared can be said again.
      expect(preferences.save(chosen, 3, now + 3)).toEqual({ revision: 4, ...chosen, updatedAt: now + 3 });
      expect(rows()).toHaveLength(1);
    } finally { db.close(); }
  });

  it("returns a stored choice that has since left its set, and refuses to save it again", () => {
    const { preferences, db, rows } = store();
    try {
      // A row from when a seasonal job type, a fortnightly period and the kuna were all offered.
      db.prepare(
        `INSERT INTO preferences (id, revision, place, job_types, available_from, pay_amount, pay_currency, pay_period, updated_at) VALUES (1, 7, 'Zagreb', '["full_time","seasonal"]', '2021-06', 9000, 'HRK', 'biweekly', ?)`,
      ).run(now);
      const stored = preferences.read();
      // Read as stored: nothing is dropped, replaced or refused for no longer being offered.
      expect(stored).toEqual({
        revision: 7, place: "Zagreb", jobTypes: ["full_time", "seasonal"], availableFrom: "2021-06",
        payFloor: { amount: 9000, currency: "HRK", period: "biweekly" }, updatedAt: now,
      });
      const held = rows();
      const { revision: _revision, updatedAt: _updatedAt, ...values } = stored;
      expect(refusal(() => preferences.save(values, 7, now + 1))).toBe(REFUSED);
      // Each retired choice is enough to refuse the save by itself.
      expect(refusal(() => preferences.save({ ...values, jobTypes: ["full_time"], payFloor: { amount: 9000, currency: "EUR", period: "biweekly" } }, 7, now + 1))).toBe(REFUSED);
      expect(refusal(() => preferences.save({ ...values, jobTypes: ["full_time"], payFloor: { amount: 9000, currency: "HRK", period: "month" } }, 7, now + 1))).toBe(REFUSED);
      expect(refusal(() => preferences.save({ ...values, payFloor: { amount: 9000, currency: "EUR", period: "month" } }, 7, now + 1))).toBe(REFUSED);
      expect(rows()).toEqual(held);
      // Replaced with choices offered today, it saves.
      const replaced = preferences.save({ ...values, jobTypes: ["full_time"], payFloor: { amount: 1200, currency: "EUR", period: "month" } }, 7, now + 2);
      expect(replaced).toEqual({
        revision: 8, place: "Zagreb", jobTypes: ["full_time"], availableFrom: "2021-06",
        payFloor: { amount: 1200, currency: "EUR", period: "month" }, updatedAt: now + 2,
      });
    } finally { db.close(); }
  });

  it("the table itself refuses a second row, half a pay floor, a fractional amount and an oversized place", () => {
    const { db, rows } = store();
    try {
      const insert = (columns: Record<string, string | number | null>) => {
        const names = Object.keys(columns);
        db.prepare(`INSERT INTO preferences (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...Object.values(columns));
      };
      const row = { id: 1, revision: 1, updated_at: now };
      const pay = { pay_amount: 140000, pay_currency: "CAD", pay_period: "year" };
      for (const [why, columns] of Object.entries({
        "a second row": { ...row, id: 2 },
        "a row numbered nothing": { ...row, id: 0 },
        "revision 0, which is no row at all": { ...row, revision: 0 },
        "a fractional revision": { ...row, revision: 1.5 },
        "a revision past the last safe integer": { ...row, revision: "9007199254740992" },
        "no time of saving": { id: 1, revision: 1 },
        "an amount alone": { ...row, pay_amount: 140000 },
        "a currency alone": { ...row, pay_currency: "CAD" },
        "a period alone": { ...row, pay_period: "year" },
        "a pay floor without its amount": { ...row, ...pay, pay_amount: null },
        "a pay floor without its currency": { ...row, ...pay, pay_currency: null },
        "a pay floor without its period": { ...row, ...pay, pay_period: null },
        "a fractional amount": { ...row, ...pay, pay_amount: 140000.5 },
        "an amount of nothing": { ...row, ...pay, pay_amount: 0 },
        "a negative amount": { ...row, ...pay, pay_amount: -1 },
        "an amount over the cap": { ...row, ...pay, pay_amount: 1_000_000_000_000 },
        "an amount in words": { ...row, ...pay, pay_amount: "a lot" },
        "a currency that is no code": { ...row, ...pay, pay_currency: "CA" },
        "a currency spelled out": { ...row, ...pay, pay_currency: "Canadian dollars" },
        "a period of no length": { ...row, ...pay, pay_period: "" },
        "a period too long to be one": { ...row, ...pay, pay_period: "fortnight" },
        "an oversized place": { ...row, place: "x".repeat(121) },
        "an empty place, which is said as no place": { ...row, place: "" },
        "job types that are no list": { ...row, job_types: "" },
        "job types with no value": { ...row, job_types: null },
        "an oversized list of job types": { ...row, job_types: JSON.stringify(Array.from({ length: 20 }, (_, n) => `type_${n}`)) },
        "an availability too short to be one": { ...row, available_from: "no" },
        "an availability too long to be one": { ...row, available_from: "2027-03-01" },
      }))
        expect(() => insert(columns), why).toThrow(/constraint failed/i);
      expect(rows()).toEqual([]);

      // What it accepts: one row, with nothing said unless it is given, and a pay floor only whole.
      insert(row);
      expect(rows()).toEqual([{ id: 1, revision: 1, place: null, job_types: "[]", available_from: null, pay_amount: null, pay_currency: null, pay_period: null, updated_at: now }]);
      expect(() => insert(row), "the same row again").toThrow(/constraint failed/i);
      db.prepare(`UPDATE preferences SET place = ?, pay_amount = 999999999999, pay_currency = 'CAD', pay_period = 'year'`).run("x".repeat(120));
      expect(rows()).toMatchObject([{ place: "x".repeat(120), pay_amount: 999999999999 }]);
      // An update is held to the same checks as the row it changes.
      for (const change of [`id = 2`, `revision = 0`, `pay_amount = 1.5`, `pay_currency = NULL`, `place = ''`, `revision = revision + 9007199254740991`])
        expect(() => db.prepare(`UPDATE preferences SET ${change}`).run(), change).toThrow(/constraint failed/i);
    } finally { db.close(); }
  });
});
