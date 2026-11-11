import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ResumeBody, ResumeLine } from "../../src/shared/api";
import type { FactRecord } from "../../src/shared/types";
import { createSchema } from "../../src/vault/schema";
import { isWithheld, sensitiveUse, setSensitive, usableQuote, withheldFacts, type Withheld } from "../../src/vault/sensitive";
import { evidenceForFacts } from "../../src/vault/snapshots";

// The one place that says which facts are withheld, on the vault's whole schema in Node's SQLite,
// so the triggers that guard a fact are the ones a real vault has.

const SKILLS = "Go, TypeScript, Kubernetes, PostgreSQL";
const LED = "Led the migration of 40 services to Kubernetes";

function vault() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(statement: string, ...bindings: (string | number | null)[]) {
      const rows = db.prepare(statement).all(...bindings);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
  let depth = 0;
  const transaction = <T>(fn: () => T): T => {
    const name = `sensitive_${depth++}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw error;
    } finally {
      depth--;
    }
  };
  createSchema(sql, transaction);
  const run = (statement: string, ...bindings: (string | number | null | Uint8Array)[]) => void db.prepare(statement).run(...bindings);
  run(`INSERT INTO sources (id, filename, r2_key, markdown, state, created_at) VALUES ('source', 'resume.pdf', 'vaults/test/sources/source', '', 'ready', 1)`);
  /** A fact read from an upload, with the line it was read from, or one its owner typed (no quote). */
  const fact = (id: string, text: string, quote: string | null, kind = "accomplishment") => {
    if (quote !== null) run(`INSERT INTO evidence (id, source_id, quote) VALUES (?, 'source', ?)`, `quote-${id}`, quote);
    run(
      `INSERT INTO facts (id, kind, text, evidence_id, source_id, origin, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 7)`,
      id, kind, text, quote === null ? null : `quote-${id}`, quote === null ? null : "source", quote === null ? "user" : "extracted",
    );
  };
  const row = (id: string) =>
    db.prepare(`SELECT f.*, i.value AS incarnation FROM facts f JOIN entity_incarnations i ON i.kind = 'fact' AND i.item_id = f.id WHERE f.id = ?`).get(id) as Record<string, unknown>;
  return { db, sql, run, fact, row };
}

const none: Withheld = { ids: new Set(), quotes: new Set() };
const held = (ids: string[], quotes: string[] = []): Withheld => ({ ids: new Set(ids), quotes: new Set(quotes) });

describe("which facts are withheld", () => {
  it("is nothing when no fact is marked, and a new fact starts unmarked", () => {
    const { db, sql, fact, row } = vault();
    try {
      fact("go", "Go", SKILLS, "skill");
      fact("typed", "Ran the on-call rotation", null);
      expect(row("go").sensitive).toBe(0);
      const withheld = withheldFacts(sql);
      expect([...withheld.ids]).toEqual([]);
      expect([...withheld.quotes]).toEqual([]);
    } finally { db.close(); }
  });

  it("is the marked facts by ID, and the exact line each was read from", () => {
    const { db, sql, fact } = vault();
    try {
      fact("kubernetes", "Kubernetes", SKILLS, "skill");
      fact("go", "Go", SKILLS, "skill");
      fact("led", LED, `${LED}, cutting deploy time by 60%`);
      fact("typed", "Ran the on-call rotation", null);
      setSensitive(sql, ["kubernetes", "typed"], true);
      const withheld = withheldFacts(sql);
      expect([...withheld.ids].sort()).toEqual(["kubernetes", "typed"]);
      // A fact its owner typed has no line. The other skill of the list is not marked, but its line is withheld.
      expect([...withheld.quotes]).toEqual([SKILLS]);
      setSensitive(sql, ["led"], true);
      expect([...withheldFacts(sql).quotes].sort()).toEqual([SKILLS, `${LED}, cutting deploy time by 60%`].sort());
      setSensitive(sql, ["kubernetes", "typed", "led"], false);
      expect(withheldFacts(sql)).toEqual({ ids: new Set(), quotes: new Set() });
    } finally { db.close(); }
  });

  it("keeps the line of a marked fact its owner has since reworded", () => {
    const { db, sql, run, fact } = vault();
    try {
      fact("kubernetes", "Kubernetes", SKILLS, "skill");
      setSensitive(sql, ["kubernetes"], true);
      // An edit makes the fact the owner's own claim; the quote stays beside it, and so does the mark.
      run(`UPDATE facts SET text = 'Kubernetes in production', origin = 'user', revision = revision + 1 WHERE id = 'kubernetes'`);
      expect(withheldFacts(sql)).toEqual({ ids: new Set(["kubernetes"]), quotes: new Set([SKILLS]) });
    } finally { db.close(); }
  });

  it("marks and unmarks without touching anything a line is checked against", () => {
    const { db, sql, run, fact, row } = vault();
    try {
      fact("led", LED, LED);
      run(`UPDATE facts SET level = 'led', vector = ? WHERE id = 'led'`, new Uint8Array([1, 2, 3, 4]));
      const before = row("led");
      setSensitive(sql, ["led"], true);
      // No trigger names the column: the revision and the incarnation a running draft compares stay put.
      expect(row("led")).toEqual({ ...before, sensitive: 1 });
      setSensitive(sql, ["led"], true);
      expect(row("led")).toEqual({ ...before, sensitive: 1 });
      setSensitive(sql, ["led", "no-such-fact"], false);
      expect(row("led")).toEqual(before);
      // The column holds a mark or no mark, and nothing else.
      expect(() => run(`UPDATE facts SET sensitive = 2 WHERE id = 'led'`)).toThrow(/CHECK constraint failed/);
      expect(() => run(`UPDATE facts SET sensitive = NULL WHERE id = 'led'`)).toThrow(/NOT NULL constraint failed/);
    } finally { db.close(); }
  });
});

describe("the quote a fact may be used with", () => {
  const withheld = held(["kubernetes"], [SKILLS]);

  it("is none for a fact its owner wrote, as it always was", () => {
    expect(usableQuote({ origin: "user", text: "Go", quote: SKILLS }, none)).toBeNull();
    expect(usableQuote({ origin: "user", text: "Go", quote: SKILLS }, withheld)).toBeNull();
    expect(usableQuote({ origin: "user", text: "Go", quote: null }, withheld)).toBeNull();
  });

  it("is the fact's own words when its line is one a marked fact was read from", () => {
    expect(usableQuote({ origin: "extracted", text: "Go", quote: SKILLS }, withheld)).toBe("Go");
    // The same line in another upload is the same words, so it is covered too.
    expect(usableQuote({ origin: "extracted", text: "PostgreSQL", quote: `${SKILLS}` }, withheld)).toBe("PostgreSQL");
  });

  it("is its own line otherwise", () => {
    expect(usableQuote({ origin: "extracted", text: "Go", quote: SKILLS }, none)).toBe(SKILLS);
    expect(usableQuote({ origin: "extracted", text: "Mentored 2 junior engineers", quote: "Mentored 2 junior engineers" }, withheld)).toBe("Mentored 2 junior engineers");
    expect(usableQuote({ origin: "extracted", text: "Go", quote: `Skills: ${SKILLS}` }, withheld)).toBe(`Skills: ${SKILLS}`);
    expect(usableQuote({ origin: "extracted", text: "Go", quote: null }, withheld)).toBeNull();
  });
});

describe("whether stored work rests on a withheld fact", () => {
  const withheld = held(["kubernetes"], [SKILLS]);

  it("does when it cites the marked fact, whatever was stored with it", () => {
    expect(isWithheld("kubernetes", { text: "Kubernetes", quote: SKILLS }, withheld)).toBe(true);
    expect(isWithheld("kubernetes", { text: "Kubernetes", quote: null }, withheld)).toBe(true);
    expect(isWithheld("kubernetes", undefined, withheld)).toBe(true);
  });

  it("does when the fact was stored with a marked fact's line, and not when it was stored with its own words", () => {
    expect(isWithheld("go", { text: "Go", quote: SKILLS }, withheld)).toBe(true);
    expect(isWithheld("go", { text: "Go", quote: "Go" }, withheld)).toBe(false);
    expect(isWithheld("go", { text: "Go", quote: null }, withheld)).toBe(false);
    expect(isWithheld("go", undefined, withheld)).toBe(false);
    // A fact that is the whole line says only its own words: the line is its text, not more than it.
    expect(isWithheld("list", { text: SKILLS, quote: SKILLS }, withheld)).toBe(false);
    expect(isWithheld("go", { text: "Go", quote: SKILLS }, none)).toBe(false);
  });
});

describe("what a resume version takes from marked facts", () => {
  const record = (id: string, text: string, quote: string | null, extra: Partial<FactRecord> = {}): FactRecord => ({
    id, revision: 1, origin: quote === null ? "user" : "extracted", roleId: "role", kind: "accomplishment", text, level: null, quote,
    ...(quote === null ? { levelExplicit: false } : {}), ...extra,
  });
  const line = (id: string, factIds: string[]): ResumeLine => ({ id, text: `Line ${id}`, factIds, status: "kept" });
  const section = (lines: ResumeLine[]) => ({ roleId: "role", kind: "job" as const, org: "Acme", title: null, startDate: null, endDate: null, lines });
  /** A version's stored facts and full evidence, as the vault saves them together. */
  const saved = (records: FactRecord[]) => ({
    facts: Object.fromEntries(records.map((item) => [item.id, { text: item.text, quote: item.quote }])),
    evidence: evidenceForFacts(records),
  });
  const use = (body: ResumeBody, records: FactRecord[], withheld: Withheld) => {
    const { facts, evidence } = saved(records);
    return sensitiveUse(body, facts, evidence, withheld);
  };

  const led = record("led", LED, LED);
  const mentored = record("mentored", "Mentored 2 junior engineers", "Mentored 2 junior engineers");
  const kubernetes = record("kubernetes", "Kubernetes", SKILLS, { kind: "skill", roleId: null });
  const go = record("go", "Go", SKILLS, { kind: "skill", roleId: null });

  it("finds each line that cites a marked fact, the summary included, and no other", () => {
    const body: ResumeBody = {
      summary: line("summary", ["mentored", "led"]),
      sections: [section([line("first", ["led"]), line("second", ["mentored"])]), section([line("third", ["mentored", "led"])])],
      skills: [],
    };
    expect(use(body, [led, mentored], held(["led"], [LED]))).toEqual({ lineIds: ["summary", "first", "third"], skills: [] });
    expect(use(body, [led, mentored], held(["mentored"], ["Mentored 2 junior engineers"]))).toEqual({ lineIds: ["summary", "second", "third"], skills: [] });
    expect(use(body, [led, mentored], none)).toEqual({ lineIds: [], skills: [] });
    expect(use(body, [led, mentored], held(["another"], ["Another line"]))).toEqual({ lineIds: [], skills: [] });
    // By its ID alone, when an older version kept nothing about the fact.
    expect(sensitiveUse(body, {}, undefined, held(["led"]))).toEqual({ lineIds: ["summary", "first", "third"], skills: [] });
    expect(sensitiveUse(body, undefined, undefined, held(["led"]))).toEqual({ lineIds: ["summary", "first", "third"], skills: [] });
  });

  it("finds a line that cites a fact stored with a marked fact's line, and not one stored with its own words", () => {
    const body: ResumeBody = { summary: null, sections: [section([line("uses-go", ["go"])])], skills: [] };
    const withheld = held(["kubernetes"], [SKILLS]);
    // Checked while "Go" still had the whole skills list for a quote, so the line may rest on "Kubernetes".
    expect(use(body, [go], withheld)).toEqual({ lineIds: ["uses-go"], skills: [] });
    // Written after the mark: "Go" was captured with its own word as its only evidence.
    expect(use(body, [{ ...go, quote: "Go" }], withheld)).toEqual({ lineIds: [], skills: [] });
    expect(use(body, [{ ...go, origin: "user", quote: null, levelExplicit: false }], withheld)).toEqual({ lineIds: [], skills: [] });
  });

  it("finds a printed skill only when every record behind it is marked", () => {
    const body: ResumeBody = { summary: null, sections: [], skills: ["Go", "Kubernetes"] };
    expect(use(body, [go, kubernetes], held(["kubernetes"], [SKILLS]))).toEqual({ lineIds: [], skills: ["Kubernetes"] });
    // The same skill from a second upload, left unmarked, still stands behind the printed word.
    const again = record("kubernetes-2", "Kubernetes", "Kubernetes, Terraform", { kind: "skill", roleId: null });
    expect(use(body, [go, kubernetes, again], held(["kubernetes"], [SKILLS]))).toEqual({ lineIds: [], skills: [] });
    expect(use(body, [go, kubernetes, again], held(["kubernetes", "kubernetes-2"], [SKILLS, "Kubernetes, Terraform"]))).toEqual({ lineIds: [], skills: ["Kubernetes"] });
    // A marked fact of another kind with the same word is not what printed the skill.
    const mention = record("mention", "Kubernetes", "Kubernetes", { kind: "credential", roleId: null });
    expect(use({ ...body, skills: ["Kubernetes"] }, [mention, again], held(["mention"], ["Kubernetes"]))).toEqual({ lineIds: [], skills: [] });
  });

  it("does not find a printed skill that only shares a marked skill's line", () => {
    const body: ResumeBody = { summary: null, sections: [], skills: ["Go"] };
    // "Go" prints as its own word. Nothing on the sheet rests on the rest of its line.
    expect(use(body, [go, kubernetes], held(["kubernetes"], [SKILLS]))).toEqual({ lineIds: [], skills: [] });
  });

  it("finds nothing in a body it can't read", () => {
    const withheld = held(["led"], [LED]);
    const { facts, evidence } = saved([led]);
    for (const body of [
      null,
      undefined,
      "body",
      {},
      { summary: null, sections: "none", skills: [] },
      { summary: null, sections: [], skills: "Go" },
      { summary: null, sections: [null], skills: [] },
      { summary: null, sections: [{ lines: "none" }], skills: [] },
      { summary: null, sections: [{ lines: [null] }], skills: [] },
      { summary: { id: "summary", factIds: "led" }, sections: [], skills: [] },
      { summary: { id: 7, factIds: ["led"] }, sections: [], skills: [] },
      { summary: { id: "summary", factIds: ["led", 7] }, sections: [], skills: [] },
      { summary: { id: "summary", factIds: ["led"] }, sections: [], skills: [7] },
    ])
      expect(sensitiveUse(body as unknown as ResumeBody, facts, evidence, withheld), JSON.stringify(body)).toEqual({ lineIds: [], skills: [] });
    // Stored facts that are not a map are read as none, and the citation still counts by its ID.
    const body: ResumeBody = { summary: line("summary", ["led"]), sections: [], skills: [] };
    expect(sensitiveUse(body, [] as unknown as Record<string, { text: string; quote: string | null }>, evidence, withheld)).toEqual({ lineIds: ["summary"], skills: [] });
  });
});
