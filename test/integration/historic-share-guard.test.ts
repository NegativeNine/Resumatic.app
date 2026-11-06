import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import type { FactView, RoleView } from "../../src/shared/api";
import { vault } from "../../src/shared/stubs";
import { fromBase64url } from "../../src/worker/crypto";
import { call, cookieFrom, fakeModels, JOB_DESCRIPTION, RESUME, signIn, waitForResume, waitForSource } from "./support";

beforeEach(() => setModels(() => fakeModels()));
afterEach(() => setModels(null));

describe("historical share grounding", () => {
  it.each([
    ["ownership level", "Led the migration project", "Migration project participant"],
    ["number", "Built 987654321 services", "Built services"],
    ["name", "Built HYPERTOOL services", "Built services"],
  ])("blocks an older line with an unsupported %s", async (_kind, claim, factText) => {
    const user = await signIn();
    const upload = await user.upload("synthetic.pdf", RESUME);
    const { sourceId } = await upload.json() as { sourceId: string };
    await waitForSource(user, sourceId);
    const { facts } = await user.json<{ facts: FactView[] }>("/api/facts");
    const { roles } = await user.json<{ roles: RoleView[] }>("/api/roles");
    expect((await user.send("POST", "/api/review", { confirm: [...facts, ...roles].map((item) => item.id), reject: [] })).status).toBe(204);
    const { applicationId } = await (await user.send("POST", "/api/applications", { jdText: JOB_DESCRIPTION })).json() as { applicationId: string };
    const { resumeId } = await (await user.send("POST", `/api/applications/${applicationId}/resumes`)).json() as { resumeId: string };
    await waitForResume(user, resumeId);
    const share = await user.send("POST", "/api/shares", { factIds: [], resumes: [{ id: resumeId, version: 1 }] });
    expect(share.status).toBe(201);
    const { grant, url } = await share.json() as { grant: { id: string }; url: string };
    const exchange = await call("/share/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(url).hash.slice(1) }) });
    const cookie = cookieFrom(exchange, "__Host-share")!;
    const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
    const { vid } = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { vid: string };
    await runInDurableObject(vault(env, vid), (_instance, state) => {
      const sql = state.storage.sql;
      const row = sql.exec<{ data: string }>(`SELECT data FROM resume_versions WHERE resume_id=? AND version=1`, resumeId).one();
      const saved = JSON.parse(row.data);
      const line = saved.render.body.sections[0].lines[0];
      line.text = claim;
      line.factIds = [line.factIds[0]];
      saved.facts[line.factIds[0]] = { text: factText, quote: null };
      delete saved.evidence; // An old version did not capture level provenance.
      sql.exec(`UPDATE resume_versions SET data=? WHERE resume_id=? AND version=1`, JSON.stringify(saved), resumeId);
      sql.exec(`UPDATE resumes SET body=? WHERE id=?`, JSON.stringify(saved.render.body), resumeId);
      const shared = JSON.parse(sql.exec<{ snapshot: string }>(`SELECT snapshot FROM share_grants WHERE id=?`, grant.id).one().snapshot);
      shared.resumes[0].sections[0].lines[0].text = line.text;
      sql.exec(`UPDATE share_grants SET snapshot=? WHERE id=?`, JSON.stringify(shared), grant.id);
    });
    expect((await user.json(`/api/resumes/${resumeId}`)).needsGroundingReview).toBe(true);
    for (const suffix of ["pdf", "docx", "preview"])
      expect((await user.fetch(`/api/resumes/${resumeId}/${suffix}`)).status).toBe(409);
    expect((await user.send("POST", "/api/shares", { factIds: [], resumes: [{ id: resumeId, version: 1 }] })).status).toBe(409);
    expect((await call("/share/snapshot", { cookie })).status).toBe(410);
    expect(JSON.stringify(await user.json("/api/export"))).toContain(claim);
  }, 30_000);

  it("blocks an issued detached-edit share while keeping its snapshot for its owner", async () => {
    const user = await signIn();
    const uploaded = await user.upload("synthetic.pdf", RESUME);
    const { sourceId } = await uploaded.json() as { sourceId: string };
    await waitForSource(user, sourceId);
    const { facts } = await user.json<{ facts: FactView[] }>("/api/facts");
    const { roles } = await user.json<{ roles: RoleView[] }>("/api/roles");
    expect((await user.send("POST", "/api/review", { confirm: [...facts, ...roles].map((item) => item.id), reject: [] })).status).toBe(204);
    const app = await user.send("POST", "/api/applications", { jdText: JOB_DESCRIPTION });
    const { applicationId } = await app.json() as { applicationId: string };
    const generation = await user.send("POST", `/api/applications/${applicationId}/resumes`);
    const { resumeId } = await generation.json() as { resumeId: string };
    await waitForResume(user, resumeId);
    const response = await user.send("POST", "/api/shares", { factIds: [], resumes: [{ id: resumeId, version: 1 }] });
    expect(response.status, await response.clone().text()).toBe(201);
    const { grant, url } = await response.json() as { grant: { id: string }; url: string };
    const exchange = await call("/share/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(url).hash.slice(1) }) });
    expect(exchange.status).toBe(204);
    const cookie = cookieFrom(exchange, "__Host-share")!;
    expect((await call("/share/snapshot", { cookie })).status).toBe(200);
    expect((await user.json<{ grants: { id: string; available?: boolean }[] }>("/api/shares")).grants.find((item) => item.id === grant.id)?.available).toBe(true);
    const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
    const { vid } = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { vid: string };
    await runInDurableObject(vault(env, vid), (_instance, state) => {
      const row = state.storage.sql.exec<{ snapshot: string }>(`SELECT snapshot FROM share_grants WHERE id = ?`, grant.id).one();
      const snapshot = JSON.parse(row.snapshot);
      const line = snapshot.resumes[0].sections.flatMap((section: { lines: unknown[] }) => section.lines)[0];
      line.text = "Unverified old edit";
      line.verification = "user-authored";
      snapshot.resumes[0].verification = "mixed";
      state.storage.sql.exec(`UPDATE share_grants SET snapshot = ? WHERE id = ?`, JSON.stringify(snapshot), grant.id);
    });
    expect((await call("/share/snapshot", { cookie })).status).toBe(410);
    expect((await user.json<{ grants: { id: string; available?: boolean }[] }>("/api/shares")).grants.find((item) => item.id === grant.id)?.available).toBe(false);
    const exported = await user.json<{ shares: { snapshot: unknown }[] }>("/api/export");
    expect(JSON.stringify(exported.shares)).toContain("Unverified old edit");
  }, 30_000);
});
