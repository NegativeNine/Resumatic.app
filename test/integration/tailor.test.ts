import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModels } from "../../src/ai/models";
import { setPdfRenderer } from "../../src/render/pdf";
import { docxKey, pdfKey, vaultPrefix } from "../../src/shared/r2";
import { vault } from "../../src/shared/stubs";
import { snapshotCacheKey } from "../../src/worker/vault-export-cache";
import {
  JOB_DESCRIPTION,
  RESUME,
  fakeModels,
  signIn,
  waitForResume,
  waitForSource,
  type FakeModelOptions,
  type User,
} from "./support";

let options: FakeModelOptions;
let rendered: string[];

beforeEach(() => {
  options = { calls: {} };
  rendered = [];
  setModels(() => fakeModels(options));
  setPdfRenderer(async (_env, html) => {
    rendered.push(html);
    return new TextEncoder().encode(`%PDF-1.7 fake ${rendered.length}`);
  });
});

afterEach(() => {
  setModels(null);
  setPdfRenderer(null);
});

/** A user whose fixture resume has been read and every proposal confirmed. */
async function readyUser(): Promise<User> {
  const user = await signIn();
  const res = await user.upload("jane-doe.pdf", RESUME);
  const { sourceId } = (await res.json()) as { sourceId: string };
  await waitForSource(user, sourceId);
  const { facts } = await user.json("/api/facts");
  const { roles } = await user.json("/api/roles");
  const confirm = [
    ...facts.map((f: { id: string }) => f.id),
    ...roles.map((r: { id: string }) => r.id),
  ];
  expect(
    (await user.send("POST", "/api/review", { confirm, reject: [] })).status,
  ).toBe(204);
  return user;
}

async function newApplication(user: User): Promise<string> {
  const res = await user.send("POST", "/api/applications", {
    jdText: JOB_DESCRIPTION,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { applicationId: string }).applicationId;
}

async function bytesOf(res: Response): Promise<string> {
  return new TextDecoder().decode(await res.arrayBuffer());
}

async function startTailor(
  user: User,
  applicationId: string,
): Promise<Response> {
  return user.send("POST", `/api/applications/${applicationId}/resumes`);
}

async function tailor(user: User, applicationId: string): Promise<any> {
  const res = await startTailor(user, applicationId);
  expect(res.status, await res.clone().text()).toBe(202);
  const { resumeId } = (await res.json()) as { resumeId: string };
  return waitForResume(user, resumeId);
}

describe("Tailor", () => {
  it("writes only verified lines, and reports what it repaired, replaced, dropped and could not cover", async () => {
    options.summary = {
      text: "Led the migration of 40 services to Kubernetes and built a Go service",
      cites: [
        "Led the migration of 40 services to Kubernetes, cutting deploy time by 60%",
        "Built a Go service that processes 2 million events per day",
      ],
    };
    options.rewrites = {
      // Fails the number check, then is repaired.
      "Led the migration of 40 services to Kubernetes, cutting deploy time by 60%":
        "Cut deploy time by 75% by migrating services to Kubernetes",
      // Passes the checks but not the judge, twice; replaced by the fact itself.
      "Built a Go service that processes 2 million events per day":
        "Built a Go service that processes 2 million events per day for synergy",
    };
    options.repairs = {
      "Cut deploy time by 75% by migrating services to Kubernetes":
        "Cut deploy time by 60% by moving services to Kubernetes",
    };
    options.judgeRejects = ["synergy"];
    options.extraLines = [
      // Cites a fact from another role: cannot be repaired or replaced, so it is dropped.
      {
        under: "Led the migration of 40 services to Kubernetes, cutting deploy time by 60%",
        text: "Mentored 2 junior engineers on Kubernetes",
        cites: ["Mentored 2 junior engineers"],
      },
      // Cites a fact that does not exist: discarded before verification.
      {
        under: "Led the migration of 40 services to Kubernetes, cutting deploy time by 60%",
        text: "Won three industry awards",
        cites: ["Nothing like this"],
      },
    ];

    const user = await readyUser();
    const applicationId = await newApplication(user);
    const resume = await tailor(user, applicationId);

    expect(resume.state, resume.error).toBe("ready");
    expect(resume.report).toEqual({
      kept: 4,
      repaired: 1,
      replaced: 1,
      dropped: 1,
      gaps: ["Rust systems programming"],
    });

    const body = resume.body;
    expect(body.summary).toMatchObject({
      status: "kept",
      text: options.summary.text,
    });
    expect(body.sections.map((s: { org: string }) => s.org)).toEqual([
      "Acme Corp",
      "Globex",
      "State University",
    ]);
    const acme = body.sections[0].lines.map(
      (l: { text: string; status: string }) => `${l.status}: ${l.text}`,
    );
    expect(acme.sort()).toEqual([
      "kept: Helped design the billing API used by 3 product teams",
      "repaired: Cut deploy time by 60% by moving services to Kubernetes",
      "replaced: Built a Go service that processes 2 million events per day",
    ]);
    expect(body.sections[2]).toMatchObject({ kind: "education", lines: [] });
    expect(body.skills.sort()).toEqual(["Go", "Kubernetes", "PostgreSQL"]);

    // Every printed line cites facts, and the view carries each fact's quote for the evidence panel.
    const lines = [
      body.summary,
      ...body.sections.flatMap((s: { lines: unknown[] }) => s.lines),
    ];
    for (const line of lines) {
      expect(line.factIds.length).toBeGreaterThan(0);
      for (const id of line.factIds)
        expect(resume.facts[id]?.quote).toBeTruthy();
    }
    const text = JSON.stringify(body);
    for (const invented of ["75%", "synergy", "Won three", 'on Kubernetes"'])
      expect(text).not.toContain(invented);

    // The view carries the contact details this version prints, so the sheet in the app matches its PDF.
    expect(resume.profile).toEqual(await user.json("/api/profile"));

    const { applications } = await user.json("/api/applications");
    expect(applications[0]).toMatchObject({
      id: applicationId,
      company: "Initrode",
      title: "Platform Engineer",
    });
    expect((await user.json("/api/me")).quota.used).toBe(1);
  });

  it("fails clearly, and refunds the quota, when no facts are confirmed", async () => {
    const user = await signIn();
    const applicationId = await newApplication(user);
    const resume = await tailor(user, applicationId);
    expect(resume.state).toBe("failed");
    expect(resume.error).toBe("Confirm some facts before tailoring a resume");
    expect(resume.body).toBeNull();
    expect((await user.json("/api/me")).quota.used).toBe(0);
  });

  it("runs one tailoring at a time per user", async () => {
    let release!: () => void;
    options.hold = new Promise<void>((r) => (release = r));
    const user = await readyUser();
    const applicationId = await newApplication(user);
    const first = await startTailor(user, applicationId);
    expect(first.status).toBe(202);
    const second = await startTailor(user, applicationId);
    expect(second.status).toBe(409);
    release();
    const { resumeId } = (await first.json()) as { resumeId: string };
    expect((await waitForResume(user, resumeId)).state).toBe("ready");
  });

  it("enforces the monthly quota", async () => {
    const user = await readyUser();
    const applicationId = await newApplication(user);
    for (let i = 0; i < 3; i++)
      expect((await tailor(user, applicationId)).state).toBe("ready");
    const res = await startTailor(user, applicationId);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("quota");
    expect(body.message).toMatch(
      /^you have used all 3 tailored resumes for this month; more on [A-Z][a-z]+ 1$/,
    );
    // The analysis is reused for later resumes of the same application.
    expect(options.calls?.analyze).toBe(1);
  });

  it("names a job by the start of its description until it has been analyzed", async () => {
    const user = await signIn();
    await newApplication(user);
    const [job] = (await user.json("/api/applications")).applications;
    expect(job).toMatchObject({ company: null, title: null, resumes: [] });
    expect(job.excerpt).toMatch(
      /^Platform Engineer at Initrode We are looking for .*…$/,
    );
    expect(job.excerpt.length).toBeLessThanOrEqual(101);
  });

  it("validates job descriptions", async () => {
    const user = await signIn();
    expect(
      (await user.send("POST", "/api/applications", { jdText: "too short" }))
        .status,
    ).toBe(422);
    expect(
      (
        await user.send("POST", "/api/applications", {
          jdText: "x".repeat(20_001),
        })
      ).status,
    ).toBe(422);
    expect(
      (await user.send("POST", "/api/applications/nope/resumes")).status,
    ).toBe(404);
  });
});

describe("roles and facts the user adds", () => {
  it("are printed like extracted ones", async () => {
    const user = await signIn();
    const { roleId } = (await (
      await user.send("POST", "/api/roles", {
        kind: "job",
        org: "Initech",
        title: "Staff Engineer",
        startDate: "2019-01",
        endDate: null,
      })
    ).json()) as {
      roleId: string;
    };
    for (const text of [
      "Ran Kubernetes clusters for the payments team",
      "Built React dashboards for support agents",
    ]) {
      expect(
        (
          await user.send("POST", "/api/facts", {
            roleId,
            kind: "accomplishment",
            text,
            level: "implemented",
          })
        ).status,
      ).toBe(201);
    }
    const resume = await tailor(user, await newApplication(user));
    expect(resume.state, resume.error).toBe("ready");
    expect(resume.body.sections).toHaveLength(1);
    expect(resume.body.sections[0]).toMatchObject({
      org: "Initech",
      title: "Staff Engineer",
    });
    expect(
      resume.body.sections[0].lines.map((l: { text: string }) => l.text).sort(),
    ).toEqual([
      "Built React dashboards for support agents",
      "Ran Kubernetes clusters for the payments team",
    ]);
    // A typed fact has no quote; the evidence panel shows the fact alone.
    for (const line of resume.body.sections[0].lines)
      expect(resume.facts[line.factIds[0]]).toMatchObject({ quote: null });
  });
});

describe("editing and PDF export", () => {
  it("serves an existing PDF in shared pilot mode but blocks a new Browser Run request", async () => {
    const user = await readyUser();
    const resume = await tailor(user, await newApplication(user));
    expect(await bytesOf(await user.fetch(`/api/resumes/${resume.id}/pdf`))).toBe("%PDF-1.7 fake 1");
    const vid = JSON.parse(
      atob(user.cookie.slice("__Host-session=".length).split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")),
    ).vid;
    const legacyKey = pdfKey(vid, resume.id, resume.version, resume.body.sections.some((s: { unknownEndStartDate?: string }) => !!s.unknownEndStartDate));
    expect((await env.FILES.list({ prefix: `${vaultPrefix(vid)}exports/` })).objects).toHaveLength(0);
    const previous = env.PILOT_SHARED_BUDGET;
    try {
      env.PILOT_SHARED_BUDGET = "true";
      expect(await bytesOf(await user.fetch(`/api/resumes/${resume.id}/pdf`))).toBe("%PDF-1.7 fake 1");
      expect(rendered).toHaveLength(1);
      await runInDurableObject(vault(env, vid), (_instance, state) => {
        state.storage.sql.exec(`DELETE FROM export_cache_chunks`);
        state.storage.sql.exec(`DELETE FROM export_cache`);
      });
      await env.FILES.put(legacyKey, new TextEncoder().encode("%PDF-1.7 historical"));
      const response = await user.fetch(`/api/resumes/${resume.id}/pdf`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "unavailable" });
      expect(rendered).toHaveLength(1);
      await env.FILES.delete(legacyKey);
    } finally {
      env.PILOT_SHARED_BUDGET = previous;
    }
  });

  it("caches PDF and DOCX in the Vault without any new R2 writes", async () => {
    const user = await readyUser();
    const resume = await tailor(user, await newApplication(user));
    const vid = JSON.parse(atob(user.cookie.slice("__Host-session=".length).split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"))).vid;
    const put = vi.spyOn(env.FILES, "put");
    try {
      const pdf = await user.fetch(`/api/resumes/${resume.id}/pdf`);
      expect(pdf.status).toBe(200);
      expect(await bytesOf(pdf)).toBe("%PDF-1.7 fake 1");
      expect(await bytesOf(await user.fetch(`/api/resumes/${resume.id}/pdf`))).toBe("%PDF-1.7 fake 1");
      expect(rendered).toHaveLength(1);
      const first = await user.fetch(`/api/resumes/${resume.id}/docx`);
      expect(first.status).toBe(200);
      const expected = new Uint8Array(await first.arrayBuffer());
      const second = await user.fetch(`/api/resumes/${resume.id}/docx`);
      expect(second.status).toBe(200);
      expect(new Uint8Array(await second.arrayBuffer())).toEqual(expected);
      expect(put).not.toHaveBeenCalled();
      await runInDurableObject(vault(env, vid), (_instance, state) => {
        expect(state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM export_cache`).one().count).toBe(2);
      });
    } finally { put.mockRestore(); }
  });

  it("regenerates PDF and DOCX instead of serving unbound historical cache entries", async () => {
    const user = await readyUser();
    const resume = await tailor(user, await newApplication(user));
    const session = JSON.parse(atob(user.cookie.slice("__Host-session=".length).split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")));
    const vid = session.vid;
    const unknown = resume.body.sections.some((s: { unknownEndStartDate?: string }) => !!s.unknownEndStartDate);
    const pdf = pdfKey(vid, resume.id, resume.version, unknown), docx = docxKey(vid, resume.id, resume.version, unknown);
    await env.FILES.put(pdf, new TextEncoder().encode("historical-pdf"));
    await env.FILES.put(docx, new TextEncoder().encode("historical-docx"));
    const who = { userId: session.uid, gen: session.gen, epoch: session.epoch };
    await vault(env, vid).putExportCache(who, pdf, new TextEncoder().encode("unbound-vault-pdf"));
    await vault(env, vid).putExportCache(who, docx, new TextEncoder().encode("unbound-vault-docx"));
    const put = vi.spyOn(env.FILES, "put");
    try {
      expect(await bytesOf(await user.fetch(`/api/resumes/${resume.id}/pdf`))).toBe("%PDF-1.7 fake 1");
      const word = new Uint8Array(await (await user.fetch(`/api/resumes/${resume.id}/docx`)).arrayBuffer());
      expect(word.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
      expect(put).not.toHaveBeenCalled();
      expect(rendered).toHaveLength(1);
    } finally { put.mockRestore(); }
  });

  it("does not reuse cached output when the render snapshot differs at the same version", async () => {
    const user = await readyUser();
    const resume = await tailor(user, await newApplication(user));
    const session = JSON.parse(atob(user.cookie.slice("__Host-session=".length).split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(await bytesOf(await user.fetch(`/api/resumes/${resume.id}/pdf`))).toBe("%PDF-1.7 fake 1");
    // Simulate a different restored snapshot with the same numeric version.
    await runInDurableObject(vault(env, session.vid), (_instance, state) => {
      const row = state.storage.sql.exec<{ data: string }>(`SELECT data FROM resume_versions WHERE resume_id=? AND version=?`, resume.id, resume.version).one();
      const saved = JSON.parse(row.data);
      saved.render.profile.name = "Another Synthetic Candidate";
      state.storage.sql.exec(`UPDATE resume_versions SET data=? WHERE resume_id=? AND version=?`, JSON.stringify(saved), resume.id, resume.version);
    });
    expect(await bytesOf(await user.fetch(`/api/resumes/${resume.id}/pdf`))).toBe("%PDF-1.7 fake 2");
    expect(rendered[1]).toContain("Another Synthetic Candidate");
  });

  it("regenerates DOCX instead of serving an older formatting version from either cache", async () => {
    const user = await readyUser();
    const resume = await tailor(user, await newApplication(user));
    const session = JSON.parse(atob(user.cookie.slice("__Host-session=".length).split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")));
    const key = docxKey(session.vid, resume.id, resume.version, resume.body.sections.some((s: { unknownEndStartDate?: string }) => !!s.unknownEndStartDate));
    const oldKey = key.replace("-word2", "-word1");
    const who = { userId: session.uid, gen: session.gen, epoch: session.epoch };
    await vault(env, session.vid).putExportCache(who, oldKey, new TextEncoder().encode("old-vault-docx"));
    await env.FILES.put(oldKey, new TextEncoder().encode("old-r2-docx"));
    const response = await user.fetch(`/api/resumes/${resume.id}/docx`);
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const data = await vault(env, session.vid).renderData(who, resume.id);
    expect(await vault(env, session.vid).readExportCache(who, await snapshotCacheKey(key, data))).toEqual(bytes);
  });

  it("rejects direct unverified edits and keeps the cached resume unchanged", async () => {
    const user = await readyUser();
    const resume = await tailor(user, await newApplication(user));
    const line = resume.body.sections[0].lines[0];

    const pdf = await user.fetch(`/api/resumes/${resume.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toMatch(
      /^attachment; filename=".*\.pdf"$/,
    );
    expect(await bytesOf(pdf)).toBe("%PDF-1.7 fake 1");
    expect(rendered[0]).toContain(line.text);

    // Cached: same version, no second render.
    expect(
      await bytesOf(await user.fetch(`/api/resumes/${resume.id}/pdf`)),
    ).toBe("%PDF-1.7 fake 1");
    expect(rendered).toHaveLength(1);

    const edited = "Led a 40-service migration to Kubernetes";
    expect(
      (
        await user.send("PATCH", `/api/resumes/${resume.id}/lines/${line.id}`, {
          text: edited,
        })
      ).status,
    ).toBe(409);
    const after = await user.json(`/api/resumes/${resume.id}`);
    expect(after.version).toBe(resume.version);
    expect(after.body.sections[0].lines[0].text).toBe(line.text);

    expect(
      await bytesOf(await user.fetch(`/api/resumes/${resume.id}/pdf`)),
    ).toBe("%PDF-1.7 fake 1");
    expect(rendered).toHaveLength(1);

    const vid = JSON.parse(
      atob(
        user.cookie
          .slice("__Host-session=".length)
          .split(".")[0]!
          .replace(/-/g, "+")
          .replace(/_/g, "/"),
      ),
    ).vid;
    const pdfs = await env.FILES.list({
      prefix: `${vaultPrefix(vid)}exports/`,
    });
    // New render caches live inside the Vault; no new R2 objects are written.
    expect(pdfs.objects).toHaveLength(0);

    expect(
      (
        await user.send("PATCH", `/api/resumes/${resume.id}/lines/nope`, {
          text: "x",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await user.send("PATCH", `/api/resumes/${resume.id}/lines/${line.id}`, {
          text: "",
        })
      ).status,
    ).toBe(422);
  });

  it("previews exactly what the PDF prints, as inert HTML", async () => {
    const user = await readyUser();
    const resume = await tailor(user, await newApplication(user));
    const res = await user.fetch(`/api/resumes/${resume.id}/preview`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toMatch(
      /default-src 'none'.*sandbox/,
    );
    const html = await res.text();
    await user.fetch(`/api/resumes/${resume.id}/pdf`);
    expect(html).toBe(rendered[0]);
  });

  it("escapes everything it prints", async () => {
    const user = await readyUser();
    await user.send("PUT", "/api/profile", {
      name: "<script>alert(1)</script>",
    });
    const resume = await tailor(user, await newApplication(user));
    await user.fetch(`/api/resumes/${resume.id}/pdf`);
    expect(rendered[0]).not.toContain("<script>alert(1)</script>");
    expect(rendered[0]).toContain("&lt;script&gt;");
  });

  it("does not render a resume that is not ready", async () => {
    let release!: () => void;
    options.hold = new Promise<void>((r) => (release = r));
    const user = await readyUser();
    const res = await startTailor(user, await newApplication(user));
    const { resumeId } = (await res.json()) as { resumeId: string };
    expect((await user.fetch(`/api/resumes/${resumeId}/pdf`)).status).toBe(409);
    expect((await user.fetch(`/api/resumes/${resumeId}/preview`)).status).toBe(
      409,
    );
    expect((await user.json(`/api/resumes/${resumeId}`)).body).toBeNull();
    release();
    await waitForResume(user, resumeId);
  });
});
