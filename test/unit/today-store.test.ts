import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MAX_TODAY_LIST, MAX_TODAY_RECENT, TODAY_RECENT_MS } from "../../src/shared/today";
import { TodayStore, todayView, type TodayParts } from "../../src/vault/today";

const now = 1_800_000_000_000;
const DAY = 86_400_000;

/** The tables Today reads, with the columns it must not read beside the ones it does. */
function store() {
  const db = new DatabaseSync(":memory:");
  const statements: string[] = [];
  const sql = {
    exec(statement: string, ...bindings: (string | number | null)[]) {
      statements.push(statement);
      const values = db.prepare(statement).all(...bindings);
      return { toArray: () => values };
    },
  } as unknown as SqlStorage;
  db.exec(`CREATE TABLE sources (id TEXT PRIMARY KEY, filename TEXT NOT NULL, r2_key TEXT NOT NULL, markdown TEXT, state TEXT NOT NULL, error TEXT, run_id TEXT, created_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE applications (id TEXT PRIMARY KEY, company TEXT, title TEXT, jd_text TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE resumes (id TEXT PRIMARY KEY, application_id TEXT NOT NULL, state TEXT NOT NULL, step TEXT, error TEXT, body TEXT, created_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE resume_versions (resume_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(resume_id, version))`);
  db.exec(`CREATE TABLE documents (id TEXT PRIMARY KEY, application_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, result TEXT, error TEXT, created_at INTEGER NOT NULL)`);
  db.prepare(`INSERT INTO applications (id, company, title, jd_text, created_at) VALUES ('app', 'Litware', 'Platform Engineer', 'The whole posting, which Today never reads', ?)`).run(now - DAY);
  const source = (id: string, state: string, createdAt: number, extra: { error?: string; markdown?: string } = {}) =>
    db.prepare(`INSERT INTO sources (id, filename, r2_key, markdown, state, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, `${id}.pdf`, `vaults/v/sources/${id}`, extra.markdown ?? null, state, extra.error ?? null, createdAt);
  return { db, today: new TodayStore(sql), statements, source };
}

/** Nothing at all, for a test to fill in one part of. */
const nothing = (): TodayParts => ({
  check: new Map(),
  sourceNames: new Map(),
  unreadable: [],
  comments: [],
  suggestions: [],
  kits: [],
  jobNames: new Map(),
  working: [],
  resumesReady: [],
  copiesOpened: [],
  coachComments: [],
});

describe("Today's reads", () => {
  it("lists work in progress newest first, at most fifty of each", () => {
    const { db, today, source } = store();
    try {
      for (let i = 0; i < 60; i++) {
        source(`queued-${i}`, "queued", now - 10_000 + i * 3);
        db.prepare(`INSERT INTO resumes (id, application_id, state, step, created_at) VALUES (?, 'app', 'running', 'select', ?)`).run(`resume-${i}`, now - 10_000 + i * 3 + 1);
        db.prepare(`INSERT INTO documents (id, application_id, kind, state, created_at) VALUES (?, 'app', 'letter', 'running', ?)`).run(`doc-${i}`, now - 10_000 + i * 3 + 2);
      }
      // Finished work is not in progress.
      source("ready", "ready", now);
      db.prepare(`INSERT INTO resumes (id, application_id, state, created_at) VALUES ('done', 'app', 'ready', ?)`).run(now);
      db.prepare(`INSERT INTO documents (id, application_id, kind, state, created_at) VALUES ('written', 'app', 'prep', 'ready', ?)`).run(now);

      const working = today.working(MAX_TODAY_LIST);
      const of = (kind: string) => working.filter((item) => item.kind === kind);
      expect([of("reading").length, of("tailoring").length, of("document").length]).toEqual([50, 50, 50]);
      expect(of("reading")[0]).toEqual({ kind: "reading", sourceId: "queued-59", filename: "queued-59.pdf", startedAt: now - 10_000 + 59 * 3 });
      expect(of("tailoring")[0]).toEqual({ kind: "tailoring", resumeId: "resume-59", step: "select", startedAt: now - 10_000 + 59 * 3 + 1, applicationId: "app", title: "Platform Engineer", company: "Litware" });
      expect(of("document")[0]).toEqual({ kind: "document", documentId: "doc-59", documentKind: "letter", startedAt: now - 10_000 + 59 * 3 + 2, applicationId: "app", title: "Platform Engineer", company: "Litware" });
      expect(of("reading").at(-1)).toMatchObject({ sourceId: "queued-10" });

      // Today puts all three together, newest first, and at one moment by kind and then by ID.
      const view = todayView({ ...nothing(), working }, now);
      const started = view.working.map((item) => item.startedAt);
      expect(started).toEqual([...started].sort((a, b) => b - a));
      expect(view.working.slice(0, 3).map((item) => item.kind)).toEqual(["document", "tailoring", "reading"]);
      const tied = todayView({
        ...nothing(),
        working: [
          { kind: "tailoring", resumeId: "b", step: null, startedAt: now, applicationId: "app", title: null, company: null },
          { kind: "reading", sourceId: "z", filename: "z.pdf", startedAt: now },
          { kind: "tailoring", resumeId: "a", step: null, startedAt: now, applicationId: "app", title: null, company: null },
        ],
      }, now);
      expect(tied.working.map((item) => (item.kind === "tailoring" ? item.resumeId : item.kind))).toEqual(["reading", "a", "b"]);
    } finally {
      db.close();
    }
  });

  it("keeps recent versions inside the window only", () => {
    const { db, today } = store();
    try {
      const since = now - TODAY_RECENT_MS;
      db.prepare(`INSERT INTO resumes (id, application_id, state, created_at) VALUES ('r1', 'app', 'ready', ?)`).run(now - 20 * DAY);
      const version = (v: number, at: number) => db.prepare(`INSERT INTO resume_versions (resume_id, version, data, created_at) VALUES ('r1', ?, '{"lines":"never read"}', ?)`).run(v, at);
      version(1, now - 20 * DAY);
      version(2, since - 1);
      version(3, since);
      for (let v = 4; v < 20; v++) version(v, now - (20 - v) * 1000);

      const ready = today.resumesReady(since, MAX_TODAY_RECENT);
      expect(ready).toHaveLength(MAX_TODAY_RECENT);
      expect(ready[0]).toEqual({ kind: "resumeReady", resumeId: "r1", version: 19, at: now - 1000, applicationId: "app", title: "Platform Engineer", company: "Litware" });
      expect(ready.map((event) => event.version)).toEqual([19, 18, 17, 16, 15, 14, 13, 12, 11, 10]);
      // The window starts at `since` itself, and nothing before it is read.
      expect(today.resumesReady(since, 100).map((event) => event.version).at(-1)).toBe(3);

      // Today keeps ten events from the window, newest first, whichever kind they are.
      const view = todayView({
        ...nothing(),
        resumesReady: today.resumesReady(since, MAX_TODAY_RECENT),
        copiesOpened: [{ grantId: "g1", label: "For Dana", coachName: null, coachEmail: null, at: now - 500 }, { grantId: "old", label: null, coachName: null, coachEmail: null, at: since - 1 }],
        coachComments: [{ grantId: "g1", coachName: "Dana", coachEmail: "dana@example.test", at: now - 1000 }],
      }, now);
      expect(view.since).toBe(since);
      expect(view.recent).toHaveLength(MAX_TODAY_RECENT);
      expect(view.recent.slice(0, 3).map((event) => event.kind)).toEqual(["copyOpened", "coachCommented", "resumeReady"]);
      expect(view.recent.some((event) => event.kind === "copyOpened" && event.grantId === "old")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("totals counts over every row, past the list cap", () => {
    const copies = Array.from({ length: 60 }, (_, i) => ({ grantId: `g${i}`, coachName: null, coachEmail: `coach${i}@example.test`, count: 2, latest: now - i }));
    const kits = Array.from({ length: 60 }, (_, i) => ({ applicationId: `job-${i}`, unanswered: 1, sensitive: i % 2 }));
    const view = todayView({
      ...nothing(),
      check: new Map([["s1", { roles: 1, facts: 3 }], [null, { roles: 0, facts: 2 }]]),
      sourceNames: new Map([["s1", "cv.pdf"]]),
      unreadable: [{ sourceId: "bad", filename: "bad.pdf", createdAt: now }],
      comments: copies,
      suggestions: copies.map((copy) => ({ ...copy, count: 1 })),
      kits,
      jobNames: new Map(kits.slice(0, MAX_TODAY_LIST).map((kit) => [kit.applicationId, { title: "Engineer", company: null }])),
    }, now);
    const of = (kind: string) => view.waiting.filter((item) => item.kind === kind);
    expect([of("comments").length, of("suggestions").length, of("kit").length]).toEqual([50, 50, 50]);
    expect(of("check")).toEqual([
      { kind: "check", sourceId: "s1", filename: "cv.pdf", roles: 1, facts: 3 },
      { kind: "check", sourceId: null, filename: null, roles: 0, facts: 2 },
    ]);
    expect(of("kit")[1]).toEqual({ kind: "kit", applicationId: "job-1", title: "Engineer", company: null, unanswered: 1, sensitive: 1 });
    // Facts: six to check and one file. Jobs: sixty unanswered and thirty sensitive. Sharing: 120 comments and 60 suggestions.
    expect(view.counts).toEqual({ facts: 7, jobs: 90, sharing: 180, today: 277 });
  });

  it("reads only each file's ID and name", () => {
    const { db, today, statements, source } = store();
    try {
      source("ok", "ready", now - 3, { markdown: "PRIVATE MARKDOWN" });
      source("bad", "failed", now - 2, { error: "PRIVATE PROVIDER ERROR" });
      source("bad-too", "failed", now - 1, { error: "ANOTHER" });
      source("reading", "queued", now);
      expect(today.sourceNames()).toEqual(new Map([["ok", "ok.pdf"], ["bad", "bad.pdf"], ["bad-too", "bad-too.pdf"], ["reading", "reading.pdf"]]));
      const unreadable = today.unreadable();
      expect(unreadable).toEqual([
        { sourceId: "bad-too", filename: "bad-too.pdf", createdAt: now - 1 },
        { sourceId: "bad", filename: "bad.pdf", createdAt: now - 2 },
      ]);
      const working = today.working(MAX_TODAY_LIST);
      expect(working).toEqual([{ kind: "reading", sourceId: "reading", filename: "reading.pdf", startedAt: now }]);
      const shown = JSON.stringify(todayView({ ...nothing(), sourceNames: today.sourceNames(), unreadable, working }, now));
      expect(shown).not.toMatch(/PRIVATE|ANOTHER|r2_key|vaults\//);
      // Not a file's text, its stored error, its storage key or the whole row: only its ID, name, state and time.
      const reads = statements.filter((statement) => /\bFROM sources\b/.test(statement));
      expect(reads.length).toBeGreaterThan(2);
      for (const statement of reads) {
        expect(statement).not.toMatch(/\*|markdown|error|r2_key|run_id/);
        expect(statement).toMatch(/^SELECT id, filename(, created_at)? FROM sources/);
      }
      // Nor the posting, a resume's lines or a document's words.
      expect(statements.join("\n")).not.toMatch(/jd_text|body|data|result/);
    } finally {
      db.close();
    }
  });

  it("names the jobs it is asked about, and leaves out one that has gone", () => {
    const { db, today } = store();
    try {
      expect(today.jobNames([])).toEqual(new Map());
      expect(today.jobNames(["app", "gone"])).toEqual(new Map([["app", { title: "Platform Engineer", company: "Litware" }]]));
    } finally {
      db.close();
    }
  });
});
