/** User-authored answers retain their original wording and the question that elicited them. */
export const INTERVIEW_MIGRATIONS = [
  `CREATE TABLE interview_answers (
    fact_id TEXT PRIMARY KEY REFERENCES facts(id),
    document_id TEXT NOT NULL REFERENCES documents(id), question_id TEXT NOT NULL,
    question TEXT NOT NULL, quote TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE,
    input_digest TEXT NOT NULL, created_at INTEGER NOT NULL
  )`,
] as const;
