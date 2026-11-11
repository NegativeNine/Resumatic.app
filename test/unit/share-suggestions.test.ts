import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ResumeBody } from "../../src/shared/api";
import { isVisibleLine, unchangedWording, type ShareSnapshot, type ShareTarget } from "../../src/shared/sharing";
import { SHARE_COMMENT_MIGRATIONS } from "../../src/vault/share-comments";
import {
  SHARE_SUGGESTION_MIGRATIONS,
  coachStanding,
  isVerdict,
  lineAsShown,
  ownerStanding,
  type BoundCheck,
} from "../../src/vault/share-suggestions";
import { httpRoute } from "../../src/worker/limits";
import { removeSuggestionMigration } from "../support/undo-vault-incarnation";

const QUOTE = "Built the billing API";
const open = { suggestion_state: "open", quote: QUOTE };
const declined = { suggestion_state: "declined", quote: QUOTE };
const check = (state: string, error: string | null = null, nextStep: number | null = 2): BoundCheck => ({ state, error, nextStep });
/** The check refused the wording: `invalid` while verify, the third step, was under way. */
const verdict = check("failed", "invalid", 2);

describe("where a suggestion stands", () => {
  it("stands for its owner in each of six states", () => {
    expect(ownerStanding(open, null, QUOTE)).toBe("waiting");
    expect(ownerStanding(open, check("running", null, 1), QUOTE)).toBe("checking");
    expect(ownerStanding(open, check("ready", null, 3), QUOTE)).toBe("applied");
    expect(ownerStanding(open, verdict, QUOTE)).toBe("not_applied");
    expect(ownerStanding(declined, null, QUOTE)).toBe("declined");
    expect(ownerStanding(open, null, `${QUOTE}, rewritten`)).toBe("stale");
    expect(ownerStanding(open, null, null)).toBe("stale");
    // The first that holds: a decline over an out-of-date line, a check over the line as it is now.
    expect(ownerStanding(declined, null, null)).toBe("declined");
    expect(ownerStanding(open, check("running"), null)).toBe("checking");
    expect(ownerStanding(open, check("ready", null, 3), null)).toBe("applied");
    expect(ownerStanding(open, verdict, null)).toBe("not_applied");
    // A check that ended without a verdict leaves it as the line says.
    expect(ownerStanding(open, check("failed", "conflict", 3), QUOTE)).toBe("waiting");
    expect(ownerStanding(open, check("failed", "conflict", 3), "Other words")).toBe("stale");
  });

  it("stands for its coach in one of three, whatever the line is now", () => {
    for (const [row, bound, expected] of [
      [open, null, "waiting"],
      [open, check("running"), "waiting"],
      [open, check("failed", "conflict", 3), "waiting"],
      [open, check("failed", "quota", 2), "waiting"],
      [open, check("ready", null, 3), "used"],
      [open, verdict, "not_used"],
      [declined, null, "not_used"],
    ] as const)
      expect(coachStanding(row, bound), JSON.stringify([row, bound])).toBe(expected);
    // It takes no line at all: a line changed or gone tells the coach nothing.
    expect(coachStanding.length).toBe(2);
  });

  it("counts a refusal only at the verify step", () => {
    expect(isVerdict(verdict)).toBe(true);
    for (const [why, bound] of [
      ["invalid before the verify step", check("failed", "invalid", 1)],
      ["invalid at the finish", check("failed", "invalid", 3)],
      ["a changed resume or fact", check("failed", "conflict", 2)],
      ["a spent budget", check("failed", "quota", 2)],
      ["a cancel", check("failed", "Cancelled.", 2)],
      ["a move", check("failed", "Work was interrupted by maintenance. Start a new run.", null)],
      ["a missing run row", check("failed", "invalid", null)],
      ["still running", check("running", null, 2)],
      ["applied", check("ready", null, 3)],
      ["no check", null],
    ] as const)
      expect(isVerdict(bound), why).toBe(false);
  });
});

describe("the line a suggestion is about, as a copy shows it", () => {
  const body: ResumeBody = {
    summary: { id: "summary", text: "Backend engineer", factIds: ["f1"], status: "kept" },
    sections: [
      {
        roleId: "r1", kind: "job", org: "Acme", title: "Engineer", startDate: "2020", endDate: null,
        lines: [
          { id: "bullet", text: `• ${QUOTE}`, factIds: ["f1"], status: "kept" },
          { id: "twice", text: "One", factIds: ["f1"], status: "kept" },
          { id: "twice", text: "Two", factIds: ["f1"], status: "kept" },
        ],
      },
    ],
    skills: [],
  };
  it("reads the summary as it is and a line without its imported list marker; anything but one line is none", () => {
    expect(lineAsShown(body, "summary")).toBe("Backend engineer");
    expect(lineAsShown(body, "bullet")).toBe(QUOTE);
    expect(lineAsShown(body, "twice")).toBeNull();
    expect(lineAsShown(body, "missing")).toBeNull();
    expect(lineAsShown(null, "summary")).toBeNull();
    expect(lineAsShown({ sections: "x" } as unknown as ResumeBody, "summary")).toBeNull();
  });

  it("takes wording as the line's own when it would print the same there: a list marker is no change under a role, and is one in the summary", () => {
    const snapshot = { resumes: [{ id: "r1", version: 1, ...body }], facts: [] } as unknown as ShareSnapshot;
    const at = (lineId: string, version = 1): ShareTarget => ({ kind: "line", resumeId: "r1", version, lineId });
    for (const text of [QUOTE, `• ${QUOTE}`, `- ${QUOTE}`, `1. ${QUOTE}`, `* - ${QUOTE}`]) expect(unchangedWording(snapshot, at("bullet"), text), text).toBe(true);
    for (const text of [`${QUOTE}.`, `Rebuilt ${QUOTE}`, "Backend engineer"]) expect(unchangedWording(snapshot, at("bullet"), text), text).toBe(false);
    // The summary is printed as it is, so a marker there is wording a reader sees.
    expect(unchangedWording(snapshot, at("summary"), "Backend engineer")).toBe(true);
    expect(unchangedWording(snapshot, at("summary"), "- Backend engineer")).toBe(false);
    // Nothing the copy doesn't hold is anyone's wording.
    expect(unchangedWording(snapshot, at("missing"), QUOTE)).toBe(false);
    expect(unchangedWording(snapshot, at("bullet", 2), QUOTE)).toBe(false);
  });
});

describe("one line of characters that show", () => {
  it("refuses a second line and characters that don't show", () => {
    for (const [why, text] of [
      ["line feed", "One\nTwo"],
      ["carriage return", "One\rTwo"],
      ["line separator", "One Two"],
      ["paragraph separator", "One Two"],
      ["tab", "One\tTwo"],
      ["bell", "One\u0007"],
      ["zero-width space", "One​Two"],
      ["zero-width joiner", "One‍Two"],
      ["bidi override", "‮owT enO"],
      ["bidi isolate", "One ⁦Two⁩"],
      ["tag character", "One\u{E0041}"],
      ["variation selector", "One️"],
      ["supplementary variation selector", "One\u{E0100}"],
      ["private use", "One"],
      ["lone surrogate", "One\ud800"],
      ["Hangul filler", "OneㅤTwo"],
      ["combining grapheme joiner", "One͏Two"],
      ["soft hyphen", "One­Two"],
      ["byte order mark", "﻿One"],
    ] as const)
      expect(isVisibleLine(text), why).toBe(false);
  });

  it("allows accents, curly quotes, a no-break space and an emoji", () => {
    for (const text of ["Led the café’s “new” menu", "Résumé naïve façade", "40 services", "Shipped it 🚀", "Built the API"])
      expect(isVisibleLine(text), text).toBe(true);
  });

  it("is written with escapes only: the file that holds it has no character it would refuse", () => {
    const source = readFileSync(resolve(process.cwd(), "src/shared/sharing.ts"), "utf8");
    const lines = source.split("\n");
    expect(lines.length).toBeGreaterThan(100);
    for (const [index, line] of lines.entries()) expect(isVisibleLine(line), `line ${index + 1}`).toBe(true);
  });
});

describe("the columns", () => {
  /** The comments' table in memory, holding one comment. */
  function table() {
    const db = new DatabaseSync(":memory:");
    const sql = {
      exec(statement: string, ...bindings: (string | number | null)[]) {
        const values = db.prepare(statement).all(...bindings);
        return { toArray: () => values };
      },
    } as unknown as SqlStorage;
    for (const statement of SHARE_COMMENT_MIGRATIONS) db.exec(statement);
    db.exec(
      `INSERT INTO share_comments (id, grant_id, target_kind, target_id, resume_id, resume_version, quote, coach_user_id, coach_email, author, body, created_at, request_key)
       VALUES ('c1', 'g1', 'line', 'l1', 'r1', 1, '${QUOTE}', 'u1', 'coach@example.test', 'coach', 'A comment', 1, 'coach_g1_k1')`,
    );
    return { db, sql };
  }
  const columns = (db: DatabaseSync) => (db.prepare(`PRAGMA table_info(share_comments)`).all() as { name: string }[]).map((column) => column.name);

  it("adds its columns to a table that already holds comments, refuses any other state, and drops cleanly", () => {
    const { db, sql } = table();
    const before = columns(db);
    for (const statement of SHARE_SUGGESTION_MIGRATIONS) db.exec(statement);
    expect(columns(db)).toEqual([...before, "suggestion_state", "document_id"]);
    // The comment that was there stays a comment.
    expect(db.prepare(`SELECT body, suggestion_state, document_id FROM share_comments`).all()).toEqual([{ body: "A comment", suggestion_state: null, document_id: null }]);
    for (const state of ["open", "declined"]) db.exec(`UPDATE share_comments SET suggestion_state = '${state}'`);
    for (const state of ["withdrawn", "dismissed", "applied", "OPEN", ""])
      expect(() => db.exec(`UPDATE share_comments SET suggestion_state = '${state}'`), state).toThrow(/CHECK constraint/);
    db.exec(`UPDATE share_comments SET suggestion_state = NULL, document_id = 'd1'`);
    removeSuggestionMigration(sql);
    expect(columns(db)).toEqual(before);
    expect(db.prepare(`SELECT body FROM share_comments`).all()).toEqual([{ body: "A comment" }]);
  });

  it("counts accepting a suggestion as generation, as starting any document is", () => {
    expect(httpRoute("/api/shares/suggestions/s1/accept")).toBe("generation");
    expect(httpRoute("/api/shares/suggestions/s1/decline")).toBe("other");
    expect(httpRoute("/api/coach/clients/g1/suggestions")).toBe("other");
  });
});
