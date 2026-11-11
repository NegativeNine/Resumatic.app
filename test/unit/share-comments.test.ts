import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AppError, errorCode } from "../../src/shared/errors";
import { MAX_COMMENT_CHARS, targetText, type ShareTarget } from "../../src/shared/sharing";
import type { FactRecord, Who } from "../../src/shared/types";
import {
  MAX_COACH_COMMENTS_PER_HOUR,
  MAX_COMMENTS_PER_COPY,
  MAX_VAULT_COMMENTS,
  SHARE_COMMENT_MIGRATIONS,
  ShareCommentStore,
  cleanComment,
} from "../../src/vault/share-comments";
import {
  SHARE_COACH_MIGRATIONS,
  SHARE_DETAIL_MIGRATIONS,
  SHARE_DOCUMENT_MIGRATIONS,
  SHARE_MIGRATIONS,
  ShareStore,
  type ShareSelection,
} from "../../src/vault/shares";

const now = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const who: Who = { userId: "owner", gen: 1 };
const FACT = "Built the API";
const SKILL = "TypeScript";
const dana = { userId: "u-dana", email: "dana@example.test", name: "  Dana \n Okafor  " };
/** A second account that signs in with the address the copy names. */
const second = { userId: "u-second", email: dana.email, name: "Dana O." };

const onFact: ShareTarget = { kind: "fact", factId: "f1" };
const onSkill: ShareTarget = { kind: "fact", factId: "f2" };
const onSummary: ShareTarget = { kind: "line", resumeId: "resume1", version: 1, lineId: "summary" };
const onBullet: ShareTarget = { kind: "line", resumeId: "resume1", version: 1, lineId: "bullet" };

/** One saved version of a resume: a summary, and one line under a role that was imported with its list marker. */
function resume(version: number): ShareSelection["resumes"][number] {
  return {
    id: "resume1",
    provenance: "snapshot",
    facts: { f1: { text: FACT, quote: "private original quote" } },
    evidence: { f1: { id: "f1", revision: 1, origin: "extracted", roleId: "r1", kind: "accomplishment", text: FACT, level: "implemented", quote: "private original quote" } as FactRecord },
    roleEvidence: { r1: { id: "r1", revision: 1, kind: "job", org: "Acme", title: "Engineer", startDate: "2020", endDate: null } },
    render: {
      profile: { name: "A User", email: "a@example.test", phone: "", location: "", links: [] },
      body: {
        summary: { id: "summary", text: FACT, factIds: ["f1"], status: "kept" },
        sections: [
          { roleId: "r1", kind: "job", org: "Acme", title: "Engineer", startDate: "2020", endDate: null, lines: [{ id: "bullet", text: `• ${FACT}`, factIds: ["f1"], status: "kept" }] },
        ],
        skills: [],
      },
      version,
      company: "private application",
      title: "private job",
    },
  };
}

/** Two facts and two versions of one resume, so a line has to be named with its version. */
function selection(): ShareSelection {
  return {
    roles: [{ id: "r1", kind: "job", org: "Acme", title: "Engineer", startDate: "2020", endDate: null, state: "confirmed", quote: "private header", sourceId: "private-source" }],
    facts: [
      { id: "f1", roleId: "r1", kind: "accomplishment", text: FACT, level: "implemented", origin: "extracted", state: "confirmed", quote: "private original quote", sourceId: "private-source" },
      { id: "f2", roleId: null, kind: "skill", text: SKILL, level: null, origin: "user", state: "confirmed", quote: null, sourceId: null },
    ],
    resumes: [resume(1), resume(2)],
  };
}

/** A vault's share and comment tables in memory, with the lifecycle checks the Vault would make. */
function store() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(statement: string, ...bindings: (string | number | null)[]) {
      const values = db.prepare(statement).all(...bindings);
      return { toArray: () => values };
    },
  } as unknown as SqlStorage;
  for (const migration of [...SHARE_MIGRATIONS, ...SHARE_DETAIL_MIGRATIONS, ...SHARE_DOCUMENT_MIGRATIONS, ...SHARE_COACH_MIGRATIONS, ...SHARE_COMMENT_MIGRATIONS])
    sql.exec(migration);
  db.exec(`CREATE TABLE resume_versions (resume_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.exec(`CREATE TABLE documents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL)`);
  db.exec(`CREATE TABLE document_versions (document_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.exec(`CREATE TABLE applications (id TEXT PRIMARY KEY, title TEXT, company TEXT)`);
  db.exec(`CREATE TABLE resumes (id TEXT PRIMARY KEY, application_id TEXT NOT NULL)`);
  db.exec(`INSERT INTO applications (id, title, company) VALUES ('app1', 'Platform Engineer', 'Initrode')`);
  db.exec(`INSERT INTO resumes (id, application_id) VALUES ('resume1', 'app1')`);
  for (const saved of selection().resumes)
    db.prepare(`INSERT INTO resume_versions (resume_id, version, data) VALUES (?, ?, ?)`).run(saved.id, saved.render.version, JSON.stringify(saved));
  const security = { open: true, epoch: "epoch-one" };
  const authorizeOwner = (caller: Who) => {
    if (!security.open) throw new AppError("gone", "this account is being deleted");
    if (caller.userId !== who.userId || caller.gen !== who.gen) throw new AppError("forbidden", "not this user's vault");
  };
  const shares = new ShareStore(sql, {
    authorizeOwner,
    requireOpen() {
      if (!security.open) throw new AppError("gone", "this account is being deleted");
    },
    currentEpoch: () => security.epoch,
    // Nothing is marked sensitive in these tests; the comments check reads the copy through the same gate.
    withheld: () => ({ ids: new Set<string>(), quotes: new Set<string>() }),
  });
  const comments = new ShareCommentStore(sql, shares, authorizeOwner);
  const rows = () => db.prepare(`SELECT * FROM share_comments ORDER BY created_at, rowid`).all() as Record<string, string | number | null>[];
  /** A row put straight into storage, for filling a copy without tripping the limits on the way. */
  const seed = (grantId: string, extra: Record<string, string | number | null> = {}) => {
    const row = {
      id: crypto.randomUUID(), grant_id: grantId, target_kind: "fact", target_id: "f1", resume_id: null, resume_version: null, quote: FACT,
      coach_user_id: dana.userId, coach_email: dana.email, coach_name: "Dana Okafor", author: "coach", body: "Seeded", created_at: now - 2 * HOUR,
      seen_at: null, request_key: `seed_${crypto.randomUUID()}`, ...extra,
    };
    const columns = Object.keys(row);
    db.prepare(`INSERT INTO share_comments (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
    return row.id;
  };
  return { db, shares, comments, security, rows, seed };
}

/** A copy that names Dana, which her account has taken up. */
function taken(options: { join?: boolean } = {}) {
  const made = store();
  const grant = made.shares.create(who, selection(), now + 10 * HOUR, now, { coachEmail: dana.email, owner: { name: "Sam Rivera" } });
  const claims = { grantId: grant.id, epoch: grant.epoch };
  if (options.join !== false) made.shares.join(claims, dana, now);
  return { ...made, grant, claims };
}

/** The code of the refusal a call makes, or "none" when it goes through. */
function refusal(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return errorCode(error) ?? `unexpected: ${String(error)}`;
  }
  return "none";
}

describe("what a comment can be about", () => {
  it("is a summary, a line under a role or a fact the copy holds, read as the copy shows it", () => {
    const { shares, grant, db } = taken();
    try {
      const { snapshot } = shares.read({ grantId: grant.id, epoch: grant.epoch }, now);
      expect(targetText(snapshot, onFact)).toBe(FACT);
      expect(targetText(snapshot, onSkill)).toBe(SKILL);
      expect(targetText(snapshot, onSummary)).toBe(FACT);
      // The page prints a bullet without the list marker it was imported with, and so does its quote.
      expect(snapshot.resumes[0]!.sections[0]!.lines[0]!.text).toBe(`• ${FACT}`);
      expect(targetText(snapshot, onBullet)).toBe(FACT);
      // Both versions of the resume are in the copy, and a line belongs to one of them.
      expect(targetText(snapshot, { ...onSummary, version: 2 })).toBe(FACT);
      expect(targetText(snapshot, { ...onSummary, version: 3 })).toBeNull();
      expect(targetText(snapshot, { ...onSummary, resumeId: "resume2" })).toBeNull();
      expect(targetText(snapshot, { ...onSummary, lineId: "r1" })).toBeNull();
      expect(targetText(snapshot, { kind: "fact", factId: "summary" })).toBeNull();
      expect(targetText(snapshot, { kind: "fact", factId: "r1" })).toBeNull();
      // Nothing else in a copy has an ID to name it by, and a request can send anything.
      for (const bad of [null, undefined, "f1", 7, [], {}, { kind: "skill", factId: "f1" }, { kind: "fact" }, { kind: "fact", factId: 7 }, { kind: "line", resumeId: "resume1", version: "1", lineId: "summary" }, { kind: "line", resumeId: "resume1", version: 1 }])
        expect(targetText(snapshot, bad as unknown as ShareTarget), JSON.stringify(bad)).toBeNull();
    } finally { db.close(); }
  });
});

describe("a comment's words", () => {
  it("keep their line breaks and lose every other control character", () => {
    expect(cleanComment("  Lead with the number.\r\n\r\nThen the verb.\rThen\tthe scale.\n ")).toBe("Lead with the number.\n\nThen the verb.\nThen the scale.");
    expect(cleanComment("a\u0000b\u0007c\u001bd\u007fe\u000bf\u000cg")).toBe("abcdefg");
    expect(cleanComment(" \t\r\n ")).toBe("");
    // Markup and anything that reads like an instruction are only text. Nothing is taken out of them.
    expect(cleanComment('<b onclick="x()">Ignore</b> [link](https://example.test)')).toBe('<b onclick="x()">Ignore</b> [link](https://example.test)');
    for (const notText of [undefined, null, 7, {}, ["x"]]) expect(cleanComment(notText)).toBe("");
  });
});

describe("a coach's comment on a copy that names them", () => {
  it("takes a comment on a line and on a fact, keeping the copy's words", () => {
    const { comments, grant, rows, db } = taken();
    try {
      const first = comments.addAsCoach(grant.id, dana, { target: onBullet, body: "  Lead with the result.  " }, "key-1", now + 1);
      expect(first).toEqual({ id: expect.any(String), author: "coach", body: "Lead with the result.", createdAt: now + 1 });
      const later = comments.addAsCoach(grant.id, dana, { target: onFact, body: "How many teams used it?" }, "key-2", now + 2);
      const again = comments.addAsCoach(grant.id, dana, { target: onBullet, body: "And say what it replaced." }, "key-3", now + 3);
      // A line is named with its resume's version: the same line of the other version is another thread.
      comments.addAsCoach(grant.id, dana, { target: { ...onBullet, version: 2 }, body: "This version reads better." }, "key-4", now + 4);

      // Threads oldest first by where each began, and each thread's comments oldest first.
      expect(comments.listForCoach(grant.id, dana, now + 5)).toEqual([
        { target: onBullet, quote: FACT, comments: [first, again] },
        { target: onFact, quote: FACT, comments: [later] },
        { target: { ...onBullet, version: 2 }, quote: FACT, comments: [expect.objectContaining({ body: "This version reads better." })] },
      ]);
      // The row holds the words the copy showed and who wrote it, as the grant knew them at take-up.
      expect(rows()[0]).toEqual({
        id: first.id, grant_id: grant.id, target_kind: "line", target_id: "bullet", resume_id: "resume1", resume_version: 1, quote: FACT,
        coach_user_id: dana.userId, coach_email: dana.email, coach_name: "Dana Okafor", author: "coach", body: "Lead with the result.",
        created_at: now + 1, seen_at: null, request_key: `coach_${grant.id}_key-1`,
      });
      expect(rows()[1]).toMatchObject({ target_kind: "fact", target_id: "f1", resume_id: null, resume_version: null, quote: FACT });
    } finally { db.close(); }
  });

  it("refuses a stranger, the coach before take-up, the address under another account, the account under another address", () => {
    const { comments, shares, grant, claims, rows, db } = taken({ join: false });
    try {
      const attempt = (account: { userId: string; email: string }) => [
        refusal(() => comments.addAsCoach(grant.id, account, { target: onFact, body: "Let me in" }, "key-1", now)),
        refusal(() => comments.listForCoach(grant.id, account, now)),
        refusal(() => comments.removeAsCoach(grant.id, account, "any", now)),
      ];
      const stranger = { userId: "u-stranger", email: "someone@example.test" };
      expect(attempt(stranger)).toEqual(["gone", "gone", "gone"]);
      // Named, and holding the link, but the copy isn't in their list yet.
      expect(attempt(dana)).toEqual(["gone", "gone", "gone"]);
      shares.join(claims, dana, now);
      expect(attempt(dana)).toEqual(["none", "none", "none"]);
      expect(attempt({ userId: "u-other", email: dana.email })).toEqual(["gone", "gone", "gone"]);
      expect(attempt({ userId: dana.userId, email: "dana@elsewhere.test" })).toEqual(["gone", "gone", "gone"]);
      expect(attempt(stranger)).toEqual(["gone", "gone", "gone"]);
      // A copy that doesn't exist says the same thing as one that isn't theirs.
      expect(refusal(() => comments.addAsCoach(crypto.randomUUID(), dana, { target: onFact, body: "x" }, "key-9", now))).toBe("gone");
      expect(rows().map((row) => row.coach_user_id)).toEqual([dana.userId]);
    } finally { db.close(); }
  });

  it("refuses when revoked, expired, of an earlier epoch, undeliverable or closed, for listing and deleting too", () => {
    const { comments, shares, security, grant, rows, db } = taken();
    try {
      const kept = comments.addAsCoach(grant.id, dana, { target: onFact, body: "Kept" }, "key-1", now);
      let key = 1;
      const attempt = (at = now) => [
        refusal(() => comments.addAsCoach(grant.id, dana, { target: onFact, body: "After the end" }, `late-${key++}`, at)),
        refusal(() => comments.listForCoach(grant.id, dana, at)),
        refusal(() => comments.removeAsCoach(grant.id, dana, kept.id, at)),
      ];
      const ended = ["gone", "gone", "gone"];
      // The link's last moment has passed, whether or not anything has cleared the grant away.
      expect(attempt(now + 10 * HOUR)).toEqual(ended);
      // The account's sessions were all ended since the copy was made.
      security.epoch = "epoch-two";
      expect(attempt()).toEqual(ended);
      security.epoch = "epoch-one";
      // The vault is closing, as when its owner deletes their account.
      security.open = false;
      expect(attempt()).toEqual(ended);
      security.open = true;
      // A saved resume no longer matches the copy, so the copy can't be delivered.
      const saved = db.prepare(`SELECT data FROM resume_versions WHERE version = 1`).get()!.data as string;
      db.prepare(`UPDATE resume_versions SET data = ? WHERE version = 1`).run(JSON.stringify({ render: { profile: {}, body: { summary: null, sections: [], skills: [] } }, facts: {} }));
      expect(attempt()).toEqual(ended);
      db.prepare(`UPDATE resume_versions SET data = ? WHERE version = 1`).run(saved);
      expect(comments.listForCoach(grant.id, dana, now)).toHaveLength(1);
      shares.revoke(who, grant.id, now + 1);
      expect(attempt(now + 2)).toEqual(ended);
      // Through all of it nothing was written and nothing was deleted.
      expect(rows().map((row) => row.body)).toEqual(["Kept"]);
    } finally { db.close(); }
  });

  it("refuses a target the copy doesn't hold, an empty body and an over-long one; keeps line breaks, drops control characters", () => {
    const { comments, grant, rows, db } = taken();
    try {
      const message = (call: () => unknown) => {
        try { call(); } catch (error) { return (error as Error).message; }
        return "none";
      };
      const add = (input: unknown, key = "key-1") => message(() => comments.addAsCoach(grant.id, dana, input as { target: ShareTarget; body: string }, key, now));
      for (const target of [{ kind: "fact", factId: "f9" }, { ...onSummary, version: 3 }, { ...onSummary, lineId: "skills" }, { kind: "skill", factId: "f1" }, { kind: "line", resumeId: "resume1", version: 1.5, lineId: "summary" }, null, "f1"])
        expect(add({ target, body: "About something else" }), JSON.stringify(target)).toBe("invalid: choose a line or a fact from this copy");
      // The sentence states the limit the constant sets.
      expect(MAX_COMMENT_CHARS).toBe(1000);
      for (const body of ["", "   ", "\u0000\u0007", "\r\n\t", "x".repeat(MAX_COMMENT_CHARS + 1), 7, null, undefined])
        expect(add({ target: onFact, body }), JSON.stringify(body)?.slice(0, 20)).toBe("invalid: write a comment of up to 1,000 characters");
      expect(add(null)).toBe("invalid: write a comment of up to 1,000 characters");
      for (const key of ["", "a b", "x".repeat(101), "key/1", "clé"])
        expect(add({ target: onFact, body: "Fine" }, key), key).toBe("invalid: invalid request key");
      expect(rows()).toEqual([]);

      // The longest comment fits once what is cut away is cut away.
      const longest = comments.addAsCoach(grant.id, dana, { target: onFact, body: `  ${"x".repeat(MAX_COMMENT_CHARS)}\u0000\n` }, "key-long", now);
      expect(longest.body).toHaveLength(MAX_COMMENT_CHARS);
      const shaped = comments.addAsCoach(grant.id, dana, { target: onFact, body: "First point.\r\n\r\nSecond\tpoint.\u0007\u001b[31m" }, "key-shaped", now + 1);
      expect(shaped.body).toBe("First point.\n\nSecond point.[31m");
      // Markup is kept as the text it is.
      const markup = comments.addAsCoach(grant.id, dana, { target: onFact, body: '<img src=x onerror="alert(1)"> **bold**' }, "key-markup", now + 2);
      expect(markup.body).toBe('<img src=x onerror="alert(1)"> **bold**');
    } finally { db.close(); }
  });

  it("holds the copy, hour and vault caps", () => {
    const { comments, shares, grant, rows, seed, db } = taken();
    try {
      const message = (call: () => unknown) => {
        try { call(); } catch (error) { return (error as Error).message; }
        return "none";
      };
      let key = 0;
      const add = (at: number, account = dana) => message(() => comments.addAsCoach(grant.id, account, { target: onFact, body: "Another thought" }, `cap-${key++}`, at));

      // Sixty in an hour from one account on one copy, counted over the hour just gone.
      for (let n = 0; n < MAX_COACH_COMMENTS_PER_HOUR; n++) expect(add(now + n)).toBe("none");
      expect(add(now + 30 * MINUTE)).toBe("quota: you've written a lot of comments on this copy in the last hour; carry on later");
      // The first of them is an hour old, so there is room for one more.
      expect(add(now + HOUR)).toBe("none");
      expect(add(now + HOUR)).toBe("quota: you've written a lot of comments on this copy in the last hour; carry on later");
      // Deleting one makes room, because the limits count the rows that exist.
      comments.removeAsCoach(grant.id, dana, rows().at(-1)!.id as string, now + HOUR);
      expect(add(now + HOUR)).toBe("none");
      const first = rows()[0]!.id as string;

      // Two hundred on a copy, whoever wrote them and however long ago.
      const before = rows().length;
      for (let n = before; n < MAX_COMMENTS_PER_COPY; n++) seed(grant.id, { author: n % 2 ? "owner" : "coach" });
      expect(rows()).toHaveLength(MAX_COMMENTS_PER_COPY);
      expect(add(now + 3 * HOUR)).toBe("quota: this copy has as many comments as it can hold");
      expect(message(() => comments.replyAsOwner(who, first, "Thanks", "reply-1", now + 3 * HOUR))).toBe("quota: delete some comments to make room for more");
      comments.removeAsOwner(who, rows().at(-1)!.id as string);
      expect(message(() => comments.replyAsOwner(who, first, "Thanks", "reply-1", now + 3 * HOUR))).toBe("none");
      expect(add(now + 3 * HOUR)).toBe("quota: this copy has as many comments as it can hold");

      // A thousand in a vault, across every copy it ever shared.
      const other = shares.create(who, selection(), now + 10 * HOUR, now, { coachEmail: dana.email });
      shares.join({ grantId: other.id, epoch: other.epoch }, dana, now);
      const elsewhere = (at: number) => message(() => comments.addAsCoach(other.id, dana, { target: onFact, body: "On the other copy" }, `cap-${key++}`, at));
      const mine = comments.addAsCoach(other.id, dana, { target: onFact, body: "The first on the other copy" }, "cap-first", now + 3 * HOUR);
      for (let n = rows().length; n < MAX_VAULT_COMMENTS; n++) seed(`ended-${n % 7}`);
      expect(rows()).toHaveLength(MAX_VAULT_COMMENTS);
      expect(elsewhere(now + 4 * HOUR)).toBe("quota: this person's account can't hold more comments until they delete some");
      expect(message(() => comments.replyAsOwner(who, mine.id, "Thanks", "reply-2", now + 4 * HOUR))).toBe("quota: delete some comments to make room for more");
      comments.removeAsOwner(who, rows().find((row) => String(row.grant_id).startsWith("ended-"))!.id as string);
      expect(elsewhere(now + 4 * HOUR)).toBe("none");
      expect(rows()).toHaveLength(MAX_VAULT_COMMENTS);
    } finally { db.close(); }
  });

  it("repeats a key's answer; refuses the key with other words, another target or another account", () => {
    const { comments, shares, grant, claims, rows, seed, db } = taken();
    try {
      const input = { target: onBullet, body: "Lead with the result." };
      const made = comments.addAsCoach(grant.id, dana, input, "key-1", now);
      // A retry after a lost reply, however much later, and however the words were spaced.
      expect(comments.addAsCoach(grant.id, dana, { target: { ...onBullet }, body: " Lead with the result.\r\n" }, "key-1", now + HOUR)).toEqual(made);
      expect(rows()).toHaveLength(1);
      const reused = "the request key was already used with different input";
      expect(() => comments.addAsCoach(grant.id, dana, { ...input, body: "Lead with the verb." }, "key-1", now)).toThrow(reused);
      expect(() => comments.addAsCoach(grant.id, dana, { ...input, target: onSummary }, "key-1", now)).toThrow(reused);
      expect(() => comments.addAsCoach(grant.id, dana, { ...input, target: { ...onBullet, version: 2 } }, "key-1", now)).toThrow(reused);
      expect(() => comments.addAsCoach(grant.id, dana, { ...input, target: onFact }, "key-1", now)).toThrow(reused);
      expect(() => comments.addAsCoach(grant.id, dana, { ...input, target: null as unknown as ShareTarget }, "key-1", now)).toThrow(reused);
      // The same words under another key are another comment.
      expect(comments.addAsCoach(grant.id, dana, input, "key-2", now + 1).id).not.toBe(made.id);
      // A retry is answered even when the copy has filled up since.
      for (let n = rows().length; n < MAX_COMMENTS_PER_COPY; n++) seed(grant.id);
      expect(comments.addAsCoach(grant.id, dana, input, "key-1", now + 2)).toEqual(made);
      expect(() => comments.addAsCoach(grant.id, dana, input, "key-3", now + 2)).toThrow("as many comments as it can hold");

      // The key is the first account's. The address under another account can't read the comment back with it.
      shares.join(claims, second, now + 3);
      expect(() => comments.addAsCoach(grant.id, second, input, "key-1", now + 4)).toThrow(reused);
      // A key is kept for one copy: on another copy the same key is a new request.
      const other = shares.create(who, selection(), now + 10 * HOUR, now, { coachEmail: dana.email });
      shares.join({ grantId: other.id, epoch: other.epoch }, dana, now);
      expect(comments.addAsCoach(other.id, dana, input, "key-1", now + 5).id).not.toBe(made.id);
    } finally { db.close(); }
  });

  it("lets a coach delete only their own, and the owner any, after the end too", () => {
    const { comments, shares, grant, rows, db } = taken();
    try {
      const mine = comments.addAsCoach(grant.id, dana, { target: onFact, body: "Mine" }, "key-1", now);
      const other = comments.addAsCoach(grant.id, dana, { target: onSummary, body: "Also mine" }, "key-2", now + 1);
      const reply = comments.replyAsOwner(who, mine.id, "The owner's", "reply-1", now + 2);
      // Not the owner's reply, not a comment that isn't there, and not one named on another copy.
      comments.removeAsCoach(grant.id, dana, reply.id, now + 3);
      comments.removeAsCoach(grant.id, dana, "no-such-comment", now + 3);
      const elsewhere = shares.create(who, selection(), now + 10 * HOUR, now, { coachEmail: dana.email });
      shares.join({ grantId: elsewhere.id, epoch: elsewhere.epoch }, dana, now);
      comments.removeAsCoach(elsewhere.id, dana, mine.id, now + 3);
      expect(rows().map((row) => row.body)).toEqual(["Mine", "Also mine", "The owner's"]);
      comments.removeAsCoach(grant.id, dana, other.id, now + 3);
      expect(rows().map((row) => row.body)).toEqual(["Mine", "The owner's"]);

      // Once the copy has ended the coach deletes nothing, and the owner still deletes anything.
      shares.revoke(who, grant.id, now + 4);
      expect(refusal(() => comments.removeAsCoach(grant.id, dana, mine.id, now + 5))).toBe("gone");
      expect(rows()).toHaveLength(2);
      expect(refusal(() => comments.removeAsOwner({ ...who, userId: "another" }, mine.id))).toBe("forbidden");
      comments.removeAsOwner(who, mine.id);
      comments.removeAsOwner(who, mine.id);
      comments.removeAsOwner(who, "no-such-comment");
      expect(rows().map((row) => row.body)).toEqual(["The owner's"]);
      comments.removeAsOwner(who, reply.id);
      expect(rows()).toEqual([]);
    } finally { db.close(); }
  });

  it("hides from the coach a thread the copy no longer delivers", () => {
    const { comments, grant, seed, db } = taken();
    try {
      const shown = comments.addAsCoach(grant.id, dana, { target: onFact, body: "On a fact in the copy" }, "key-1", now);
      // Rows about a fact and a line the delivered copy doesn't hold.
      seed(grant.id, { target_id: "f-gone", quote: "A fact that left the copy", body: "On a fact that went", created_at: now + 1 });
      seed(grant.id, { target_kind: "line", target_id: "line-gone", resume_id: "resume1", resume_version: 1, quote: "A line that left", body: "On a line that went", created_at: now + 2 });
      expect(comments.listForCoach(grant.id, dana, now + 3)).toEqual([{ target: onFact, quote: FACT, comments: [shown] }]);
      // The owner still has every one of them, with the words each was about.
      expect(comments.listForOwner(who, now + 3).map((thread) => thread.quote)).toEqual(["A line that left", "A fact that left the copy", FACT]);
    } finally { db.close(); }
  });
});

describe("the owner's side of a thread", () => {
  it("lets the owner reply only to a coach's comment on a copy open to the account that wrote it; refuses another account as the owner", () => {
    const { comments, shares, grant, rows, db } = taken();
    try {
      const asked = comments.addAsCoach(grant.id, dana, { target: onBullet, body: "How many teams used it?" }, "key-1", now);
      const reply = comments.replyAsOwner(who, asked.id, "  Three.\r\nI'll say so.  ", "reply-1", now + 1);
      expect(reply).toEqual({ id: expect.any(String), author: "owner", body: "Three.\nI'll say so.", createdAt: now + 1 });
      // The reply sits in the thread it answers, about the same words, for the same account.
      expect(rows()[1]).toMatchObject({
        grant_id: grant.id, target_kind: "line", target_id: "bullet", resume_id: "resume1", resume_version: 1, quote: FACT,
        coach_user_id: dana.userId, coach_email: dana.email, coach_name: "Dana Okafor", author: "owner", seen_at: null, request_key: "owner_reply-1",
      });
      expect(comments.listForCoach(grant.id, dana, now + 2)).toEqual([{ target: onBullet, quote: FACT, comments: [asked, reply] }]);

      const gone = "that comment has been deleted; reload to see the thread as it stands";
      // The owner answers a coach. They don't answer themselves, and they start no thread.
      expect(() => comments.replyAsOwner(who, reply.id, "And another thing", "reply-2", now + 2)).toThrow(`not_found: ${gone}`);
      expect(() => comments.replyAsOwner(who, "no-such-comment", "Hello?", "reply-3", now + 2)).toThrow(`not_found: ${gone}`);
      expect(() => comments.replyAsOwner(who, 7 as unknown as string, "Hello?", "reply-3", now + 2)).toThrow(`not_found: ${gone}`);
      for (const body of ["", " \n ", "x".repeat(MAX_COMMENT_CHARS + 1)])
        expect(() => comments.replyAsOwner(who, asked.id, body, "reply-4", now + 2)).toThrow("invalid: write a comment of up to 1,000 characters");
      expect(() => comments.replyAsOwner(who, asked.id, "Fine", "reply 5", now + 2)).toThrow("invalid: invalid request key");
      const another = { ...who, userId: "another" };
      expect(refusal(() => comments.replyAsOwner(another, asked.id, "Not mine to answer", "reply-6", now + 2))).toBe("forbidden");
      expect(refusal(() => comments.replyAsOwner({ ...who, gen: 2 }, asked.id, "Signed out since", "reply-6", now + 2))).toBe("forbidden");
      // Who is asking is settled before anything else is, so another account learns nothing by asking:
      // not whether a comment exists, and not a reply the owner already made under a key.
      expect(refusal(() => comments.replyAsOwner(another, "no-such-comment", "Is anyone there?", "reply-6", now + 2))).toBe("forbidden");
      expect(refusal(() => comments.replyAsOwner(another, asked.id, "Three.\nI'll say so.", "reply-1", now + 2))).toBe("forbidden");
      expect(refusal(() => comments.replyAsOwner(another, asked.id, "", "not a key", now + 2))).toBe("forbidden");
      expect(refusal(() => comments.listForOwner(another, now))).toBe("forbidden");
      expect(refusal(() => comments.export(another))).toBe("forbidden");

      // A retry gets its reply back. The key with other words, or naming another thread's comment, is a different request.
      expect(comments.replyAsOwner(who, asked.id, "Three.\nI'll say so.", "reply-1", now + HOUR)).toEqual(reply);
      const reused = "conflict: the request key was already used with different input";
      expect(() => comments.replyAsOwner(who, asked.id, "Four.", "reply-1", now + 3)).toThrow(reused);
      const elsewhere = comments.addAsCoach(grant.id, dana, { target: onFact, body: "And this?" }, "key-2", now + 3);
      expect(() => comments.replyAsOwner(who, elsewhere.id, "Three.\nI'll say so.", "reply-1", now + 4)).toThrow(reused);
      // Even after the comment it answered has been deleted.
      comments.removeAsOwner(who, asked.id);
      expect(comments.replyAsOwner(who, asked.id, "Three.\nI'll say so.", "reply-1", now + 5)).toEqual(reply);
      expect(rows()).toHaveLength(2);

      // Once the copy has ended there is nobody to read a reply.
      const closed = "conflict: this copy isn't open to your coach any more, so they can't read a reply; share a new copy to carry on";
      expect(() => comments.replyAsOwner(who, elsewhere.id, "Too late", "reply-7", now + 10 * HOUR)).toThrow(closed);
      shares.revoke(who, grant.id, now + 6);
      expect(() => comments.replyAsOwner(who, elsewhere.id, "Too late", "reply-7", now + 7)).toThrow(closed);
      shares.purgeExpired(now + 11 * HOUR);
      expect(() => comments.replyAsOwner(who, elsewhere.id, "Too late", "reply-7", now + 11 * HOUR)).toThrow(closed);
      expect(rows()).toHaveLength(2);
    } finally { db.close(); }
  });

  it("gives a second account under the address nothing of the first's to read or delete, and stops the owner replying to the first once the second holds the copy", () => {
    const { comments, shares, grant, claims, rows, db } = taken();
    try {
      const first = comments.addAsCoach(grant.id, dana, { target: onFact, body: "From the first account" }, "key-1", now);
      const answered = comments.replyAsOwner(who, first.id, "To the first account", "reply-1", now + 1);
      // An account made again under the address takes the copy up with its link, as the grant allows.
      shares.join(claims, second, now + 2);
      expect(comments.listForCoach(grant.id, second, now + 3)).toEqual([]);
      comments.removeAsCoach(grant.id, second, first.id, now + 3);
      comments.removeAsCoach(grant.id, second, answered.id, now + 3);
      expect(rows().map((row) => row.body)).toEqual(["From the first account", "To the first account"]);
      // The first account no longer holds the copy, so it reads and writes nothing.
      expect(refusal(() => comments.listForCoach(grant.id, dana, now + 3))).toBe("gone");
      expect(refusal(() => comments.addAsCoach(grant.id, dana, { target: onFact, body: "Still here?" }, "key-2", now + 3))).toBe("gone");
      // A reply would be read by whoever holds the copy now, and that isn't who wrote the comment.
      expect(() => comments.replyAsOwner(who, first.id, "Are you there?", "reply-2", now + 4)).toThrow("this copy isn't open to your coach any more");

      const theirs = comments.addAsCoach(grant.id, second, { target: onFact, body: "From the second account" }, "key-1b", now + 5);
      const reply = comments.replyAsOwner(who, theirs.id, "To the second account", "reply-3", now + 6);
      expect(comments.listForCoach(grant.id, second, now + 7)).toEqual([{ target: onFact, quote: FACT, comments: [theirs, reply] }]);
      // The owner sees the two accounts' threads apart, on the same fact of the same copy.
      expect(comments.listForOwner(who, now + 7).map((thread) => [thread.open, thread.comments.map((comment) => comment.body)])).toEqual([
        [true, ["From the second account", "To the second account"]],
        [false, ["From the first account", "To the first account"]],
      ]);
      expect(comments.listForOwner(who, now + 7).map((thread) => thread.comments[0]!.name)).toEqual(["Dana O.", "Dana Okafor"]);
      // If the first account takes the copy up again, it reads its own thread and never the second's.
      shares.join(claims, dana, now + 8);
      expect(comments.listForCoach(grant.id, dana, now + 9)).toEqual([{ target: onFact, quote: FACT, comments: [first, answered] }]);
      expect(comments.listForOwner(who, now + 9).map((thread) => thread.open)).toEqual([false, true]);
    } finally { db.close(); }
  });

  it("says how a copy stands: open, closed, gone, and who holds it", () => {
    const { shares, grant, claims, db } = taken({ join: false });
    try {
      expect(shares.standing(who, grant.id, now)).toEqual({ open: true, coachUserId: null });
      shares.join(claims, dana, now);
      expect(shares.standing(who, grant.id, now)).toEqual({ open: true, coachUserId: dana.userId });
      shares.join(claims, second, now + 1);
      expect(shares.standing(who, grant.id, now + 2)).toEqual({ open: true, coachUserId: second.userId });
      expect(refusal(() => shares.standing({ ...who, userId: "another" }, grant.id, now))).toBe("forbidden");
      expect(shares.standing(who, "no-such-copy", now)).toBeNull();
      // Closed by its last moment passing, by a copy that can't be delivered, and by revoking it.
      expect(shares.standing(who, grant.id, now + 10 * HOUR)).toEqual({ open: false, coachUserId: second.userId });
      const saved = db.prepare(`SELECT data FROM resume_versions WHERE version = 2`).get()!.data as string;
      db.prepare(`UPDATE resume_versions SET data = ? WHERE version = 2`).run(JSON.stringify({ render: { profile: {}, body: { summary: null, sections: [], skills: [] } }, facts: {} }));
      expect(shares.standing(who, grant.id, now + 2)).toEqual({ open: false, coachUserId: second.userId });
      expect(shares.list(who, now + 2)[0]!.available).toBe(false);
      db.prepare(`UPDATE resume_versions SET data = ? WHERE version = 2`).run(saved);
      expect(shares.standing(who, grant.id, now + 2)).toEqual({ open: true, coachUserId: second.userId });
      shares.revoke(who, grant.id, now + 3);
      expect(shares.standing(who, grant.id, now + 4)).toEqual({ open: false, coachUserId: second.userId });
      // Once the grant has been cleared away there is nothing to say about it.
      shares.purgeExpired(now + 10 * HOUR);
      expect(shares.standing(who, grant.id, now + 10 * HOUR)).toBeNull();
    } finally { db.close(); }
  });

  it("opens a copy for its coach as it did, through the same check a comment passes", () => {
    const { shares, grant, db } = taken();
    try {
      const copy = shares.copyForCoach(grant.id, dana, now);
      expect(copy.coach).toEqual({ email: dana.email, name: "Dana Okafor" });
      expect(copy.view).toEqual(shares.read({ grantId: grant.id, epoch: grant.epoch }, now));
      expect(shares.openForCoach(grant.id, dana, now)).toEqual({ epoch: grant.epoch, expiresAt: grant.expiresAt });
      expect(refusal(() => shares.copyForCoach(grant.id, second, now))).toBe("gone");
      expect(refusal(() => shares.copyForCoach(grant.id, dana, grant.expiresAt))).toBe("gone");
    } finally { db.close(); }
  });

  it("counts what the owner hasn't seen", () => {
    const { comments, grant, rows, db } = taken();
    try {
      expect(comments.unseen()).toBe(0);
      const first = comments.addAsCoach(grant.id, dana, { target: onFact, body: "One" }, "key-1", now);
      const second = comments.addAsCoach(grant.id, dana, { target: onSummary, body: "Two" }, "key-2", now + 1);
      expect(comments.unseen()).toBe(2);
      // The owner's own replies are nothing new to the owner.
      const reply = comments.replyAsOwner(who, first.id, "Thanks", "reply-1", now + 2);
      expect(comments.unseen()).toBe(2);
      expect(comments.listForOwner(who, now + 3).flatMap((thread) => thread.comments.map((comment) => [comment.author, comment.seen]))).toEqual([
        ["coach", false], ["owner", undefined], ["coach", false],
      ]);
      expect(refusal(() => comments.markSeen({ ...who, userId: "another" }, [first.id, second.id], now + 4))).toBe("forbidden");
      expect(comments.unseen()).toBe(2);
      // The owner's own reply is named too, and stays as it was: only a coach's comment is seen.
      comments.markSeen(who, [first.id, second.id, reply.id, first.id], now + 4);
      expect(comments.unseen()).toBe(0);
      expect(rows().map((row) => row.seen_at)).toEqual([now + 4, now + 4, null]);
      // Seen once is seen: a later look doesn't move the time, and a new comment is new again.
      const third = comments.addAsCoach(grant.id, dana, { target: onFact, body: "Three" }, "key-3", now + 5);
      comments.markSeen(who, [first.id, second.id, third.id], now + 6);
      expect(rows().map((row) => row.seen_at)).toEqual([now + 4, now + 4, null, now + 6]);
      expect(comments.listForOwner(who, now + 7).flatMap((thread) => thread.comments.map((comment) => comment.seen))).toEqual([true, undefined, true, true]);
      // A coach is never told whether the owner has looked.
      expect(JSON.stringify(comments.listForCoach(grant.id, dana, now + 7))).not.toContain("seen");
    } finally { db.close(); }
  });

  it("marks seen only the comments the page showed, so one written since stays new", () => {
    const { comments, grant, rows, db } = taken();
    try {
      comments.addAsCoach(grant.id, dana, { target: onFact, body: "Shown" }, "key-1", now);
      // The page reads the list, and a coach writes again before the page says what it showed.
      const shown = comments.listForOwner(who, now + 1).flatMap((thread) => thread.comments).filter((comment) => comment.seen === false).map((comment) => comment.id);
      const later = comments.addAsCoach(grant.id, dana, { target: onFact, body: "Written after the list was read" }, "key-2", now + 2);
      comments.markSeen(who, shown, now + 3);
      expect(comments.unseen()).toBe(1);
      expect(rows().map((row) => [row.body, row.seen_at])).toEqual([["Shown", now + 3], ["Written after the list was read", null]]);
      // The next reading shows it as new.
      expect(comments.listForOwner(who, now + 4)[0]!.comments.find((comment) => comment.id === later.id)?.seen).toBe(false);
      // Naming nothing, or what isn't there, marks nothing.
      comments.markSeen(who, [], now + 5);
      comments.markSeen(who, ["not-a-comment"], now + 5);
      expect(comments.unseen()).toBe(1);
      // A list that isn't one, or is longer than a vault can hold comments, is refused.
      for (const ids of [undefined, "all", [7], Array.from({ length: MAX_VAULT_COMMENTS + 1 }, () => later.id)])
        expect(refusal(() => comments.markSeen(who, ids as string[], now + 6)), JSON.stringify(ids)?.slice(0, 20)).toBe("invalid");
      expect(comments.unseen()).toBe(1);
    } finally { db.close(); }
  });

  it("keeps threads through revoke and the expiry purge", () => {
    const { comments, shares, grant, db } = taken();
    try {
      const asked = comments.addAsCoach(grant.id, dana, { target: onBullet, body: "How many teams used it?" }, "key-1", now);
      comments.replyAsOwner(who, asked.id, "Three.", "reply-1", now + 1);
      const open = comments.listForOwner(who, now + 2);
      expect(open).toEqual([
        {
          target: onBullet, quote: FACT, grantId: grant.id, coachEmail: dana.email, open: true, job: { title: "Platform Engineer", company: "Initrode" },
          comments: [
            { id: asked.id, author: "coach", body: "How many teams used it?", createdAt: now, name: "Dana Okafor", seen: false },
            { id: expect.any(String), author: "owner", body: "Three.", createdAt: now + 1 },
          ],
        },
      ]);
      // Revoking clears the copy itself. What was said about it stays, closed.
      shares.revoke(who, grant.id, now + 3);
      expect(db.prepare(`SELECT snapshot FROM share_grants WHERE id = ?`).get(grant.id)!.snapshot).toBeNull();
      expect(comments.listForOwner(who, now + 4)).toEqual([{ ...open[0], open: false }]);
      // The alarm clears the grant away after its last day, and the thread is still the owner's.
      shares.purgeExpired(now + 10 * HOUR);
      expect(shares.list(who, now + 10 * HOUR)).toEqual([]);
      expect(comments.listForOwner(who, now + 10 * HOUR)).toEqual([{ ...open[0], open: false }]);
      expect(comments.export(who)).toHaveLength(2);
      expect(comments.unseen()).toBe(1);
    } finally { db.close(); }
  });

  it("lists the thread with the latest comment first, each thread oldest first", () => {
    const { comments, grant, db } = taken();
    try {
      // With nothing to list, the owner gets nothing and another account is still refused.
      expect(comments.listForOwner(who, now)).toEqual([]);
      expect(refusal(() => comments.listForOwner({ ...who, userId: "another" }, now))).toBe("forbidden");
      const a = comments.addAsCoach(grant.id, dana, { target: onFact, body: "A1" }, "key-1", now);
      comments.addAsCoach(grant.id, dana, { target: onSummary, body: "B1" }, "key-2", now + 1);
      comments.addAsCoach(grant.id, dana, { target: onSkill, body: "C1" }, "key-3", now + 2);
      const bodies = () => comments.listForOwner(who, now + 10).map((thread) => thread.comments.map((comment) => comment.body));
      expect(bodies()).toEqual([["C1"], ["B1"], ["A1"]]);
      // A reply brings its thread to the top.
      comments.replyAsOwner(who, a.id, "A2", "reply-1", now + 3);
      expect(bodies()).toEqual([["A1", "A2"], ["C1"], ["B1"]]);
      comments.addAsCoach(grant.id, dana, { target: onSummary, body: "B2" }, "key-4", now + 4);
      expect(bodies()).toEqual([["B1", "B2"], ["A1", "A2"], ["C1"]]);
      // The coach reads the same threads in the order each began.
      expect(comments.listForCoach(grant.id, dana, now + 10).map((thread) => thread.comments.map((comment) => comment.body))).toEqual([["A1", "A2"], ["B1", "B2"], ["C1"]]);
    } finally { db.close(); }
  });

  it("names the coach from the grant and the job as the owner has it now", () => {
    const { comments, shares, grant, claims, db } = taken();
    try {
      // Whatever a request says its sender is called, the name is the one the grant took at take-up.
      const first = comments.addAsCoach(grant.id, { ...dana, name: "Sam Rivera" }, { target: onSummary, body: "On the summary" }, "key-1", now);
      comments.addAsCoach(grant.id, { userId: dana.userId, email: dana.email }, { target: onFact, body: "On a fact" }, "key-2", now + 1);
      const threads = () => comments.listForOwner(who, now + 10);
      expect(threads().map((thread) => [thread.coachEmail, thread.comments[0]!.name])).toEqual([[dana.email, "Dana Okafor"], [dana.email, "Dana Okafor"]]);
      // The coach's own view carries neither their name nor their address.
      expect(JSON.stringify(comments.listForCoach(grant.id, dana, now + 2))).not.toMatch(/Dana|example\.test/);
      // An account with no name on it is known by its address, and what was already said keeps the name it came under.
      shares.join(claims, { userId: dana.userId, email: dana.email, name: "   " }, now + 3);
      comments.addAsCoach(grant.id, dana, { target: onSummary, body: "Later, with no name" }, "key-3", now + 4);
      expect(threads()[0]!.comments.map((comment) => comment.name)).toEqual(["Dana Okafor", null]);
      expect(comments.replyAsOwner(who, first.id, "Thanks", "reply-1", now + 5)).not.toHaveProperty("name");

      // A line's job is the owner's own label for it today. A fact has none.
      const jobs = () => threads().map((thread) => (thread.target.kind === "line" ? thread.job : "job" in thread ? "present" : "absent"));
      expect(jobs()).toEqual([{ title: "Platform Engineer", company: "Initrode" }, "absent"]);
      db.prepare(`UPDATE applications SET title = 'Staff Engineer', company = NULL WHERE id = 'app1'`).run();
      expect(jobs()).toEqual([{ title: "Staff Engineer", company: null }, "absent"]);
      db.prepare(`UPDATE applications SET title = NULL WHERE id = 'app1'`).run();
      expect(jobs()).toEqual([null, "absent"]);
      db.prepare(`DELETE FROM resumes`).run();
      expect(jobs()).toEqual([null, "absent"]);
    } finally { db.close(); }
  });

  it("exports every comment without its request key or the coach's account ID", () => {
    const { comments, shares, grant, db } = taken();
    try {
      const asked = comments.addAsCoach(grant.id, dana, { target: onBullet, body: "How many teams used it?" }, "key-1", now);
      const reply = comments.replyAsOwner(who, asked.id, "Three.", "reply-1", now + 1);
      comments.markSeen(who, [asked.id], now + 2);
      shares.revoke(who, grant.id, now + 3);
      const exported = comments.export(who);
      expect(exported).toEqual([
        {
          id: asked.id, grant_id: grant.id, target_kind: "line", target_id: "bullet", resume_id: "resume1", resume_version: 1, quote: FACT,
          coach_email: dana.email, coach_name: "Dana Okafor", author: "coach", body: "How many teams used it?", created_at: now, seen_at: now + 2,
        },
        {
          id: reply.id, grant_id: grant.id, target_kind: "line", target_id: "bullet", resume_id: "resume1", resume_version: 1, quote: FACT,
          coach_email: dana.email, coach_name: "Dana Okafor", author: "owner", body: "Three.", created_at: now + 1, seen_at: null,
        },
      ]);
      const text = JSON.stringify(exported);
      for (const kept of [dana.userId, "key-1", "reply-1", "request_key", "coach_user_id"]) expect(text, kept).not.toContain(kept);
    } finally { db.close(); }
  });
});
