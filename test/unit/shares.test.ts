import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
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
  shareLink,
  SHARE_COOKIE,
} from "../../src/worker/shares";
import { signToken } from "../../src/worker/crypto";

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
  for (const migration of SHARE_MIGRATIONS) sql.exec(migration);
  db.exec(`CREATE TABLE resume_versions (resume_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL)`);
  const resume = selection().resumes[0]!;
  db.prepare(`INSERT INTO resume_versions (resume_id,version,data) VALUES (?,?,?)`).run(resume.id, resume.render.version, JSON.stringify(resume));
  const security = { open: true, epoch: "epoch-one" };
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
      expect(shares.list(who)[0]!.revokedAt).toBeNull();
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
});
