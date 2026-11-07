import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { vault } from "../../src/shared/stubs";
import { RunStore } from "../../src/vault/runs";
import { readSession } from "../../src/worker/session";
import { linkedInDocument } from "../../src/pipeline/linkedin";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModels, type Models } from "../../src/ai/models";
import { Vault } from "../../src/vault/vault";
import type { FactView, RoleView } from "../../src/shared/api";
import { fakeModels, signIn, waitForSource } from "./support";

let calls = 0;
function models(): Models {
  const base = fakeModels();
  return {
    ...base,
    async complete(route, messages, schema, options) {
      if (route === "extract") {
        calls++;
        const message = messages.findLast(
          (item) => item.role === "user",
        )!.content;
        const text = /^<resume>\n([\s\S]*)\n<\/resume>$/.exec(message)?.[1];
        if (!text) throw new Error("missing description");
        return schema.parse({
          roles: [],
          facts: [
            {
              roleKey: "wrong-role",
              kind: "accomplishment",
              text,
              quote: text,
              level: null,
            },
          ],
        });
      }
      return base.complete(route, messages, schema, options);
    },
  };
}
beforeEach(() => {
  calls = 0;
  setModels(() => models());
});
afterEach(() => {
  setModels(null);
  vi.restoreAllMocks();
});

describe("LinkedIn import workflow", () => {
  it("persists deterministic roles and per-row evidence, and does not re-extract after a lost save acknowledgement", async () => {
    const original = Vault.prototype.saveExtraction;
    let lost = false;
    vi.spyOn(Vault.prototype, "saveExtraction").mockImplementation(
      async function (this: Vault, ...args) {
        const result = await original.apply(this, args);
        if (!lost) {
          lost = true;
          throw new Error("synthetic_lost_extraction_acknowledgement");
        }
        return result;
      },
    );
    const archive = zipSync({
      "Positions.csv": strToU8(
        "Company Name,Title,Description,Started On,Finished On\nAcme,Engineer,Built 12 Go APIs,Mar 2021,Present\nGlobex,Lead,Built 12 Go APIs,2018,2020",
      ),
      "Skills.csv": strToU8("Name\nGo"),
      "Messages.csv": strToU8("private-message-marker"),
    });
    const user = await signIn();
    const upload = await user.upload(
      "linkedin.zip",
      archive,
      "application/zip",
    );
    expect(upload.status, await upload.clone().text()).toBe(201);
    const { sourceId } = (await upload.json()) as { sourceId: string };
    expect(await waitForSource(user, sourceId)).toMatchObject({
      state: "ready",
      proposed: 3,
    });
    expect(lost).toBe(true);
    expect(calls).toBe(2);
    const roles = (await user.json<{ roles: RoleView[] }>("/api/roles")).roles;
    const facts = (await user.json<{ facts: FactView[] }>("/api/facts")).facts;
    const markdown = (
      await user.json<{ markdown: string }>(`/api/sources/${sourceId}/text`)
    ).markdown;
    expect(markdown).not.toContain("private-message-marker");
    expect(roles.map((r) => r.org).sort()).toEqual(["Acme", "Globex"]);
    expect(roles.find((r) => r.org === "Acme")).toMatchObject({
      title: "Engineer",
      startDate: "2021-03",
      endDate: null,
      state: "proposed",
    });
    const accomplishments = facts.filter((f) => f.kind === "accomplishment");
    expect(accomplishments).toHaveLength(2);
    expect(
      accomplishments
        .map((f) => roles.find((r) => r.id === f.roleId)?.org)
        .sort(),
    ).toEqual(["Acme", "Globex"]);
    for (const item of [...roles, ...facts])
      expect(markdown.slice(...item.span!)).toBe(item.quote);
    expect(facts.find((f) => f.kind === "skill")).toMatchObject({
      text: "Go",
      roleId: null,
      state: "proposed",
    });
  }, 25000);
  it("extracts an already frozen legacy column-order source without changing its text", async () => {
    const archive = zipSync({
      "Positions.csv": strToU8(
        "Company Name,Description,Title,Started On,Finished On\nAcme,Built 12 Go APIs,Engineer,2020,2022",
      ),
    });
    const markdown = linkedInDocument(archive, "legacy").markdown;
    expect(linkedInDocument(archive).markdown).not.toBe(markdown);
    const user = await signIn();
    const signed = await readSession(
      env.SESSION_KEY,
      user.cookie.slice(user.cookie.indexOf("=") + 1),
    );
    expect(signed).not.toBeNull();
    const sourceId = crypto.randomUUID();
    const key = `vaults/${signed!.vid}/sources/${sourceId}`;
    await env.FILES.put(key, archive);
    await runInDurableObject(vault(env, signed!.vid), (_instance, state) => {
      const sql = state.storage.sql;
      const runs = new RunStore(sql, (fn) => state.storage.transactionSync(fn));
      runs.begin(
        {
          id: sourceId,
          kind: "distill",
          targetId: sourceId,
          requestKey: `legacy:${sourceId}`,
          inputDigest: sourceId,
          steps: ["convert", "extract", "embed"],
        },
        () => {
          sql.exec(
            `INSERT INTO sources (id,filename,r2_key,markdown,state,run_id,created_at,extractor) VALUES (?, 'linkedin.zip', ?, ?, 'queued', ?, ?, ?)`,
            sourceId,
            key,
            markdown,
            sourceId,
            Date.now(),
            `llm:${env.MODEL_EXTRACT}`,
          );
          sql.exec(
            `INSERT INTO source_revisions (id,source_id,markdown,created_at) VALUES (?,?,?,?)`,
            `${sourceId}:1`,
            sourceId,
            markdown,
            Date.now(),
          );
        },
      );
      runs.claim(sourceId);
      runs.commitStep(sourceId, "convert", () => {});
    });
    await env.DISTILL.create({
      id: sourceId,
      params: { vaultId: signed!.vid, sourceId },
    });
    expect(await waitForSource(user, sourceId)).toMatchObject({
      state: "ready",
      proposed: 1,
    });
    expect((await user.json(`/api/sources/${sourceId}/text`)).markdown).toBe(
      markdown,
    );
    expect(
      (await user.json<{ roles: RoleView[] }>("/api/roles")).roles[0],
    ).toMatchObject({
      org: "Acme",
      title: "Engineer",
      startDate: "2020",
      endDate: "2022",
    });
    expect(calls).toBe(1);
  });
});
