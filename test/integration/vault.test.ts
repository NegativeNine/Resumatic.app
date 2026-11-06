import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import { extractFacts } from "../../src/pipeline/distill";
import { MAX_UPLOAD_BYTES } from "../../src/shared/api";
import { vaultPrefix } from "../../src/shared/r2";
import { vault } from "../../src/shared/stubs";
import {
  fakeModels,
  RESUME,
  signIn,
  type FakeModelOptions,
  type User,
  waitForSource,
} from "./support";

let options: FakeModelOptions;

beforeEach(() => {
  options = { calls: {} };
  setModels(() => fakeModels(options));
});

afterEach(() => {
  setModels(null);
});

async function vaultIdOf(user: User): Promise<string> {
  const token = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  const padded = token.replace(/-/g, "+").replace(/_/g, "/");
  return (
    JSON.parse(atob(padded + "===".slice((padded.length + 3) % 4))) as {
      vid: string;
    }
  ).vid;
}

async function uploadResume(user: User): Promise<string> {
  const res = await user.upload("jane-doe.pdf", RESUME);
  expect(res.status, await res.clone().text()).toBe(201);
  const { sourceId } = (await res.json()) as { sourceId: string };
  return sourceId;
}

describe("profile", () => {
  it("starts empty and saves edits", async () => {
    const user = await signIn();
    expect(await user.json("/api/profile")).toEqual({
      revision: 1,
      name: "",
      email: "",
      phone: "",
      location: "",
      links: [],
    });
    const saved = await user.json("/api/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Jane Doe",
        links: ["https://janedoe.dev"],
      }),
    });
    expect(saved).toMatchObject({
      name: "Jane Doe",
      links: ["https://janedoe.dev"],
      email: "",
    });
  });

  it("rejects malformed input with 422", async () => {
    const user = await signIn();
    const res = await user.send("PUT", "/api/profile", { links: "not-a-list" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid" });
    const notJson = await user.fetch("/api/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(notJson.status).toBe(422);
  });
});

describe("uploads", () => {
  it("accepts only PDF and DOCX files of at most 10 MB", async () => {
    const user = await signIn();
    expect((await user.upload("notes.txt", "hello", "text/plain")).status).toBe(
      422,
    );
    expect((await user.upload("empty.pdf", "")).status).toBe(422);
    const big = await user.upload(
      "big.pdf",
      new Uint8Array(MAX_UPLOAD_BYTES + 1),
    );
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: "too_large" });
    const noFile = await user.fetch("/api/sources", {
      method: "POST",
      body: new FormData(),
    });
    expect(noFile.status).toBe(422);
    expect((await user.json("/api/sources")).sources).toEqual([]);
  });

  it("reads at most three uploads at a time", async () => {
    let release!: () => void;
    options.holdConvert = new Promise<void>((r) => (release = r));
    const user = await signIn();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await uploadResume(user));
    const fourth = await user.upload("one-more.pdf", RESUME);
    expect(fourth.status).toBe(409);
    expect(
      (await env.FILES.list({ prefix: vaultPrefix(await vaultIdOf(user)) }))
        .objects,
    ).toHaveLength(3);
    release();
    for (const id of ids)
      expect((await waitForSource(user, id)).state).toBe("ready");
    const fifth = await user.upload("one-more.pdf", RESUME);
    expect(fifth.status).toBe(201);
    await waitForSource(
      user,
      ((await fifth.json()) as { sourceId: string }).sourceId,
    );
  });

  it("stores the file under the vault's own prefix", async () => {
    const user = await signIn();
    await waitForSource(user, await uploadResume(user));
    const listed = await env.FILES.list({
      prefix: vaultPrefix(await vaultIdOf(user)),
    });
    expect(listed.objects).toHaveLength(1);
  });
});

describe("Distill", () => {
  it("proposes only facts whose quotes are in the document and whose claims the quotes support", async () => {
    const user = await signIn();
    const sourceId = await uploadResume(user);
    const source = await waitForSource(user, sourceId);
    expect(source).toMatchObject({ state: "ready", error: null, proposed: 8 });

    const { roles } = await user.json("/api/roles");
    expect(roles.map((r: { org: string }) => r.org).sort()).toEqual([
      "Acme Corp",
      "Globex",
      "State University",
    ]);
    expect(
      roles.every(
        (r: { state: string; quote: string }) =>
          r.state === "proposed" && r.quote,
      ),
    ).toBe(true);

    const { facts } = await user.json("/api/facts?state=proposed");
    const texts = facts.map((f: { text: string }) => f.text);
    expect(texts).toHaveLength(8);
    expect(texts).not.toContain(
      "Built a Go service that processes 5 million events per day",
    );
    expect(texts).not.toContain("Won the Globex innovation award");
    for (const fact of facts) {
      expect(RESUME.replace(/\s+/g, " ")).toContain(fact.quote);
      expect(fact.origin).toBe("extracted");
    }
    // The model said "owned"; the quote says "Helped", so the level is lowered.
    expect(
      facts.find((f: { text: string }) => f.text.startsWith("Helped design"))
        .level,
    ).toBe("contributed");
    expect(
      facts
        .filter((f: { kind: string }) => f.kind === "skill")
        .every(
          (f: { level: unknown; roleId: unknown }) =>
            f.level === null && f.roleId === null,
        ),
    ).toBe(true);
    expect(options.calls).toMatchObject({
      toMarkdown: 1,
      extract: 1,
      embed: 1,
    });
  });

  it("replaces its own proposals when the extract step is retried", async () => {
    const user = await signIn();
    const sourceId = await uploadResume(user);
    await waitForSource(user, sourceId);
    const { extraction } = await extractFacts(fakeModels(), RESUME);
    await vault(env, await vaultIdOf(user)).saveExtraction(
      sourceId,
      extraction,
    );
    expect((await user.json("/api/facts")).facts).toHaveLength(8);
    expect((await user.json("/api/roles")).roles).toHaveLength(3);
  });

  it("marks an upload failed when its run stopped without saying so", async () => {
    const user = await signIn();
    const vid = await vaultIdOf(user);
    await runInDurableObject(vault(env, vid), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO sources (id, filename, r2_key, state, run_id, created_at) VALUES ('stuck', 'old.pdf', 'k', 'queued', 'no-such-run', ?)`,
        Date.now() - 31 * 60 * 1000,
      );
    });
    const [source] = (await user.json("/api/sources")).sources;
    expect(source).toMatchObject({
      id: "stuck",
      state: "failed",
      error: "Reading this file stopped unexpectedly.",
    });
  });

  it("records a failure the user can read when the file cannot be read", async () => {
    options.toMarkdownError = "no text could be read from this file";
    const user = await signIn();
    const sourceId = await uploadResume(user);
    const source = await waitForSource(user, sourceId);
    expect(source.state).toBe("failed");
    expect(source.error).toBe("No text could be read from this file");
    expect((await user.json("/api/facts")).facts).toEqual([]);
  });
});

describe("review", () => {
  it("confirms facts with their roles, and rejecting a role rejects its proposed facts", async () => {
    const user = await signIn();
    await waitForSource(user, await uploadResume(user));
    const { facts } = await user.json("/api/facts");
    const { roles } = await user.json("/api/roles");
    const acme = roles.find((r: { org: string }) => r.org === "Acme Corp");
    const globex = roles.find((r: { org: string }) => r.org === "Globex");
    const acmeFact = facts.find(
      (f: { roleId: string }) => f.roleId === acme.id,
    );

    expect(
      (
        await user.send("POST", "/api/review", {
          confirm: [acmeFact.id],
          reject: [globex.id],
        })
      ).status,
    ).toBe(204);

    const after = await user.json("/api/roles");
    expect(
      after.roles.find((r: { id: string }) => r.id === acme.id).state,
    ).toBe("confirmed");
    expect(
      after.roles.find((r: { id: string }) => r.id === globex.id).state,
    ).toBe("rejected");
    const globexFacts = (await user.json("/api/facts")).facts.filter(
      (f: { roleId: string }) => f.roleId === globex.id,
    );
    expect(
      globexFacts.every((f: { state: string }) => f.state === "rejected"),
    ).toBe(true);
    expect(
      (await user.json("/api/facts?state=confirmed")).facts.map(
        (f: { id: string }) => f.id,
      ),
    ).toEqual([acmeFact.id]);
    expect(
      (await user.send("POST", "/api/review", { confirm: "all", reject: [] }))
        .status,
    ).toBe(422);
  });

  it("treats typed and edited facts as the user's own claims", async () => {
    const user = await signIn();
    await waitForSource(user, await uploadResume(user));
    const { roles } = await user.json("/api/roles");
    const acme = roles.find((r: { org: string }) => r.org === "Acme Corp");

    const created = await user.send("POST", "/api/facts", {
      roleId: acme.id,
      kind: "accomplishment",
      text: "Ran the on-call rotation for the platform team",
      level: "implemented",
    });
    expect(created.status).toBe(201);
    const { factId } = (await created.json()) as { factId: string };
    const fact = (await user.json("/api/facts")).facts.find(
      (f: { id: string }) => f.id === factId,
    );
    expect(fact).toMatchObject({
      origin: "user",
      state: "confirmed",
      quote: null,
      sourceId: null,
    });

    const extracted = (await user.json("/api/facts?state=proposed")).facts[0];
    expect(
      (
        await user.send("PATCH", `/api/facts/${extracted.id}`, {
          text: "Shortened text",
        })
      ).status,
    ).toBe(204);
    const edited = (await user.json("/api/facts")).facts.find(
      (f: { id: string }) => f.id === extracted.id,
    );
    expect(edited).toMatchObject({
      text: "Shortened text",
      origin: "user",
      quote: extracted.quote,
    });

    expect(
      (await user.send("PATCH", "/api/facts/does-not-exist", { text: "x" }))
        .status,
    ).toBe(404);
    expect(
      (
        await user.send("POST", "/api/facts", {
          roleId: null,
          kind: "accomplishment",
          text: "x".repeat(601),
          level: null,
        })
      ).status,
    ).toBe(422);
  });

  it("lets the user add a role their uploads missed, and move facts between roles", async () => {
    const user = await signIn();
    await waitForSource(user, await uploadResume(user));
    const created = await user.send("POST", "/api/roles", {
      kind: "job",
      org: "Initech",
      title: "Staff Engineer",
      startDate: "2012",
      endDate: "2014-06",
    });
    expect(created.status).toBe(201);
    const { roleId } = (await created.json()) as { roleId: string };
    const role = (await user.json("/api/roles")).roles.find(
      (r: { id: string }) => r.id === roleId,
    );
    expect(role).toMatchObject({
      org: "Initech",
      state: "confirmed",
      quote: null,
      sourceId: null,
    });

    const fact = (await user.json("/api/facts")).facts.find(
      (f: { text: string }) => f.text === "Mentored 2 junior engineers",
    );
    expect(
      (await user.send("PATCH", `/api/facts/${fact.id}`, { roleId })).status,
    ).toBe(204);
    const moved = (await user.json("/api/facts")).facts.find(
      (f: { id: string }) => f.id === fact.id,
    );
    expect(moved).toMatchObject({
      roleId,
      origin: "user",
      text: fact.text,
      quote: fact.quote,
    });

    expect(
      (
        await user.send("PATCH", `/api/facts/${fact.id}`, {
          roleId: null,
          text: "Mentored two junior engineers",
        })
      ).status,
    ).toBe(204);
    expect(
      (await user.json("/api/facts")).facts.find(
        (f: { id: string }) => f.id === fact.id,
      ),
    ).toMatchObject({
      roleId: null,
      text: "Mentored two junior engineers",
    });

    // A rejected role cannot take facts; a patch must change something; dates are a year or a year and month.
    const globex = (await user.json("/api/roles")).roles.find(
      (r: { org: string }) => r.org === "Globex",
    );
    await user.send("POST", "/api/review", {
      confirm: [],
      reject: [globex.id],
    });
    expect(
      (await user.send("PATCH", `/api/facts/${fact.id}`, { roleId: globex.id }))
        .status,
    ).toBe(422);
    expect((await user.send("PATCH", `/api/facts/${fact.id}`, {})).status).toBe(
      422,
    );
    expect(
      (
        await user.send("POST", "/api/roles", {
          kind: "job",
          org: "Hooli",
          title: null,
          startDate: "March 2020",
          endDate: null,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await user.send("POST", "/api/roles", {
          kind: "job",
          org: " ",
          title: null,
          startDate: null,
          endDate: null,
        })
      ).status,
    ).toBe(422);
  });

  it("edits a role's details", async () => {
    const user = await signIn();
    await waitForSource(user, await uploadResume(user));
    const role = (await user.json("/api/roles")).roles[0];
    expect(
      (
        await user.send("PATCH", `/api/roles/${role.id}`, {
          title: "Principal Engineer",
          endDate: "2024-01",
        })
      ).status,
    ).toBe(204);
    const after = (await user.json("/api/roles")).roles.find(
      (r: { id: string }) => r.id === role.id,
    );
    expect(after).toMatchObject({
      title: "Principal Engineer",
      endDate: "2024-01",
    });
    expect(
      (await user.send("PATCH", `/api/roles/${role.id}`, { kind: "pirate" }))
        .status,
    ).toBe(422);
  });
});

describe("isolation", () => {
  it("never shows one user another user's data", async () => {
    const alice = await signIn();
    const bob = await signIn();
    await waitForSource(alice, await uploadResume(alice));
    expect((await bob.json("/api/sources")).sources).toEqual([]);
    expect((await bob.json("/api/facts")).facts).toEqual([]);
    const aliceFact = (await alice.json("/api/facts")).facts[0];
    expect(
      (
        await bob.send("PATCH", `/api/facts/${aliceFact.id}`, {
          text: "mine now",
        })
      ).status,
    ).toBe(404);
  });
});

describe("export", () => {
  it("downloads everything in the vault as JSON", async () => {
    const user = await signIn();
    await user.send("PUT", "/api/profile", { name: "Jane Doe" });
    await waitForSource(user, await uploadResume(user));
    const res = await user.fetch("/api/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="resumatic-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const data = (await res.json()) as any;
    expect(data.profile.name).toBe("Jane Doe");
    expect(data.sources).toHaveLength(1);
    expect(data.sources[0].markdown).toBe(RESUME);
    expect(data.roles).toHaveLength(3);
    expect(data.facts).toHaveLength(8);

    // The export links to the original upload, which downloads as it was sent.
    const original = await user.fetch(data.sources[0].file);
    expect(original.status).toBe(200);
    expect(original.headers.get("content-disposition")).toBe(
      'attachment; filename="jane-doe.pdf"',
    );
    expect(new TextDecoder().decode(await original.arrayBuffer())).toBe(RESUME);
    const stranger = await signIn();
    expect((await stranger.fetch(data.sources[0].file)).status).toBe(404);
  });
});
