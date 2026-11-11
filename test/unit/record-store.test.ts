import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MAX_LINKS_PER_ITEM, MAX_TAGS_PER_SUBJECT, type NewPart, type NewTag, type Range, type Stamp } from "../../src/shared/record";
import { RecordStore } from "../../src/vault/record";
import { createSchema } from "../../src/vault/schema";

// The store runs here on the vault's whole schema, in Node's SQLite, so the triggers that guard
// facts and roles are the ones a real vault has. test/integration/record.test.ts runs the same
// tables inside a vault.

const LINE = "Designed and built the API, cutting deploy time from 40 minutes to 6.";
const VERSION = "esco-1.2.1+onet-31.0+c036f953";

const model: Stamp = { proposedBy: "model", model: "@cf/test/judge", method: "judge/1", taxonomyVersion: VERSION, confidence: 0.96, shadow: false };
const rule: Stamp = { proposedBy: "rule", model: null, method: "identical-wording/1", taxonomyVersion: null, confidence: null, shadow: false };
const owner: Stamp = { proposedBy: "owner", model: null, method: "owner", taxonomyVersion: VERSION, confidence: null, shadow: false };
const shadow = (stamp: Stamp): Stamp => ({ ...stamp, shadow: true });

/** The range of `words` in `line`, which must hold them exactly once. */
function at(line: string, words: string): Range {
  const start = line.indexOf(words);
  if (start < 0 || line.indexOf(words, start + 1) >= 0) throw new Error(`"${words}" is not in the line exactly once`);
  return [start, start + words.length];
}

const designed: NewPart = { kind: "clause", ranges: [at(LINE, "Designed"), at(LINE, "the API")] };
const built: NewPart = { kind: "clause", ranges: [at(LINE, "built the API")] };
const cutting = (resultOf: number): NewPart => ({ kind: "result", ranges: [at(LINE, "cutting deploy time from 40 minutes to 6")], resultOf });
const api: NewPart = { kind: "mention", ranges: [at(LINE, "API")] };
/** Two clauses, the outcome of the second, and one mention. */
const DIVISION: NewPart[] = [designed, built, cutting(1), api];

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
    const name = `record_${depth++}`;
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
  const count = (table: string, where = "1 = 1") => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
  const source = (id: string) =>
    run(`INSERT INTO sources (id, filename, r2_key, markdown, state, created_at) VALUES (?, ?, ?, '', 'ready', 1)`, id, `${id}.pdf`, `vaults/test/sources/${id}`);
  const role = (id: string, fields: { kind?: string; org?: string; title?: string | null; start?: string | null; end?: string | null } = {}) =>
    run(
      `INSERT INTO roles (id, kind, org, title, start_date, end_date, state) VALUES (?, ?, ?, ?, ?, ?, 'confirmed')`,
      id,
      fields.kind ?? "job",
      fields.org ?? "Acme",
      fields.title === undefined ? "Engineer" : fields.title,
      fields.start === undefined ? "2019-03" : fields.start,
      fields.end === undefined ? "2021-06" : fields.end,
    );
  /** A fact read from an upload: its text is its line, and its quote is where the line sits. */
  const fact = (id: string, text: string, fields: { role?: string | null; kind?: string; source?: string } = {}) => {
    const upload = fields.source ?? "upload-1";
    run(`INSERT INTO evidence (id, source_id, quote, start, end, source_revision_id) VALUES (?, ?, ?, 0, ?, ?)`, `quote-${id}`, upload, text, text.length, `${upload}:1`);
    run(
      `INSERT INTO facts (id, role_id, kind, text, evidence_id, source_id, origin, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'extracted', 'proposed', 1)`,
      id,
      fields.role === undefined ? "r1" : fields.role,
      fields.kind ?? "accomplishment",
      text,
      `quote-${id}`,
      upload,
    );
  };
  source("upload-1");
  source("upload-2");
  role("r1");
  fact("f1", LINE);
  return { db, record, run, count, source, role, fact };
}

/** The code of the error a call throws, such as "conflict". */
function refusal(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return String((error as Error).message).split(":")[0]!;
  }
  return "nothing";
}

const tag = (subject: NewTag["subject"], conceptId: string, conceptKind: NewTag["conceptKind"], label: string, stamp: Stamp = model): NewTag => ({
  subject,
  conceptId,
  conceptKind,
  label,
  stamp,
});

describe("how a line divides", () => {
  it("stores parts as positions and reads them back in the line's own words", () => {
    const { record, db } = vault();
    const saved = record.proposeSplit({ factId: "f1", line: LINE, parts: DIVISION, stamp: model });
    expect(saved.state).toBe("proposed");
    expect(new Set(saved.partIds).size).toBe(4);
    const split = record.split("f1")!;
    expect(split).toMatchObject({ id: saved.splitId, factId: "f1", state: "proposed", proposedBy: "model", model: "@cf/test/judge", method: "judge/1", shadow: false, decidedBy: null, decidedAt: null });
    // Stored in the order the parts start in the line, whatever order they were proposed in.
    expect(split.parts.map((part) => [part.kind, part.text])).toEqual([
      ["clause", "Designed the API"],
      ["clause", "built the API"],
      ["mention", "API"],
      ["result", "cutting deploy time from 40 minutes to 6"],
    ]);
    // The answer names each part in the order it was given.
    expect(saved.partIds).toEqual([split.parts[0]!.id, split.parts[1]!.id, split.parts[3]!.id, split.parts[2]!.id]);
    expect(split.parts[3]!.resultOf).toBe(split.parts[1]!.id);
    expect(split.parts.filter((part) => part.kind !== "result").every((part) => part.resultOf === null)).toBe(true);
    // No wording is kept anywhere but the fact's own row.
    const stored = db.prepare(`SELECT * FROM fact_parts ORDER BY position`).all() as Record<string, unknown>[];
    expect(Object.keys(stored[0]!).sort()).toEqual(["id", "kind", "position", "ranges", "result_of", "split_id"]);
    expect(JSON.stringify(stored)).not.toContain("Designed");
    for (const part of split.parts) for (const word of part.text.split(" ")) expect(LINE).toContain(word);
  });

  it("stores nothing unless the parts are whole words of the line as it now stands", () => {
    const { record, count, fact } = vault();
    fact("skill", "Python", { role: null, kind: "skill" });
    expect(refusal(() => record.proposeSplit({ factId: "missing", line: LINE, parts: DIVISION, stamp: model }))).toBe("not_found");
    expect(refusal(() => record.proposeSplit({ factId: "skill", line: "Python", parts: [{ kind: "clause", ranges: [[0, 6]] }], stamp: model }))).toBe("invalid");
    // The parts were worked out against wording the fact no longer has.
    expect(refusal(() => record.proposeSplit({ factId: "f1", line: LINE.replace("40", "45"), parts: DIVISION, stamp: model }))).toBe("conflict");
    expect(refusal(() => record.proposeSplit({ factId: "f1", line: LINE, parts: [{ kind: "clause", ranges: [[2, 8]] }], stamp: model }))).toBe("invalid");
    expect(refusal(() => record.proposeSplit({ factId: "f1", line: LINE, parts: [api], stamp: model }))).toBe("invalid");
    expect(refusal(() => record.proposeSplit({ factId: "f1", line: LINE, parts: DIVISION, stamp: { ...model, model: null } }))).toBe("invalid");
    expect(count("fact_splits")).toBe(0);
    expect(count("fact_parts")).toBe(0);
    expect(record.split("f1")).toBeNull();
  });

  it("stores one division once, in whatever order it is proposed", () => {
    const { record, count } = vault();
    const first = record.proposeSplit({ factId: "f1", line: LINE, parts: DIVISION, stamp: model });
    // The same four parts, turned round: the result now names its clause at another position.
    const again = record.proposeSplit({ factId: "f1", line: LINE, parts: [api, cutting(3), designed, built], stamp: { ...model, method: "judge/2" } });
    expect(again.splitId).toBe(first.splitId);
    expect(again.partIds).toEqual([first.partIds[3], first.partIds[2], first.partIds[0], first.partIds[1]]);
    expect(count("fact_splits")).toBe(1);
    expect(count("fact_parts")).toBe(4);
    // Still one proposal, stamped by what proposed it last.
    expect(record.split("f1")).toMatchObject({ id: first.splitId, state: "proposed", method: "judge/2" });
    // Once decided, the stamp is what the owner decided about.
    record.decideSplit(first.splitId, "confirmed");
    record.proposeSplit({ factId: "f1", line: LINE, parts: DIVISION, stamp: { ...model, method: "judge/3" } });
    expect(record.split("f1")).toMatchObject({ state: "confirmed", method: "judge/2" });
  });

  it("replaces a division nobody has decided, with everything tagged on it", () => {
    const { record, count } = vault();
    const first = record.proposeSplit({ factId: "f1", line: LINE, parts: DIVISION, stamp: model });
    record.proposeTag(tag({ kind: "part", id: first.partIds[3]! }, "esco:skill:api-design", "skill", "design application interfaces"));
    const second = record.proposeSplit({ factId: "f1", line: LINE, parts: [built, cutting(0)], stamp: model });
    expect(second.splitId).not.toBe(first.splitId);
    expect(record.split("f1")!.parts.map((part) => part.text)).toEqual(["built the API", "cutting deploy time from 40 minutes to 6"]);
    expect(count("fact_splits")).toBe(1);
    expect(count("fact_parts")).toBe(2);
    expect(count("record_tags")).toBe(0);
  });

  it("leaves a division the owner accepted, and does not store again one they turned down", () => {
    const { record, count } = vault();
    const first = record.proposeSplit({ factId: "f1", line: LINE, parts: DIVISION, stamp: model });
    record.decideSplit(first.splitId, "rejected");
    expect(record.split("f1")).toBeNull();
    // Offered again by a newer check, it is still turned down, and nothing new is stored.
    expect(record.proposeSplit({ factId: "f1", line: LINE, parts: DIVISION, stamp: { ...model, method: "judge/2" } })).toMatchObject({ splitId: first.splitId, state: "rejected" });
    expect(count("fact_splits")).toBe(1);
    const second = record.proposeSplit({ factId: "f1", line: LINE, parts: [built, cutting(0)], stamp: model });
    record.decideSplit(second.splitId, "confirmed");
    expect(record.split("f1")).toMatchObject({ id: second.splitId, state: "confirmed", decidedBy: "owner" });
    expect(refusal(() => record.proposeSplit({ factId: "f1", line: LINE, parts: [designed, built], stamp: model }))).toBe("conflict");
    // The division they turned down stays turned down while another stands.
    expect(record.proposeSplit({ factId: "f1", line: LINE, parts: DIVISION, stamp: model }).state).toBe("rejected");
    expect(record.split("f1")!.id).toBe(second.splitId);
    expect(count("fact_splits")).toBe(2);
  });

  it("lets the owner divide a line themselves, replacing whatever stood", () => {
    const { record, count } = vault();
    const offered = record.proposeSplit({ factId: "f1", line: LINE, parts: DIVISION, stamp: model });
    record.decideSplit(offered.splitId, "confirmed");
    const own = record.proposeSplit({ factId: "f1", line: LINE, parts: [designed, built], stamp: owner });
    expect(own.state).toBe("confirmed");
    expect(record.split("f1")).toMatchObject({ id: own.splitId, state: "confirmed", proposedBy: "owner", decidedBy: "owner" });
    expect(count("fact_splits")).toBe(1);
    // Choosing a division they once turned down accepts that very one.
    record.decideSplit(own.splitId, "rejected");
    const other = record.proposeSplit({ factId: "f1", line: LINE, parts: [built, cutting(0)], stamp: model });
    expect(record.proposeSplit({ factId: "f1", line: LINE, parts: [designed, built], stamp: owner })).toMatchObject({ splitId: own.splitId, state: "confirmed" });
    expect(record.split("f1")!.id).toBe(own.splitId);
    expect(count("fact_splits", `id = '${other.splitId}'`)).toBe(0);
  });

  it("is undone by the owner, and a line divides one way at a time", () => {
    const { record, count } = vault();
    const first = record.proposeSplit({ factId: "f1", line: LINE, parts: DIVISION, stamp: model });
    record.proposeTag(tag({ kind: "part", id: first.partIds[3]! }, "onet:tool:rest-api", "tool", "REST API"));
    record.decideSplit(first.splitId, "confirmed");
    record.decideSplit(first.splitId, "confirmed");
    expect(record.split("f1")!.state).toBe("confirmed");
    expect(count("record_tags")).toBe(1);
    record.decideSplit(first.splitId, "rejected");
    expect(record.split("f1")).toBeNull();
    // Nothing stays tagged on a division that shows nothing.
    expect(count("record_tags")).toBe(0);
    expect(refusal(() => record.proposeTag(tag({ kind: "part", id: first.partIds[3]! }, "onet:tool:rest-api", "tool", "REST API")))).toBe("conflict");
    const second = record.proposeSplit({ factId: "f1", line: LINE, parts: [built, cutting(0)], stamp: model });
    expect(refusal(() => record.decideSplit(first.splitId, "confirmed"))).toBe("conflict");
    record.decideSplit(second.splitId, "rejected");
    record.decideSplit(first.splitId, "confirmed");
    expect(record.split("f1")!.id).toBe(first.splitId);
    expect(refusal(() => record.decideSplit("missing", "confirmed"))).toBe("not_found");
  });

  it("keeps a division in shadow apart from the one that shows", () => {
    const { record } = vault();
    const hidden = record.proposeSplit({ factId: "f1", line: LINE, parts: DIVISION, stamp: shadow(model) });
    expect(record.split("f1")).toBeNull();
    expect(record.split("f1", { shadow: true })!.id).toBe(hidden.splitId);
    const shown = record.proposeSplit({ factId: "f1", line: LINE, parts: [designed, built], stamp: model });
    expect(record.split("f1")!.id).toBe(shown.splitId);
    expect(record.split("f1", { shadow: true })!.id).toBe(hidden.splitId);
    // What is shown to nobody can't be decided by anybody.
    expect(refusal(() => record.decideSplit(hidden.splitId, "confirmed"))).toBe("not_found");
    expect(refusal(() => record.proposeSplit({ factId: "f1", line: LINE, parts: DIVISION, stamp: shadow(owner) }))).toBe("invalid");
  });
});

describe("tags", () => {
  it("go on a fact, a part or a role, and relate by the kind of concept", () => {
    const { record } = vault();
    const split = record.proposeSplit({ factId: "f1", line: LINE, parts: DIVISION, stamp: model });
    record.proposeTag(tag({ kind: "fact", id: "f1" }, "esco:skill:api-design", "skill", "design application interfaces"));
    record.proposeTag(tag({ kind: "fact", id: "f1" }, "onet:activity:4.A.3.b.1", "activity", "Interacting With Computers"));
    record.proposeTag(tag({ kind: "part", id: split.partIds[3]! }, "onet:tool:rest-api", "tool", "REST API", { ...model, method: "exact-label/1", proposedBy: "rule", model: null, confidence: null }));
    record.proposeTag(tag({ kind: "role", id: "r1" }, "onet:occ:15-1252.00", "occupation", "Software Developers"));
    expect(record.tags({ kind: "fact", id: "f1" }).map((found) => [found.relation, found.conceptKind, found.label, found.state, found.taxonomyVersion])).toEqual([
      ["shows", "skill", "design application interfaces", "proposed", VERSION],
      ["does", "activity", "Interacting With Computers", "proposed", VERSION],
    ]);
    expect(record.tags({ kind: "part", id: split.partIds[3]! })).toMatchObject([{ relation: "uses", conceptId: "onet:tool:rest-api", proposedBy: "rule", model: null, method: "exact-label/1" }]);
    expect(record.tags({ kind: "role", id: "r1" })).toMatchObject([{ relation: "occupation", conceptId: "onet:occ:15-1252.00", subject: { kind: "role", id: "r1" } }]);
    expect(record.tags({ kind: "fact", id: "f1" }, { state: "confirmed" })).toEqual([]);
  });

  it("are refused on what isn't there, and where a concept of that kind doesn't belong", () => {
    const { record, count } = vault();
    expect(refusal(() => record.proposeTag(tag({ kind: "fact", id: "missing" }, "onet:tool:python", "tool", "Python")))).toBe("not_found");
    expect(refusal(() => record.proposeTag(tag({ kind: "role", id: "missing" }, "onet:occ:15-1252.00", "occupation", "Software Developers")))).toBe("not_found");
    expect(refusal(() => record.proposeTag(tag({ kind: "part", id: "missing" }, "onet:tool:python", "tool", "Python")))).toBe("not_found");
    expect(refusal(() => record.proposeTag(tag({ kind: "fact", id: "f1" }, "onet:occ:15-1252.00", "occupation", "Software Developers")))).toBe("invalid");
    expect(refusal(() => record.proposeTag(tag({ kind: "role", id: "r1" }, "onet:tool:python", "tool", "Python")))).toBe("invalid");
    expect(refusal(() => record.proposeTag(tag({ kind: "fact", id: "f1" }, "python", "tool", "Python")))).toBe("invalid");
    expect(refusal(() => record.proposeTag(tag({ kind: "fact", id: "f1" }, "onet:tool:python", "tool", "Python", { ...model, taxonomyVersion: null })))).toBe("invalid");
    expect(count("record_tags")).toBe(0);
  });

  it("keep what the owner decided when a rule or a model proposes them again", () => {
    const { record, count } = vault();
    const python = tag({ kind: "fact", id: "f1" }, "onet:tool:python", "tool", "Python");
    const go = tag({ kind: "fact", id: "f1" }, "onet:tool:go", "tool", "Go");
    const first = record.proposeTag(python);
    // Proposed again before anyone decided: one tag, stamped by what proposed it last.
    expect(record.proposeTag({ ...python, label: "Python (language)", stamp: { ...model, method: "judge/2", confidence: 0.99 } })).toEqual({ tagId: first.tagId, state: "proposed" });
    expect(record.tags({ kind: "fact", id: "f1" })).toMatchObject([{ id: first.tagId, label: "Python (language)", method: "judge/2", confidence: 0.99, state: "proposed" }]);
    record.decideTag(first.tagId, "confirmed");
    const second = record.proposeTag(go);
    record.decideTag(second.tagId, "rejected");
    expect(record.proposeTag({ ...python, stamp: { ...model, method: "judge/3" } })).toEqual({ tagId: first.tagId, state: "confirmed" });
    expect(record.proposeTag({ ...go, stamp: { ...model, method: "judge/3" } })).toEqual({ tagId: second.tagId, state: "rejected" });
    expect(record.tags({ kind: "fact", id: "f1" })).toMatchObject([
      { id: first.tagId, state: "confirmed", decidedBy: "owner", method: "judge/2" },
      { id: second.tagId, state: "rejected", decidedBy: "owner", method: "judge/1" },
    ]);
    expect(count("record_tags")).toBe(2);
  });

  it("are the owner's to add, confirm, reject and undo", () => {
    const { record } = vault();
    const added = record.proposeTag(tag({ kind: "fact", id: "f1" }, "onet:tool:kubernetes", "tool", "Kubernetes", owner));
    expect(added.state).toBe("confirmed");
    expect(record.tags({ kind: "fact", id: "f1" })).toMatchObject([{ proposedBy: "owner", state: "confirmed", decidedBy: "owner" }]);
    record.decideTag(added.tagId, "rejected");
    expect(record.tags({ kind: "fact", id: "f1" }, { state: "rejected" })).toHaveLength(1);
    record.decideTag(added.tagId, "confirmed");
    expect(record.tags({ kind: "fact", id: "f1" }, { state: "confirmed" })).toHaveLength(1);
    // Adding a tag they once rejected confirms it, whoever first proposed it.
    const offered = record.proposeTag(tag({ kind: "fact", id: "f1" }, "onet:tool:go", "tool", "Go"));
    record.decideTag(offered.tagId, "rejected");
    expect(record.proposeTag(tag({ kind: "fact", id: "f1" }, "onet:tool:go", "tool", "Go", owner))).toEqual({ tagId: offered.tagId, state: "confirmed" });
    expect(refusal(() => record.decideTag("missing", "confirmed"))).toBe("not_found");
  });

  it("stay in shadow when they are proposed in shadow", () => {
    const { record } = vault();
    const hidden = record.proposeTag(tag({ kind: "fact", id: "f1" }, "onet:tool:python", "tool", "Python", shadow(model)));
    expect(record.tags({ kind: "fact", id: "f1" })).toEqual([]);
    expect(record.tags({ kind: "fact", id: "f1" }, { shadow: true })).toMatchObject([{ id: hidden.tagId, shadow: true }]);
    expect(refusal(() => record.decideTag(hidden.tagId, "confirmed"))).toBe("not_found");
    // The same concept can be proposed where it shows without touching the one in shadow.
    const shown = record.proposeTag(tag({ kind: "fact", id: "f1" }, "onet:tool:python", "tool", "Python"));
    expect(shown.tagId).not.toBe(hidden.tagId);
    // A part in shadow carries only shadow tags.
    const split = record.proposeSplit({ factId: "f1", line: LINE, parts: DIVISION, stamp: shadow(model) });
    expect(refusal(() => record.proposeTag(tag({ kind: "part", id: split.partIds[3]! }, "onet:tool:rest-api", "tool", "REST API")))).toBe("invalid");
    expect(record.proposeTag(tag({ kind: "part", id: split.partIds[3]! }, "onet:tool:rest-api", "tool", "REST API", shadow(model))).state).toBe("proposed");
  });

  it("are held to a limit for each fact, part or role", () => {
    const { record } = vault();
    for (let index = 0; index < MAX_TAGS_PER_SUBJECT; index++) record.proposeTag(tag({ kind: "fact", id: "f1" }, `onet:tool:tool-${index}`, "tool", `Tool ${index}`));
    expect(refusal(() => record.proposeTag(tag({ kind: "fact", id: "f1" }, "onet:tool:one-more", "tool", "One more")))).toBe("too_large");
    // One already held can still be proposed again, and another subject is not affected.
    expect(record.proposeTag(tag({ kind: "fact", id: "f1" }, "onet:tool:tool-0", "tool", "Tool 0")).state).toBe("proposed");
    expect(record.proposeTag(tag({ kind: "role", id: "r1" }, "onet:occ:15-1252.00", "occupation", "Software Developers")).state).toBe("proposed");
  });
});

describe("merging what says the same thing", () => {
  /** A second upload of the same job: its own role and its own copy of the line. */
  function twice() {
    const made = vault();
    made.role("r2");
    made.fact("f2", LINE, { role: "r2", source: "upload-2" });
    return made;
  }

  it("confirms without asking only identical wording in one role", () => {
    const { record, fact, count } = twice();
    // The two roles are alike in every field, so a rule may join them.
    expect(record.proposeLink({ kind: "role", from: "r2", to: "r1", relation: "same", stamp: { ...rule, method: "identical-role/1" }, confirm: true })).toMatchObject({ state: "confirmed" });
    expect(record.root("role", "r2")).toBe("r1");
    expect(record.merged("role", "r1")).toEqual(["r2"]);
    const merged = record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: rule, confirm: true });
    expect(merged.state).toBe("confirmed");
    expect(record.links("fact", "f1")).toMatchObject([{ id: merged.linkId, from: "f2", to: "f1", relation: "same", state: "confirmed", proposedBy: "rule", decidedBy: "rule", method: "identical-wording/1" }]);
    expect(record.root("fact", "f2")).toBe("f1");
    expect(record.root("fact", "f1")).toBe("f1");
    expect(record.merged("fact", "f1")).toEqual(["f2"]);
    // Anything less than the same words is refused, however close.
    fact("f3", LINE.replace("40 minutes", "45 minutes"), { role: "r2", source: "upload-2" });
    fact("f4", LINE.replace("Designed", "Helped design"), { role: "r2", source: "upload-2" });
    fact("f5", LINE, { role: "r2", source: "upload-2", kind: "credential" });
    for (const from of ["f3", "f4", "f5"])
      expect(refusal(() => record.proposeLink({ kind: "fact", from, to: "f1", relation: "same", stamp: rule, confirm: true })), from).toBe("invalid");
    // The same finding can still be offered to the owner.
    expect(record.proposeLink({ kind: "fact", from: "f3", to: "f1", relation: "same", stamp: model }).state).toBe("proposed");
    expect(count("record_links", "kind = 'fact'")).toBe(2);
  });

  it("never merges unasked an accomplishment that stands outside any role", () => {
    const { record, fact } = vault();
    // Read twice with no job found for either: nothing says they are from the same one.
    fact("loose-1", LINE, { role: null });
    fact("loose-2", LINE, { role: null, source: "upload-2" });
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "loose-2", to: "loose-1", relation: "same", stamp: rule, confirm: true }))).toBe("invalid");
    expect(record.proposeLink({ kind: "fact", from: "loose-2", to: "loose-1", relation: "same", stamp: rule }).state).toBe("proposed");
    expect(record.root("fact", "loose-2")).toBe("loose-2");
    // A skill or a credential is the same item wherever it is listed.
    for (const kind of ["skill", "credential"]) {
      fact(`${kind}-1`, "Kubernetes", { role: null, kind });
      fact(`${kind}-2`, "Kubernetes", { role: null, kind, source: "upload-2" });
      expect(record.proposeLink({ kind: "fact", from: `${kind}-2`, to: `${kind}-1`, relation: "same", stamp: rule, confirm: true }).state, kind).toBe("confirmed");
    }
    // But a skill is not a credential, and a fact in a role is not one outside it.
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "skill-1", to: "credential-1", relation: "same", stamp: rule, confirm: true }))).toBe("invalid");
    fact("placed", "Kubernetes", { kind: "skill" });
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "placed", to: "skill-1", relation: "same", stamp: rule, confirm: true }))).toBe("conflict");
  });

  it("never merges unasked two lines or two roles that differ in the number or the sign they start with", () => {
    const { record, fact, role } = vault();
    // Two state examinations are two credentials, and a figure's sign is part of the figure.
    for (const [kind, first, second] of [
      ["credential", "1. Staatsexamen", "2. Staatsexamen"],
      ["accomplishment", "+ 5% churn", "- 5% churn"],
    ] as const) {
      const within = kind === "credential" ? null : "r1";
      fact(`${kind}-1`, first, { role: within, kind });
      fact(`${kind}-2`, second, { role: within, kind, source: "upload-2" });
      expect(refusal(() => record.proposeLink({ kind: "fact", from: `${kind}-2`, to: `${kind}-1`, relation: "same", stamp: rule, confirm: true })), first).toBe("invalid");
      expect(record.root("fact", `${kind}-2`)).toBe(`${kind}-2`);
      // The likeness can still be offered to the owner.
      expect(record.proposeLink({ kind: "fact", from: `${kind}-2`, to: `${kind}-1`, relation: "same", stamp: rule }).state, first).toBe("proposed");
    }
    // The first chair of a board is not the second.
    role("chair-1", { title: "1. Vorsitzender" });
    role("chair-2", { title: "2. Vorsitzender" });
    expect(refusal(() => record.proposeLink({ kind: "role", from: "chair-2", to: "chair-1", relation: "same", stamp: { ...rule, method: "identical-role/1" }, confirm: true }))).toBe("invalid");
    expect(record.root("role", "chair-2")).toBe("chair-2");
  });

  it("merges nothing: both rows and both quotes stay as they were", () => {
    const { record, db } = twice();
    const before = JSON.stringify(db.prepare(`SELECT * FROM facts ORDER BY id`).all().concat(db.prepare(`SELECT * FROM evidence ORDER BY id`).all(), db.prepare(`SELECT * FROM roles ORDER BY id`).all()));
    record.proposeLink({ kind: "role", from: "r2", to: "r1", relation: "same", stamp: { ...rule, method: "identical-role/1" }, confirm: true });
    record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: rule, confirm: true });
    const after = JSON.stringify(db.prepare(`SELECT * FROM facts ORDER BY id`).all().concat(db.prepare(`SELECT * FROM evidence ORDER BY id`).all(), db.prepare(`SELECT * FROM roles ORDER BY id`).all()));
    expect(after).toBe(before);
    // The fact that stands has the quote from every upload that states it.
    expect(record.evidenceOf("f1")).toEqual([
      { factId: "f1", own: true, sourceId: "upload-1", quote: LINE, span: [0, LINE.length] },
      { factId: "f2", own: false, sourceId: "upload-2", quote: LINE, span: [0, LINE.length] },
    ]);
    expect(record.evidenceOf("f2")).toMatchObject([{ factId: "f2", own: true }]);
  });

  it("joins facts only inside one role", () => {
    const { record } = twice();
    // The roles are separate, so the facts can't be linked where it shows, by anyone.
    for (const stamp of [rule, model, owner])
      expect(refusal(() => record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp })), stamp.proposedBy).toBe("conflict");
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "fuller", stamp: model }))).toBe("conflict");
    // In shadow nothing stands, so a likeness can be recorded to be measured.
    expect(record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: shadow(rule) }).state).toBe("proposed");
    expect(record.root("fact", "f2")).toBe("f2");
  });

  it("separates the facts of two roles when the roles are separated, and joins them again with the roles", () => {
    const { record } = twice();
    const roles = record.proposeLink({ kind: "role", from: "r2", to: "r1", relation: "same", stamp: { ...rule, method: "identical-role/1" }, confirm: true });
    record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: rule, confirm: true });
    expect(record.merged("fact", "f1")).toEqual(["f2"]);
    expect(record.links("fact", "f1")).toMatchObject([{ state: "confirmed", holds: true }]);
    // The owner says these were two different jobs.
    record.decideLink(roles.linkId, "rejected");
    expect(record.root("role", "r2")).toBe("r2");
    expect(record.root("fact", "f2")).toBe("f2");
    expect(record.merged("fact", "f1")).toEqual([]);
    expect(record.evidenceOf("f1")).toHaveLength(1);
    // The link between the facts is as it was stored. It says of itself that it no longer holds.
    expect(record.links("fact", "f1")).toMatchObject([{ state: "confirmed", decidedBy: "rule", holds: false }]);
    expect(record.links("role", "r1")).toMatchObject([{ state: "rejected", holds: false }]);
    record.decideLink(roles.linkId, "confirmed");
    expect(record.root("fact", "f2")).toBe("f1");
    expect(record.evidenceOf("f1")).toHaveLength(2);
    expect(record.links("fact", "f1")).toMatchObject([{ state: "confirmed", holds: true }]);
    expect(record.links("role", "r1")).toMatchObject([{ state: "confirmed", proposedBy: "rule", decidedBy: "owner" }]);
  });

  it("holds roles to every field that names them", () => {
    const { record, role } = vault();
    role("same");
    role("other-title", { title: "Senior Engineer" });
    role("other-dates", { end: "2022-01" });
    role("no-title", { title: null });
    role("still-there", { end: null });
    const identical = { ...rule, method: "identical-role/1" };
    expect(record.proposeLink({ kind: "role", from: "same", to: "r1", relation: "same", stamp: identical, confirm: true }).state).toBe("confirmed");
    for (const from of ["other-title", "other-dates", "no-title", "still-there"])
      expect(refusal(() => record.proposeLink({ kind: "role", from, to: "r1", relation: "same", stamp: identical, confirm: true })), from).toBe("invalid");
    // A promotion looks like this, so it is only ever offered.
    expect(record.proposeLink({ kind: "role", from: "other-title", to: "r1", relation: "same", stamp: model }).state).toBe("proposed");
    expect(record.root("role", "other-title")).toBe("other-title");
    expect(refusal(() => record.proposeLink({ kind: "role", from: "missing", to: "r1", relation: "same", stamp: model }))).toBe("not_found");
    expect(refusal(() => record.proposeLink({ kind: "role", from: "same", to: "r1", relation: "fuller", stamp: model }))).toBe("invalid");
  });

  it("is the owner's to accept, turn down and undo", () => {
    const { record, fact } = vault();
    fact("f2", "Built the API and cut deploy time to 6 minutes.");
    const offered = record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: model });
    expect(offered.state).toBe("proposed");
    // An offer changes nothing until it is accepted.
    expect(record.root("fact", "f2")).toBe("f2");
    expect(record.links("fact", "f2")).toMatchObject([{ state: "proposed", holds: false }]);
    record.decideLink(offered.linkId, "confirmed");
    expect(record.root("fact", "f2")).toBe("f1");
    expect(record.links("fact", "f2")).toMatchObject([{ state: "confirmed", proposedBy: "model", decidedBy: "owner" }]);
    record.decideLink(offered.linkId, "rejected");
    expect(record.root("fact", "f2")).toBe("f2");
    // Turned down by the owner, it stays turned down whatever proposes it again.
    expect(record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: { ...model, method: "judge/2" } })).toEqual({ linkId: offered.linkId, state: "rejected" });
    expect(record.root("fact", "f2")).toBe("f2");
    // Only the owner merging them by hand brings it back.
    expect(record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: owner })).toEqual({ linkId: offered.linkId, state: "confirmed" });
    expect(record.root("fact", "f2")).toBe("f1");
    expect(refusal(() => record.decideLink("missing", "confirmed"))).toBe("not_found");
  });

  it("does not let a rule reopen a merge the owner separated", () => {
    const { record, fact } = vault();
    fact("f2", LINE, { source: "upload-2" });
    const merged = record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: rule, confirm: true });
    record.decideLink(merged.linkId, "rejected");
    expect(record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: rule, confirm: true })).toEqual({ linkId: merged.linkId, state: "rejected" });
    expect(record.root("fact", "f2")).toBe("f2");
    expect(record.links("fact", "f2")).toMatchObject([{ state: "rejected", proposedBy: "rule", decidedBy: "owner" }]);
  });

  it("does not let a rule or a model make the separated merge the other way round", () => {
    const { record, fact, count } = vault();
    fact("f2", LINE, { source: "upload-2" });
    const merged = record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: rule, confirm: true });
    record.decideLink(merged.linkId, "rejected");
    // The same two facts, with the other one standing for both: still the merge the owner undid.
    expect(record.proposeLink({ kind: "fact", from: "f1", to: "f2", relation: "same", stamp: rule, confirm: true })).toEqual({ linkId: merged.linkId, state: "rejected" });
    expect(record.root("fact", "f1")).toBe("f1");
    expect(record.root("fact", "f2")).toBe("f2");
    // Nor is it offered again, by a rule or by a model.
    for (const stamp of [rule, model]) expect(record.proposeLink({ kind: "fact", from: "f1", to: "f2", relation: "same", stamp }), stamp.proposedBy).toEqual({ linkId: merged.linkId, state: "rejected" });
    expect(count("record_links")).toBe(1);
    // A finding kept in shadow is beside what shows, and stands for nothing.
    expect(record.proposeLink({ kind: "fact", from: "f1", to: "f2", relation: "same", stamp: shadow(rule) }).state).toBe("proposed");
    expect(record.root("fact", "f1")).toBe("f1");
    // Only the owner joins them again, whichever way round.
    expect(record.proposeLink({ kind: "fact", from: "f1", to: "f2", relation: "same", stamp: owner }).state).toBe("confirmed");
    expect(record.root("fact", "f1")).toBe("f2");
  });

  it("does not let a rule rejoin two roles the owner separated, the other way round", () => {
    const { record, role, fact } = vault();
    role("r2");
    fact("f2", LINE, { role: "r2", source: "upload-2" });
    const identical = { ...rule, method: "identical-role/1" };
    const roles = record.proposeLink({ kind: "role", from: "r2", to: "r1", relation: "same", stamp: identical, confirm: true });
    record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: rule, confirm: true });
    // The owner says these were two different jobs, which separates their lines too.
    record.decideLink(roles.linkId, "rejected");
    expect(record.root("fact", "f2")).toBe("f2");
    expect(record.proposeLink({ kind: "role", from: "r1", to: "r2", relation: "same", stamp: identical, confirm: true })).toEqual({ linkId: roles.linkId, state: "rejected" });
    expect(record.proposeLink({ kind: "role", from: "r1", to: "r2", relation: "same", stamp: model })).toEqual({ linkId: roles.linkId, state: "rejected" });
    expect(record.root("role", "r1")).toBe("r1");
    expect(record.root("role", "r2")).toBe("r2");
    expect(record.root("fact", "f2")).toBe("f2");
    expect(record.evidenceOf("f1")).toHaveLength(1);
    // The owner can still say they were one job after all.
    record.decideLink(roles.linkId, "confirmed");
    expect(record.root("fact", "f2")).toBe("f1");
  });

  it("does not let a rule rejoin what the owner separated by merging one of the two into what the other stands in", () => {
    const { record, fact } = vault();
    fact("f2", LINE, { source: "upload-2" });
    fact("f3", LINE, { source: "upload-2" });
    record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: rule, confirm: true });
    const third = record.proposeLink({ kind: "fact", from: "f3", to: "f1", relation: "same", stamp: rule, confirm: true });
    // The owner takes f3 out of the fact that stands for all three.
    record.decideLink(third.linkId, "rejected");
    expect(record.evidenceOf("f1").map((quote) => quote.factId)).toEqual(["f1", "f2"]);
    // Merging f3 into f2, which stands in f1, would put it back.
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "f3", to: "f2", relation: "same", stamp: rule, confirm: true }))).toBe("conflict");
    expect(record.root("fact", "f3")).toBe("f3");
    expect(record.evidenceOf("f1").map((quote) => quote.factId)).toEqual(["f1", "f2"]);
    // So would an offer of that merge which a rule then confirmed.
    const offered = record.proposeLink({ kind: "fact", from: "f3", to: "f2", relation: "same", stamp: model });
    expect(offered.state).toBe("proposed");
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "f3", to: "f2", relation: "same", stamp: rule, confirm: true }))).toBe("conflict");
    expect(record.root("fact", "f3")).toBe("f3");
    // The owner accepting the offer is the owner joining them again.
    record.decideLink(offered.linkId, "confirmed");
    expect(record.root("fact", "f3")).toBe("f1");
    expect(record.evidenceOf("f1").map((quote) => quote.factId)).toEqual(["f1", "f2", "f3"]);
  });

  it("does not let a rule rejoin what the owner separated by merging what stands for one of the two", () => {
    const { record, fact } = vault();
    for (const id of ["f2", "f3", "f4"]) fact(id, LINE, { source: "upload-2" });
    // f2 stands in f1, and f4 in f3. The owner has said f4 is not f1.
    record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: rule, confirm: true });
    const turnedDown = record.proposeLink({ kind: "fact", from: "f4", to: "f1", relation: "same", stamp: model });
    record.decideLink(turnedDown.linkId, "rejected");
    record.proposeLink({ kind: "fact", from: "f4", to: "f3", relation: "same", stamp: rule, confirm: true });
    // Merging f3 into f1, or into f2 which stands in it, would bring f4 along.
    for (const to of ["f1", "f2"]) expect(refusal(() => record.proposeLink({ kind: "fact", from: "f3", to, relation: "same", stamp: rule, confirm: true })), to).toBe("conflict");
    // And merging f1 into f3 would bring f1 to f4.
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "f1", to: "f3", relation: "same", stamp: rule, confirm: true }))).toBe("conflict");
    expect(record.root("fact", "f4")).toBe("f3");
    expect(record.merged("fact", "f1")).toEqual(["f2"]);
    // A fact the owner separated from nothing still merges.
    fact("f5", LINE, { source: "upload-2" });
    expect(record.proposeLink({ kind: "fact", from: "f5", to: "f2", relation: "same", stamp: rule, confirm: true }).state).toBe("confirmed");
    expect(record.root("fact", "f5")).toBe("f1");
  });

  it("does not let a rule rejoin what the owner separated while the roles of a merge are apart", () => {
    const { record, role, fact } = vault();
    role("r2");
    fact("f2", LINE, { role: "r2", source: "upload-2" });
    fact("f3", LINE);
    const roles = record.proposeLink({ kind: "role", from: "r2", to: "r1", relation: "same", stamp: { ...rule, method: "identical-role/1" }, confirm: true });
    record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: rule, confirm: true });
    // The owner turns down f3 as the same fact as f2, and later says the two jobs were different.
    record.decideLink(record.proposeLink({ kind: "fact", from: "f3", to: "f2", relation: "same", stamp: model }).linkId, "rejected");
    record.decideLink(roles.linkId, "rejected");
    expect(record.merged("fact", "f1")).toEqual([]);
    // f2 is out of f1 only until the roles are rejoined, so merging f3 into f1 would join f3 and f2 then.
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "f3", to: "f1", relation: "same", stamp: rule, confirm: true }))).toBe("conflict");
    record.decideLink(roles.linkId, "confirmed");
    expect(record.merged("fact", "f1")).toEqual(["f2"]);
    expect(record.root("fact", "f3")).toBe("f3");
  });

  it("counts an offer the owner's own choice replaced as one the owner turned down", () => {
    const { record, fact } = vault();
    fact("f2", LINE, { source: "upload-2" });
    fact("f3", LINE, { source: "upload-2" });
    // A model offers f3 as the same fact as f2. The owner merges f3 into f1 instead.
    const offered = record.proposeLink({ kind: "fact", from: "f3", to: "f2", relation: "same", stamp: model });
    expect(record.proposeLink({ kind: "fact", from: "f3", to: "f1", relation: "same", stamp: owner }).state).toBe("confirmed");
    expect(record.links("fact", "f2")).toMatchObject([{ id: offered.linkId, state: "rejected", decidedBy: "owner" }]);
    // The owner never said f2 and f3 differ, only chose another fact to stand for f3. The record
    // has that offer down as turned down all the same, so no rule joins the two without asking:
    // merging f2 into f1 would put f2 and f3 in one group.
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: rule, confirm: true }))).toBe("conflict");
    expect(record.proposeLink({ kind: "fact", from: "f2", to: "f3", relation: "same", stamp: model })).toEqual({ linkId: offered.linkId, state: "rejected" });
    expect(record.root("fact", "f2")).toBe("f2");
    // It can still be offered, and the owner accepting the offer joins all three.
    const again = record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: model });
    expect(again.state).toBe("proposed");
    record.decideLink(again.linkId, "confirmed");
    expect(record.evidenceOf("f1").map((quote) => quote.factId).sort()).toEqual(["f1", "f2", "f3"]);
  });

  it("lets a rule confirm identical wording that was first only offered", () => {
    const { record, fact } = vault();
    fact("f2", LINE, { source: "upload-2" });
    const offered = record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: model });
    expect(record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: rule, confirm: true })).toEqual({ linkId: offered.linkId, state: "confirmed" });
    expect(record.links("fact", "f1")).toMatchObject([{ state: "confirmed", decidedBy: "rule" }]);
  });

  it("merges a fact into one other at most, and never in a circle", () => {
    const { record, fact } = vault();
    fact("f2", LINE, { source: "upload-2" });
    fact("f3", LINE, { source: "upload-2" });
    record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: rule, confirm: true });
    // f2 already stands inside f1.
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "f2", to: "f3", relation: "same", stamp: rule, confirm: true }))).toBe("conflict");
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "f1", to: "f2", relation: "same", stamp: rule, confirm: true }))).toBe("conflict");
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "f1", to: "f2", relation: "same", stamp: model }))).toBe("conflict");
    // A chain is fine: f3 into f2, which is already in f1.
    record.proposeLink({ kind: "fact", from: "f3", to: "f2", relation: "same", stamp: rule, confirm: true });
    expect(record.root("fact", "f3")).toBe("f1");
    expect(record.merged("fact", "f1")).toEqual(["f2", "f3"]);
    expect(record.merged("fact", "f2")).toEqual(["f3"]);
    expect(record.evidenceOf("f1").map((quote) => quote.factId)).toEqual(["f1", "f2", "f3"]);
    // Closing the circle is refused, for a rule and for the owner alike.
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "f1", to: "f3", relation: "same", stamp: rule, confirm: true }))).toBe("conflict");
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "f1", to: "f3", relation: "same", stamp: owner }))).toBe("conflict");
    const offered = record.proposeLink({ kind: "fact", from: "f1", to: "f3", relation: "same", stamp: model });
    expect(refusal(() => record.decideLink(offered.linkId, "confirmed"))).toBe("conflict");
    expect(record.root("fact", "f1")).toBe("f1");
  });

  it("lets the owner's own choice replace an offer nobody decided, and nothing else", () => {
    const { record, fact } = vault();
    fact("f2", "Built the API.");
    fact("f3", "Built the API for partners.");
    const offered = record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: model });
    // A second offer for the same fact waits for the first to be decided.
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "f2", to: "f3", relation: "same", stamp: model }))).toBe("conflict");
    const chosen = record.proposeLink({ kind: "fact", from: "f2", to: "f3", relation: "same", stamp: owner });
    expect(chosen.state).toBe("confirmed");
    expect(record.root("fact", "f2")).toBe("f3");
    expect(record.links("fact", "f2").map((found) => [found.to, found.state, found.decidedBy])).toEqual([
      ["f1", "rejected", "owner"],
      ["f3", "confirmed", "owner"],
    ]);
    // What the owner confirmed is not replaced, even by the owner, until they undo it.
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: owner }))).toBe("conflict");
    record.decideLink(chosen.linkId, "rejected");
    expect(record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: owner })).toEqual({ linkId: offered.linkId, state: "confirmed" });
  });

  it("links a fuller version without merging it", () => {
    const { record, fact } = vault();
    fact("short", "Built the API.");
    const fuller = record.proposeLink({ kind: "fact", from: "f1", to: "short", relation: "fuller", stamp: model });
    expect(fuller.state).toBe("proposed");
    record.decideLink(fuller.linkId, "confirmed");
    // Both stand: a fuller version is shown with the other, not in place of it.
    expect(record.root("fact", "f1")).toBe("f1");
    expect(record.root("fact", "short")).toBe("short");
    expect(record.merged("fact", "short")).toEqual([]);
    expect(record.evidenceOf("short")).toHaveLength(1);
    // Two facts are joined one way at a time.
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "short", to: "f1", relation: "fuller", stamp: model }))).toBe("conflict");
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "short", to: "f1", relation: "same", stamp: model }))).toBe("conflict");
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "f1", to: "short", relation: "same", stamp: model }))).toBe("conflict");
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "f1", to: "short", relation: "fuller", stamp: rule, confirm: true }))).toBe("invalid");
  });

  it("keeps what is in shadow from merging anything", () => {
    const { record, fact } = vault();
    fact("f2", LINE, { source: "upload-2" });
    const hidden = record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: shadow(rule) });
    expect(hidden.state).toBe("proposed");
    expect(record.links("fact", "f1")).toEqual([]);
    expect(record.links("fact", "f1", { shadow: true })).toMatchObject([{ id: hidden.linkId, shadow: true, holds: false }]);
    expect(record.root("fact", "f2")).toBe("f2");
    expect(record.evidenceOf("f1")).toHaveLength(1);
    expect(refusal(() => record.decideLink(hidden.linkId, "confirmed"))).toBe("not_found");
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: shadow(rule), confirm: true }))).toBe("invalid");
    // The same pair can be merged where it shows without touching the one in shadow.
    expect(record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: rule, confirm: true }).state).toBe("confirmed");
    expect(record.links("fact", "f1", { shadow: true })).toMatchObject([{ state: "proposed" }]);
  });

  it("is held to a limit for each fact or role", () => {
    const { record, fact } = vault();
    for (let index = 0; index < MAX_LINKS_PER_ITEM; index++) {
      fact(`short-${index}`, `Built part ${index} of the API.`);
      record.proposeLink({ kind: "fact", from: "f1", to: `short-${index}`, relation: "fuller", stamp: model });
    }
    fact("one-more", "Built the last part of the API.");
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "f1", to: "one-more", relation: "fuller", stamp: model }))).toBe("too_large");
    expect(refusal(() => record.proposeLink({ kind: "fact", from: "one-more", to: "f1", relation: "same", stamp: model }))).toBe("too_large");
  });
});

describe("what a change to a fact or a role takes with it", () => {
  /** f1 divided and tagged, with one fact merged into it, one offered, one fuller, and f1 itself offered elsewhere. */
  function busy() {
    const made = vault();
    const { record, fact, role } = made;
    fact("merged", LINE, { source: "upload-2" });
    fact("offered", "Designed and built the API.");
    fact("short", "Built the API.");
    fact("longer", `${LINE.slice(0, -1)} for 30 partner teams.`);
    fact("other", "Ran the on-call rota.");
    const split = record.proposeSplit({ factId: "f1", line: LINE, parts: DIVISION, stamp: model });
    record.decideSplit(split.splitId, "confirmed");
    record.proposeSplit({ factId: "f1", line: LINE, parts: [built, cutting(0)], stamp: shadow(model) });
    record.decideTag(record.proposeTag(tag({ kind: "fact", id: "f1" }, "esco:skill:api-design", "skill", "design application interfaces")).tagId, "confirmed");
    record.proposeTag(tag({ kind: "fact", id: "f1" }, "onet:tool:rest-api", "tool", "REST API", shadow(model)));
    record.proposeTag(tag({ kind: "part", id: split.partIds[3]! }, "onet:tool:rest-api", "tool", "REST API"));
    record.proposeTag(tag({ kind: "fact", id: "other" }, "onet:activity:4.A.4.b.4", "activity", "Guiding, Directing, and Motivating Subordinates"));
    record.proposeTag(tag({ kind: "role", id: "r1" }, "onet:occ:15-1252.00", "occupation", "Software Developers"));
    record.proposeLink({ kind: "fact", from: "merged", to: "f1", relation: "same", stamp: rule, confirm: true });
    record.proposeLink({ kind: "fact", from: "offered", to: "f1", relation: "same", stamp: model });
    record.proposeLink({ kind: "fact", from: "f1", to: "short", relation: "fuller", stamp: model });
    record.proposeLink({ kind: "fact", from: "longer", to: "f1", relation: "fuller", stamp: model });
    record.proposeLink({ kind: "fact", from: "other", to: "short", relation: "fuller", stamp: model });
    role("r2");
    record.proposeLink({ kind: "role", from: "r2", to: "r1", relation: "same", stamp: { ...rule, method: "identical-role/1" }, confirm: true });
    return made;
  }

  it("drops every judgement about a fact's words when the words change", () => {
    const { record, run, count } = busy();
    expect(count("fact_splits")).toBe(2);
    expect(count("record_tags")).toBe(5);
    run(`UPDATE facts SET text = ?, revision = revision + 1 WHERE id = 'f1'`, LINE.replace("40 minutes", "45 minutes"));
    // Its parts pointed at the old words, in shadow or not.
    expect(count("fact_splits")).toBe(0);
    expect(count("fact_parts")).toBe(0);
    expect(record.split("f1")).toBeNull();
    // Its tags were decided about the old words, even the one the owner confirmed.
    expect(count("record_tags", "subject_kind IN ('fact','part') AND subject_id <> 'other'")).toBe(0);
    // So was every likeness, except what was already merged into it.
    expect(record.links("fact", "f1").map((found) => [found.from, found.to, found.relation, found.state])).toEqual([["merged", "f1", "same", "confirmed"]]);
    expect(record.merged("fact", "f1")).toEqual(["merged"]);
    // Nothing about any other fact or the role went with it.
    expect(count("record_tags", "subject_id = 'other'")).toBe(1);
    expect(count("record_tags", "subject_kind = 'role'")).toBe(1);
    expect(record.links("fact", "other")).toHaveLength(1);
    expect(record.root("role", "r2")).toBe("r1");
  });

  it("separates a fact from the one it was merged into when its own words change", () => {
    const { record, run } = busy();
    expect(record.root("fact", "merged")).toBe("f1");
    run(`UPDATE facts SET text = ? WHERE id = 'merged'`, "Designed the API.");
    expect(record.root("fact", "merged")).toBe("merged");
    expect(record.merged("fact", "f1")).toEqual([]);
    expect(record.links("fact", "merged")).toEqual([]);
  });

  it("keeps everything when a fact changes in any other way", () => {
    const { record, run, count } = busy();
    const before = JSON.stringify(record.export());
    run(`UPDATE facts SET state = 'confirmed', level = 'led', revision = revision + 1, updated_at = 9 WHERE id = 'f1'`);
    run(`UPDATE facts SET text = text WHERE id = 'f1'`);
    run(`UPDATE facts SET vector = NULL WHERE id = 'f1'`);
    expect(JSON.stringify(record.export())).toBe(before);
    expect(count("fact_splits")).toBe(2);
  });

  it("takes everything about a fact with the fact, as a retried reading of an upload does", () => {
    const { record, run, count } = busy();
    run(`DELETE FROM facts WHERE id = 'f1'`);
    expect(count("fact_splits")).toBe(0);
    expect(count("fact_parts")).toBe(0);
    expect(count("record_tags", "subject_kind IN ('fact','part') AND subject_id <> 'other'")).toBe(0);
    expect(count("record_links", "kind = 'fact' AND (from_id = 'f1' OR to_id = 'f1')")).toBe(0);
    // What was merged into it stands by itself again.
    expect(record.root("fact", "merged")).toBe("merged");
    expect(record.links("fact", "other")).toHaveLength(1);
    expect(count("record_tags", "subject_id = 'other'")).toBe(1);
    // The same for every fact an upload proposed.
    run(`DELETE FROM facts WHERE state = 'proposed'`);
    expect(count("record_links", "kind = 'fact'")).toBe(0);
    expect(count("record_tags", "subject_kind <> 'role'")).toBe(0);
  });

  it("takes a role's occupation with its title, and its undecided likenesses with any field that names it", () => {
    const { record, run, role, count } = busy();
    role("r3", { title: "Senior Engineer" });
    role("r4");
    record.proposeLink({ kind: "role", from: "r3", to: "r1", relation: "same", stamp: model });
    record.proposeLink({ kind: "role", from: "r1", to: "r4", relation: "same", stamp: model });
    // Dates don't change what occupation a title names.
    run(`UPDATE roles SET end_date = '2022-01' WHERE id = 'r1'`);
    expect(count("record_tags", "subject_kind = 'role'")).toBe(1);
    // But they do change which role this is: offers go, and what was merged into it stays.
    expect(record.links("role", "r1").map((found) => [found.from, found.to, found.state])).toEqual([["r2", "r1", "confirmed"]]);
    run(`UPDATE roles SET org = org, state = 'confirmed', revision = revision + 1 WHERE id = 'r1'`);
    expect(count("record_tags", "subject_kind = 'role'")).toBe(1);
    run(`UPDATE roles SET title = 'Staff Engineer' WHERE id = 'r1'`);
    expect(count("record_tags", "subject_kind = 'role'")).toBe(0);
    expect(record.root("role", "r2")).toBe("r1");
    // A role that changes is no longer the one that was merged into another.
    run(`UPDATE roles SET org = 'Acme Labs' WHERE id = 'r2'`);
    expect(record.root("role", "r2")).toBe("r2");
  });

  it("takes everything about a role with the role", () => {
    const { record, run, count } = busy();
    run(`UPDATE facts SET role_id = NULL`);
    run(`DELETE FROM roles WHERE id = 'r1'`);
    expect(count("record_tags", "subject_kind = 'role'")).toBe(0);
    expect(count("record_links", "kind = 'role'")).toBe(0);
    expect(record.root("role", "r2")).toBe("r2");
  });
});

describe("the export", () => {
  it("gives every judgement held, whatever its state, and says which are in shadow", () => {
    const { record, fact } = vault();
    fact("f2", LINE, { source: "upload-2" });
    const split = record.proposeSplit({ factId: "f1", line: LINE, parts: DIVISION, stamp: model });
    record.decideSplit(split.splitId, "rejected");
    record.proposeSplit({ factId: "f1", line: LINE, parts: [built, cutting(0)], stamp: shadow(model) });
    record.proposeTag(tag({ kind: "fact", id: "f1" }, "onet:tool:rest-api", "tool", "REST API", shadow(model)));
    record.decideTag(record.proposeTag(tag({ kind: "fact", id: "f1" }, "esco:skill:api-design", "skill", "design application interfaces")).tagId, "rejected");
    record.proposeLink({ kind: "fact", from: "f2", to: "f1", relation: "same", stamp: rule, confirm: true });
    const exported = record.export();
    expect(exported.factSplits.map((found) => [found.state, found.shadow, found.parts.length])).toEqual([
      ["rejected", false, 4],
      ["proposed", true, 2],
    ]);
    expect(exported.factSplits[0]!.parts[0]).toEqual({ id: expect.any(String), kind: "clause", ranges: designed.ranges, text: "Designed the API", resultOf: null });
    expect(exported.conceptTags.map((found) => [found.label, found.state, found.shadow])).toEqual([
      ["REST API", "proposed", true],
      ["design application interfaces", "rejected", false],
    ]);
    expect(exported.recordLinks).toMatchObject([{ kind: "fact", from: "f2", to: "f1", relation: "same", state: "confirmed", decidedBy: "rule", method: "identical-wording/1", holds: true }]);
    // Plain data: it goes into the export file as it is.
    expect(JSON.parse(JSON.stringify(exported))).toEqual(exported);
  });

  it("is empty for a vault nothing has been proposed in", () => {
    expect(vault().record.export()).toEqual({ factSplits: [], conceptTags: [], recordLinks: [] });
  });
});
