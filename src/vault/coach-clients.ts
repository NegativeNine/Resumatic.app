import { AppError } from "../shared/errors";
import { COACH_CLIENT_KEPT_MS } from "../shared/sharing";

// The copies other people have shared with this account as their coach. This is the coach's own
// list, in the coach's own vault. It holds where each copy lives and nothing the copy says: the
// copy itself stays in its owner's vault, which decides each time whether this account may open it.
// An entry is kept for COACH_CLIENT_KEPT_MS after its copy's last day and is unseen from then on,
// whether or not it has been cleared away yet.

export const COACH_CLIENT_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS coach_clients (
     grant_id TEXT PRIMARY KEY,
     owner_vault TEXT NOT NULL,
     owner_name TEXT,
     added_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
];

export const MAX_COACH_CLIENTS = 200;

/** One client's copy, as the coach's vault keeps it. The owner's vault ID never leaves the server. */
export interface CoachClientEntry {
  grantId: string;
  ownerVault: string;
  ownerName: string | null;
  addedAt: number;
  expiresAt: number;
}

interface Row extends Record<string, SqlStorageValue> {
  grant_id: string;
  owner_vault: string;
  owner_name: string | null;
  added_at: number;
  expires_at: number;
}

const entry = (row: Row): CoachClientEntry => ({
  grantId: row.grant_id,
  ownerVault: row.owner_vault,
  ownerName: row.owner_name,
  addedAt: row.added_at,
  expiresAt: row.expires_at,
});

export class CoachClientStore {
  constructor(private readonly sql: SqlStorage) {}

  /** Adds a copy to the list, or refreshes what the list says about one already there. */
  add(client: Omit<CoachClientEntry, "addedAt">, now = Date.now()): void {
    if (!/^[0-9a-f-]{36}$/i.test(client.grantId) || !/^[0-9a-f]{64}$/.test(client.ownerVault) || !Number.isSafeInteger(client.expiresAt))
      throw new AppError("invalid", "this copy can't be added");
    this.purge(now);
    this.requireRoom(client.grantId, now);
    this.sql.exec(
      `INSERT INTO coach_clients (grant_id, owner_vault, owner_name, added_at, expires_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(grant_id) DO UPDATE SET owner_vault = excluded.owner_vault, owner_name = excluded.owner_name, expires_at = excluded.expires_at`,
      client.grantId, client.ownerVault, client.ownerName?.slice(0, 200) || null, now, client.expiresAt,
    );
  }

  /** Refuses a copy the list has no room for. One already on the list is only refreshed, so it always fits. */
  requireRoom(grantId: string, now = Date.now()): void {
    const known = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM coach_clients WHERE grant_id = ?`, grantId).one().n > 0;
    if (!known && this.count(now) >= MAX_COACH_CLIENTS)
      throw new AppError("conflict", "your client list is full; remove a copy that has ended, then add this one");
  }

  /** Newest first. */
  list(now = Date.now()): CoachClientEntry[] {
    return this.sql
      .exec<Row>(`SELECT * FROM coach_clients WHERE expires_at > ? ORDER BY added_at DESC, grant_id LIMIT ?`, now - COACH_CLIENT_KEPT_MS, MAX_COACH_CLIENTS)
      .toArray()
      .map(entry);
  }

  get(grantId: string, now = Date.now()): CoachClientEntry | null {
    const row = this.sql.exec<Row>(`SELECT * FROM coach_clients WHERE grant_id = ? AND expires_at > ? LIMIT 1`, grantId, now - COACH_CLIENT_KEPT_MS).toArray()[0];
    return row ? entry(row) : null;
  }

  count(now = Date.now()): number {
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM coach_clients WHERE expires_at > ?`, now - COACH_CLIENT_KEPT_MS).one().n;
  }

  remove(grantId: string): void {
    this.sql.exec(`DELETE FROM coach_clients WHERE grant_id = ?`, grantId);
  }

  /** Clears entries past their time. Call from the Vault alarm; they are unseen before that anyway. */
  purge(now = Date.now()): void {
    this.sql.exec(`DELETE FROM coach_clients WHERE expires_at <= ?`, now - COACH_CLIENT_KEPT_MS);
  }

  /**
   * When the next entry is due to be cleared, or null when none is held. The Vault sets its alarm
   * by this: a vault used only to coach has nothing else that would ever wake it.
   */
  nextAlarm(): number | null {
    return this.sql.exec<{ at: number | null }>(`SELECT MIN(expires_at) + ? AS at FROM coach_clients`, COACH_CLIENT_KEPT_MS).one().at;
  }

  /** The list as the account's export gives it. Where each copy is kept stays on the server. */
  export(now = Date.now()): Omit<CoachClientEntry, "ownerVault">[] {
    return this.list(now).map(({ ownerVault: _kept, ...rest }) => rest);
  }
}
