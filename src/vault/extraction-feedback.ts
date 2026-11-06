/** Counts only. No career text or extracted claims enter the experiment ledger. */
export const FEEDBACK_MIGRATIONS = [
  `CREATE TABLE extraction_feedback_sources (source_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL)`,
  `CREATE TABLE extraction_feedback_facts (fact_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, proposed_at INTEGER NOT NULL, confirmed_at INTEGER, rejected_at INTEGER, edited_at INTEGER)`,
  `CREATE INDEX extraction_feedback_facts_source ON extraction_feedback_facts(source_id)`,
  `CREATE TABLE extraction_feedback_manual (fact_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, added_at INTEGER NOT NULL)`,
  `CREATE INDEX extraction_feedback_manual_source ON extraction_feedback_manual(source_id)`,
] as const;
export const FEEDBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export class ExtractionFeedback {
  constructor(private readonly sql: SqlStorage) {}
  start(sourceId: string, at: number): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO extraction_feedback_sources(source_id,started_at) VALUES (?,?)`,
      sourceId,
      at,
    );
  }
  proposals(sourceId: string, at = Date.now()): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO extraction_feedback_facts(fact_id,source_id,proposed_at) SELECT f.id,f.source_id,? FROM facts f JOIN extraction_feedback_sources c ON c.source_id=f.source_id WHERE f.source_id=? AND f.origin='extracted'`,
      at,
      sourceId,
    );
  }
  review(factId: string, action: "confirmed" | "rejected", at: number): void {
    const column = action === "confirmed" ? "confirmed_at" : "rejected_at";
    this.sql.exec(
      `UPDATE extraction_feedback_facts SET ${column}=COALESCE(${column},?) WHERE fact_id=?`,
      at,
      factId,
    );
  }
  rejectRole(roleId: string, at: number): void {
    this.sql.exec(
      `UPDATE extraction_feedback_facts SET rejected_at=COALESCE(rejected_at,?) WHERE fact_id IN (SELECT id FROM facts WHERE role_id=? AND state='proposed')`,
      at,
      roleId,
    );
  }
  edit(factId: string, at: number): void {
    this.sql.exec(
      `UPDATE extraction_feedback_facts SET edited_at=COALESCE(edited_at,?) WHERE fact_id=?`,
      at,
      factId,
    );
  }
  manual(factId: string, at: number): void {
    // Attribute once to the newest observed source within seven days; this is correlation, not causation.
    const source = this.sql
      .exec<{ source_id: string }>(
        `SELECT c.source_id FROM extraction_feedback_sources c JOIN sources s ON s.id=c.source_id WHERE c.started_at<=? AND c.started_at>=? ORDER BY c.started_at DESC,c.source_id DESC LIMIT 1`,
        at,
        at - FEEDBACK_WINDOW_MS,
      )
      .toArray()[0];
    if (source)
      this.sql.exec(
        `INSERT OR IGNORE INTO extraction_feedback_manual(fact_id,source_id,added_at) VALUES (?,?,?)`,
        factId,
        source.source_id,
        at,
      );
  }
  list(now = Date.now()) {
    return this.sql
      .exec<{
        source_id: string;
        extractor: string;
        started_at: number;
        state: string;
        proposed: number;
        confirmed: number;
        rejected: number;
        edited: number;
        manual_added: number;
      }>(
        `SELECT s.id AS source_id,s.extractor,c.started_at,s.state,
        (SELECT COUNT(*) FROM extraction_feedback_facts f WHERE f.source_id=s.id AND f.proposed_at<=c.started_at+?) AS proposed,
        (SELECT COUNT(*) FROM extraction_feedback_facts f WHERE f.source_id=s.id AND f.confirmed_at<=c.started_at+?) AS confirmed,
        (SELECT COUNT(*) FROM extraction_feedback_facts f WHERE f.source_id=s.id AND f.rejected_at<=c.started_at+?) AS rejected,
        (SELECT COUNT(*) FROM extraction_feedback_facts f WHERE f.source_id=s.id AND f.edited_at<=c.started_at+?) AS edited,
        (SELECT COUNT(*) FROM extraction_feedback_manual m WHERE m.source_id=s.id AND m.added_at<=c.started_at+?) AS manual_added
       FROM extraction_feedback_sources c JOIN sources s ON s.id=c.source_id ORDER BY c.started_at DESC,s.id`,
        FEEDBACK_WINDOW_MS,
        FEEDBACK_WINDOW_MS,
        FEEDBACK_WINDOW_MS,
        FEEDBACK_WINDOW_MS,
        FEEDBACK_WINDOW_MS,
      )
      .toArray()
      .map((r) => ({
        sourceId: r.source_id,
        extractor: r.extractor,
        startedAt: r.started_at,
        state: r.state,
        proposed: r.proposed,
        confirmed: r.confirmed,
        rejected: r.rejected,
        edited: r.edited,
        manualAdded: r.manual_added,
        windowComplete: now >= r.started_at + FEEDBACK_WINDOW_MS,
      }));
  }
}
