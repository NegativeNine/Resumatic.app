import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModels } from "../../src/ai/models";
import { Vault } from "../../src/vault/vault";
import { vault } from "../../src/shared/stubs";
import type { FactView } from "../../src/shared/api";
import {
  eventually,
  fakeModels,
  RESUME,
  signIn,
  waitForSource,
  type FakeModelOptions,
  type User,
} from "./support";

let options: FakeModelOptions;
beforeEach(() => {
  options = { calls: {} };
  setModels(() => fakeModels(options));
});
afterEach(() => {
  setModels(null);
  vi.restoreAllMocks();
});

function session(user: User): { uid: string; vid: string; gen: number } {
  const body = user.cookie
    .slice("__Host-session=".length)
    .split(".")[0]!
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return JSON.parse(atob(body + "===".slice((body.length + 3) % 4)));
}
async function upload(user: User, text = RESUME): Promise<string> {
  const response = await user.upload("synthetic.pdf", text);
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { sourceId: string }).sourceId;
}

describe("extraction commit integrity", () => {
  it("reuses saved conversion and extraction after lost acknowledgements, preserving intervening review", async () => {
    const saveSource = Vault.prototype.saveSource;
    const saveExtraction = Vault.prototype.saveExtraction;
    let lostConversion = false;
    let lostExtraction = false;
    vi.spyOn(Vault.prototype, "saveSource").mockImplementation(async function (
      this: Vault,
      ...args
    ) {
      await saveSource.apply(this, args);
      if (args[1].markdown !== undefined && !lostConversion) {
        lostConversion = true;
        throw new Error("synthetic_lost_conversion_acknowledgement");
      }
    });
    vi.spyOn(Vault.prototype, "saveExtraction").mockImplementation(
      async function (this: Vault, ...args) {
        const result = await saveExtraction.apply(this, args);
        if (!lostExtraction) {
          lostExtraction = true;
          throw new Error("synthetic_lost_extraction_acknowledgement");
        }
        return result;
      },
    );
    const user = await signIn();
    const sourceId = await upload(user);
    await eventually(
      async () => lostExtraction,
      "the extraction commit before its lost acknowledgement",
    );
    const { facts } = await user.json<{ facts: FactView[] }>("/api/facts");
    expect(facts).toHaveLength(9);
    const reviewed = facts[0]!;
    expect(
      (
        await user.send("POST", "/api/review", {
          confirm: [reviewed.id],
          reject: [],
          expectedRevisions: { [reviewed.id]: reviewed.revision },
        })
      ).status,
    ).toBe(204);
    expect(await waitForSource(user, sourceId)).toMatchObject({
      state: "ready",
      proposed: 8,
    });
    const after = (await user.json<{ facts: FactView[] }>("/api/facts")).facts;
    expect(after.map((fact) => fact.id).sort()).toEqual(
      facts.map((fact) => fact.id).sort(),
    );
    expect(after.find((fact) => fact.id === reviewed.id)?.state).toBe(
      "confirmed",
    );
    expect(options.calls).toMatchObject({
      toMarkdown: 1,
      extract: 1,
      embed: 1,
    });
    const progress = await vault(env, session(user).vid).sourceProgress(
      sourceId,
      sourceId,
    );
    expect(progress.convertedChars).toBe(RESUME.length);
    expect(progress.extraction).toMatchObject({ roles: 3, facts: 9 });
    expect(progress.extraction!.dropped).toBeGreaterThan(0);
    expect(progress.extractor).toBe(`llm:${env.MODEL_EXTRACT}`);
  }, 25_000);

  it("stores exact UTF-16 source offsets and leaves the converted revision immutable", async () => {
    const user = await signIn();
    const markdown = `🧑‍💻 Synthetic candidate\r\n${RESUME}`;
    const sourceId = await upload(user, markdown);
    expect((await waitForSource(user, sourceId)).state).toBe("ready");
    const evidence = await user.json<{
      markdown: string;
      revisionId: string;
      origin: string;
    }>(`/api/sources/${sourceId}/text`);
    expect(evidence).toEqual({
      markdown,
      revisionId: `${sourceId}:1`,
      origin: "upload",
    });
    const facts = (await user.json<{ facts: FactView[] }>("/api/facts")).facts;
    for (const fact of facts) {
      expect(fact.span).toBeTruthy();
      expect(markdown.slice(...fact.span!)).toBe(fact.quote);
    }
    await vault(env, session(user).vid).saveSource(sourceId, {
      markdown: "replacement text",
    });
    expect(await user.json(`/api/sources/${sourceId}/text`)).toEqual(evidence);
  });

  it("stores image transcription as a separate source and marks all of its evidence", async () => {
    let transcriptions = 0;
    setModels(() => ({
      ...fakeModels(options),
      transcribePages: async () => {
        transcriptions++;
        return { markdown: RESUME };
      },
    }));
    const user = await signIn();
    const originalId = await upload(user);
    await waitForSource(user, originalId);
    const { uid, vid, gen } = session(user);
    // A tiny synthetic PNG header: no image or network service is called by this fake.
    const bytes = new Uint8Array(24);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    bytes.set([73, 72, 68, 82], 12);
    new DataView(bytes.buffer).setUint32(16, 1);
    new DataView(bytes.buffer).setUint32(20, 1);
    const key = `vaults/${vid}/sources/synthetic.ocr.json`;
    await env.FILES.put(
      key,
      JSON.stringify({
        images: [
          {
            mimeType: "image/png",
            base64: btoa(String.fromCharCode(...bytes)),
          },
          {
            mimeType: "image/png",
            base64: btoa(String.fromCharCode(...bytes)),
          },
        ],
        referenceDate: "2026-11-06",
      }),
    );
    const { sourceId } = await vault(env, vid).addSource(
      { userId: uid, gen },
      {
        filename: "synthetic.pdf (image transcription)",
        r2Key: key,
        origin: "ocr",
        parentSourceId: originalId,
      },
    );
    expect((await waitForSource(user, sourceId)).state).toBe("ready");
    expect(transcriptions).toBe(1);
    const listed = (
      await user.json<{ sources: import("../../src/shared/api").SourceView[] }>(
        "/api/sources",
      )
    ).sources;
    expect(listed.find((s) => s.id === sourceId)?.conversionImageCount).toBe(2);
    expect(
      listed.find((s) => s.id === originalId)?.conversionImageCount,
    ).toBeNull();
    expect(options.calls?.toMarkdown).toBe(1);
    expect((await user.json(`/api/sources/${originalId}/text`)).origin).toBe(
      "upload",
    );
    const evidence = await user.json(`/api/sources/${sourceId}/text`);
    expect(evidence).toMatchObject({ origin: "ocr", markdown: RESUME });
    const facts = (
      await user.json<{ facts: FactView[] }>("/api/facts")
    ).facts.filter((fact) => fact.sourceId === sourceId);
    expect(facts).toHaveLength(9);
    for (const fact of facts) {
      expect(fact.evidenceOrigin).toBe("ocr");
      expect(RESUME.slice(...fact.span!)).toBe(fact.quote);
    }
  });
});
