import type { ResumeBody } from "../shared/api";
import { wording } from "../shared/record";
import { completeEvidence, type ResumeVersion } from "./snapshots";

// A fact its owner has marked sensitive stays theirs to read, edit and export, and goes nowhere
// else: it is chosen for nothing generated, copied into no share and returned to no connected app.
// This file is the only one that names the column. Everything else asks here which facts are
// withheld, so one rule decides it everywhere.
//
// A fact read from an upload keeps the line it was read from as its quote, and that line can hold
// more than the fact: a skill's quote is its whole list. So while a fact is marked, the line it was
// read from is evidence for nothing. Other facts read from that line stay in use, with their own
// words as their only evidence.

export const SENSITIVE_MIGRATIONS: readonly string[] = [
  // Existing facts are unmarked. No trigger names this column, so marking a fact changes neither
  // its revision nor its incarnation: the mark says nothing about what a line may claim.
  `ALTER TABLE facts ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1))`,
  `CREATE INDEX facts_sensitive ON facts (sensitive) WHERE sensitive = 1`,
];

export interface Withheld {
  /** IDs of the facts marked sensitive. */
  readonly ids: ReadonlySet<string>;
  /** The exact `evidence.quote` of each marked fact. While a fact is marked, the line it was read from is evidence for nothing. */
  readonly quotes: ReadonlySet<string>;
}

/** The facts marked now, and the lines they were read from. Quotes match by text, so the same line in another upload is covered. */
export function withheldFacts(sql: SqlStorage): Withheld {
  const ids = new Set<string>();
  const quotes = new Set<string>();
  const marked = sql
    .exec<{ id: string; quote: string | null }>(
      `SELECT f.id, e.quote FROM facts f LEFT JOIN evidence e ON e.id = f.evidence_id WHERE f.sensitive = 1`,
    )
    .toArray();
  for (const row of marked) {
    ids.add(row.id);
    if (typeof row.quote === "string") quotes.add(row.quote);
  }
  return { ids, quotes };
}

/**
 * The words a mark goes by from one copy of a line to another: `wording()`, with every star and
 * backtick taken out as well. Cleaning once took out a star or backtick set off by spaces and now
 * keeps it, so one line can be stored either way, and the mark must reach both. Comparing on less
 * only ever marks more.
 */
export function markedWording(text: string): string {
  return wording(text).replace(/[*`]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Null for a user's own fact, as today; the fact's own `text` when its quote is in `quotes`; otherwise its quote. */
export function usableQuote(fact: { origin: string; text: string; quote: string | null }, withheld: Withheld): string | null {
  if (fact.origin === "user") return null;
  if (fact.quote !== null && withheld.quotes.has(fact.quote)) return fact.text;
  return fact.quote;
}

/** Its ID is in `ids`, or its stored quote is in `quotes` and is not its stored text. */
export function isWithheld(id: string, stored: { text: string; quote: string | null } | undefined, withheld: Withheld): boolean {
  if (withheld.ids.has(id)) return true;
  return !!stored && typeof stored.quote === "string" && stored.quote !== stored.text && withheld.quotes.has(stored.quote);
}

/**
 * What a saved resume version takes from marked facts: the lines, summary included, that cite one
 * or were checked against the line one was read from, and the printed skills that only marked
 * facts stand behind. A skill printed from a fact that merely shares a marked fact's line is the
 * person's own unmarked word and is not returned. A body that can't be read returns nothing: the
 * gate has already refused it for that.
 */
export function sensitiveUse(
  body: ResumeBody,
  facts: ResumeVersion["facts"] | undefined,
  evidence: ResumeVersion["evidence"],
  withheld: Withheld,
): { lineIds: string[]; skills: string[] } {
  const nothing = { lineIds: [], skills: [] };
  if (withheld.ids.size === 0) return nothing;
  if (!body || typeof body !== "object" || !Array.isArray(body.sections) || !Array.isArray(body.skills)) return nothing;
  const stored: NonNullable<ResumeVersion["facts"]> = facts && typeof facts === "object" && !Array.isArray(facts) ? facts : {};
  const lines = body.summary ? [body.summary] : [];
  for (const section of body.sections) {
    if (!section || !Array.isArray(section.lines)) return nothing;
    lines.push(...section.lines);
  }
  const lineIds = new Set<string>();
  for (const line of lines) {
    if (!line || typeof line.id !== "string" || !Array.isArray(line.factIds) || line.factIds.some((id) => typeof id !== "string")) return nothing;
    if (line.factIds.some((id) => isWithheld(id, Object.hasOwn(stored, id) ? stored[id] : undefined, withheld))) lineIds.add(line.id);
  }
  const skills = new Set<string>();
  for (const skill of body.skills) {
    if (typeof skill !== "string") return nothing;
    // Support is the gate's own test: a complete captured skill record with these words and this quote.
    const behind = Object.entries(stored).filter(([id, kept]) => {
      if (!kept || kept.text !== skill || !evidence || !Object.hasOwn(evidence, id)) return false;
      const full = evidence[id];
      return completeEvidence(full) && full.id === id && full.kind === "skill" && full.text === kept.text && full.quote === kept.quote;
    });
    if (behind.length > 0 && behind.every(([id]) => withheld.ids.has(id))) skills.add(skill);
  }
  return { lineIds: [...lineIds], skills: [...skills] };
}

/** Marks or unmarks these facts and nothing else about them: revision, origin, level, time and vector stay as they were. */
export function setSensitive(sql: SqlStorage, ids: Iterable<string>, sensitive: boolean): void {
  for (const id of ids) sql.exec(`UPDATE facts SET sensitive = ? WHERE id = ?`, sensitive ? 1 : 0, id);
}
