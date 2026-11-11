import { AppError } from "../shared/errors";
import { PREFERENCES_CHANGED, PREFERENCES_REFUSED, cleanPreferences, type Preferences } from "../shared/preferences";

// A person's job preferences: one row in their own vault, saved whole by its owner at a revision
// they name. This store is its only reader and writer. The Vault reaches it from the owner's two
// calls and the owner's export, and from nowhere that makes a resume, a copy or a tool's answer.
//
// There is no row until the first save, so revision 0 means nothing has been said. A seeded row,
// as the profile has, would make a fenced replacement refuse to start: it needs every table it
// receives, the profile apart, to be empty where it arrives.
//
// The table's own checks hold only what never changes: one row, the caps, and a pay floor that is
// whole or absent. Which job types, periods and currencies are offered is the rule's to say
// (cleanPreferences), because a list fixed in a CHECK could only change by rebuilding the table.

export const PREFERENCES_MIGRATIONS: readonly string[] = [
  `CREATE TABLE preferences (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
     place TEXT CHECK (place IS NULL OR length(place) BETWEEN 1 AND 120),
     job_types TEXT NOT NULL DEFAULT '[]' CHECK (length(job_types) BETWEEN 2 AND 160),
     available_from TEXT CHECK (available_from IS NULL OR length(available_from) BETWEEN 3 AND 7),
     pay_amount INTEGER CHECK (pay_amount IS NULL OR (typeof(pay_amount) = 'integer' AND pay_amount BETWEEN 1 AND 999999999999)),
     pay_currency TEXT CHECK (pay_currency IS NULL OR length(pay_currency) = 3),
     pay_period TEXT CHECK (pay_period IS NULL OR length(pay_period) BETWEEN 1 AND 8),
     updated_at INTEGER NOT NULL,
     CHECK ((pay_amount IS NULL) = (pay_currency IS NULL) AND (pay_amount IS NULL) = (pay_period IS NULL))
   )`,
];

interface Row extends Record<string, SqlStorageValue> {
  revision: number;
  place: string | null;
  job_types: string;
  available_from: string | null;
  pay_amount: number | null;
  pay_currency: string | null;
  pay_period: string | null;
  updated_at: number;
}

export class PreferencesStore {
  constructor(private readonly sql: SqlStorage) {}

  /**
   * The row as it is stored. No choice is checked against today's lists here: one that was saved
   * while it was offered is still its owner's to see, export and replace.
   */
  read(): Preferences {
    const row = this.sql
      .exec<Row>(`SELECT revision, place, job_types, available_from, pay_amount, pay_currency, pay_period, updated_at FROM preferences WHERE id = 1`)
      .toArray()[0];
    if (!row) return { revision: 0, place: null, jobTypes: [], availableFrom: null, payFloor: null, updatedAt: null };
    return {
      revision: row.revision,
      place: row.place,
      jobTypes: JSON.parse(row.job_types) as string[],
      availableFrom: row.available_from,
      payFloor:
        row.pay_amount === null || row.pay_currency === null || row.pay_period === null
          ? null
          : { amount: row.pay_amount, currency: row.pay_currency, period: row.pay_period },
      updatedAt: row.updated_at,
    };
  }

  /**
   * Replaces all four values, if `expectedRevision` is the revision stored now. The values are
   * checked again here, because a route is not the Vault's only caller. A save of unchanged
   * values still takes the next revision.
   */
  save(values: unknown, expectedRevision: number, now = Date.now()): Preferences {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER)
      throw new AppError("conflict", PREFERENCES_CHANGED);
    const clean = cleanPreferences(values);
    if (!clean) throw new AppError("invalid", PREFERENCES_REFUSED);
    if (this.read().revision !== expectedRevision) throw new AppError("conflict", PREFERENCES_CHANGED);
    // The read above and this write run in one synchronous turn, with nothing awaited between
    // them, so no other save can fall between the check and the write.
    this.sql.exec(
      `INSERT INTO preferences (id, revision, place, job_types, available_from, pay_amount, pay_currency, pay_period, updated_at)
       VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET revision = revision + 1, place = excluded.place, job_types = excluded.job_types,
         available_from = excluded.available_from, pay_amount = excluded.pay_amount, pay_currency = excluded.pay_currency,
         pay_period = excluded.pay_period, updated_at = excluded.updated_at`,
      clean.place,
      JSON.stringify(clean.jobTypes),
      clean.availableFrom,
      clean.payFloor?.amount ?? null,
      clean.payFloor?.currency ?? null,
      clean.payFloor?.period ?? null,
      now,
    );
    return this.read();
  }
}
