import { unzipSync, strFromU8 } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import type { FactView, ResumeView, RoleView } from "../../src/shared/api";
import type { ShareGrant, SharedView } from "../../src/shared/sharing";
import {
  call,
  cookieFrom,
  fakeModels,
  JOB_DESCRIPTION,
  RESUME,
  eventually,
  signIn,
  waitForResume,
  waitForSource,
} from "./support";

beforeEach(() => setModels(() => fakeModels()));
afterEach(() => setModels(null));

describe("immutable versions and selected coach snapshots", () => {
  it("preserves old versions, verifies edits, shares only selected snapshots and revokes an issued cookie", async () => {
    const user = await signIn();
    const upload = await user.upload("synthetic.pdf", RESUME);
    const source = (await upload.json()) as { sourceId: string };
    await waitForSource(user, source.sourceId);
    const { facts } = await user.json<{ facts: FactView[] }>("/api/facts");
    const { roles } = await user.json<{ roles: RoleView[] }>("/api/roles");
    expect(
      (
        await user.send("POST", "/api/review", {
          confirm: [...facts, ...roles].map((item) => item.id),
          reject: [],
        })
      ).status,
    ).toBe(204);
    const application = await user.send("POST", "/api/applications", {
      jdText: JOB_DESCRIPTION,
    });
    const { applicationId } = (await application.json()) as {
      applicationId: string;
    };
    const generation = await user.send(
      "POST",
      `/api/applications/${applicationId}/resumes`,
    );
    const { resumeId } = (await generation.json()) as { resumeId: string };
    const original = (await waitForResume(user, resumeId)) as ResumeView;
    expect(original.state).toBe("ready");
    const lines = original.body!.sections.flatMap(
      (section) => section.lines,
    );
    const line = lines.find((item) => item.factIds.length && item.factIds.every(
      (id) => lines.every((other) => other.id === item.id || !other.factIds.includes(id)) &&
        !(original.body!.summary?.factIds ?? []).includes(id),
    ))!;
    expect(line).toBeDefined();
    const editedText = line.text.endsWith(".") ? line.text.slice(0, -1) : `${line.text}.`;
    expect(
      (
        await user.send("PATCH", `/api/resumes/${resumeId}/lines/${line.id}`, {
          text: editedText,
          expectedVersion: 1,
        })
      ).status,
    ).toBe(409);
    const editResponse = await user.send("POST", `/api/applications/${applicationId}/documents`, {
      kind: "refine", resumeId, expectedVersion: 1, lineIds: [line.id], manualText: editedText,
    });
    expect(editResponse.status, await editResponse.clone().text()).toBe(202);
    const { documentId } = await editResponse.json() as { documentId: string };
    const completed = await eventually(async () => {
      const document = await user.json<{ state: string; error: string | null }>(`/api/documents/${documentId}`);
      return document.state === "running" ? null : document;
    }, "verified edit");
    expect(completed).toMatchObject({ state: "ready" });
    const edited = await user.json<ResumeView>(`/api/resumes/${resumeId}`);
    expect(edited.version).toBe(2);
    expect(
      edited
        .body!.sections.flatMap((section) => section.lines)
        .find((item) => item.id === line.id),
    ).toMatchObject({ text: editedText, status: "kept", factIds: line.factIds });
    expect(
      (await user.json<ResumeView>(`/api/resumes/${resumeId}?version=1`)).body,
    ).toEqual(original.body);
    const docx = await user.fetch(`/api/resumes/${resumeId}/docx?version=2`);
    expect(docx.status).toBe(200);
    expect(
      strFromU8(
        unzipSync(new Uint8Array(await docx.arrayBuffer()))[
          "word/document.xml"
        ]!,
      ),
    ).toContain(editedText);
    const chosen = facts.find((fact) => fact.kind === "skill")!;
    const shared = await user.send("POST", "/api/shares", {
      factIds: [chosen.id],
      resumes: [{ id: resumeId, version: 2 }],
    });
    expect(shared.status, await shared.clone().text()).toBe(201);
    const { grant, url } = (await shared.json()) as {
      grant: ShareGrant;
      url: string;
    };
    const link = new URL(url);
    expect(link.pathname).toBe("/share");
    expect(link.search).toBe("");
    const exchange = await call("/share/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: link.hash.slice(1) }),
    });
    expect(exchange.status).toBe(200);
    expect(await exchange.json()).toEqual({ grantId: grant.id });
    const coachCookie = cookieFrom(exchange, "__Host-share")!;
    const snapshot = await call("/share/snapshot", { cookie: coachCookie });
    const before = (await snapshot.json()) as SharedView;
    expect(before.snapshot.facts.map((fact) => fact.id)).toEqual([chosen.id]);
    expect(
      before.snapshot.resumes[0]!.sections.flatMap(
        (section) => section.lines,
      ).find((item) => item.id === line.id),
    ).toMatchObject({ text: editedText, verification: "verified" });
    expect(JSON.stringify(before)).not.toContain('"quote"');
    expect(JSON.stringify(before)).not.toContain('"factIds"');
    await user.send("PATCH", `/api/facts/${chosen.id}`, {
      text: "Changed later",
    });
    await user.send("PATCH", `/api/resumes/${resumeId}/lines/${line.id}`, {
      text: "Changed after sharing",
      expectedVersion: 2,
    });
    expect(
      await (await call("/share/snapshot", { cookie: coachCookie })).json(),
    ).toEqual(before);
    const stranger = await signIn();
    expect(
      (
        await stranger.send("POST", "/api/shares", {
          factIds: [chosen.id],
          resumes: [],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("/api/me", {
          cookie: `__Host-session=${link.hash.slice(1)}`,
        })
      ).status,
    ).toBe(401);
    const exported = await user.json<{
      shares: { snapshot: SharedView["snapshot"] | null }[];
    }>("/api/export");
    expect(exported.shares[0]?.snapshot).toEqual(before.snapshot);
    expect((await user.send("DELETE", `/api/shares/${grant.id}`)).status).toBe(
      204,
    );
    expect(
      (await call("/share/snapshot", { cookie: coachCookie })).status,
    ).toBe(410);
    expect(
      (
        await call("/share/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: link.hash.slice(1) }),
        })
      ).status,
    ).toBe(410);
  });
});
