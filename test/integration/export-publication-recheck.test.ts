import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { setPdfRenderer } from "../../src/render/pdf";
import { vault } from "../../src/shared/stubs";
import type { FactRecord, RenderData } from "../../src/shared/types";
import { app } from "../../src/worker/routes";
import { readSession } from "../../src/worker/session";
import { signIn } from "./support";

afterEach(() => setPdfRenderer(null));

async function fixture() {
  const user = await signIn();
  const session = await readSession(env.SESSION_KEY, user.cookie.slice("__Host-session=".length));
  if (!session) throw Error("missing synthetic session");
  const stub = vault(env, session.vid);
  const fact: FactRecord = { id: "fact", revision: 1, roleId: null, kind: "accomplishment", text: "Built payment services", level: null, quote: null, origin: "user" };
  const render: RenderData = { profile: { name: "Avery Example", email: "avery@example.test", phone: "", location: "", links: [] },
    company: "Example", title: "Engineer", version: 1, body: { summary: { id: "summary", text: fact.text, factIds: [fact.id], status: "kept" }, sections: [], skills: [] } };
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`INSERT INTO facts(id,kind,text,origin,state,updated_at) VALUES(?,'accomplishment',?,'user','confirmed',1)`, fact.id, fact.text);
    sql.exec(`INSERT INTO applications(id,jd_text,created_at) VALUES('app','Build services',1)`);
    sql.exec(`INSERT INTO resumes(id,application_id,state,body,created_at) VALUES('resume','app','ready',?,1)`, JSON.stringify(render.body));
    sql.exec(`INSERT INTO resume_versions(resume_id,version,data,created_at) VALUES('resume',1,?,1)`, JSON.stringify({ render, facts: { fact: { text: fact.text, quote: null } }, evidence: { fact }, roleEvidence: {}, provenance: "snapshot" }));
  });
  const mark = async () => { expect((await user.send("POST", "/api/facts/sensitive", { ids: [fact.id], sensitive: true })).status).toBe(204); };
  return { user, stub, mark };
}

it("refuses a PDF and avoids caching it if a cited fact becomes private while Browser Run is pending", async () => {
  const { user, stub, mark } = await fixture();
  setPdfRenderer(async () => { await mark(); return new TextEncoder().encode("%PDF-1.7 synthetic"); });
  const response = await user.fetch("/api/resumes/resume/pdf");
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("private");
  await runInDurableObject(stub, (_instance, state) => {
    expect(state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM export_cache`).one().n).toBe(0);
  });
  // Inspection remains available to the owner.
  expect((await user.fetch("/api/resumes/resume")).status).toBe(200);
});

it.each(["pdf", "docx"])("refuses cached %s bytes when the supporting fact becomes private during lookup", async (format) => {
  const { user, stub, mark } = await fixture();
  setPdfRenderer(async () => new TextEncoder().encode("%PDF-1.7 synthetic"));
  expect((await user.fetch(`/api/resumes/resume/${format}`)).status).toBe(200);
  let marked = false;
  const namespace = {
    idFromString: (id: string) => env.VAULT.idFromString(id),
    get: (id: DurableObjectId) => {
      const target = env.VAULT.get(id);
      return {
        renderData: (...args: Parameters<typeof stub.renderData>) => target.renderData(...args),
        checkSession: (...args: Parameters<typeof stub.checkSession>) => target.checkSession(...args),
        putExportCache: (...args: Parameters<typeof stub.putExportCache>) => target.putExportCache(...args),
        readExportCache: async (...args: Parameters<typeof stub.readExportCache>) => {
          const bytes = await target.readExportCache(...args);
          expect(bytes).not.toBeNull();
          if (!marked) { marked = true; await mark(); }
          return bytes;
        },
      };
    },
  };
  const response = await app.fetch(new Request(`https://resumatic.test/api/resumes/resume/${format}`, { headers: { cookie: user.cookie } }), { ...env, VAULT: namespace } as unknown as Env);
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("private");
});

it("refuses cached bytes when a same-version snapshot changes while remaining otherwise printable", async () => {
  const { user, stub } = await fixture();
  expect((await user.fetch("/api/resumes/resume/docx")).status).toBe(200);
  const namespace = {
    idFromString: (id: string) => env.VAULT.idFromString(id),
    get: (id: DurableObjectId) => {
      const target = env.VAULT.get(id);
      return {
        renderData: (...args: Parameters<typeof stub.renderData>) => target.renderData(...args),
        checkSession: (...args: Parameters<typeof stub.checkSession>) => target.checkSession(...args),
        putExportCache: (...args: Parameters<typeof stub.putExportCache>) => target.putExportCache(...args),
        readExportCache: async (...args: Parameters<typeof stub.readExportCache>) => {
          const bytes = await target.readExportCache(...args);
          expect(bytes).not.toBeNull();
          await runInDurableObject(stub, (_instance, state) => {
            const saved = JSON.parse(state.storage.sql.exec<{ data: string }>(`SELECT data FROM resume_versions WHERE resume_id='resume' AND version=1`).one().data);
            saved.render.profile.name = "Blair Example";
            state.storage.sql.exec(`UPDATE resume_versions SET data=? WHERE resume_id='resume' AND version=1`, JSON.stringify(saved));
          });
          return bytes;
        },
      };
    },
  };
  const response = await app.fetch(new Request("https://resumatic.test/api/resumes/resume/docx", { headers: { cookie: user.cookie } }), { ...env, VAULT: namespace } as unknown as Env);
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("changed while its file was being prepared");
});
