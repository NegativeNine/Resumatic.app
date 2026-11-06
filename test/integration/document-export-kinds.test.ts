import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";
import { fromBase64url } from "../../src/worker/crypto";
import { signIn } from "./support";

describe("document DOCX export", () => {
  it("exports only cover letters and interview preparation, never refinement or questions", async () => {
    const user = await signIn();
    const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
    const { vid } = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as { vid: string };
    const ids = Object.fromEntries(["refine", "questions", "letter", "prep"].map((kind) => [kind, crypto.randomUUID()]));
    await runInDurableObject(vault(env, vid), (_instance, state) => {
      for (const [kind, id] of Object.entries(ids)) {
        const result = {
          kind,
          units: [{ id: "u1", roleId: null, text: kind === "refine" ? "Uncited historical text" : "Built one service", factIds: kind === "refine" ? [] : ["f1"], status: kind === "refine" ? "edited" : "kept", group: 0 }],
          questions: [{ id: "q1", requirement: "synthetic", question: "Synthetic question?" }],
          report: { kept: 0, repaired: 0, replaced: 0, dropped: 0, gaps: [] },
        };
        state.storage.sql.exec(
          "INSERT INTO documents (id, application_id, kind, state, version, created_at) VALUES (?, ?, ?, 'ready', 1, ?)",
          id, "synthetic-application", kind, Date.now(),
        );
        state.storage.sql.exec(
          "INSERT INTO document_versions (document_id, version, data, created_at) VALUES (?, 1, ?, ?)",
          id, JSON.stringify({ result, facts: { f1: { text: "Built one service", quote: "Built one service" } } }), Date.now(),
        );
      }
    });
    for (const kind of ["refine", "questions"]) {
      const response = await user.fetch(`/api/documents/${ids[kind]}/docx`);
      expect(response.status).toBe(422);
      expect(response.headers.get("content-type")).not.toContain("wordprocessingml");
    }
    for (const kind of ["letter", "prep"]) {
      const response = await user.fetch(`/api/documents/${ids[kind]}/docx`);
      expect(response.status).toBe(200);
      const zip = unzipSync(new Uint8Array(await response.arrayBuffer()));
      const xml = strFromU8(zip["word/document.xml"]!);
      expect(xml).toContain("Built one service");
      if (kind === "prep") expect(xml).toContain("Synthetic question?");
    }
    const stranger = await signIn();
    expect((await stranger.fetch(`/api/documents/${ids.letter}/docx`)).ok).toBe(false);
  });
});
