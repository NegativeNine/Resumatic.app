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
