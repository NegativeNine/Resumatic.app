import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import type { FactView, RoleView } from "../../src/shared/api";
import { TRANSFER_TABLES, type TransferPage } from "../../src/shared/operations";
import { vaultPrefix } from "../../src/shared/r2";
import type { NewTag, Range, RecordExport, Stamp } from "../../src/shared/record";
import type { ShareGrant } from "../../src/shared/sharing";
import { vault } from "../../src/shared/stubs";
import { OPERATION_MIGRATIONS, VaultOperations } from "../../src/vault/operations";
import { RecordStore } from "../../src/vault/record";
import { MIGRATIONS, SCHEMA_VERSION, createSchema, hasSchema, migrate } from "../../src/vault/schema";
import { fromBase64url } from "../../src/worker/crypto";
import { removeRecordMigration } from "../support/undo-vault-incarnation";
import { RESUME, call, cookieFrom, fakeModels, signIn, waitForSource, type User } from "./support";

// The record's tables inside a real vault: reached by its migration, cleared by the app's own
// edits, exported with everything else and moved with the vault. Nothing in the app writes them
// yet, so each test stores its judgements through the store, as a later pipeline step will.

const VERSION = "esco-1.2.1+onet-31.0+c036f953";
const model: Stamp = { proposedBy: "model", model: "@cf/test/judge", method: "judge/1", taxonomyVersion: VERSION, confidence: 0.97, shadow: false };
const rule: Stamp = { proposedBy: "rule", model: null, method: "identical-wording/1", taxonomyVersion: null, confidence: null, shadow: false };
const TABLES = ["fact_splits", "fact_parts", "record_tags", "record_links"] as const;

beforeEach(() => setModels(() => fakeModels()));
afterEach(() => setModels(null));

/** The range of `words` in `line`, which must hold them exactly once. */
function at(line: string, words: string): Range {
  const start = line.indexOf(words);
  if (start < 0 || line.indexOf(words, start + 1) >= 0) throw new Error(`"${words}" is not in the line exactly once`);
  return [start, start + words.length];
}

function vaultOf(user: User) {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  const session = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { vid: string };
  return vault(env, session.vid);
}

/** Runs inside the person's vault, with the record's store over its storage. */
function inVault<T>(user: User, work: (record: RecordStore, sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(vaultOf(user), (_instance, state) =>
    work(new RecordStore(state.storage.sql, (fn) => state.storage.transactionSync(fn)), state.storage.sql),
  );
}

function counts(sql: SqlStorage): Record<string, number> {
  return Object.fromEntries(TABLES.map((table) => [table, sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n]));
}

async function uploaded(user: User, filename: string, content: string): Promise<string> {
  const response = await user.upload(filename, content);
  expect(response.status, await response.clone().text()).toBe(201);
  const { sourceId } = (await response.json()) as { sourceId: string };
  expect((await waitForSource(user, sourceId)).state).toBe("ready");
  return sourceId;
}

const facts = async (user: User) => (await user.json<{ facts: FactView[] }>("/api/facts")).facts;
const roles = async (user: User) => (await user.json<{ roles: RoleView[] }>("/api/roles")).roles;

const tool = (subject: NewTag["subject"], stamp: Stamp = model): NewTag => ({
  subject,
  conceptId: "onet:tool:kubernetes",
  conceptKind: "tool",
  label: "Kubernetes",
  stamp,
});

describe("a line read from an upload", () => {
  it("divides into its own words, keeps its quote as evidence, and is exported with what was proposed", async () => {
    const user = await signIn();
    const sourceId = await uploaded(user, "jane-doe.pdf", RESUME);
    const before = await facts(user);
    const fact = before.find((found) => found.text.startsWith("Led the migration"))!;
    const line = fact.text;
    expect(line).toBe("Led the migration of 40 services to Kubernetes, cutting deploy time by 60%");

    const saved = await inVault(user, (record, sql) => {
      const split = record.proposeSplit({
        factId: fact.id,
        line,
        parts: [
          { kind: "result", ranges: [at(line, "cutting deploy time by 60%")], resultOf: 1 },
          { kind: "clause", ranges: [at(line, "Led the migration of 40 services to Kubernetes")] },
          { kind: "mention", ranges: [at(line, "Kubernetes")] },
        ],
        stamp: model,
      });
      const tagged = record.proposeTag(tool({ kind: "part", id: split.partIds[2]! }));
      const evidence = record.evidenceOf(fact.id);
      const markdown = sql.exec<{ markdown: string }>(`SELECT markdown FROM sources WHERE id = ?`, sourceId).one().markdown;
      return { split, tagged, evidence, markdown, read: record.split(fact.id)!, counts: counts(sql) };
    });
    expect(saved.counts).toEqual({ fact_splits: 1, fact_parts: 3, record_tags: 1, record_links: 0 });
    expect(saved.read.parts.map((part) => [part.kind, part.text])).toEqual([
      ["clause", "Led the migration of 40 services to Kubernetes"],
      ["mention", "Kubernetes"],
      ["result", "cutting deploy time by 60%"],
    ]);
    expect(saved.read.parts[2]!.resultOf).toBe(saved.read.parts[0]!.id);
    // Its evidence is the quote the upload gave it, where the upload has it.
    expect(saved.evidence).toHaveLength(1);
    expect(saved.evidence[0]).toMatchObject({ factId: fact.id, own: true, sourceId, quote: fact.quote });
    expect(saved.markdown.slice(...saved.evidence[0]!.span!)).toBe(fact.quote);

    // Nothing the app shows has changed.
    expect(await facts(user)).toEqual(before);

    const exported = await user.json<RecordExport & { facts: FactView[] }>("/api/export");
    expect(exported.facts).toHaveLength(before.length);
    expect(exported.factSplits).toMatchObject([{ id: saved.split.splitId, factId: fact.id, state: "proposed", proposedBy: "model", model: "@cf/test/judge", shadow: false }]);
    expect(exported.factSplits[0]!.parts.map((part) => part.text)).toEqual(saved.read.parts.map((part) => part.text));
    expect(exported.conceptTags).toMatchObject([{ id: saved.tagged.tagId, subject: { kind: "part", id: saved.split.partIds[2] }, conceptId: "onet:tool:kubernetes", relation: "uses", taxonomyVersion: VERSION }]);
    expect(exported.recordLinks).toEqual([]);
  });

  it("is exported with nothing when nothing has been proposed", async () => {
    const user = await signIn();
    const exported = await user.json<RecordExport>("/api/export");
    expect(exported).toMatchObject({ factSplits: [], conceptTags: [], recordLinks: [] });
  });
});

describe("two uploads of one resume", () => {
  it("merge only what is word for word the same, keep both quotes, and change nothing the app shows", async () => {
    const user = await signIn();
    const earlier = await uploaded(user, "jane-doe.pdf", RESUME);
    const later = await uploaded(user, "jane-doe-2024.pdf", `${RESUME}\nVolunteer: Code Club mentor, 2019`);
    const before = { facts: await facts(user), roles: await roles(user) };
    const from = (sourceId: string) => ({
      acme: before.roles.find((role) => role.sourceId === sourceId && role.org === "Acme Corp")!,
      globex: before.roles.find((role) => role.sourceId === sourceId && role.org === "Globex")!,
      built: before.facts.find((fact) => fact.sourceId === sourceId && fact.text.startsWith("Built a Go service"))!,
      mentored: before.facts.find((fact) => fact.sourceId === sourceId && fact.text.startsWith("Mentored"))!,
      dashboards: before.facts.find((fact) => fact.sourceId === sourceId && fact.text.startsWith("Implemented React"))!,
    });
    const first = from(earlier);
    const second = from(later);
    // Reading the second upload proposed every role and fact again, as it does today.
    expect(second.acme.id).not.toBe(first.acme.id);
    expect(second.built.text).toBe(first.built.text);

    const outcome = await inVault(user, (record) => {
      const code = (call: () => unknown) => {
        try {
          call();
        } catch (error) {
          return String((error as Error).message).split(":")[0];
        }
        return "nothing";
      };
      const sameFact = { kind: "fact" as const, from: second.built.id, to: first.built.id, relation: "same" as const, stamp: rule, confirm: true };
      // The two jobs have not been joined, so their lines can't be.
      const tooSoon = code(() => record.proposeLink(sameFact));
      const job = record.proposeLink({ kind: "role", from: second.acme.id, to: first.acme.id, relation: "same", stamp: { ...rule, method: "identical-role/1" }, confirm: true });
      const merged = record.proposeLink(sameFact);
      record.proposeLink({ kind: "role", from: second.globex.id, to: first.globex.id, relation: "same", stamp: { ...rule, method: "identical-role/1" }, confirm: true });
      // Two different lines of one job are not the same fact, whatever a rule says.
      const different = code(() => record.proposeLink({ kind: "fact", from: second.mentored.id, to: first.dashboards.id, relation: "same", stamp: rule, confirm: true }));
      const evidence = record.evidenceOf(first.built.id);
      const stands = record.root("fact", second.built.id);
      record.decideLink(job.linkId, "rejected");
      return { tooSoon, job, merged, different, evidence, stands, apart: record.evidenceOf(first.built.id), root: record.root("fact", second.built.id) };
    });
    expect(outcome.tooSoon).toBe("conflict");
    expect(outcome.job.state).toBe("confirmed");
    expect(outcome.merged.state).toBe("confirmed");
    expect(outcome.different).toBe("invalid");
    expect(outcome.stands).toBe(first.built.id);
    // One fact, with the quote from each upload that states it.
    expect(outcome.evidence.map((quote) => [quote.factId, quote.own, quote.sourceId, quote.quote])).toEqual([
      [first.built.id, true, earlier, first.built.quote],
      [second.built.id, false, later, second.built.quote],
    ]);
    // Separating the two jobs separates their lines again.
    expect(outcome.apart).toHaveLength(1);
    expect(outcome.root).toBe(second.built.id);

    // Every role, fact and quote is as it was: nothing reads the record yet.
    expect(await facts(user)).toEqual(before.facts);
    expect(await roles(user)).toEqual(before.roles);
  });
});

describe("changes made in the app", () => {
  const LINE = "Designed and built the billing API, cutting invoice errors by 30%.";

  async function owner() {
    const user = await signIn();
    const added = await user.send("POST", "/api/facts", { roleId: null, kind: "accomplishment", text: LINE, level: "implemented" });
    expect(added.status, await added.clone().text()).toBe(201);
    const { factId } = (await added.json()) as { factId: string };
    // The line as the vault holds it is what parts are positions in.
    const line = (await facts(user)).find((fact) => fact.id === factId)!.text;
    await inVault(user, (record) => {
      const split = record.proposeSplit({
        factId,
        line,
        parts: [
          { kind: "clause", ranges: [at(line, "Designed and built the billing API")] },
          { kind: "result", ranges: [at(line, "cutting invoice errors by 30%")], resultOf: 0 },
        ],
        stamp: model,
      });
      record.decideSplit(split.splitId, "confirmed");
      record.decideTag(record.proposeTag(tool({ kind: "fact", id: factId })).tagId, "confirmed");
      record.proposeTag(tool({ kind: "part", id: split.partIds[0]! }));
    });
    return { user, factId, line };
  }

  it("keep a fact's parts and tags while its words stay the same", async () => {
    const { user, factId } = await owner();
    expect((await user.send("PATCH", `/api/facts/${factId}`, { level: "led" })).status).toBe(204);
    expect((await user.send("POST", "/api/review", { reject: [factId], confirm: [] })).status).toBe(204);
    expect((await user.send("POST", "/api/review", { reject: [], confirm: [factId] })).status).toBe(204);
    const role = await user.send("POST", "/api/roles", { kind: "job", org: "Acme", title: "Engineer", startDate: "2020", endDate: null });
    const { roleId } = (await role.json()) as { roleId: string };
    expect((await user.send("PATCH", `/api/facts/${factId}`, { roleId })).status).toBe(204);
    const held = await inVault(user, (record, sql) => ({ split: record.split(factId), tags: record.tags({ kind: "fact", id: factId }), counts: counts(sql) }));
    expect(held.counts).toEqual({ fact_splits: 1, fact_parts: 2, record_tags: 2, record_links: 0 });
    expect(held.split).toMatchObject({ state: "confirmed", decidedBy: "owner" });
    expect(held.tags).toMatchObject([{ state: "confirmed" }]);
  });

  it("take a fact's parts and tags with its words when the owner rewords it", async () => {
    const { user, factId, line } = await owner();
    expect((await user.send("PATCH", `/api/facts/${factId}`, { text: "Designed the billing API." })).status).toBe(204);
    const held = await inVault(user, (record, sql) => ({ split: record.split(factId), tags: record.tags({ kind: "fact", id: factId }), counts: counts(sql) }));
    // The parts pointed at words that are gone, and the tags were decided about them.
    expect(held).toEqual({ split: null, tags: [], counts: { fact_splits: 0, fact_parts: 0, record_tags: 0, record_links: 0 } });
    const reworded = (await facts(user)).find((fact) => fact.id === factId)!;
    expect(reworded.origin).toBe("user");
    expect(reworded.text).not.toBe(line);
    expect(reworded.text).toContain("Designed the billing API");
    // The line as it now reads can be divided afresh.
    const again = await inVault(user, (record) =>
      record.proposeSplit({ factId, line: reworded.text, parts: [{ kind: "clause", ranges: [at(reworded.text, "Designed the billing API")] }], stamp: model }),
    );
    expect(again.state).toBe("proposed");
  });

  it("leave a coach's copy showing the line, and none of its parts or tags", async () => {
    const { user, factId, line } = await owner();
    const made = await user.send("POST", "/api/shares", { factIds: [factId], resumes: [] });
    expect(made.status, await made.clone().text()).toBe(201);
    const { grant, url } = (await made.json()) as { grant: ShareGrant; url: string };
    const exchange = await call("/share/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(url).hash.slice(1) }) });
    expect(exchange.status).toBe(200);
    const copy = await call(`/share/snapshot?g=${grant.id}`, { cookie: cookieFrom(exchange, `__Host-share-${grant.id}`)! });
    expect(copy.status).toBe(200);
    const text = await copy.text();
    expect(text).toContain(line);
    // The fact has an accepted division and two tags; none of it is in the copy.
    for (const kept of ["Kubernetes", "onet:tool", "ranges", "clause", "taxonomy", "factSplits", "conceptTags"]) expect(text, kept).not.toContain(kept);
  });

  it("refuse parts worked out against words the owner has since changed", async () => {
    const { user, factId, line } = await owner();
    expect((await user.send("PATCH", `/api/facts/${factId}`, { text: "Designed the billing API." })).status).toBe(204);
    const refused = await inVault(user, (record) => {
      try {
        record.proposeSplit({ factId, line, parts: [{ kind: "clause", ranges: [at(line, "Designed and built the billing API")] }], stamp: model });
      } catch (error) {
        return String((error as Error).message);
      }
      return "stored";
    });
    expect(refused).toMatch(/^conflict: /);
  });
});

describe("a vault's own storage", () => {
  it("drops everything about a fact with the fact, through each table in turn", async () => {
    const user = await signIn();
    await uploaded(user, "jane-doe.pdf", RESUME);
    const all = await facts(user);
    const fact = all.find((found) => found.text.startsWith("Led the migration"))!;
    const other = all.find((found) => found.text.startsWith("Helped design"))!;
    const line = fact.text;
    const left = await inVault(user, (record, sql) => {
      const split = record.proposeSplit({ factId: fact.id, line, parts: [{ kind: "clause", ranges: [at(line, "Led the migration of 40 services to Kubernetes")] }, { kind: "mention", ranges: [at(line, "Kubernetes")] }], stamp: model });
      record.proposeTag(tool({ kind: "part", id: split.partIds[1]! }));
      record.proposeTag(tool({ kind: "fact", id: fact.id }));
      record.proposeTag(tool({ kind: "fact", id: other.id }));
      record.proposeLink({ kind: "fact", from: fact.id, to: other.id, relation: "fuller", stamp: model });
      const before = counts(sql);
      // What a retried reading of an upload does to the facts it proposed the first time.
      sql.exec(`DELETE FROM facts WHERE id = ?`, fact.id);
      return { before, after: counts(sql), quotes: sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM evidence`).one().n };
    });
    expect(left.before).toEqual({ fact_splits: 1, fact_parts: 2, record_tags: 3, record_links: 1 });
    // Only the tag on the other fact is left.
    expect(left.after).toEqual({ fact_splits: 0, fact_parts: 0, record_tags: 1, record_links: 0 });
    expect(left.quotes).toBeGreaterThan(0);
  });

  it("gains the record's tables in a vault made before them, with its facts as they were", async () => {
    const user = await signIn();
    await uploaded(user, "jane-doe.pdf", RESUME);
    const before = { facts: await facts(user), roles: await roles(user) };
    await runInDurableObject(vaultOf(user), (_instance, state) => {
      const sql = state.storage.sql;
      // Rewind this vault to the schema before the record, as an older vault would be.
      removeRecordMigration(sql);
      const previous = MIGRATIONS.findIndex((migration) => migration.some((statement) => statement.includes("CREATE TABLE fact_splits")));
      expect(previous).toBeGreaterThan(-1);
      const named = (type: string) =>
        sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = ? AND (name LIKE 'record_%' OR name LIKE 'fact_splits%' OR name = 'fact_parts') ORDER BY name`, type).toArray().map((row) => row.name);
      expect(named("table")).toEqual([]);
      expect(named("trigger")).toEqual([]);
      sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
      migrate(sql, <T>(fn: () => T) => state.storage.transactionSync(fn));
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`).one().value).toBe(String(SCHEMA_VERSION));
      expect(named("table")).toEqual(["fact_parts", "fact_splits", "record_links", "record_tags"]);
      expect(named("trigger")).toEqual([
        "record_fact_deleted",
        "record_fact_reworded",
        "record_part_deleted",
        "record_role_changed",
        "record_role_deleted",
        "record_role_retitled",
        "record_split_deleted",
      ]);
      expect(counts(sql)).toEqual({ fact_splits: 0, fact_parts: 0, record_tags: 0, record_links: 0 });
    });
    expect(await facts(user)).toEqual(before.facts);
    expect(await roles(user)).toEqual(before.roles);
    // And the tables work: a tag can be proposed and read back.
    const fact = before.facts[0]!;
    const held = await inVault(user, (record) => {
      record.proposeTag(tool({ kind: "fact", id: fact.id }));
      return record.tags({ kind: "fact", id: fact.id });
    });
    expect(held).toMatchObject([{ label: "Kubernetes", state: "proposed" }]);
  });
});

describe("a vault moved to a replacement", () => {
  type Stub = ReturnType<typeof env.VAULT.get>;
  const stub = () => env.VAULT.get(env.VAULT.newUniqueId());
  const LINE = "Built a service and cut its latency by half.";

  function storage<T>(target: Stub, work: (ops: VaultOperations, record: RecordStore, sql: SqlStorage) => T | Promise<T>): Promise<T> {
    return runInDurableObject(target, async (_instance, state) => {
      const sql = state.storage.sql;
      const transaction = <R>(fn: () => R): R => state.storage.transactionSync(fn);
      if (!hasSchema(sql)) createSchema(sql, transaction);
      for (const migration of OPERATION_MIGRATIONS) sql.exec(migration);
      const ops = new VaultOperations(sql, transaction, { vaultId: target.id.toString(), userId: "owner", schemaVersion: SCHEMA_VERSION, requireMaintenanceFence: () => {} });
      return work(ops, new RecordStore(sql, transaction), sql);
    });
  }

  it("takes every part, tag and link with it", async () => {
    const source = stub();
    const destination = stub();
    const sent = await storage(source, async (ops, record, sql) => {
      sql.exec(`INSERT INTO profile (id, name) VALUES (1, 'Test Candidate')`);
      sql.exec(`INSERT INTO sources (id, filename, r2_key, markdown, state, created_at) VALUES ('source', 'resume.docx', ?, ?, 'ready', 1)`, `${vaultPrefix(source.id.toString())}sources/source`, LINE);
      sql.exec(`INSERT INTO source_revisions (id, source_id, markdown, created_at) VALUES ('revision', 'source', ?, 1)`, LINE);
      for (const id of ["one", "two"]) {
        sql.exec(`INSERT INTO evidence (id, source_id, quote, start, end, source_revision_id) VALUES (?, 'source', ?, 0, ?, 'revision')`, `quote-${id}`, LINE, LINE.length);
        sql.exec(`INSERT INTO roles (id, kind, org, title, start_date, end_date, state) VALUES (?, 'job', 'Acme', 'Engineer', '2020', '2022', 'confirmed')`, `role-${id}`);
        sql.exec(
          `INSERT INTO facts (id, role_id, kind, text, evidence_id, source_id, origin, state, vector, updated_at) VALUES (?, ?, 'accomplishment', ?, ?, 'source', 'extracted', 'confirmed', ?, 1)`,
          `fact-${id}`,
          `role-${id}`,
          LINE,
          `quote-${id}`,
          new Float32Array([0.25, 0.75]).buffer,
        );
      }
      sql.exec(`INSERT INTO meta (key, value) VALUES ('embedding_model', '@cf/test/embedding'), ('embedding_dimensions', '2'), ('embedding_generation', 'generation-1'), ('security_epoch', 'old-epoch')`);
      const split = record.proposeSplit({
        factId: "fact-one",
        line: LINE,
        parts: [
          { kind: "clause", ranges: [at(LINE, "Built a service")] },
          { kind: "result", ranges: [at(LINE, "cut its latency by half")], resultOf: 0 },
        ],
        stamp: model,
      });
      record.decideSplit(split.splitId, "confirmed");
      record.proposeTag(tool({ kind: "part", id: split.partIds[0]! }));
      record.proposeTag({ subject: { kind: "role", id: "role-one" }, conceptId: "onet:occ:15-1252.00", conceptKind: "occupation", label: "Software Developers", stamp: { ...model, shadow: true } });
      record.proposeLink({ kind: "role", from: "role-two", to: "role-one", relation: "same", stamp: { ...rule, method: "identical-role/1" }, confirm: true });
      record.proposeLink({ kind: "fact", from: "fact-two", to: "fact-one", relation: "same", stamp: rule, confirm: true });
      const manifest = ops.beginExport("move-record");
      const pages: TransferPage[] = [];
      for (const table of manifest.tables) pages.push(await ops.exportPage("move-record", table.name));
      return { manifest, pages, held: record.export(), evidence: record.evidenceOf("fact-one") };
    });
    expect(sent.manifest.tables.map((table) => table.name)).toEqual(TRANSFER_TABLES);
    expect(Object.fromEntries(sent.manifest.tables.filter((table) => (TABLES as readonly string[]).includes(table.name)).map((table) => [table.name, table.count]))).toEqual({
      fact_splits: 1,
      fact_parts: 2,
      record_tags: 2,
      record_links: 2,
    });
    expect(sent.evidence).toHaveLength(2);

    const arrived = await storage(destination, async (ops, record, sql) => {
      ops.beginImport(sent.manifest);
      for (const page of sent.pages) await ops.importPage(page);
      const status = ops.finishImport(sent.manifest.operationId, "replacement-epoch", () => {});
      return { status, held: record.export(), evidence: record.evidenceOf("fact-one"), root: record.root("fact", "fact-two"), counts: counts(sql) };
    });
    expect(arrived.status).toMatchObject({ state: "ready", completedTables: TRANSFER_TABLES.length });
    expect(arrived.counts).toEqual({ fact_splits: 1, fact_parts: 2, record_tags: 2, record_links: 2 });
    // The same judgements, with the same IDs, states and stamps, and the parts still read as the line's words.
    expect(arrived.held).toEqual(sent.held);
    expect(arrived.held.factSplits[0]!.parts.map((part) => part.text)).toEqual(["Built a service", "cut its latency by half"]);
    expect(arrived.evidence).toEqual(sent.evidence);
    expect(arrived.root).toBe("fact-one");
  });
});
