import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { vault } from "../../src/shared/stubs";
import { fromBase64url } from "../../src/worker/crypto";
import { call, signIn } from "./support";

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
          units: [
            { id: "u1", roleId: "role-a", text: kind === "refine" ? "Uncited historical text" : "Built one service.", factIds: kind === "refine" ? [] : ["f1"], status: kind === "refine" ? "edited" : "kept", group: 0 },
            { id: "u2", roleId: "role-b", text: "Improved reliability & speed.", factIds: ["f1"], status: "kept", group: 0 },
            { id: "u3", roleId: null, text: "I welcome the opportunity.", factIds: ["f1"], status: "kept", group: 1 },
          ],
          questions: [{ id: "q1", requirement: "synthetic", question: "Synthetic question?" }],
          report: { kept: 0, repaired: 0, replaced: 0, dropped: 0, gaps: [] },
        };
        state.storage.sql.exec(
          "INSERT INTO documents (id, application_id, kind, state, version, created_at) VALUES (?, ?, ?, 'ready', 1, ?)",
          id, "synthetic-application", kind, Date.now(),
        );
        state.storage.sql.exec(
          "INSERT INTO document_versions (document_id, version, data, created_at) VALUES (?, 1, ?, ?)",
          id, JSON.stringify({ result, facts: { f1: { text: "Built one service", quote: "Private evidence https://example.test/private" } } }), Date.now(),
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
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-disposition")).toContain(kind === "letter" ? "cover-letter.docx" : "interview-preparation.docx");
      const zip = unzipSync(new Uint8Array(await response.arrayBuffer()));
      const xml = strFromU8(zip["word/document.xml"]!);
      expect(xml).toContain("Built one service");
      expect(xml).not.toContain("Private evidence");
      expect(xml).not.toContain("https://example.test/private");
      if (kind === "letter") {
        expect(xml).toContain("Built one service. Improved reliability &amp; speed.");
        expect(xml).toContain("I welcome the opportunity.");
        expect(xml.indexOf("Built one service.")).toBeLessThan(xml.indexOf("I welcome the opportunity."));
      }
      if (kind === "prep") expect(xml).toContain("Synthetic question?");
    }
    expect((await call(`/api/documents/${ids.letter}/docx`)).ok).toBe(false);
    const stranger = await signIn();
    expect((await stranger.fetch(`/api/documents/${ids.letter}/docx`)).ok).toBe(false);
    // A stored result cannot be downloaded while its run is incomplete or cancelled.
    for (const state of ["running", "failed"]) {
      await runInDurableObject(vault(env, vid), (_instance, objectState) => {
        objectState.storage.sql.exec("UPDATE documents SET state = ? WHERE id = ?", state, ids.letter);
      });
      const response = await user.fetch(`/api/documents/${ids.letter}/docx`);
      expect(response.status).toBe(409);
      expect(response.headers.get("content-type")).not.toContain("wordprocessingml");
    }
  });
});
