import { AppError } from "../shared/errors";
import {
  MAX_LINKS_PER_ITEM,
  MAX_TAGS_PER_SUBJECT,
  PART_KINDS,
  linkProblem,
  partText,
  partsProblem,
  sameRole,
  sameWording,
  stampProblem,
  tagProblem,
  tagRelation,
  type ConceptTag,
  type FactEvidence,
  type FactPart,
  type FactSplit,
  type Judgement,
  type JudgementState,
  type LinkKind,
  type LinkRelation,
  type NewLink,
  type NewPart,
  type NewTag,
  type PartKind,
  type Proposer,
  type Range,
  type RecordExport,
  type RecordLink,
  type Stamp,
  type TagRelation,
  type TagSubject,
  type TagSubjectKind,
} from "../shared/record";
import type { ConceptKind } from "../taxonomy/types";

// The record beside a person's lines: how a line divides, which concepts it shows, and which
// facts or roles say the same thing. Nothing here changes a fact, a role or a quote. Every row is
// a judgement about one: stamped with what made it, proposed until someone decides, and undone by
// changing its state. docs/record.md says what each table is for.

/** What made a judgement and what was decided about it. The same columns on all three tables. */
const JUDGEMENT = `
  state TEXT NOT NULL CHECK (state IN ('proposed','confirmed','rejected')),
  shadow INTEGER NOT NULL CHECK (shadow IN (0,1)),
  proposed_by TEXT NOT NULL, model TEXT, method TEXT NOT NULL, taxonomy_version TEXT, confidence REAL,
  created_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER`;
const JUDGEMENT_COLUMNS = "state, shadow, proposed_by, model, method, taxonomy_version, confidence, created_at, decided_by, decided_at";

export const RECORD_MIGRATIONS: readonly string[] = [
  `CREATE TABLE fact_splits (id TEXT PRIMARY KEY, fact_id TEXT NOT NULL REFERENCES facts (id),${JUDGEMENT})`,
  // A line divides one way at a time. Ways the owner turned down are kept, so they aren't offered again.
  `CREATE UNIQUE INDEX fact_splits_live ON fact_splits (fact_id, shadow) WHERE state <> 'rejected'`,
  `CREATE INDEX fact_splits_by_fact ON fact_splits (fact_id)`,
  // A part is positions in its fact's text and nothing else: the record holds no second wording.
  // result_of is the position, in the same division, of the claim a result is an outcome of.
  `CREATE TABLE fact_parts (
    id TEXT PRIMARY KEY, split_id TEXT NOT NULL REFERENCES fact_splits (id), position INTEGER NOT NULL,
    kind TEXT NOT NULL, ranges TEXT NOT NULL, result_of INTEGER, UNIQUE (split_id, position)
  )`,
  `CREATE TABLE record_tags (
    id TEXT PRIMARY KEY, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
    concept_id TEXT NOT NULL, concept_kind TEXT NOT NULL, label TEXT NOT NULL, relation TEXT NOT NULL,${JUDGEMENT}
  )`,
  `CREATE UNIQUE INDEX record_tags_key ON record_tags (subject_kind, subject_id, concept_id, relation, shadow)`,
  // Matching by concept asks which facts and parts carry one.
  `CREATE INDEX record_tags_by_concept ON record_tags (concept_id)`,
  `CREATE TABLE record_links (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, relation TEXT NOT NULL,${JUDGEMENT},
    CHECK (from_id <> to_id)
  )`,
  `CREATE UNIQUE INDEX record_links_key ON record_links (kind, from_id, to_id, relation, shadow)`,
  // A fact or a role is merged into one other at most.
  `CREATE UNIQUE INDEX record_links_merged ON record_links (kind, from_id, shadow) WHERE relation = 'same' AND state <> 'rejected'`,
  `CREATE INDEX record_links_to ON record_links (kind, to_id)`,
  // A fact or role that goes takes every judgement about it with it. These fire for every writer,
  // including ones written before the record existed, such as a retried reading of an upload.
  `CREATE TRIGGER record_fact_deleted BEFORE DELETE ON facts BEGIN
     DELETE FROM fact_splits WHERE fact_id = OLD.id;
     DELETE FROM record_tags WHERE subject_kind = 'fact' AND subject_id = OLD.id;
     DELETE FROM record_links WHERE kind = 'fact' AND from_id = OLD.id;
     DELETE FROM record_links WHERE kind = 'fact' AND to_id = OLD.id;
   END`,
  `CREATE TRIGGER record_role_deleted BEFORE DELETE ON roles BEGIN
     DELETE FROM record_tags WHERE subject_kind = 'role' AND subject_id = OLD.id;
     DELETE FROM record_links WHERE kind = 'role' AND from_id = OLD.id;
     DELETE FROM record_links WHERE kind = 'role' AND to_id = OLD.id;
   END`,
  `CREATE TRIGGER record_split_deleted BEFORE DELETE ON fact_splits BEGIN
     DELETE FROM fact_parts WHERE split_id = OLD.id;
   END`,
  `CREATE TRIGGER record_part_deleted BEFORE DELETE ON fact_parts BEGIN
     DELETE FROM record_tags WHERE subject_kind = 'part' AND subject_id = OLD.id;
   END`,
  // A judgement is about particular words. When a fact's words change, its parts no longer point
  // at them and its tags were never decided about them, so both go, with any link that compared
  // the old words. Only what was merged into the fact stays: those quotes stay beside it as its
  // own original quote does, and separating them is the owner's to do.
  `CREATE TRIGGER record_fact_reworded AFTER UPDATE OF text ON facts WHEN NEW.text IS NOT OLD.text BEGIN
     DELETE FROM fact_splits WHERE fact_id = NEW.id;
     DELETE FROM record_tags WHERE subject_kind = 'fact' AND subject_id = NEW.id;
     DELETE FROM record_links WHERE kind = 'fact' AND from_id = NEW.id;
     DELETE FROM record_links WHERE kind = 'fact' AND to_id = NEW.id AND (relation <> 'same' OR state <> 'confirmed');
   END`,
  // The same for a role: an occupation was chosen for a title, and a likeness for the fields that
  // name the role.
  `CREATE TRIGGER record_role_retitled AFTER UPDATE OF kind, title ON roles
     WHEN NEW.kind IS NOT OLD.kind OR NEW.title IS NOT OLD.title BEGIN
     DELETE FROM record_tags WHERE subject_kind = 'role' AND subject_id = NEW.id;
   END`,
  `CREATE TRIGGER record_role_changed AFTER UPDATE OF kind, org, title, start_date, end_date, unknown_end_start_date ON roles
     WHEN NEW.kind IS NOT OLD.kind OR NEW.org IS NOT OLD.org OR NEW.title IS NOT OLD.title OR NEW.start_date IS NOT OLD.start_date
       OR NEW.end_date IS NOT OLD.end_date OR NEW.unknown_end_start_date IS NOT OLD.unknown_end_start_date BEGIN
     DELETE FROM record_links WHERE kind = 'role' AND from_id = NEW.id;
     DELETE FROM record_links WHERE kind = 'role' AND to_id = NEW.id AND state <> 'confirmed';
   END`,
];

type Cell = string | number | null;
type Table = "fact_splits" | "record_tags" | "record_links";
type JudgementRow = {
  id: string;
  state: string;
  shadow: number;
  proposed_by: string;
  model: string | null;
  method: string;
  taxonomy_version: string | null;
  confidence: number | null;
  created_at: number;
  decided_by: string | null;
  decided_at: number | null;
};
type SplitRow = JudgementRow & { fact_id: string };
type PartRow = { id: string; split_id: string; position: number; kind: string; ranges: string; result_of: number | null };
type TagRow = JudgementRow & {
  subject_kind: string;
  subject_id: string;
  concept_id: string;
  concept_kind: string;
  label: string;
  relation: string;
};
type LinkRow = JudgementRow & { kind: string; from_id: string; to_id: string; relation: string };
type FactItem = { id: string; kind: string; text: string; role_id: string | null };
type RoleItem = {
  id: string;
  kind: string;
  org: string;
  title: string | null;
  start_date: string | null;
  end_date: string | null;
  unknown_end_start_date: string | null;
};
/** A part as it is stored: in its division's own order, a result naming its claim by position. */
type StoredPart = { kind: PartKind; ranges: Range[]; resultOf: number | null };

const IDENTICAL_ONLY = "only identical wording, in one role, merges without asking";

function refuse(problem: string | null): void {
  if (problem) throw new AppError("invalid", problem);
}

function judgement(row: JudgementRow): Judgement {
  return {
    id: row.id,
    state: row.state as JudgementState,
    proposedBy: row.proposed_by as Proposer,
    model: row.model,
    method: row.method,
    taxonomyVersion: row.taxonomy_version,
    confidence: row.confidence,
    shadow: row.shadow === 1,
    createdAt: row.created_at,
    decidedBy: row.decided_by as Judgement["decidedBy"],
    decidedAt: row.decided_at,
  };
}

function compareParts(a: NewPart, b: NewPart): number {
  for (let i = 0; i < Math.min(a.ranges.length, b.ranges.length); i++) {
    const delta = a.ranges[i]![0] - b.ranges[i]![0] || a.ranges[i]![1] - b.ranges[i]![1];
    if (delta) return delta;
  }
  return a.ranges.length - b.ranges.length || PART_KINDS.indexOf(a.kind) - PART_KINDS.indexOf(b.kind);
}

/**
 * Parts in the order they start in the line, so one division is always stored one way whatever
 * order it was proposed in. `rank[i]` is where the caller's part i ended up.
 */
function inOrder(parts: NewPart[]): { parts: StoredPart[]; rank: number[] } {
  const order = parts.map((_, index) => index).sort((a, b) => compareParts(parts[a]!, parts[b]!));
  const rank: number[] = [];
  order.forEach((index, position) => {
    rank[index] = position;
  });
  return {
    rank,
    parts: order.map((index) => {
      const part = parts[index]!;
      return {
        kind: part.kind,
        ranges: part.ranges.map(([start, end]): Range => [start, end]),
        resultOf: part.resultOf == null ? null : rank[part.resultOf]!,
      };
    }),
  };
}

function shapeOf(parts: StoredPart[]): string {
  return JSON.stringify(parts.map((part) => [part.kind, part.ranges, part.resultOf]));
}

function storedPart(row: PartRow): StoredPart {
  return { kind: row.kind as PartKind, ranges: JSON.parse(row.ranges) as Range[], resultOf: row.result_of };
}

function tagView(row: TagRow): ConceptTag {
  return {
    ...judgement(row),
    taxonomyVersion: row.taxonomy_version ?? "",
    subject: { kind: row.subject_kind as TagSubjectKind, id: row.subject_id },
    conceptId: row.concept_id,
    conceptKind: row.concept_kind as ConceptKind,
    label: row.label,
    relation: row.relation as TagRelation,
  };
}

/**
 * Reads and writes the record's judgements. It checks what can be checked from the record alone:
 * that a part is whole words of its line as the line now stands, that a tag names a concept in
 * the taxonomy's own form, and that nothing but identical wording is confirmed without the owner.
 * Whether a part or a tag means what the line means is decided where it is proposed.
 */
export class RecordStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: <T>(fn: () => T) => T,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ---------------------------------------------------------------- parts of a line

  /**
   * Stores one way a line divides. `line` is the wording the parts were worked out against; if the
   * fact no longer says exactly that, nothing is stored. A new proposal replaces one nobody has
   * decided. It never replaces a division the owner accepted, and one the owner turned down is
   * not stored again. The owner dividing a line themselves replaces whatever stood.
   */
  proposeSplit(input: { factId: string; line: string; parts: NewPart[]; stamp: Stamp }): {
    splitId: string;
    state: JudgementState;
    partIds: string[];
  } {
    refuse(stampProblem(input.stamp));
    return this.transaction(() => {
      const fact = this.sql
        .exec<{ text: string; kind: string }>(`SELECT text, kind FROM facts WHERE id = ?`, input.factId)
        .toArray()[0];
      if (!fact) throw new AppError("not_found", "no such fact");
      if (fact.kind === "skill") throw new AppError("invalid", "a skill is one item and has no parts");
      if (fact.text !== input.line) throw new AppError("conflict", "this fact's wording changed; divide it again");
      refuse(partsProblem(fact.text, input.parts));
      const { parts, rank } = inOrder(input.parts);
      const shape = shapeOf(parts);
      const owner = input.stamp.proposedBy === "owner";
      const known = this.sql
        .exec<SplitRow>(
          `SELECT * FROM fact_splits WHERE fact_id = ? AND shadow = ? ORDER BY created_at, id`,
          input.factId,
          input.stamp.shadow ? 1 : 0,
        )
        .toArray();
      const same = known.find((row) => shapeOf(this.partRows(row.id).map(storedPart)) === shape);
      const live = known.find((row) => row.state !== "rejected");
      const answer = (splitId: string, state: JudgementState) => {
        const ids = this.partRows(splitId).map((row) => row.id);
        return { splitId, state, partIds: input.parts.map((_, index) => ids[rank[index]!]!) };
      };
      if (same && (!owner || same.state === "confirmed")) {
        if (same.state === "proposed") this.restamp("fact_splits", same.id, input.stamp);
        return answer(same.id, same.state as JudgementState);
      }
      if (live && live.id !== same?.id) {
        if (live.state === "confirmed" && !owner)
          throw new AppError("conflict", "the owner accepted another way this line divides");
        this.sql.exec(`DELETE FROM fact_splits WHERE id = ?`, live.id);
      }
      if (same) {
        this.decide("fact_splits", same.id, "confirmed", "owner");
        return answer(same.id, "confirmed");
      }
      const id = crypto.randomUUID();
      const opening = this.opening(input.stamp);
      this.sql.exec(
        `INSERT INTO fact_splits (id, fact_id, ${JUDGEMENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.factId,
        ...opening.values,
      );
      parts.forEach((part, position) =>
        this.sql.exec(
          `INSERT INTO fact_parts (id, split_id, position, kind, ranges, result_of) VALUES (?, ?, ?, ?, ?, ?)`,
          crypto.randomUUID(),
          id,
          position,
          part.kind,
          JSON.stringify(part.ranges),
          part.resultOf,
        ),
      );
      return answer(id, opening.state);
    });
  }

  /** How a line divides now: the division proposed or accepted, or null while the line is whole. */
  split(factId: string, options: { shadow?: boolean } = {}): FactSplit | null {
    const row = this.sql
      .exec<SplitRow>(
        `SELECT * FROM fact_splits WHERE fact_id = ? AND shadow = ? AND state <> 'rejected'`,
        factId,
        options.shadow ? 1 : 0,
      )
      .toArray()[0];
    return row ? this.splitView(row) : null;
  }

  /** The owner accepts a division or turns it down. Turning down one they accepted undoes it. */
  decideSplit(splitId: string, decision: "confirmed" | "rejected"): void {
    this.transaction(() => {
      const row = this.visible<SplitRow>("fact_splits", splitId, "division of a line");
      if (row.state === decision) return;
      if (
        decision === "confirmed" &&
        this.sql
          .exec(`SELECT id FROM fact_splits WHERE fact_id = ? AND shadow = 0 AND state <> 'rejected' AND id <> ?`, row.fact_id, splitId)
          .toArray().length
      )
        throw new AppError("conflict", "this line has been divided another way since");
      this.decide("fact_splits", splitId, decision, "owner");
      // A division that was turned down shows nothing, so nothing stays tagged on it.
      if (decision === "rejected")
        this.sql.exec(
          `DELETE FROM record_tags WHERE subject_kind = 'part' AND subject_id IN (SELECT id FROM fact_parts WHERE split_id = ?)`,
          splitId,
        );
    });
  }

  // ---------------------------------------------------------------- tags

  /**
   * Stores a concept proposed for a fact, a part or a role. Proposing one again leaves a decision
   * alone: a rule or a model never reopens what the owner confirmed or rejected. A tag the owner
   * adds themselves is confirmed at once, whatever stood before.
   */
  proposeTag(input: NewTag): { tagId: string; state: JudgementState } {
    refuse(tagProblem(input));
    const relation = tagRelation(input.subject.kind, input.conceptKind)!;
    const owner = input.stamp.proposedBy === "owner";
    return this.transaction(() => {
      this.requireSubject(input.subject, input.stamp.shadow);
      const existing = this.sql
        .exec<TagRow>(
          `SELECT * FROM record_tags WHERE subject_kind = ? AND subject_id = ? AND concept_id = ? AND relation = ? AND shadow = ?`,
          input.subject.kind,
          input.subject.id,
          input.conceptId,
          relation,
          input.stamp.shadow ? 1 : 0,
        )
        .toArray()[0];
      if (existing) {
        if (owner) {
          if (existing.state !== "confirmed") this.decide("record_tags", existing.id, "confirmed", "owner");
          return { tagId: existing.id, state: "confirmed" };
        }
        if (existing.state === "proposed") {
          this.restamp("record_tags", existing.id, input.stamp);
          this.sql.exec(`UPDATE record_tags SET concept_kind = ?, label = ? WHERE id = ?`, input.conceptKind, input.label, existing.id);
        }
        return { tagId: existing.id, state: existing.state as JudgementState };
      }
      const held = this.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM record_tags WHERE subject_kind = ? AND subject_id = ?`,
          input.subject.kind,
          input.subject.id,
        )
        .toArray()[0]!.n;
      if (held >= MAX_TAGS_PER_SUBJECT) throw new AppError("too_large", "this already has as many tags as it can hold");
      const id = crypto.randomUUID();
      const opening = this.opening(input.stamp);
      this.sql.exec(
        `INSERT INTO record_tags (id, subject_kind, subject_id, concept_id, concept_kind, label, relation, ${JUDGEMENT_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.subject.kind,
        input.subject.id,
        input.conceptId,
        input.conceptKind,
        input.label,
        relation,
        ...opening.values,
      );
      return { tagId: id, state: opening.state };
    });
  }

  /** The tags on one fact, part or role, oldest first. Shadow tags only when asked for. */
  tags(subject: TagSubject, options: { shadow?: boolean; state?: JudgementState } = {}): ConceptTag[] {
    return this.sql
      .exec<TagRow>(
        `SELECT * FROM record_tags WHERE subject_kind = ? AND subject_id = ? AND shadow = ? AND (? IS NULL OR state = ?) ORDER BY created_at, id`,
        subject.kind,
        subject.id,
        options.shadow ? 1 : 0,
        options.state ?? null,
        options.state ?? null,
      )
      .toArray()
      .map(tagView);
  }

  /** The owner confirms a tag or rejects it. Rejecting one they confirmed undoes it. */
  decideTag(tagId: string, decision: "confirmed" | "rejected"): void {
    this.transaction(() => {
      const row = this.visible<TagRow>("record_tags", tagId, "tag");
      if (row.state !== decision) this.decide("record_tags", tagId, decision, "owner");
    });
  }

  // ---------------------------------------------------------------- links

  /**
   * Stores a likeness between two facts or two roles. `same` merges `from` into `to` once it is
   * confirmed: `to` stands for both, and nothing about either row changes. Only the owner
   * confirms, with one exception the record checks for itself: a rule may confirm at once that
   * two facts of one kind in one role have the same wording, or that two roles are alike in every
   * field. Outside any role that holds for skills and credentials only. A rule or a model never
   * reopens what the owner decided.
   */
  proposeLink(input: NewLink): { linkId: string; state: JudgementState } {
    refuse(linkProblem(input));
    const shadow = input.stamp.shadow ? 1 : 0;
    const owner = input.stamp.proposedBy === "owner";
    const confirming = owner || input.confirm === true;
    const link = { kind: input.kind, from: input.from, to: input.to, relation: input.relation, shadow };
    return this.transaction(() => {
      if (input.kind === "fact") {
        const from = this.fact(input.from);
        const to = this.fact(input.to);
        // In shadow nothing stands, so nothing is asked of the roles: theirs may be in shadow too.
        if (!shadow) this.requireOneRole(input.from, input.to);
        // An accomplishment outside any role has no role that was found to be the same one.
        if (input.confirm && !(from.kind === to.kind && sameWording(from.text, to.text) && (from.role_id !== null || from.kind !== "accomplishment")))
          throw new AppError("invalid", IDENTICAL_ONLY);
      } else {
        const from = this.role(input.from);
        const to = this.role(input.to);
        if (input.confirm && !sameRole(roleIdentity(from), roleIdentity(to))) throw new AppError("invalid", IDENTICAL_ONLY);
      }
      const existing = this.sql
        .exec<LinkRow>(
          `SELECT * FROM record_links WHERE kind = ? AND from_id = ? AND to_id = ? AND relation = ? AND shadow = ?`,
          input.kind,
          input.from,
          input.to,
          input.relation,
          shadow,
        )
        .toArray()[0];
      if (existing) {
        if (existing.state === "confirmed" || (existing.state === "rejected" && !owner))
          return { linkId: existing.id, state: existing.state as JudgementState };
        if (!confirming) {
          this.restamp("record_links", existing.id, input.stamp);
          return { linkId: existing.id, state: "proposed" };
        }
        this.clearWay(link, existing.id, owner, true);
        this.decide("record_links", existing.id, "confirmed", owner ? "owner" : "rule");
        return { linkId: existing.id, state: "confirmed" };
      }
      this.clearWay(link, null, owner, confirming);
      for (const item of [input.from, input.to]) {
        const held = this.sql
          .exec<{ n: number }>(
            `SELECT COUNT(*) AS n FROM record_links WHERE kind = ? AND (from_id = ? OR to_id = ?)`,
            input.kind,
            item,
            item,
          )
          .toArray()[0]!.n;
        if (held >= MAX_LINKS_PER_ITEM) throw new AppError("too_large", "this already has as many links as it can hold");
      }
      const id = crypto.randomUUID();
      const opening = this.opening(input.stamp, input.confirm === true);
      this.sql.exec(
        `INSERT INTO record_links (id, kind, from_id, to_id, relation, ${JUDGEMENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.kind,
        input.from,
        input.to,
        input.relation,
        ...opening.values,
      );
      return { linkId: id, state: opening.state };
    });
  }

  /** Every link a fact or role is in, either way round, oldest first. Shadow links only when asked for. */
  links(kind: LinkKind, id: string, options: { shadow?: boolean; state?: JudgementState } = {}): RecordLink[] {
    return this.sql
      .exec<LinkRow>(
        `SELECT * FROM record_links WHERE kind = ? AND shadow = ? AND (from_id = ? OR to_id = ?) AND (? IS NULL OR state = ?) ORDER BY created_at, id`,
        kind,
        options.shadow ? 1 : 0,
        id,
        id,
        options.state ?? null,
        options.state ?? null,
      )
      .toArray()
      .map((row) => this.linkView(row));
  }

  /** The owner accepts a link or turns it down. Turning down a merge separates the two again. */
  decideLink(linkId: string, decision: "confirmed" | "rejected"): void {
    this.transaction(() => {
      const row = this.visible<LinkRow>("record_links", linkId, "link");
      if (row.state === decision) return;
      if (decision === "confirmed") {
        if (row.kind === "fact") this.requireOneRole(row.from_id, row.to_id);
        this.clearWay(
          { kind: row.kind as LinkKind, from: row.from_id, to: row.to_id, relation: row.relation as LinkRelation, shadow: 0 },
          row.id,
          true,
          true,
        );
      }
      this.decide("record_links", linkId, decision, "owner");
    });
  }

  /**
   * The fact or role that stands for this one: itself, unless it was merged into another. A merge
   * of two facts holds only while they sit in one role, so separating two roles separates their
   * facts and joining the roles again joins them again, with nothing rewritten either time.
   */
  root(kind: LinkKind, id: string): string {
    if (kind === "role") return this.chain("role", id).at(-1)!;
    const path = this.chain("fact", id);
    let current = id;
    for (const next of path.slice(1)) {
      if (!this.inOneRole(current, next)) break;
      current = next;
    }
    return current;
  }

  /** Every fact or role merged into this one, directly or through another, in the order they were merged. */
  merged(kind: LinkKind, id: string): string[] {
    const found: string[] = [];
    const seen = new Set([id]);
    const queue = [id];
    while (queue.length) {
      const current = queue.shift()!;
      const sources = this.sql
        .exec<{ from_id: string }>(
          `SELECT from_id FROM record_links WHERE kind = ? AND to_id = ? AND relation = 'same' AND state = 'confirmed' AND shadow = 0
           ORDER BY decided_at, created_at, id`,
          kind,
          current,
        )
        .toArray();
      for (const { from_id: from } of sources) {
        if (seen.has(from) || (kind === "fact" && !this.inOneRole(from, current))) continue;
        seen.add(from);
        found.push(from);
        queue.push(from);
      }
    }
    return found;
  }

  /**
   * Every quote that supports a fact: its own, then the quote of each fact merged into it. This
   * is how a fact has several pieces of evidence. No quote is copied or moved to make it so.
   */
  evidenceOf(factId: string): FactEvidence[] {
    return [factId, ...this.merged("fact", factId)].flatMap((id) =>
      this.sql
        .exec<{ source_id: string; quote: string; start: number | null; end: number | null }>(
          `SELECT e.source_id, e.quote, e.start, e.end FROM facts f JOIN evidence e ON e.id = f.evidence_id WHERE f.id = ?`,
          id,
        )
        .toArray()
        .map((row) => ({
          factId: id,
          own: id === factId,
          sourceId: row.source_id,
          quote: row.quote,
          span: row.start === null || row.end === null ? null : ([row.start, row.end] as Range),
        })),
    );
  }

  /** Everything held, for the owner's export: every state, and shadow judgements too. */
  export(): RecordExport {
    return {
      factSplits: this.sql
        .exec<SplitRow>(`SELECT * FROM fact_splits ORDER BY created_at, id`)
        .toArray()
        .map((row) => this.splitView(row)),
      conceptTags: this.sql.exec<TagRow>(`SELECT * FROM record_tags ORDER BY created_at, id`).toArray().map(tagView),
      recordLinks: this.sql
        .exec<LinkRow>(`SELECT * FROM record_links ORDER BY created_at, id`)
        .toArray()
        .map((row) => this.linkView(row)),
    };
  }

  // ---------------------------------------------------------------- internals

  /** The stamp and first state of a new judgement, in the order of JUDGEMENT_COLUMNS. */
  private opening(stamp: Stamp, confirm = false): { state: JudgementState; values: Cell[] } {
    const at = this.now();
    const decidedBy = stamp.proposedBy === "owner" ? "owner" : confirm ? "rule" : null;
    const state: JudgementState = decidedBy ? "confirmed" : "proposed";
    return {
      state,
      values: [
        state,
        stamp.shadow ? 1 : 0,
        stamp.proposedBy,
        stamp.model,
        stamp.method,
        stamp.taxonomyVersion,
        stamp.confidence,
        at,
        decidedBy,
        decidedBy ? at : null,
      ],
    };
  }

  private decide(table: Table, id: string, state: "confirmed" | "rejected", by: "rule" | "owner"): void {
    this.sql.exec(`UPDATE ${table} SET state = ?, decided_by = ?, decided_at = ? WHERE id = ?`, state, by, this.now(), id);
  }

  /** A proposal made again takes the stamp of what made it last. */
  private restamp(table: Table, id: string, stamp: Stamp): void {
    this.sql.exec(
      `UPDATE ${table} SET proposed_by = ?, model = ?, method = ?, taxonomy_version = ?, confidence = ? WHERE id = ?`,
      stamp.proposedBy,
      stamp.model,
      stamp.method,
      stamp.taxonomyVersion,
      stamp.confidence,
      id,
    );
  }

  /** A judgement the owner can decide. One in shadow is shown to nobody, so to them it isn't there. */
  private visible<T extends JudgementRow>(table: Table, id: string, what: string): T {
    const row = this.sql.exec<T>(`SELECT * FROM ${table} WHERE id = ?`, id).toArray()[0];
    if (!row || row.shadow === 1) throw new AppError("not_found", `no such ${what}`);
    return row;
  }

  private partRows(splitId: string): PartRow[] {
    return this.sql.exec<PartRow>(`SELECT * FROM fact_parts WHERE split_id = ? ORDER BY position`, splitId).toArray();
  }

  private splitView(row: SplitRow): FactSplit {
    const line = this.sql.exec<{ text: string }>(`SELECT text FROM facts WHERE id = ?`, row.fact_id).toArray()[0]?.text ?? "";
    const rows = this.partRows(row.id);
    const parts: FactPart[] = rows.map((part) => {
      const ranges = JSON.parse(part.ranges) as Range[];
      return {
        id: part.id,
        kind: part.kind as PartKind,
        ranges,
        text: partText(line, ranges),
        resultOf: part.result_of === null ? null : (rows[part.result_of]?.id ?? null),
      };
    });
    return { ...judgement(row), factId: row.fact_id, parts };
  }

  private linkView(row: LinkRow): RecordLink {
    return {
      ...judgement(row),
      kind: row.kind as LinkKind,
      from: row.from_id,
      to: row.to_id,
      relation: row.relation as LinkRelation,
      holds: row.state === "confirmed" && row.shadow === 0 && (row.kind === "role" || this.inOneRole(row.from_id, row.to_id)),
    };
  }

  private fact(id: string): FactItem {
    const row = this.sql.exec<FactItem>(`SELECT id, kind, text, role_id FROM facts WHERE id = ?`, id).toArray()[0];
    if (!row) throw new AppError("not_found", "no such fact");
    return row;
  }

  private role(id: string): RoleItem {
    const row = this.sql
      .exec<RoleItem>(`SELECT id, kind, org, title, start_date, end_date, unknown_end_start_date FROM roles WHERE id = ?`, id)
      .toArray()[0];
    if (!row) throw new AppError("not_found", "no such role");
    return row;
  }

  /** What a tag is on must exist, and a part must belong to a division that still stands. */
  private requireSubject(subject: TagSubject, shadow: boolean): void {
    if (subject.kind === "fact") this.fact(subject.id);
    else if (subject.kind === "role") this.role(subject.id);
    else {
      const split = this.sql
        .exec<{ state: string; shadow: number }>(
          `SELECT s.state, s.shadow FROM fact_parts p JOIN fact_splits s ON s.id = p.split_id WHERE p.id = ?`,
          subject.id,
        )
        .toArray()[0];
      if (!split) throw new AppError("not_found", "no such part");
      if (split.state === "rejected") throw new AppError("conflict", "that way of dividing the line was turned down");
      if (split.shadow === 1 && !shadow) throw new AppError("invalid", "a part in shadow carries only shadow tags");
    }
  }

  /** True when two facts sit in one role: the same role, roles merged into one, or no role for either. */
  private inOneRole(a: string, b: string): boolean {
    const roleOf = (id: string) =>
      this.sql.exec<{ role_id: string | null }>(`SELECT role_id FROM facts WHERE id = ?`, id).toArray()[0];
    const left = roleOf(a);
    const right = roleOf(b);
    if (!left || !right) return false;
    if (left.role_id === null || right.role_id === null) return left.role_id === right.role_id;
    return this.root("role", left.role_id) === this.root("role", right.role_id);
  }

  private requireOneRole(a: string, b: string): void {
    if (!this.inOneRole(a, b)) throw new AppError("conflict", "facts are linked only inside one role; merge their roles first");
  }

  /** An item, then each item it was merged into in turn, by confirmed links alone. */
  private chain(kind: LinkKind, id: string): string[] {
    const path = [id];
    for (;;) {
      const next = this.sql
        .exec<{ to_id: string }>(
          `SELECT to_id FROM record_links WHERE kind = ? AND from_id = ? AND relation = 'same' AND state = 'confirmed' AND shadow = 0`,
          kind,
          path.at(-1)!,
        )
        .toArray()[0];
      if (!next || path.includes(next.to_id)) return path;
      path.push(next.to_id);
    }
  }

  /**
   * Makes room for a link that is about to stand, or refuses it. Two items are joined one way at
   * a time, and an item is merged into one other at most. The owner's own choice replaces an
   * offer nobody had decided; nothing else replaces anything.
   */
  private clearWay(
    link: { kind: LinkKind; from: string; to: string; relation: LinkRelation; shadow: number },
    self: string | null,
    owner: boolean,
    confirming: boolean,
  ): void {
    const rivals = this.sql
      .exec<LinkRow>(
        `SELECT * FROM record_links WHERE kind = ? AND shadow = ? AND state <> 'rejected' AND
           ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?) OR (? = 'same' AND relation = 'same' AND from_id = ?))`,
        link.kind,
        link.shadow,
        link.from,
        link.to,
        link.to,
        link.from,
        link.relation,
        link.from,
      )
      .toArray()
      .filter((row) => row.id !== self);
    for (const rival of rivals) {
      if (!owner || rival.state !== "proposed")
        throw new AppError(
          "conflict",
          rival.to_id === link.to || rival.from_id === link.to
            ? "these two are already linked another way"
            : "this is already merged into another, or offered as the same as another",
        );
      this.decide("record_links", rival.id, "rejected", "owner");
    }
    if (confirming && link.relation === "same" && link.shadow === 0 && this.chain(link.kind, link.to).includes(link.from))
      throw new AppError("conflict", "these are already merged the other way round");
  }
}

function roleIdentity(row: RoleItem) {
  return {
    kind: row.kind,
    org: row.org,
    title: row.title,
    startDate: row.start_date,
    endDate: row.end_date,
    unknownEndStartDate: row.unknown_end_start_date,
  };
}
