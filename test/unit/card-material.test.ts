import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { NewPart, NewTag, Range, Stamp } from "../../src/shared/record";
import type { RoleRecord } from "../../src/shared/types";
import { readCardMaterial } from "../../src/vault/card";
import { RecordStore } from "../../src/vault/record";
import { createSchema } from "../../src/vault/schema";
import { withheldFacts } from "../../src/vault/sensitive";
import type { ConceptKind } from "../../src/taxonomy";

// What a vault gives for its owner's card, read from the record on the vault's whole schema in
// Node's SQLite. The facts and roles passed in are chosen here as the Vault chooses them
// (`usableFacts()` and its confirmed jobs); test/integration/card-preview.test.ts runs the Vault's own.

const VERSION = "esco-1.2.1+onet-31.0+c036f953";
const owner: Stamp = { proposedBy: "owner", model: null, method: "owner", taxonomyVersion: VERSION, confidence: null, shadow: false };
const model: Stamp = { proposedBy: "model", model: "@cf/test/judge", method: "judge/1", taxonomyVersion: VERSION, confidence: 0.9, shadow: false };
const shadow: Stamp = { ...model, shadow: true };

const S = (n: number) => `esco:skill:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const O = (n: number) => `esco:occupation:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const KUBERNETES = "onet:tool:kubernetes";
const GROUP = "esco:skill:S1.1";
const CATEGORY = "onet:toolcat:5.A.1.02";
const ACTIVITY = "onet:activity:4.A.3.b.1.I01.D01";

const LINE = "Designed the billing API and cut hosting costs by 30%";
function at(line: string, words: string): Range {
  const start = line.indexOf(words);
  return [start, start + words.length];
}
const DIVISION: NewPart[] = [
  { kind: "clause", ranges: [at(LINE, "Designed the billing API")] },
  { kind: "clause", ranges: [at(LINE, "cut hosting costs by 30%")] },
];

function vault() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(statement: string, ...bindings: (string | number | null)[]) {
      const rows = db.prepare(statement).all(...bindings);
      return { toArray: () => rows, one: () => rows[0] };
    },
  } as unknown as SqlStorage;
  let depth = 0;
  const transaction = <T>(fn: () => T): T => {
    const name = `card_${depth++}`;
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
  let clock = 1_800_000_000_000;
  const record = new RecordStore(sql, transaction, () => clock++);
  const run = (statement: string, ...bindings: (string | number | null)[]) => void db.prepare(statement).run(...bindings);
  run(`INSERT INTO sources (id, filename, r2_key, markdown, state, created_at) VALUES ('upload-1', 'cv.pdf', 'vaults/test/sources/upload-1', '', 'ready', 1)`);
  const role = (id: string, fields: { kind?: string; org?: string; title?: string; start?: string | null; end?: string | null; state?: string } = {}) =>
    run(
      `INSERT INTO roles (id, kind, org, title, start_date, end_date, state) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      fields.kind ?? "job",
      fields.org ?? "Northwind Traders",
      fields.title ?? "Staff Platform Engineer",
      fields.start === undefined ? "2019-03" : fields.start,
      fields.end === undefined ? null : fields.end,
      fields.state ?? "confirmed",
    );
  const fact = (id: string, text: string, fields: { role?: string | null; kind?: string; state?: string } = {}) => {
    run(`INSERT INTO evidence (id, source_id, quote, start, end, source_revision_id) VALUES (?, 'upload-1', ?, 0, ?, 'upload-1:1')`, `quote-${id}`, text, text.length);
    run(
      `INSERT INTO facts (id, role_id, kind, text, evidence_id, source_id, origin, state, updated_at) VALUES (?, ?, ?, ?, ?, 'upload-1', 'extracted', ?, 1)`,
      id,
      fields.role === undefined ? "job-1" : fields.role,
      fields.kind ?? "accomplishment",
      text,
      `quote-${id}`,
      fields.state ?? "confirmed",
    );
  };
  const tag = (kind: "fact" | "part" | "role", id: string, conceptId: string, conceptKind: ConceptKind, stamp: Stamp = owner) => {
    const made: NewTag = { subject: { kind, id }, conceptId, conceptKind, label: `stored label of ${conceptId}`, stamp };
    return record.proposeTag(made).tagId;
  };
  const mark = (id: string, sensitive = true) => run(`UPDATE facts SET sensitive = ? WHERE id = ?`, sensitive ? 1 : 0, id);

  /** The material as the Vault reads it: `usableFacts()`, the marked facts and the confirmed jobs. */
  const material = () => {
    const withheld = withheldFacts(sql).ids;
    const usable = (
      db
        .prepare(
          `SELECT f.id, f.kind FROM facts f LEFT JOIN roles r ON r.id = f.role_id
           WHERE f.state = 'confirmed' AND (f.role_id IS NULL OR r.state = 'confirmed')`,
        )
        .all() as { id: string; kind: "accomplishment" | "skill" | "credential" }[]
    ).filter((row) => !withheld.has(row.id));
    const jobs = (
      db.prepare(`SELECT id, kind, org, title, start_date, end_date, unknown_end_start_date FROM roles WHERE state = 'confirmed' AND kind = 'job'`).all() as Record<string, string | null>[]
    ).map(
      (row): RoleRecord => ({
        id: row.id!,
        kind: "job",
        org: row.org!,
        title: row.title ?? null,
        startDate: row.start_date ?? null,
        endDate: row.end_date ?? null,
        unknownEndStartDate: row.unknown_end_start_date ?? null,
      }),
    );
    return readCardMaterial(record, usable, withheld, jobs);
  };
  role("job-1");
  return { db, record, run, role, fact, tag, mark, material };
}

describe("what a vault gives for its owner's card", () => {
  it("takes confirmed, non-shadow tags only", () => {
    const { db, record, fact, tag, material } = vault();
    fact("f1", LINE);
    tag("fact", "f1", S(1), "skill");
    tag("fact", "f1", S(2), "skill", model);
    record.decideTag(tag("fact", "f1", S(3), "skill", model), "rejected");
    // A shadow tag is read by nothing but measurement, even one somehow stored as confirmed.
    tag("fact", "f1", S(4), "knowledge", shadow);
    db.prepare(`UPDATE record_tags SET state = 'confirmed' WHERE shadow = 1`).run();
    expect(material().skills).toEqual([{ conceptId: S(1), facts: 1 }]);
    // The owner confirming a proposed tag brings it in.
    record.decideTag(record.tags({ kind: "fact", id: "f1" }).find((one) => one.conceptId === S(2))!.id, "confirmed");
    expect(material().skills).toEqual([
      { conceptId: S(1), facts: 1 },
      { conceptId: S(2), facts: 1 },
    ]);
  });

  it("takes no tag from a skills-list fact, a fact outside usableFacts, a does relation or an unconfirmed role", () => {
    const { fact, role, tag, material } = vault();
    fact("accomplishment", LINE);
    tag("fact", "accomplishment", S(1), "skill");
    tag("fact", "accomplishment", KUBERNETES, "tool");
    // What a line does is an activity, not a skill.
    tag("fact", "accomplishment", ACTIVITY, "activity");
    // A credential counts as an accomplishment does.
    fact("credential", "Certified Kubernetes Administrator", { kind: "credential", role: null });
    tag("fact", "credential", KUBERNETES, "tool");
    // A skills-list item says nothing more than that the person listed it.
    fact("listed", "Go", { kind: "skill", role: null });
    tag("fact", "listed", S(6), "knowledge");
    // Facts outside usableFacts(): one still proposed, one rejected, and one under a role that isn't confirmed.
    fact("proposed", "Ran the on-call rota", { state: "proposed" });
    tag("fact", "proposed", S(2), "skill");
    fact("rejected", "Ran the hiring loop", { state: "rejected" });
    tag("fact", "rejected", S(3), "skill");
    role("pending", { state: "proposed", title: "Consultant" });
    fact("under-pending", "Advised three clients", { role: "pending" });
    tag("fact", "under-pending", S(5), "skill");
    // Roles: only a confirmed job's occupation counts.
    tag("role", "job-1", O(1), "occupation");
    tag("role", "pending", O(2), "occupation");
    role("degree", { kind: "education", title: "BSc Computer Science", start: "2012", end: "2015" });
    tag("role", "degree", O(3), "occupation");
    role("turned-down", { state: "rejected", title: "Intern" });
    tag("role", "turned-down", "esco:isco:C2512", "occupation-group");

    const given = material();
    expect(given.skills).toEqual([
      { conceptId: KUBERNETES, facts: 2 },
      { conceptId: S(1), facts: 1 },
    ]);
    expect(given.jobs).toEqual([{ startDate: "2019-03", endDate: null, unknownEndStartDate: null, occupations: [O(1)] }]);
  });

  it("takes a part's tags only from a confirmed division", () => {
    const { record, fact, tag, material } = vault();
    fact("f1", LINE);
    const offered = record.proposeSplit({ factId: "f1", line: LINE, parts: DIVISION, stamp: model });
    tag("part", offered.partIds[0]!, S(1), "skill");
    tag("part", offered.partIds[1]!, S(2), "skill");
    // Only proposed, so its parts show nothing yet.
    expect(material().skills).toEqual([]);
    record.decideSplit(offered.splitId, "confirmed");
    // A part and its fact showing one concept are still one fact.
    tag("fact", "f1", S(2), "skill");
    expect(material().skills).toEqual([
      { conceptId: S(1), facts: 1 },
      { conceptId: S(2), facts: 1 },
    ]);
    // A part's tag that is itself only proposed doesn't count.
    tag("part", offered.partIds[0]!, S(3), "skill", model);
    expect(material().skills.map((skill) => skill.conceptId)).toEqual([S(1), S(2)]);
    // Turning the division down takes its parts' tags away.
    record.decideSplit(offered.splitId, "rejected");
    expect(material().skills).toEqual([{ conceptId: S(2), facts: 1 }]);
  });

  it("never takes a withheld fact's concept, even when an unmarked fact carries it too, or a part of it does", () => {
    const { record, fact, tag, mark, material } = vault();
    fact("marked", LINE);
    fact("plain", "Built the deployment pipeline");
    fact("other", "Mentored two engineers");
    // The marked fact names S(1) on itself, with a tag nobody has decided, and S(2) on a part of a division nobody has decided.
    tag("fact", "marked", S(1), "skill", model);
    const split = record.proposeSplit({ factId: "marked", line: LINE, parts: DIVISION, stamp: model });
    tag("part", split.partIds[1]!, S(2), "skill", model);
    // The unmarked facts show S(1), S(2) and S(3), confirmed, on themselves and on a part.
    tag("fact", "plain", S(1), "skill");
    tag("fact", "other", S(2), "skill");
    tag("fact", "other", S(3), "skill");
    tag("fact", "plain", S(3), "skill");
    // The marked fact also names a skill group and a tool category itself, which other facts' skills may be shown as.
    tag("fact", "marked", GROUP, "skill-group", model);
    tag("fact", "marked", CATEGORY, "tool-category", model);
    expect(material().skills).toEqual([
      { conceptId: S(3), facts: 2 },
      { conceptId: S(1), facts: 1 },
      { conceptId: S(2), facts: 1 },
    ]);
    expect(material().barred).toEqual([]);
    mark("marked");
    expect(material().skills).toEqual([{ conceptId: S(3), facts: 2 }]);
    // Every concept the marked fact or its part names goes to the Worker as barred, so it can leave each off as a group too.
    expect(material().barred).toEqual([GROUP, S(1), S(2), CATEGORY].sort());
    // A tag the owner rejected on the marked fact still names its concept, and still bars it.
    record.decideTag(record.tags({ kind: "fact", id: "marked" })[0]!.id, "rejected");
    expect(material().skills).toEqual([{ conceptId: S(3), facts: 2 }]);
    expect(material().barred).toContain(S(1));
    // Unmarked, each comes back.
    mark("marked", false);
    expect(material().skills.map((skill) => skill.conceptId)).toEqual([S(3), S(1), S(2)]);
    expect(material().barred).toEqual([]);
  });

  it("takes occupations only from confirmed jobs, and holds no title, organisation, text or row ID", () => {
    const { fact, role, tag, mark, material } = vault();
    role("job-2", { org: "Contoso Pharmaceuticals", title: "Head of Platform", start: "2014", end: "2019-02" });
    tag("role", "job-1", O(1), "occupation");
    tag("role", "job-1", "onet:occ:99-1001.00", "occupation");
    tag("role", "job-2", O(2), "occupation", model);
    tag("role", "job-2", "esco:isco:C2512", "occupation-group");
    fact("f1", LINE);
    fact("f2", "Migrated 40 services to Kubernetes", { role: "job-2" });
    tag("fact", "f1", S(8), "knowledge");
    tag("fact", "f2", S(8), "knowledge");
    tag("fact", "f2", KUBERNETES, "tool");
    tag("fact", "f1", S(1), "skill");
    fact("f3", "Negotiated the supplier settlement");
    tag("fact", "f3", S(7), "skill");
    mark("f3");

    const given = material();
    expect(given).toEqual({
      jobs: expect.arrayContaining([
        { startDate: "2019-03", endDate: null, unknownEndStartDate: null, occupations: [O(1), "onet:occ:99-1001.00"] },
        // Only the confirmed occupation of the second job.
        { startDate: "2014", endDate: "2019-02", unknownEndStartDate: null, occupations: ["esco:isco:C2512"] },
      ]),
      // Most facts first, then by ID.
      skills: [
        { conceptId: S(8), facts: 2 },
        { conceptId: S(1), facts: 1 },
        { conceptId: KUBERNETES, facts: 1 },
      ],
      // A marked fact's concepts, by concept ID alone.
      barred: [S(7)],
    });
    expect(given.jobs).toHaveLength(2);
    const text = JSON.stringify(given);
    for (const word of ["Northwind", "Contoso", "Staff Platform Engineer", "Head of Platform", "billing", "Kubernetes", "settlement", "stored label", "job-1", "job-2", "f1", "f2", "f3", "upload-1"])
      expect(text, word).not.toContain(word);
    expect(Object.keys(given.jobs[0]!).sort()).toEqual(["endDate", "occupations", "startDate", "unknownEndStartDate"]);
    expect(Object.keys(given.skills[0]!).sort()).toEqual(["conceptId", "facts"]);
  });
});
