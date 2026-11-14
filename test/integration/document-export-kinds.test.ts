import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { DocumentView } from "../../src/shared/documents";
import type { FactRecord } from "../../src/shared/types";
import { vault } from "../../src/shared/stubs";
import { app } from "../../src/worker/routes";
import { readSession } from "../../src/worker/session";
import { call, signIn } from "./support";

const PRIVATE_QUOTE = "Private source: Built one service with Go";
const FACTS: FactRecord[] = [
  { id: "f1", revision: 1, roleId: "role-a", kind: "accomplishment", origin: "extracted", text: "Built one service", level: null, quote: PRIVATE_QUOTE },
  { id: "f2", revision: 1, roleId: "role-b", kind: "accomplishment", origin: "extracted", text: "Improved reliability and speed", level: null, quote: "Improved reliability and speed" },
  { id: "f3", revision: 1, roleId: null, kind: "accomplishment", origin: "user", text: "I welcome the opportunity", level: null, quote: null },
];
type Saved = { result: NonNullable<DocumentView["result"]>; facts: Record<string, { text: string; quote: string | null }>; evidence?: Record<string, FactRecord>; privateCoverage?: unknown; receipts?: unknown };
async function seed() {
  const user = await signIn();
  const session = await readSession(env.SESSION_KEY, user.cookie.slice("__Host-session=".length));
  if (!session) throw new Error("missing synthetic session");
  const stub = vault(env, session.vid);
  const who = { userId: session.uid, gen: session.gen, epoch: session.epoch };
  const inside = <T>(work: (sql: SqlStorage) => T) => runInDurableObject(stub, (_instance, state) => work(state.storage.sql));
  const ids = Object.fromEntries(["refine", "questions", "letter", "prep"].map((kind) => [kind, crypto.randomUUID()]));
  await inside((sql) => {
    sql.exec(`INSERT INTO sources (id, filename, r2_key, markdown, state, created_at) VALUES ('synthetic-source', 'synthetic.txt', 'synthetic', ?, 'ready', 1)`, `${PRIVATE_QUOTE}\n${FACTS[1]!.text}`);
    for (const id of ["role-a", "role-b"]) sql.exec(`INSERT INTO roles (id, kind, org, title, state) VALUES (?, 'job', 'Acme', 'Engineer', 'confirmed')`, id);
    for (const fact of FACTS) {
      const evidenceId = `e-${fact.id}`;
      if (fact.quote) sql.exec(`INSERT INTO evidence (id, source_id, quote) VALUES (?, 'synthetic-source', ?)`, evidenceId, fact.quote);
      sql.exec(`INSERT INTO facts (id, role_id, kind, text, evidence_id, origin, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 1)`, fact.id, fact.roleId, fact.kind, fact.text, fact.quote ? evidenceId : null, fact.origin);
    }
    for (const [kind, id] of Object.entries(ids)) {
      const result = {
        kind,
        units: [
          { id: "u1", roleId: "role-a", text: "Built one service.", factIds: ["f1"], status: "kept", group: 0 },
          { id: "u2", roleId: "role-b", text: "Improved reliability and speed.", factIds: ["f2"], status: "kept", group: 0 },
          { id: "u3", roleId: null, text: "I welcome the opportunity.", factIds: ["f3"], status: "kept", group: 1 },
        ],
        questions: kind === "letter" ? [] : [{ id: "q1", requirement: "Private posting requirement", question: "Synthetic question?" }, { id: "q2", requirement: "Another private requirement", question: "Second question?" }],
        report: { kept: 3, repaired: 0, replaced: 0, dropped: 0, gaps: [] },
      };
      const saved = { result, facts: Object.fromEntries(FACTS.map(({ id, text, quote }) => [id, { text, quote }])), evidence: Object.fromEntries(FACTS.map((fact) => [fact.id, fact])), privateCoverage: "private coverage", receipts: "private receipt" };
      sql.exec(`INSERT INTO documents (id, application_id, kind, state, version, created_at) VALUES (?, 'synthetic-application', ?, 'ready', 1, 1)`, id, kind);
      sql.exec(`INSERT INTO document_versions (document_id, version, data, created_at) VALUES (?, 1, ?, 1)`, id, JSON.stringify(saved));
    }
  });
  const change = async (work: (saved: Saved) => void, id = ids.letter!) => inside((sql) => {
    const saved = JSON.parse(sql.exec<{ data: string }>(`SELECT data FROM document_versions WHERE document_id = ? AND version = 1`, id).one().data) as Saved;
    work(saved); sql.exec(`UPDATE document_versions SET data = ? WHERE document_id = ? AND version = 1`, JSON.stringify(saved), id);
  });
  return { user, stub, who, inside, ids, change };
}
async function wordXml(response: Response) {
  expect(response.status, response.status === 200 ? "" : await response.clone().text()).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return strFromU8(unzipSync(new Uint8Array(await response.arrayBuffer()))["word/document.xml"]!);
}
async function refused(response: Response, status = 409) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(response.headers.get("content-type")).not.toContain("wordprocessingml");
}

describe("checked document DOCX publication", () => {
  it("exports valid saved letters and preparation through a narrow checked projection", async () => {
    const { user, stub, who, ids } = await seed();
    for (const kind of ["letter", "prep"] as const) {
      const response = await user.fetch(`/api/documents/${ids[kind]}/docx`);
      expect(response.headers.get("content-disposition")).toContain(kind === "letter" ? "cover-letter.docx" : "interview-preparation.docx");
      const xml = await wordXml(response);
      expect(xml).toContain("Built one service.");
      expect(xml).toContain("Improved reliability and speed.");
      for (const hidden of [PRIVATE_QUOTE, "Private posting", "private coverage", "private receipt", "factIds", "role-a", "f1"])
        expect(xml).not.toContain(hidden);
      if (kind === "letter") {
        expect(xml).toContain("Built one service. Improved reliability and speed.");
        expect(xml.indexOf("Built one service.")).toBeLessThan(xml.indexOf("I welcome the opportunity."));
      } else expect(xml).toContain("Synthetic question?");
      const projection = await stub.documentExportData(who, ids[kind]!);
      expect(Object.keys(projection).sort()).toEqual(["document", "snapshot"]);
      expect(Object.keys(projection.document).sort()).toEqual(["id", "kind", "paragraphs", "questions", "version"]);
      expect(projection.snapshot).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const text = JSON.stringify(projection);
      for (const hidden of [PRIVATE_QUOTE, "Private posting", "private coverage", "private receipt", '"quote"', '"evidence"', '"factIds"']) expect(text).not.toContain(hidden);
    }
  });
  it("refuses other document kinds and wrong owners", async () => {
    const { user, ids } = await seed();
    for (const kind of ["refine", "questions"]) await refused(await user.fetch(`/api/documents/${ids[kind]}/docx`), 422);
    expect((await call(`/api/documents/${ids.letter}/docx`)).status).toBe(401);
    await refused(await (await signIn()).fetch(`/api/documents/${ids.letter}/docx`), 404);
  });
  it.each(["running", "failed"])("refuses a %s document even when saved bytes exist", async (state) => {
    const { user, ids, inside } = await seed();
    await inside((sql) => sql.exec(`UPDATE documents SET state = ? WHERE id = ?`, state, ids.letter));
    await refused(await user.fetch(`/api/documents/${ids.letter}/docx`));
  });
  it.each([
    ["legacy evidence", (saved: Saved) => { delete saved.evidence; }],
    ["unverified status", (saved: Saved) => { saved.result.units[0]!.status = "edited"; }],
    ["overstated unit", (saved: Saved) => { saved.result.units[0]!.text = "Built 40 services."; }],
    ["cross-role unit", (saved: Saved) => { saved.result.units[0]!.roleId = "role-b"; }],
    ["detached evidence", (saved: Saved) => { saved.evidence!.f1!.quote = "Different evidence"; }],
    ["kind mismatch", (saved: Saved) => { saved.result.kind = "prep"; }],
  ] as const)("refuses %s while preserving owner inspection", async (_name, mutate) => {
    const { user, ids, change } = await seed(); await change(mutate);
    await refused(await user.fetch(`/api/documents/${ids.letter}/docx`));
    const inspection = await user.json<DocumentView>(`/api/documents/${ids.letter}`);
    expect(inspection.result?.units).toHaveLength(3);
  });
  it.each(["private fact", "private source line", "withdrawn fact", "withdrawn role"])("refuses %s after saving", async (reason) => {
    const { user, ids, inside } = await seed();
    await inside((sql) => {
      if (reason === "private fact") sql.exec(`UPDATE facts SET sensitive = 1 WHERE id = 'f1'`);
      else if (reason === "private source line") {
        sql.exec(`INSERT INTO facts (id, kind, text, evidence_id, origin, state, sensitive, updated_at) VALUES ('private-sibling', 'skill', 'Go', 'e-f1', 'extracted', 'confirmed', 1, 1)`);
      } else if (reason === "withdrawn fact") sql.exec(`UPDATE facts SET state = 'rejected' WHERE id = 'f1'`);
      else sql.exec(`UPDATE roles SET state = 'rejected' WHERE id = 'role-a'`);
    });
    await refused(await user.fetch(`/api/documents/${ids.letter}/docx`));
    expect((await user.json<DocumentView>(`/api/documents/${ids.letter}`)).result?.units[0]?.text).toBe("Built one service.");
  });
  it("retains the exact saved evidence across ordinary edits", async () => {
    const { user, ids, inside } = await seed();
    await inside((sql) => sql.exec(`UPDATE facts SET text = 'Built internal tools', origin = 'user', revision = revision + 1 WHERE id = 'f1'`));
    const xml = await wordXml(await user.fetch(`/api/documents/${ids.letter}/docx`));
    expect(xml).toContain("Built one service."); expect(xml).not.toContain("Built internal tools");
  });
  it.each(["version", "evidence", "privacy", "withdrawal", "session"])("rechecks a %s change between projection and returning bytes", async (reason) => {
    const { user, ids, stub, who, inside, change } = await seed(); let first = true; let checked = false;
    const namespace = {
      idFromString: (id: string) => env.VAULT.idFromString(id),
      get: (id: DurableObjectId) => {
        const target = env.VAULT.get(id);
        return { documentExportData: async (...args: Parameters<typeof stub.documentExportData>) => {
          if (!first) checked = args[2]?.version === 1 && typeof args[2]?.snapshot === "string";
          const projection = await target.documentExportData(...args);
          if (first) {
            first = false;
            if (reason === "version") await inside((sql) => {
              sql.exec(`INSERT INTO document_versions (document_id, version, data, created_at) SELECT document_id, 2, data, created_at FROM document_versions WHERE document_id = ? AND version = 1`, ids.letter);
              sql.exec(`UPDATE documents SET version = 2 WHERE id = ?`, ids.letter);
            });
            else if (reason === "evidence") await change((saved) => { saved.evidence!.f1 = { ...saved.evidence!.f1!, revision: 2 }; });
            else if (reason === "privacy") await inside((sql) => sql.exec(`UPDATE facts SET sensitive = 1 WHERE id = 'f1'`));
            else if (reason === "withdrawal") await inside((sql) => sql.exec(`UPDATE facts SET state = 'rejected' WHERE id = 'f1'`));
            else await stub.signOutEverywhere(who);
          }
          return projection;
        } };
      },
    };
    const bindings = { ...env, VAULT: namespace } as unknown as Env;
    const response = await app.fetch(new Request(`https://resumatic.test/api/documents/${ids.letter}/docx`, { headers: { cookie: user.cookie } }), bindings);
    await refused(response, reason === "session" ? 401 : 409); expect(checked).toBe(true);
  });
});
