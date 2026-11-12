import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  MAX_SHARE_BYTES,
  MAX_SHARE_DOCUMENTS,
  SHARE_COACH_MIGRATIONS,
  SHARE_DETAIL_MIGRATIONS,
  SHARE_DOCUMENT_MIGRATIONS,
  SHARE_READ_INTERVAL_MS,
  SHARE_MIGRATIONS,
  SHARE_TTL_MS,
  ShareStore,
  snapshotSelection,
  type ShareSelection,
} from "../../src/vault/shares";
import {
  createShareSession,
  createShareToken,
  readShareToken,
  shareCookieName,
  shareLink,
  SHARE_COOKIE,
} from "../../src/worker/shares";
import { signToken } from "../../src/worker/crypto";
import type { FactRecord } from "../../src/shared/types";
import type { Withheld } from "../../src/vault/sensitive";

const now = 1_800_000_000_000;
const who = { userId: "owner", gen: 1 };
const secret = "share-secret-that-is-at-least-32-bytes-long";
const claims = {
  vid: "a".repeat(64),
  grantId: "0653389a-0d6d-4e90-94eb-23cc98b95c19",
  epoch: "epoch-one",
  exp: now + SHARE_TTL_MS,
};
function selection(): ShareSelection {
  return {
    roles: [
      {
        id: "r1",
        kind: "job",
        org: "Acme",
        title: "Engineer",
        startDate: "2020",
        endDate: null,
        state: "confirmed",
        quote: "private header",
        sourceId: "private-source",
      },
    ],
    facts: [
      {
        id: "f1",
        roleId: "r1",
        kind: "accomplishment",
        text: "Built the API",
        level: "implemented",
        origin: "extracted",
        state: "confirmed",
        quote: "private original quote",
        sourceId: "private-source",
      },
    ],
    resumes: [
      {
        id: "resume1",
        provenance: "snapshot",
        facts: { f1: { text: "Built the API", quote: "private original quote" } },
        render: {
          profile: {
            name: "A User",
            email: "a@example.test",
            phone: "",
            location: "",
            links: [],
          },
          body: {
            summary: {
              id: "line1",
              text: "Built the API",
              factIds: ["f1"],
              status: "kept",
            },
            sections: [],
            skills: [],
          },
          version: 1,
          company: "private application",
          title: "private job",
        },
      },
    ],
  };
}

function store() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(statement: string, ...bindings: (string | number | null)[]) {
      const values = db.prepare(statement).all(...bindings);
      return { toArray: () => values };
    },
  } as unknown as SqlStorage;
  for (const migration of [...SHARE_MIGRATIONS, ...SHARE_DETAIL_MIGRATIONS, ...SHARE_DOCUMENT_MIGRATIONS, ...SHARE_COACH_MIGRATIONS]) sql.exec(migration);
  db.exec(`CREATE TABLE resume_versions (resume_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.exec(`CREATE TABLE documents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL)`);
  db.exec(`CREATE TABLE document_versions (document_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL)`);
  const resume = selection().resumes[0]!;
  db.prepare(`INSERT INTO resume_versions (resume_id,version,data) VALUES (?,?,?)`).run(resume.id, resume.render.version, JSON.stringify(resume));
  const security: { open: boolean; epoch: string; withheld: Withheld } = { open: true, epoch: "epoch-one", withheld: { ids: new Set(), quotes: new Set() } };
  const shares = new ShareStore(sql, {
    authorizeOwner(caller) {
      if (
        !security.open ||
        caller.userId !== who.userId ||
        caller.gen !== who.gen
      )
        throw new Error("owner required");
    },
    requireOpen() {
      if (!security.open) throw new Error("closed");
    },
    currentEpoch() {
      return security.epoch;
    },
    withheld() {
      return security.withheld;
    },
  });
  return { shares, security, db };
}

describe("coach share snapshots", () => {
  it("retains the unknown-end start in selected role and resume snapshots", () => {
    const original = selection();
    const role = original.roles[0]!;
    role.startDate = null;
    role.unknownEndStartDate = "2020";
    original.resumes[0]!.render.body.sections.push({
      roleId: role.id, kind: role.kind, org: role.org, title: role.title,
      startDate: null, endDate: null, unknownEndStartDate: "2020", lines: [],
    });
    original.resumes[0]!.roleEvidence = { [role.id]: {
      id: role.id, revision: 1, kind: role.kind, org: role.org, title: role.title,
      startDate: null, endDate: null, unknownEndStartDate: "2020",
    } };
    const snapshot = snapshotSelection(original, now);
    expect(snapshot.facts[0]!.role).toMatchObject({
      startDate: null, endDate: null, unknownEndStartDate: "2020",
    });
    expect(snapshot.resumes[0]!.sections[0]).toMatchObject({
      startDate: null, endDate: null, unknownEndStartDate: "2020",
    });
    role.unknownEndStartDate = "2024";
    expect(snapshot.facts[0]!.role!.unknownEndStartDate).toBe("2020");
  });
  it("rejects a resume with a forged section heading or missing role evidence", () => {
    const original = selection();
    original.resumes[0]!.render.body.sections = [{
      roleId: "r1", kind: "job", org: "Acme", title: "Engineer",
      startDate: "2020", endDate: null, lines: [],
    }];
    expect(() => snapshotSelection(original)).toThrow(/unverified content/);
    original.resumes[0]!.roleEvidence = { r1: {
      id: "r1", revision: 1, kind: "job", org: "Acme", title: "Engineer",
      startDate: "2020", endDate: null,
    } };
    expect(() => snapshotSelection(original)).not.toThrow();
    original.resumes[0]!.render.body.sections[0]!.title = "Chief Executive";
    expect(() => snapshotSelection(original)).toThrow(/unverified content/);
  });
  it("copies only selected public fields for grounded resumes", () => {
    const original = selection();
    original.facts[0]!.interview = {
      documentId: "private-doc",
      questionId: "q1",
      question: "private interview question",
      quote: "private interview answer",
    };
    const snapshot = snapshotSelection(original, now);
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain("private");
    expect(json).not.toContain("factIds");
    expect(snapshot.resumes[0]!.verification).toBe("verified");
    original.facts[0]!.text = "Edited later";
    original.resumes[0]!.render.profile.name = "Changed later";
    expect(snapshot.facts[0]!.text).toBe("Built the API");
    expect(snapshot.resumes[0]!.profile.name).toBe("A User");
  });
  it("rejects unconfirmed facts/roles, empty selections, excessive selections and oversize snapshots", () => {
    expect(() =>
      snapshotSelection({ facts: [], roles: [], resumes: [] }),
    ).toThrow("select at least one");
    const bad = selection();
    bad.facts[0]!.state = "proposed";
    expect(() => snapshotSelection(bad)).toThrow("only confirmed");
    bad.facts[0]!.state = "confirmed";
    bad.roles[0]!.state = "proposed";
    expect(() => snapshotSelection(bad)).toThrow("confirm");
    const large = selection();
    large.facts[0]!.text = "x".repeat(1024 * 1024);
    expect(() => snapshotSelection(large)).toThrow("too large");
    expect(() =>
      snapshotSelection({
        ...selection(),
        facts: Array.from({ length: 101 }, (_, i) => ({
          ...selection().facts[0]!,
          id: String(i),
        })),
      }),
    ).toThrow("too many");
  });
  it("refuses detached edits, missing evidence and legacy resume versions", () => {
    const value = selection();
    value.resumes[0]!.render.body.summary!.status = "edited";
    expect(() => snapshotSelection(value)).toThrow("unverified content");
    value.resumes[0]!.render.body.summary!.status = "kept";
    value.resumes[0]!.render.body.summary!.factIds = [];
    expect(() => snapshotSelection(value)).toThrow("unverified content");
    value.resumes[0]!.render.body.summary!.factIds = ["missing"];
    expect(() => snapshotSelection(value)).toThrow("unverified content");
    value.resumes[0]!.render.body.summary!.factIds = ["f1"];
    value.resumes[0]!.render.body.skills = ["unbacked skill"];
    expect(() => snapshotSelection(value)).toThrow("unverified content");
    value.resumes[0]!.render.body.skills = [];
    value.resumes[0]!.provenance = "legacy";
    expect(() => snapshotSelection(value)).toThrow("unverified content");
  });
  it("keeps an old detached share private without erasing the owner's stored snapshot", () => {
    const { shares, db } = store();
    try {
      const grant = shares.create(who, selection(), now + 10_000, now);
      const saved = db.prepare(`SELECT snapshot FROM share_grants WHERE id = ?`).get(grant.id)!;
      const old = JSON.parse(saved.snapshot as string);
      old.resumes[0].summary = { id: "line1", text: "Unverified historical edit", verification: "user-authored" };
      old.resumes[0].verification = "user-authored";
      db.prepare(`UPDATE share_grants SET snapshot = ? WHERE id = ?`).run(JSON.stringify(old), grant.id);
      expect(() => shares.read({ grantId: grant.id, epoch: grant.epoch }, now)).toThrow("unavailable");
      expect(shares.export(who)[0]!.snapshot!.resumes[0]!.summary!.text).toBe("Unverified historical edit");
      expect(shares.list(who, now)[0]).toMatchObject({ revokedAt: null, available: false });
    } finally { db.close(); }
  });
  it("enforces owner auth, immutable reads, immediate revocation and epoch changes", () => {
    const { shares, security, db } = store();
    try {
      const input = selection();
      const grant = shares.create(who, input, now + 10_000, now);
      input.facts[0]!.text = "Future edit";
      expect(
        shares.read({ grantId: grant.id, epoch: grant.epoch }, now).snapshot
          .facts[0]!.text,
      ).toBe("Built the API");
      expect(shares.export(who)[0]?.snapshot?.facts[0]?.text).toBe(
        "Built the API",
      );
      expect(() => shares.list({ ...who, userId: "another" })).toThrow(
        "owner required",
      );
      security.epoch = "epoch-two";
      expect(() =>
        shares.read({ grantId: grant.id, epoch: grant.epoch }, now),
      ).toThrow("unavailable");
      security.epoch = grant.epoch;
      shares.revoke(who, grant.id, now);
      shares.revoke(who, grant.id, now + 1);
      expect(() =>
        shares.read({ grantId: grant.id, epoch: grant.epoch }, now),
      ).toThrow("unavailable");
      expect(
        db
          .prepare("SELECT snapshot FROM share_grants WHERE id = ?")
          .get(grant.id)?.snapshot,
      ).toBeNull();
    } finally {
      db.close();
    }
  });
  it("expires at the exact boundary before alarm cleanup, and denies closed accounts", () => {
    const { shares, security, db } = store();
    try {
      const grant = shares.create(who, selection(), now + 1000, now);
      expect(() =>
        shares.create(who, selection(), now + SHARE_TTL_MS + 1, now),
      ).toThrow("within seven days");
      expect(() =>
        shares.read({ grantId: grant.id, epoch: grant.epoch }, now + 1000),
      ).toThrow("expired");
      security.open = false;
      expect(() =>
        shares.read({ grantId: grant.id, epoch: grant.epoch }, now),
      ).toThrow("closed");
      security.open = true;
      shares.purgeExpired(now + 1000);
      expect(shares.list(who)).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe("how many copies are shared", () => {
  it("counts copies neither revoked nor expired, and those naming a coach", () => {
    const { shares, db } = store();
    try {
      expect(shares.openCounts(now)).toEqual({ copies: 0, coachCopies: 0 });
      shares.create(who, selection(), now + 10_000, now);
      const named = shares.create(who, selection(), now + 10_000, now, { coachEmail: "dana@example.test" });
      shares.create(who, selection(), now + 20_000, now, { coachEmail: "lee@example.test" });
      const soon = shares.create(who, selection(), now + 1_000, now, { coachEmail: "kim@example.test" });
      expect(shares.openCounts(now)).toEqual({ copies: 4, coachCopies: 3 });
      // Revoked: no longer shared.
      shares.revoke(who, named.id, now);
      expect(shares.openCounts(now)).toEqual({ copies: 3, coachCopies: 2 });
      // Expired at the exact moment, before the alarm erases it.
      expect(shares.openCounts(now + 999)).toEqual({ copies: 3, coachCopies: 2 });
      expect(shares.openCounts(now + 1_000)).toEqual({ copies: 2, coachCopies: 1 });
      expect(soon.coach?.email).toBe("kim@example.test");
      expect(shares.openCounts(now + 20_000)).toEqual({ copies: 0, coachCopies: 0 });
    } finally {
      db.close();
    }
  });
});

describe("what a copy says about its owner and its jobs", () => {
  const read = (shares: ShareStore, grant: { id: string; epoch: string }, at = now) =>
    shares.read({ grantId: grant.id, epoch: grant.epoch }, at);

  it("names nobody and no job unless the owner asked", () => {
    const { shares, db } = store();
    try {
      const grant = shares.create(who, selection(), now + 10_000, now);
      const view = read(shares, grant);
      expect(view.snapshot).toMatchObject({ schemaVersion: 2, owner: null });
      expect(view.snapshot.resumes[0]!.job).toBeNull();
      // The job the resume was written for stays in the vault.
      expect(JSON.stringify(view)).not.toContain("private");
      expect(grant).toMatchObject({ label: null, lastReadAt: null });
    } finally { db.close(); }
  });

  it("carries the owner's name and each resume's job when asked, and keeps the label for the owner", () => {
    const { shares, db } = store();
    try {
      const grant = shares.create(who, selection(), now + 10_000, now, {
        label: "  For Dana  ",
        owner: { name: "  Avery Example " },
        jobs: { resume1: { title: "Staff Engineer", company: "Litware" }, another: { title: "Not shared", company: null } },
      });
      expect(grant.label).toBe("For Dana");
      const view = read(shares, grant);
      expect(view.snapshot.owner).toEqual({ name: "Avery Example" });
      expect(view.snapshot.resumes[0]!.job).toEqual({ title: "Staff Engineer", company: "Litware" });
      // The reader gets the copy and when it ends. The label is the owner's own note.
      expect(Object.keys(view).sort()).toEqual(["expiresAt", "grantId", "snapshot"]);
      expect(JSON.stringify(view)).not.toContain("Dana");
      expect(JSON.stringify(view)).not.toContain("Not shared");
      expect(shares.list(who, now)[0]).toMatchObject({ label: "For Dana", lastReadAt: null, available: true });
      expect(shares.export(who)[0]).toMatchObject({ label: "For Dana", snapshot: { owner: { name: "Avery Example" } } });
    } finally { db.close(); }
  });

  it("refuses a label that is long or runs over a line, and drops an empty one", () => {
    const { shares, db } = store();
    try {
      expect(() => shares.create(who, selection(), now + 10_000, now, { label: "x".repeat(81) })).toThrow("one short line");
      for (const label of ["For Dana\nand Sam", "For Dana\tand Sam", "For Dana\u0000"])
        expect(() => shares.create(who, selection(), now + 10_000, now, { label })).toThrow("one short line");
      expect(shares.create(who, selection(), now + 10_000, now, { label: "   " }).label).toBeNull();
      expect(shares.create(who, selection(), now + 10_000, now, { label: "x".repeat(80) }).label).toHaveLength(80);
      expect(shares.list(who, now)).toHaveLength(2);
    } finally { db.close(); }
  });

  it("still opens a copy made before names and jobs were added", () => {
    const { shares, db } = store();
    try {
      const grant = shares.create(who, selection(), now + 10_000, now);
      const earlier = snapshotSelection(selection(), now);
      expect(earlier.schemaVersion).toBe(1);
      db.prepare(`UPDATE share_grants SET snapshot = ? WHERE id = ?`).run(JSON.stringify(earlier), grant.id);
      const view = read(shares, grant);
      expect(view.snapshot).toEqual(earlier);
      expect(view.snapshot.owner).toBeUndefined();
      // An earlier copy never carried a job, so one that claims to is not what was saved.
      const forged = { ...earlier, resumes: [{ ...earlier.resumes[0]!, job: { title: "Added later", company: null } }] };
      db.prepare(`UPDATE share_grants SET snapshot = ? WHERE id = ?`).run(JSON.stringify(forged), grant.id);
      expect(() => read(shares, grant)).toThrow("unavailable");
    } finally { db.close(); }
  });

  it("checks a named copy's resume against the saved version, whatever the name and job say", () => {
    const { shares, db } = store();
    try {
      const details = { owner: { name: "Avery Example" }, jobs: { resume1: { title: "Staff Engineer", company: "Litware" } } };
      const grant = shares.create(who, selection(), now + 10_000, now, details);
      const saved = () => JSON.parse(db.prepare(`SELECT snapshot FROM share_grants WHERE id = ?`).get(grant.id)!.snapshot as string);
      const store_ = (value: unknown) => db.prepare(`UPDATE share_grants SET snapshot = ? WHERE id = ?`).run(JSON.stringify(value), grant.id);
      const original = saved();
      const changed = saved();
      changed.resumes[0].summary.text = "Ran the whole company";
      store_(changed);
      expect(() => read(shares, grant)).toThrow("unavailable");
      for (const job of [{ title: "Staff Engineer", company: "Litware", notes: "private" }, { title: 7, company: null }, "Litware", { title: "x".repeat(201), company: null }]) {
        store_({ ...original, resumes: [{ ...original.resumes[0], job }] });
        expect(() => read(shares, grant)).toThrow("unavailable");
      }
      for (const owner of [undefined, { name: "" }, { name: 7 }, { name: "x".repeat(201) }, "Avery"]) {
        store_({ ...original, owner });
        expect(() => read(shares, grant)).toThrow("unavailable");
      }
      store_(original);
      expect(read(shares, grant).snapshot).toEqual(original);
    } finally { db.close(); }
  });

  it("counts a copy whose name pushes it past the size limit as too large", () => {
    const { shares, db } = store();
    try {
      const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
      const large = selection();
      large.facts[0]!.text = "";
      const room = MAX_SHARE_BYTES - size(snapshotSelection(large, now));
      // The selection alone fits exactly. What a copy adds around it has to fit as well.
      large.facts[0]!.text = "x".repeat(room);
      expect(size(snapshotSelection(large, now))).toBe(MAX_SHARE_BYTES);
      expect(() => shares.create(who, large, now + 10_000, now)).toThrow("too large");
      // A name is cut to 200 characters. With 100 bytes to spare it doesn't fit, and the copy without it does.
      large.facts[0]!.text = "x".repeat(room - 100);
      expect(() => shares.create(who, large, now + 10_000, now, { owner: { name: "n".repeat(500) } })).toThrow("too large");
      const grant = shares.create(who, large, now + 10_000, now);
      expect(read(shares, grant).snapshot.owner).toBeNull();
      large.facts[0]!.text = "x".repeat(room - 300);
      const named = shares.create(who, large, now + 10_000, now, { owner: { name: "n".repeat(500) } });
      expect(read(shares, named).snapshot.owner).toEqual({ name: "n".repeat(200) });
    } finally { db.close(); }
  });

  it("notes when a copy is opened, and only while it can be opened", () => {
    const { shares, db } = store();
    try {
      const minute = SHARE_READ_INTERVAL_MS;
      const grant = shares.create(who, selection(), now + 10 * minute, now);
      // Checking whether a link still works, as the owner's list does, isn't opening it.
      shares.list(who, now + 1);
      read(shares, grant, now + 2);
      expect(shares.list(who, now + 3)[0]!.lastReadAt).toBeNull();
      shares.recordRead(grant.id, now + 500);
      expect(shares.list(who, now + 501)[0]!.lastReadAt).toBe(now + 500);
      // The list shows minutes, so a reload within the minute writes nothing.
      shares.recordRead(grant.id, now + 900);
      shares.recordRead(grant.id, now + 499 + minute);
      expect(shares.list(who, now + minute)[0]!.lastReadAt).toBe(now + 500);
      shares.recordRead(grant.id, now + 500 + minute);
      expect(shares.list(who, now + 2 * minute)[0]!.lastReadAt).toBe(now + 500 + minute);
      // Not once it has expired or been revoked.
      shares.recordRead(grant.id, now + 10 * minute);
      expect(shares.export(who)[0]!.lastReadAt).toBe(now + 500 + minute);
      shares.revoke(who, grant.id, now + 5 * minute);
      shares.recordRead(grant.id, now + 6 * minute);
      expect(shares.export(who)[0]).toMatchObject({ lastReadAt: now + 500 + minute, revokedAt: now + 5 * minute });
    } finally { db.close(); }
  });
});

describe("cover letters and interview preparation in a copy", () => {
  const SENTENCE = "Built the API";
  const QUESTION = "How would you discuss your experience relevant to API design?";
  /** A saved document version as the vault writes one now, with the full record of the fact it cites. */
  const saved = (kind: "letter" | "prep") => ({
    result: {
      kind,
      units: [{ id: "u1", roleId: "r1", text: SENTENCE, factIds: ["f1"], group: 0, status: "kept" }],
      questions: kind === "prep" ? [{ id: "q1", requirement: "private requirement from the posting", question: QUESTION }] : [],
    },
    facts: { f1: { text: SENTENCE, quote: "private original quote" } },
    evidence: { f1: { id: "f1", revision: 1, origin: "extracted", roleId: "r1", kind: "accomplishment", text: SENTENCE, level: "implemented", quote: "private original quote" } as FactRecord },
    profile: { name: "A User", email: "private@example.test" },
  });
  function withDocuments() {
    const made = store();
    for (const [id, kind] of [["letter1", "letter"], ["prep1", "prep"]] as const) {
      made.db.prepare(`INSERT INTO documents (id, kind, state) VALUES (?, ?, 'ready')`).run(id, kind);
      made.db.prepare(`INSERT INTO document_versions (document_id, version, data) VALUES (?, 1, ?)`).run(id, JSON.stringify(saved(kind)));
    }
    const chosen = (id: "letter1" | "prep1") => ({ id, version: 1, kind: id === "letter1" ? "letter" : "prep", data: saved(id === "letter1" ? "letter" : "prep") });
    const snapshotOf = (grantId: string) => JSON.parse(made.db.prepare(`SELECT snapshot FROM share_grants WHERE id = ?`).get(grantId)!.snapshot as string);
    const rewrite = (grantId: string, value: unknown) => made.db.prepare(`UPDATE share_grants SET snapshot = ? WHERE id = ?`).run(JSON.stringify(value), grantId);
    return { ...made, chosen, snapshotOf, rewrite };
  }
  const none = { facts: [], roles: [], resumes: [] };

  it("can be the whole copy, as their words alone", () => {
    const { shares, chosen, db } = withDocuments();
    try {
      const grant = shares.create(who, { ...none, documents: [chosen("letter1"), chosen("prep1")] }, now + 10_000, now, {
        documentJobs: { letter1: { title: "Staff Engineer", company: "Litware" }, other: { title: "Not shared", company: null } },
      });
      expect(grant).toMatchObject({ factCount: 0, resumeCount: 0, documentCount: 2 });
      const view = shares.read({ grantId: grant.id, epoch: grant.epoch }, now);
      expect(view.snapshot).toEqual({
        schemaVersion: 3, createdAt: now, owner: null, facts: [], resumes: [],
        documents: [
          { id: "letter1", version: 1, kind: "letter", paragraphs: [SENTENCE], questions: [], job: { title: "Staff Engineer", company: "Litware" } },
          { id: "prep1", version: 1, kind: "prep", paragraphs: [], questions: [{ question: QUESTION, points: [SENTENCE] }], job: null },
        ],
      });
      // Not the quote, the posting's requirement, the contact details, nor another document's job.
      expect(JSON.stringify(view)).not.toContain("private");
      expect(JSON.stringify(view)).not.toContain("Not shared");
      expect(shares.list(who, now)[0]).toMatchObject({ documentCount: 2, available: true });
      expect(shares.export(who)[0]).toMatchObject({ documentCount: 2, snapshot: { schemaVersion: 3 } });
    } finally { db.close(); }
  });

  it("sits beside facts and resumes, and a copy without documents is as it was", () => {
    const { shares, chosen, db } = withDocuments();
    try {
      const mixed = shares.create(who, { ...selection(), documents: [chosen("letter1")] }, now + 10_000, now);
      expect(mixed).toMatchObject({ factCount: 1, resumeCount: 1, documentCount: 1 });
      const view = shares.read({ grantId: mixed.id, epoch: mixed.epoch }, now);
      expect(view.snapshot.schemaVersion).toBe(3);
      expect(view.snapshot.facts).toHaveLength(1);
      expect(view.snapshot.resumes).toHaveLength(1);
      const plain = shares.create(who, selection(), now + 10_000, now);
      const without = shares.read({ grantId: plain.id, epoch: plain.epoch }, now).snapshot;
      expect(without.schemaVersion).toBe(2);
      expect(without).not.toHaveProperty("documents");
      expect(plain.documentCount).toBe(0);
      expect(() => shares.create(who, { ...none, documents: [] }, now + 10_000, now)).toThrow("select at least one fact, resume or document");
    } finally { db.close(); }
  });

  it("refuses a document that can't be checked, a repeat, and more than a copy holds", () => {
    const { shares, chosen, db } = withDocuments();
    try {
      const old = chosen("letter1");
      delete (old.data as { evidence?: unknown }).evidence;
      expect(() => shares.create(who, { ...none, documents: [old] }, now + 10_000, now)).toThrow("can't be shared as it is");
      expect(() => shares.create(who, { ...none, documents: [{ ...chosen("letter1"), kind: "questions" }] }, now + 10_000, now)).toThrow("can't be shared as it is");
      expect(() => shares.create(who, { ...none, documents: [chosen("letter1"), chosen("letter1")] }, now + 10_000, now)).toThrow("duplicate share selection");
      const many = Array.from({ length: MAX_SHARE_DOCUMENTS + 1 }, (_, i) => ({ ...chosen("letter1"), id: `letter${i}` }));
      expect(() => shares.create(who, { ...none, documents: many }, now + 10_000, now)).toThrow("too many items");
      expect(() => shares.create(who, { ...none, documents: many.slice(1) }, now + 10_000, now)).not.toThrow();
      // The size limit counts the documents with everything else.
      const long = chosen("prep1");
      long.data.result.questions = [{ id: "q1", requirement: "r", question: "How would you discuss it?" }];
      long.data.result.units = Array.from({ length: 400 }, (_, i) => ({ id: `u${i}`, roleId: "r1", text: SENTENCE, factIds: ["f1"], group: 0, status: "kept" }));
      const large = selection();
      large.facts[0]!.text = "x".repeat(MAX_SHARE_BYTES - 5_000);
      expect(() => shares.create(who, { ...large, documents: [long] }, now + 10_000, now)).toThrow("too large");
      expect(shares.list(who, now)).toHaveLength(1);
    } finally { db.close(); }
  });

  it("is rebuilt from the saved document every time the copy is read", () => {
    const { shares, chosen, db, snapshotOf, rewrite } = withDocuments();
    try {
      const grant = shares.create(who, { ...none, documents: [chosen("letter1"), chosen("prep1")] }, now + 10_000, now);
      const read = () => shares.read({ grantId: grant.id, epoch: grant.epoch }, now);
      const original = snapshotOf(grant.id);
      expect(read().snapshot).toEqual(original);
      // The stored copy says something the saved document doesn't.
      for (const change of [
        (copy: typeof original) => { copy.documents[0].paragraphs[0] = "Ran the whole company"; },
        (copy: typeof original) => { copy.documents[1].questions[0].points.push("Founded the company"); },
        (copy: typeof original) => { copy.documents[1].questions[0].question = "Why are you the best?"; },
        (copy: typeof original) => { copy.documents[0].kind = "prep"; },
        (copy: typeof original) => { copy.documents[0].version = 2; },
        (copy: typeof original) => { copy.documents[0].id = "missing"; },
        (copy: typeof original) => { copy.documents[0].notes = "private"; },
        (copy: typeof original) => { copy.documents[0].job = { title: "Staff Engineer", company: "Litware", notes: "private" }; },
        (copy: typeof original) => { delete copy.documents[0].job; },
        // Documents belong to a version 3 copy, and a version 3 copy has some.
        (copy: typeof original) => { copy.schemaVersion = 2; },
        (copy: typeof original) => { copy.documents = []; },
        (copy: typeof original) => { delete copy.documents; },
        (copy: typeof original) => { copy.documents = "letter1"; },
        (copy: typeof original) => { copy.schemaVersion = 4; },
        (copy: typeof original) => { copy.owner = { name: "" }; },
      ]) {
        const copy = structuredClone(original);
        change(copy);
        rewrite(grant.id, copy);
        expect(read, JSON.stringify(copy).slice(0, 120)).toThrow("unavailable");
      }
      rewrite(grant.id, original);
      expect(read().snapshot).toEqual(original);
      expect(shares.list(who, now)[0]!.available).toBe(true);

      // The saved document no longer says what the copy holds, or is no longer there to check.
      const letter = saved("letter");
      letter.result.units[0]!.text = "Built the API and the billing system";
      db.prepare(`UPDATE document_versions SET data = ? WHERE document_id = 'letter1'`).run(JSON.stringify(letter));
      expect(read).toThrow("unavailable");
      expect(shares.list(who, now)[0]!.available).toBe(false);
      db.prepare(`UPDATE document_versions SET data = ? WHERE document_id = 'letter1'`).run(JSON.stringify(saved("letter")));
      expect(read().snapshot).toEqual(original);
      const withoutEvidence = saved("prep") as { evidence?: unknown };
      delete withoutEvidence.evidence;
      db.prepare(`UPDATE document_versions SET data = ? WHERE document_id = 'prep1'`).run(JSON.stringify(withoutEvidence));
      expect(read).toThrow("unavailable");
      db.prepare(`UPDATE document_versions SET data = ? WHERE document_id = 'prep1'`).run(JSON.stringify(saved("prep")));
      db.prepare(`UPDATE documents SET state = 'failed' WHERE id = 'prep1'`).run();
      expect(read).toThrow("unavailable");
      db.prepare(`UPDATE documents SET state = 'ready' WHERE id = 'prep1'`).run();
      db.prepare(`DELETE FROM document_versions WHERE document_id = 'letter1'`).run();
      expect(read).toThrow("unavailable");
      // The owner's stored copy is untouched by any of this.
      expect(shares.export(who)[0]!.snapshot).toEqual(original);
    } finally { db.close(); }
  });

  it("gives a copy without documents no way to carry one", () => {
    const { shares, db, snapshotOf, rewrite } = withDocuments();
    try {
      const grant = shares.create(who, selection(), now + 10_000, now);
      const copy = snapshotOf(grant.id);
      copy.documents = [{ id: "letter1", version: 1, kind: "letter", paragraphs: [SENTENCE], questions: [], job: null }];
      rewrite(grant.id, copy);
      expect(() => shares.read({ grantId: grant.id, epoch: grant.epoch }, now)).toThrow("unavailable");
      // Nor a copy from before names and jobs.
      const earlier = snapshotSelection(selection(), now) as unknown as Record<string, unknown>;
      earlier.documents = copy.documents;
      rewrite(grant.id, earlier);
      expect(() => shares.read({ grantId: grant.id, epoch: grant.epoch }, now)).toThrow("unavailable");
    } finally { db.close(); }
  });
});

describe("the coach a copy names", () => {
  const dana = { userId: "u-dana", email: "dana@example.test", name: "  Dana \n Okafor  " };
  const made = (coachEmail?: string | null) => {
    const { shares, db, security } = store();
    const grant = shares.create(who, selection(), now + 10_000, now, { coachEmail, owner: { name: "Sam Rivera" } });
    return { shares, db, security, grant, claims: { grantId: grant.id, epoch: grant.epoch } };
  };

  it("is nobody unless an address is given, and an address is kept as accounts compare it", () => {
    const plain = made();
    try {
      expect(plain.grant.coach).toBeNull();
      expect(plain.shares.reviewer(plain.claims, dana, now)).toBe("none");
      expect(plain.shares.reviewer(plain.claims, null, now)).toBe("none");
      expect(() => plain.shares.join(plain.claims, dana, now)).toThrow("names a different address");
      for (const bad of ["dana", "dana@example", "a b@example.test", "@example.test", `${"x".repeat(250)}@example.test`])
        expect(() => plain.shares.create(who, selection(), now + 10_000, now, { coachEmail: bad }), bad).toThrow("enter the coach's email address");
      expect(plain.shares.create(who, selection(), now + 10_000, now, { coachEmail: "  " }).coach).toBeNull();
      expect(plain.shares.create(who, selection(), now + 10_000, now, { coachEmail: " Dana@Example.TEST " }).coach).toEqual({ email: "dana@example.test", name: null, joinedAt: null });
    } finally { plain.db.close(); }
  });

  it("is taken up by the one account with that address, and by no other", () => {
    const { shares, db, grant, claims } = made("dana@example.test");
    try {
      expect(shares.reviewer(claims, null, now)).toBe("named");
      expect(shares.reviewer(claims, { userId: "u-x", email: "someone@example.test" }, now)).toBe("other");
      expect(shares.reviewer(claims, dana, now)).toBe("you");
      expect(() => shares.join(claims, { userId: "u-x", email: "someone@example.test" }, now)).toThrow("names a different address");
      expect(() => shares.openForCoach(grant.id, dana, now)).toThrow("unavailable");
      expect(shares.coachStatus(grant.id, dana, now)).toBeNull();

      expect(shares.join(claims, dana, now + 5)).toEqual({ ownerName: "Sam Rivera", expiresAt: now + 10_000 });
      expect(shares.reviewer(claims, dana, now)).toBe("joined");
      expect(shares.list(who, now)[0]!.coach).toEqual({ email: "dana@example.test", name: "Dana Okafor", joinedAt: now + 5 });
      // Taking it up again keeps when it was first taken up.
      shares.join(claims, { ...dana, name: null }, now + 50);
      expect(shares.list(who, now)[0]!.coach).toEqual({ email: "dana@example.test", name: null, joinedAt: now + 5 });
      expect(shares.openForCoach(grant.id, dana, now)).toEqual({ epoch: grant.epoch, expiresAt: now + 10_000 });
      expect(shares.coachStatus(grant.id, dana, now)).toEqual({ active: true, ownerName: "Sam Rivera", expiresAt: now + 10_000, factCount: 1, resumeCount: 1, documentCount: 0 });

      // The same address under another account, or the same account under another address, is not the coach.
      for (const other of [{ userId: "u-other", email: dana.email }, { userId: dana.userId, email: "dana@elsewhere.test" }]) {
        expect(() => shares.openForCoach(grant.id, other, now)).toThrow("unavailable");
        expect(shares.coachStatus(grant.id, other, now)).toBeNull();
      }
      expect(shares.reviewer(claims, { userId: "u-other", email: dana.email }, now)).toBe("you");
      // An account made again under the address takes the copy up afresh.
      shares.join(claims, { userId: "u-other", email: dana.email, name: "Dana O." }, now + 90);
      expect(shares.list(who, now)[0]!.coach).toEqual({ email: "dana@example.test", name: "Dana O.", joinedAt: now + 90 });
      expect(() => shares.openForCoach(grant.id, dana, now)).toThrow("unavailable");
      expect(shares.export(who)[0]!.coach).toMatchObject({ email: "dana@example.test", joinedAt: now + 90 });
    } finally { db.close(); }
  });

  it("gives the coach nothing once the link has expired, been revoked or stopped being deliverable", () => {
    const { shares, db, security, grant, claims } = made("dana@example.test");
    try {
      // Ending every session on the owner's account closes its copies, to a coach as to a link.
      security.epoch = "epoch-two";
      expect(() => shares.join(claims, dana, now)).toThrow("unavailable");
      expect(() => shares.reviewer(claims, dana, now)).toThrow("unavailable");
      security.epoch = "epoch-one";
      shares.join(claims, dana, now);
      security.epoch = "epoch-two";
      expect(shares.coachStatus(grant.id, dana, now)).toBeNull();
      expect(() => shares.openForCoach(grant.id, dana, now)).toThrow("unavailable");
      security.epoch = "epoch-one";
      expect(shares.coachStatus(grant.id, dana, now)).toMatchObject({ active: true });
      expect(() => shares.openForCoach(grant.id, dana, now + 10_000)).toThrow("unavailable");
      expect(shares.coachStatus(grant.id, dana, now + 10_000)).toBeNull();
      expect(() => shares.reviewer(claims, dana, now + 10_000)).toThrow("unavailable");
      expect(() => shares.join(claims, dana, now + 10_000)).toThrow("unavailable");
      expect(() => shares.join({ ...claims, epoch: "another" }, dana, now)).toThrow("unavailable");
      // The saved resume no longer matches the copy, so there is nothing to open.
      db.prepare(`UPDATE resume_versions SET data = ? WHERE resume_id = 'resume1'`).run(JSON.stringify({ render: { profile: {}, body: { summary: null, sections: [], skills: [] } }, facts: {} }));
      expect(() => shares.openForCoach(grant.id, dana, now)).toThrow("unavailable");
      // The coach's list says no more of it than of a link that has ended, and it can't be taken up again.
      expect(shares.coachStatus(grant.id, dana, now)).toBeNull();
      expect(() => shares.join(claims, dana, now + 1)).toThrow("gone: this share link is unavailable or expired");
      shares.revoke(who, grant.id, now + 1);
      expect(() => shares.openForCoach(grant.id, dana, now + 2)).toThrow("unavailable");
      expect(shares.coachStatus(grant.id, dana, now + 2)).toBeNull();
      // The owner's record of who took it up stays with the revoked link.
      expect(shares.list(who, now + 2)[0]).toMatchObject({ revokedAt: now + 1, coach: { email: "dana@example.test", name: "Dana Okafor", joinedAt: now } });
    } finally { db.close(); }
  });
});

describe("a fact its owner has marked sensitive", () => {
  const QUOTE = "private original quote";
  const marked = (ids: string[], quotes: string[] = []): Withheld => ({ ids: new Set(ids), quotes: new Set(quotes) });
  const unmarked = marked([]);
  /** A letter that says the one fact, saved with the full record it was checked against. */
  const letter = () => ({
    result: { kind: "letter", units: [{ id: "u1", roleId: "r1", text: "Built the API", factIds: ["f1"], group: 0, status: "kept" }], questions: [] },
    facts: { f1: { text: "Built the API", quote: QUOTE } },
    evidence: { f1: { id: "f1", revision: 1, origin: "extracted", roleId: "r1", kind: "accomplishment", text: "Built the API", level: "implemented", quote: QUOTE } as FactRecord },
  });
  const none = { facts: [], roles: [], resumes: [] };
  /** Three copies made while nothing is marked: the fact alone, the resume alone and the letter alone. */
  function copies(coachEmail?: string) {
    const made = store();
    made.db.prepare(`INSERT INTO documents (id, kind, state) VALUES ('letter1', 'letter', 'ready')`).run();
    made.db.prepare(`INSERT INTO document_versions (document_id, version, data) VALUES ('letter1', 1, ?)`).run(JSON.stringify(letter()));
    const chosen = { id: "letter1", version: 1, kind: "letter", data: letter() };
    const whole = selection();
    const fact = made.shares.create(who, { ...whole, resumes: [] }, now + 10_000, now, { coachEmail });
    const resume = made.shares.create(who, { ...whole, facts: [] }, now + 10_000, now + 1);
    const document = made.shares.create(who, { ...none, documents: [chosen] }, now + 10_000, now + 2);
    const read = (grant: { id: string; epoch: string }) => made.shares.read({ grantId: grant.id, epoch: grant.epoch }, now + 3);
    return { ...made, chosen, fact, resume, document, read };
  }

  it("is not copied, and neither is a resume or a letter that uses it", () => {
    const { shares, security, db, chosen } = copies();
    try {
      security.withheld = marked(["f1"], [QUOTE]);
      expect(() => shares.create(who, { ...selection(), resumes: [] }, now + 10_000, now)).toThrow("A fact marked sensitive can't be shared. Unmark it, or leave it out.");
      expect(() => shares.create(who, { ...selection(), facts: [] }, now + 10_000, now)).toThrow("This version uses a fact you keep private");
      expect(() => shares.create(who, { ...none, documents: [chosen] }, now + 10_000, now)).toThrow("can't be shared as it is");
      expect(() => shares.create(who, { ...selection(), documents: [chosen] }, now + 10_000, now)).toThrow();
      // The gate itself, given the marks, refuses in the same words. Given none, it is as it was.
      expect(() => snapshotSelection(selection(), now, marked(["f1"]))).toThrow("A fact marked sensitive can't be shared");
      expect(() => snapshotSelection({ ...selection(), facts: [] }, now, marked(["f1"]))).toThrow("you keep private");
      expect(() => snapshotSelection(selection(), now, unmarked)).not.toThrow();
      // Nothing was made beyond the three copies from before the mark.
      expect(db.prepare(`SELECT COUNT(*) AS n FROM share_grants`).get()).toEqual({ n: 3 });
      security.withheld = unmarked;
      expect(shares.create(who, { ...selection(), documents: [chosen] }, now + 10_000, now)).toMatchObject({ factCount: 1, resumeCount: 1, documentCount: 1 });
    } finally { db.close(); }
  });

  it("closes each copy that holds it or uses it, says so only to its owner, and opens them again when unmarked", () => {
    const { shares, security, db, fact, resume, document, read } = copies();
    try {
      const before = { fact: read(fact), resume: read(resume), document: read(document) };
      expect(shares.list(who, now + 3).map((grant) => grant.available)).toEqual([true, true, true]);

      security.withheld = marked(["f1"], [QUOTE]);
      for (const grant of [fact, resume, document])
        // The words a reader gets for any link that has ended. Nothing says a fact exists or is marked.
        expect(() => read(grant), grant.id).toThrow("gone: this share link is unavailable or expired");
      // The owner's list says the links are closed, and the copies themselves are kept as they were.
      expect(shares.list(who, now + 3).map((grant) => [grant.revokedAt, grant.available])).toEqual([[null, false], [null, false], [null, false]]);
      expect(shares.export(who).map((grant) => grant.snapshot)).toEqual([before.document.snapshot, before.resume.snapshot, before.fact.snapshot]);
      // Passing the marks in closes a copy just as asking for them does.
      security.withheld = unmarked;
      expect(() => shares.read({ grantId: fact.id, epoch: fact.epoch }, now + 3, marked(["f1"]))).toThrow("unavailable");

      // Unmarked, each copy is delivered exactly as it was.
      expect({ fact: read(fact), resume: read(resume), document: read(document) }).toEqual(before);
      expect(shares.list(who, now + 3).map((grant) => grant.available)).toEqual([true, true, true]);
      // A copy revoked while it was closed stays gone.
      security.withheld = marked(["f1"], [QUOTE]);
      shares.revoke(who, fact.id, now + 4);
      security.withheld = unmarked;
      expect(() => read(fact)).toThrow("unavailable");
    } finally { db.close(); }
  });

  it("closes a resume or a letter checked against its line, and leaves a copy of another fact's own words open", () => {
    const { shares, security, db, fact, resume, document, read } = copies();
    try {
      // Another fact read from the same line is marked. "Built the API" is not.
      security.withheld = marked(["another"], [QUOTE]);
      // A copied fact is its text and never its quote, so the copy that holds only that stays open.
      expect(read(fact).snapshot.facts.map((copied) => copied.text)).toEqual(["Built the API"]);
      expect(() => read(resume)).toThrow("unavailable");
      expect(() => read(document)).toThrow("unavailable");
      // Newest first: the letter, the resume, the fact.
      expect(shares.list(who, now + 3).map((grant) => grant.available)).toEqual([false, false, true]);
    } finally { db.close(); }
  });

  it("gives the coach a copy names nothing while it is marked", () => {
    const dana = { userId: "u-dana", email: "dana@example.test", name: "Dana Okafor" };
    const { shares, security, db, fact } = copies(dana.email);
    try {
      const claims = { grantId: fact.id, epoch: fact.epoch };
      const listed = { active: true, ownerName: null, expiresAt: now + 10_000, factCount: 1, resumeCount: 0, documentCount: 0 };
      shares.join(claims, dana, now);
      expect(shares.openForCoach(fact.id, dana, now)).toEqual({ epoch: fact.epoch, expiresAt: now + 10_000 });
      expect(shares.coachStatus(fact.id, dana, now)).toEqual(listed);
      security.withheld = marked(["f1"], [QUOTE]);
      expect(() => shares.openForCoach(fact.id, dana, now)).toThrow("gone: this share link is unavailable or expired");
      expect(() => shares.read(claims, now)).toThrow("unavailable");
      // Their list says of it what it says of a link that has ended: nothing, not even how much it holds.
      expect(shares.coachStatus(fact.id, dana, now)).toBeNull();
      security.withheld = unmarked;
      expect(shares.openForCoach(fact.id, dana, now)).toEqual({ epoch: fact.epoch, expiresAt: now + 10_000 });
      expect(shares.coachStatus(fact.id, dana, now)).toEqual(listed);
    } finally { db.close(); }
  });

  it("can't be taken up by the coach a copy names while it is marked, and its owner is shown no take-up", () => {
    const dana = { userId: "u-dana", email: "dana@example.test", name: "Dana Okafor" };
    const { shares, security, db, fact } = copies(dana.email);
    try {
      // The coach holds the link's session from before the mark, and has not taken the copy up.
      const claims = { grantId: fact.id, epoch: fact.epoch };
      const named = () => shares.list(who, now).find((grant) => grant.id === fact.id)!.coach;
      expect(shares.reviewer(claims, dana, now)).toBe("you");
      security.withheld = marked(["f1"], [QUOTE]);
      // The same words as for a link that has ended, for the named coach and for anyone else.
      expect(() => shares.join(claims, dana, now)).toThrow("gone: this share link is unavailable or expired");
      expect(() => shares.join(claims, { userId: "u-x", email: "someone@example.test" }, now)).toThrow("gone: this share link is unavailable or expired");
      expect(named()).toEqual({ email: dana.email, name: null, joinedAt: null });
      expect(shares.coachStatus(fact.id, dana, now)).toBeNull();
      // Unmarked, the copy is taken up as it always could be.
      security.withheld = unmarked;
      expect(shares.join(claims, dana, now + 5)).toEqual({ ownerName: null, expiresAt: now + 10_000 });
      expect(named()).toEqual({ email: dana.email, name: "Dana Okafor", joinedAt: now + 5 });
      // Marked again once taken up, a repeat of the take-up is refused too and changes nothing.
      security.withheld = marked(["f1"], [QUOTE]);
      expect(() => shares.join(claims, { ...dana, name: "Someone Else" }, now + 9)).toThrow("gone: this share link is unavailable or expired");
      expect(named()).toEqual({ email: dana.email, name: "Dana Okafor", joinedAt: now + 5 });
    } finally { db.close(); }
  });
});

describe("share credential isolation", () => {
  it("keeps link bearer secrets in fragments and rejects wrong-purpose tokens", async () => {
    const token = await createShareToken(secret, claims);
    const link = new URL(shareLink("https://app.example.com", token));
    expect(link.pathname).toBe("/share");
    expect(link.search).toBe("");
    expect(link.hash).toBe(`#${token}`);
    expect(
      await readShareToken(secret, token, "coach-link", now),
    ).toMatchObject(claims);
    expect(
      await readShareToken(secret, token, "coach-session", now),
    ).toBeNull();
    expect(
      await readShareToken(secret, token, "coach-link", claims.exp),
    ).toBeNull();
    const owner = await signToken(secret, {
      uid: "owner",
      vid: claims.vid,
      gen: 1,
      exp: claims.exp,
    });
    expect(await readShareToken(secret, owner, "coach-link", now)).toBeNull();
  });
  it("caps a separate HttpOnly session at an hour and at grant expiration", async () => {
    for (const exp of [now + 30_000, claims.exp]) {
      const cookie = await createShareSession(
        secret,
        { ...claims, exp, kind: "coach-link" },
        now,
      );
      expect(cookie.startsWith(`${SHARE_COOKIE}=`)).toBe(true);
      expect(cookie).toContain("Secure; HttpOnly; SameSite=Strict");
      const token = cookie.split(";")[0]!.slice(SHARE_COOKIE.length + 1);
      const session = await readShareToken(secret, token, "coach-session", now);
      expect(session!.exp).toBe(Math.min(exp, now + 3_600_000));
      expect(await readShareToken(secret, token, "coach-link", now)).toBeNull();
    }
  });
  it("gives each copy a cookie of its own, named only by a well-formed grant", async () => {
    const name = shareCookieName(claims.grantId.toUpperCase());
    expect(name).toBe(`__Host-share-${claims.grantId}`);
    const cookie = await createShareSession(secret, { ...claims, kind: "coach-link" }, now, name);
    expect(cookie.startsWith(`${name}=`)).toBe(true);
    expect(cookie).toContain("Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600");
    const session = await readShareToken(secret, cookie.split(";")[0]!.slice(name.length + 1), "coach-session", now);
    expect(session).toMatchObject({ grantId: claims.grantId, kind: "coach-session" });
    // Anything else would let a request choose a cookie name, or break the header.
    for (const bad of ["", "legacy", `${claims.grantId}; Domain=example.com`, `${claims.grantId}=x`, "../../etc", `${claims.grantId} `])
      expect(() => shareCookieName(bad)).toThrow("unavailable");
  });
});
