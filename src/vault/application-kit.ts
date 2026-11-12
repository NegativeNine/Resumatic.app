import { AppError } from "../shared/errors";
import {
  MAX_SAVED_ANSWERS,
  REFUSED_KIND_SENTENCE,
  SAVED_ANSWERS_FULL,
  SAVED_ANSWER_CHANGED,
  SAVED_ANSWER_LABEL_TAKEN,
  SAVED_ANSWER_REFUSED,
  answerKey,
  cleanSavedAnswerInput,
  refusedKind,
  savedLabelError,
  type KitExport,
  type KitQuestionRecord,
  type KitRecord,
  type KitMatchedBy,
  type KitPart,
  type KitQuestionState,
  type RefusedKind,
  type SavedAnswer,
  type SensitiveKind,
} from "../shared/kit";

// Saved answers and application kits: three tables in the owner's own vault, and this store their
// only reader and writer. The Vault reaches it from the owner's calls, the owner's export and the
// deletion of a job, and from nowhere that makes a resume, a document, a copy or a tool's answer:
// test/unit/saved-answers-reach.test.ts holds it there.
//
// A kit has no row until its first write, so revision 0 means none, as preferences do. A kit's
// answers are never facts or evidence: usableFacts(), tailoring, documents, shares and apps read
// nothing here.
//
// The tables' checks hold only what never changes: the caps, the states and which columns go
// together. Which words are refused is the rule's to say (refusedKind), because the list grows,
// and a saved answer it refuses later is kept, shown with the reason, and never used.

export const SAVED_ANSWER_MIGRATIONS: readonly string[] = [
  `CREATE TABLE saved_answers (
     id TEXT PRIMARY KEY,
     revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
     label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
     label_key TEXT NOT NULL UNIQUE CHECK (length(label_key) >= 1),
     answer_text TEXT NOT NULL CHECK (length(answer_text) BETWEEN 1 AND 4000),
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE application_kits (
     application_id TEXT PRIMARY KEY,
     revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
     state TEXT NOT NULL CHECK (state IN ('draft','approved')),
     approved_at INTEGER,
     resume_id TEXT, resume_version INTEGER,
     letter_id TEXT, letter_version INTEGER,
     prep_id TEXT, prep_version INTEGER,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     CHECK ((state = 'approved') = (approved_at IS NOT NULL)),
     CHECK ((resume_id IS NULL) = (resume_version IS NULL)),
     CHECK ((letter_id IS NULL) = (letter_version IS NULL)),
     CHECK ((prep_id IS NULL) = (prep_version IS NULL))
   )`,
  `CREATE TABLE kit_questions (
     id TEXT PRIMARY KEY,
     application_id TEXT NOT NULL,
     position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 29),
     question TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 1000),
     state TEXT NOT NULL CHECK (state IN ('matched','asks','sensitive')),
     matched_by TEXT CHECK (matched_by IS NULL OR matched_by IN ('label','judge','owner')),
     saved_answer_id TEXT,
     confirmed_revision INTEGER,
     sensitive_kind TEXT CHECK (sensitive_kind IS NULL OR sensitive_kind IN ('work_authorisation','pay','personal','judge')),
     typed_answer TEXT CHECK (typed_answer IS NULL OR length(typed_answer) BETWEEN 1 AND 4000),
     CHECK ((state = 'matched') = (saved_answer_id IS NOT NULL) AND (state = 'matched') = (matched_by IS NOT NULL)),
     CHECK (state = 'matched' OR confirmed_revision IS NULL),
     CHECK (state <> 'matched' OR typed_answer IS NULL),
     CHECK ((state = 'sensitive') = (sensitive_kind IS NOT NULL)),
     UNIQUE (application_id, position)
   )`,
  `CREATE INDEX kit_questions_by_saved_answer ON kit_questions (saved_answer_id)`,
];

interface SavedRow extends Record<string, SqlStorageValue> {
  id: string;
  revision: number;
  label: string;
  label_key: string;
  answer_text: string;
  created_at: number;
  updated_at: number;
}

interface KitRow extends Record<string, SqlStorageValue> {
  application_id: string;
  revision: number;
  state: "draft" | "approved";
  approved_at: number | null;
  resume_id: string | null;
  resume_version: number | null;
  letter_id: string | null;
  letter_version: number | null;
  prep_id: string | null;
  prep_version: number | null;
  created_at: number;
  updated_at: number;
}

interface QuestionRow extends Record<string, SqlStorageValue> {
  id: string;
  application_id: string;
  position: number;
  question: string;
  state: KitQuestionState;
  matched_by: KitMatchedBy | null;
  saved_answer_id: string | null;
  confirmed_revision: number | null;
  sensitive_kind: SensitiveKind | null;
  typed_answer: string | null;
}

/** A question as it is written: everything but where it belongs, which the write supplies. */
type QuestionValues = Omit<KitQuestionRecord, "applicationId" | "position">;

const SAVED_COLUMNS = "id, revision, label, label_key, answer_text, created_at, updated_at";
const QUESTION_COLUMNS = "id, application_id, position, question, state, matched_by, saved_answer_id, confirmed_revision, sensitive_kind, typed_answer";
const KIT_COLUMNS = "application_id, revision, state, approved_at, resume_id, resume_version, letter_id, letter_version, prep_id, prep_version, created_at, updated_at";

/** The kind today's list refuses a saved answer for, by its label first, then its text. */
const savedRefusal = (row: { label: string; answer_text: string }): RefusedKind | null => refusedKind(row.label) ?? refusedKind(row.answer_text);

const kitRecord = (row: KitRow): KitRecord => ({
  applicationId: row.application_id,
  revision: row.revision,
  state: row.state,
  approvedAt: row.approved_at,
  resume: row.resume_id === null || row.resume_version === null ? null : { id: row.resume_id, version: row.resume_version },
  letter: row.letter_id === null || row.letter_version === null ? null : { id: row.letter_id, version: row.letter_version },
  prep: row.prep_id === null || row.prep_version === null ? null : { id: row.prep_id, version: row.prep_version },
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const questionRecord = (row: QuestionRow): KitQuestionRecord => ({
  id: row.id,
  applicationId: row.application_id,
  position: row.position,
  question: row.question,
  state: row.state,
  matchedBy: row.matched_by,
  savedAnswerId: row.saved_answer_id,
  confirmedRevision: row.confirmed_revision,
  sensitiveKind: row.sensitive_kind,
  typedAnswer: row.typed_answer,
});

const savedView = (row: SavedRow): SavedAnswer => ({
  id: row.id,
  revision: row.revision,
  label: row.label,
  answer: row.answer_text,
  refusedKind: savedRefusal(row),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** The checks every saved answer's label and text pass, in order: shape and caps, a key, then today's list. */
function checkedInput(input: unknown): { label: string; answer: string; key: string } {
  const clean = cleanSavedAnswerInput(input);
  if (!clean) throw new AppError("invalid", SAVED_ANSWER_REFUSED);
  const empty = savedLabelError(clean.label);
  if (empty) throw new AppError("invalid", empty);
  const kind = refusedKind(clean.label) ?? refusedKind(clean.answer);
  if (kind) throw new AppError("invalid", REFUSED_KIND_SENTENCE[kind]);
  return { ...clean, key: answerKey(clean.label) };
}

export class ApplicationKitStore {
  constructor(private readonly sql: SqlStorage) {}

  // ---------------------------------------------------------------- saved answers

  /** Every saved answer, as its owner reads them, each with what today's list says of it. */
  listSaved(): SavedAnswer[] {
    return this.sql.exec<SavedRow>(`SELECT ${SAVED_COLUMNS} FROM saved_answers ORDER BY created_at, id`).toArray().map(savedView);
  }

  /** One saved answer, or null. */
  saved(id: string): SavedAnswer | null {
    const row = this.sql.exec<SavedRow>(`SELECT ${SAVED_COLUMNS} FROM saved_answers WHERE id = ?`, id).toArray()[0];
    return row ? savedView(row) : null;
  }

  /** The saved answers a question may be matched to, with their keys and labels: never their text. */
  usableSaved(): { id: string; label: string; labelKey: string; revision: number }[] {
    return this.sql
      .exec<SavedRow>(`SELECT ${SAVED_COLUMNS} FROM saved_answers ORDER BY created_at, id`)
      .toArray()
      .filter((row) => savedRefusal(row) === null)
      .map((row) => ({ id: row.id, label: row.label, labelKey: row.label_key, revision: row.revision }));
  }

  /** What every saved answer's match rests on, as one text: an edit, an add or a delete changes it. */
  savedDigest(): string {
    return JSON.stringify(
      this.sql.exec<{ id: string; label_key: string; revision: number }>(`SELECT id, label_key, revision FROM saved_answers ORDER BY id`).toArray().map((row) => [row.id, row.label_key, row.revision]),
    );
  }

  /**
   * Adds a saved answer, or returns the one with the same label and text: a save sent twice keeps
   * one. The checks run in order: shape and caps, a label with a key, today's list, the same key,
   * then the cap on how many are kept.
   */
  addSaved(input: unknown, now: number): SavedAnswer {
    const { label, answer, key } = checkedInput(input);
    const same = this.sql.exec<SavedRow>(`SELECT ${SAVED_COLUMNS} FROM saved_answers WHERE label_key = ?`, key).toArray()[0];
    if (same) {
      if (same.answer_text === answer) return savedView(same);
      throw new AppError("conflict", SAVED_ANSWER_LABEL_TAKEN);
    }
    if (this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM saved_answers`).one().n >= MAX_SAVED_ANSWERS)
      throw new AppError("conflict", SAVED_ANSWERS_FULL);
    const id = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO saved_answers (id, revision, label, label_key, answer_text, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)`,
      id, label, key, answer, now, now,
    );
    return this.saved(id)!;
  }

  /**
   * Replaces a saved answer's label and text, if `expectedRevision` is its revision now. The
   * checks run in order: that it exists, shape and caps, a key, today's list, the revision, then a
   * label no other saved answer has. An edit of unchanged words still takes the next revision.
   */
  editSaved(id: string, input: unknown, expectedRevision: number, now: number): SavedAnswer {
    const row = this.sql.exec<SavedRow>(`SELECT ${SAVED_COLUMNS} FROM saved_answers WHERE id = ?`, id).toArray()[0];
    if (!row) throw new AppError("not_found", "no such saved answer");
    const { label, answer, key } = checkedInput(input);
    if (row.revision !== expectedRevision) throw new AppError("conflict", SAVED_ANSWER_CHANGED);
    if (this.sql.exec(`SELECT 1 FROM saved_answers WHERE label_key = ? AND id <> ?`, key, id).toArray().length)
      throw new AppError("conflict", SAVED_ANSWER_LABEL_TAKEN);
    this.sql.exec(
      `UPDATE saved_answers SET revision = revision + 1, label = ?, label_key = ?, answer_text = ?, updated_at = ? WHERE id = ?`,
      label, key, answer, now, id,
    );
    return this.saved(id)!;
  }

  /** Returns every kit with a question that uses this saved answer to draft, at its next revision. */
  resetKitsUsing(savedAnswerId: string, now: number): void {
    this.sql.exec(
      `UPDATE application_kits SET state='draft', approved_at=NULL, revision=revision+1, updated_at=?
       WHERE application_id IN (SELECT application_id FROM kit_questions WHERE saved_answer_id=?)`,
      now, savedAnswerId,
    );
  }

  /** Deletes a saved answer. Each question matched to it asks again, and each kit using it is a draft again. */
  deleteSaved(id: string, now: number): void {
    if (!this.sql.exec(`SELECT 1 FROM saved_answers WHERE id = ?`, id).toArray().length) throw new AppError("not_found", "no such saved answer");
    this.resetKitsUsing(id, now);
    this.sql.exec(`UPDATE kit_questions SET state='asks', matched_by=NULL, saved_answer_id=NULL, confirmed_revision=NULL WHERE saved_answer_id=?`, id);
    this.sql.exec(`DELETE FROM saved_answers WHERE id = ?`, id);
  }

  // ---------------------------------------------------------------- kits

  /** A job's kit, or null before its first write. */
  kit(applicationId: string): KitRecord | null {
    const row = this.sql.exec<KitRow>(`SELECT ${KIT_COLUMNS} FROM application_kits WHERE application_id = ?`, applicationId).toArray()[0];
    return row ? kitRecord(row) : null;
  }

  /** A kit's questions, in order. */
  questions(applicationId: string): KitQuestionRecord[] {
    return this.sql.exec<QuestionRow>(`SELECT ${QUESTION_COLUMNS} FROM kit_questions WHERE application_id = ? ORDER BY position`, applicationId).toArray().map(questionRecord);
  }

  /**
   * Writes a kit's questions whole, in this order. Every row is deleted and written again, because
   * a reorder that renumbered rows in place would collide with one another on the way.
   */
  replaceQuestions(applicationId: string, rows: readonly QuestionValues[]): void {
    this.sql.exec(`DELETE FROM kit_questions WHERE application_id=?`, applicationId);
    rows.forEach((row, position) =>
      this.sql.exec(
        `INSERT INTO kit_questions (${QUESTION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, applicationId, position, row.question, row.state, row.matchedBy, row.savedAnswerId, row.confirmedRevision, row.sensitiveKind, row.typedAnswer,
      ),
    );
  }

  /** Changes one question's answer, and nothing else about it. */
  answerQuestion(applicationId: string, id: string, values: Pick<KitQuestionRecord, "state" | "matchedBy" | "savedAnswerId" | "confirmedRevision" | "typedAnswer">): void {
    this.sql.exec(
      `UPDATE kit_questions SET state = ?, matched_by = ?, saved_answer_id = ?, confirmed_revision = ?, typed_answer = ? WHERE application_id = ? AND id = ?`,
      values.state, values.matchedBy, values.savedAnswerId, values.confirmedRevision, values.typedAnswer, applicationId, id,
    );
  }

  /**
   * Makes the kit a draft at its next revision, made now if it had no row. Every write to a kit
   * ends here, even one that changes nothing, so an approval never outlives a change.
   */
  touchDraft(applicationId: string, now: number): void {
    this.sql.exec(
      `INSERT INTO application_kits (application_id, revision, state, approved_at, created_at, updated_at) VALUES (?, 1, 'draft', NULL, ?, ?)
       ON CONFLICT (application_id) DO UPDATE SET revision = revision + 1, state = 'draft', approved_at = NULL, updated_at = excluded.updated_at`,
      applicationId, now, now,
    );
  }

  /** Replaces the kit's three choices, as a draft at its next revision. */
  setParts(applicationId: string, parts: { resume: KitPart | null; letter: KitPart | null; prep: KitPart | null }, now: number): void {
    this.touchDraft(applicationId, now);
    this.sql.exec(
      `UPDATE application_kits SET resume_id = ?, resume_version = ?, letter_id = ?, letter_version = ?, prep_id = ?, prep_version = ? WHERE application_id = ?`,
      parts.resume?.id ?? null, parts.resume?.version ?? null, parts.letter?.id ?? null, parts.letter?.version ?? null,
      parts.prep?.id ?? null, parts.prep?.version ?? null, applicationId,
    );
  }

  /** Approves a draft at its next revision. */
  approve(applicationId: string, now: number): void {
    this.sql.exec(`UPDATE application_kits SET state = 'approved', approved_at = ?, revision = revision + 1, updated_at = ? WHERE application_id = ?`, now, now, applicationId);
  }

  /** Erases a job's kit: its questions, then its row. */
  deleteKit(applicationId: string): void {
    this.sql.exec(`DELETE FROM kit_questions WHERE application_id=?`, applicationId);
    this.sql.exec(`DELETE FROM application_kits WHERE application_id=?`, applicationId);
  }

  /** All three tables for the owner's export, every row as stored, revisions included. */
  export(): KitExport {
    return {
      savedAnswers: this.sql.exec<SavedRow>(`SELECT ${SAVED_COLUMNS} FROM saved_answers ORDER BY created_at, id`).toArray().map((row) => ({
        id: row.id,
        revision: row.revision,
        label: row.label,
        labelKey: row.label_key,
        answer: row.answer_text,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      applicationKits: this.sql.exec<KitRow>(`SELECT ${KIT_COLUMNS} FROM application_kits ORDER BY created_at, application_id`).toArray().map(kitRecord),
      kitQuestions: this.sql.exec<QuestionRow>(`SELECT ${QUESTION_COLUMNS} FROM kit_questions ORDER BY application_id, position`).toArray().map(questionRecord),
    };
  }
}
