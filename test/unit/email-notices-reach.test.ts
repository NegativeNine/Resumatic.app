import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NOTICE_KINDS, noticeMessage } from "../../src/shared/email-notices";

// What an email notice can be made of. The store that decides when one is due reads timestamps and
// states, and never a column that holds anyone's words, so nothing a coach wrote or a fact says can
// reach a notice. And a notice's words are fixed: each kind's subject and text, with the app's
// origin as the only thing put into them.

// Vitest runs from the repository root.
const STORE = readFileSync(resolve(process.cwd(), "src/vault/email-notices.ts"), "utf8");
const ORIGIN = "https://app.example.test";
const FOOTER = "You get this email because you turned on email notices in Resumatic. To stop them, turn them off under Account.\n";

describe("what an email notice is made of", () => {
  it("the store names no column that holds anyone's words", () => {
    for (const column of ["body", "quote", "text", "coach_email", "coach_name"])
      expect(new RegExp(`\\b${column}\\b`).test(STORE), column).toBe(false);
    // What it does read, from the two tables it looks at, and nothing more.
    const read = [...STORE.matchAll(/FROM (share_comments|facts)\b[^`]*`/g)].map((match) => match[0]);
    expect(read.length).toBeGreaterThan(0);
    for (const statement of read)
      for (const word of statement.match(/\b[a-z_]+\b/g) ?? [])
        expect(["from", "share_comments", "facts", "where", "author", "coach", "and", "suggestion_state", "is", "null", "open", "seen_at", "created_at", "limit", "state", "proposed", "as", "at"], `${word} in ${statement}`).toContain(word);
    expect(STORE).toContain("SELECT MIN(updated_at) AS at FROM facts WHERE state = 'proposed'");
  });

  it("each kind's notice is exactly its fixed subject and text", () => {
    expect(NOTICE_KINDS).toEqual(["comment", "suggestion", "reminder"]);
    expect(noticeMessage("comment", ORIGIN)).toEqual({
      subject: "New comment in Resumatic",
      text: `A coach has left a new comment on a copy you shared.\n\nSign in to read it: ${ORIGIN}/\n\n${FOOTER}`,
    });
    expect(noticeMessage("suggestion", ORIGIN)).toEqual({
      subject: "New suggested wording in Resumatic",
      text: `A coach has suggested new wording for a line in a copy you shared.\n\nSign in to see it: ${ORIGIN}/\n\n${FOOTER}`,
    });
    expect(noticeMessage("reminder", ORIGIN)).toEqual({
      subject: "Facts are waiting for you to check in Resumatic",
      text: `Some facts Resumatic found for you have been waiting for you to check them for 3 days or more.\n\nSign in to check them: ${ORIGIN}/\n\n${FOOTER}`,
    });
    // The origin is the only thing that varies.
    for (const kind of NOTICE_KINDS) {
      const other = noticeMessage(kind, "https://other.example.test");
      expect(other.subject).toBe(noticeMessage(kind, ORIGIN).subject);
      expect(other.text.replaceAll("https://other.example.test", ORIGIN)).toBe(noticeMessage(kind, ORIGIN).text);
    }
  });
});
