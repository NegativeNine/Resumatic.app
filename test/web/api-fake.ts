import { vi } from "vitest";
import type { FactPatch, NewFact, NewRole, Profile, ReviewRequest, RolePatch } from "../../src/shared/api";
import type { Fixtures } from "./fixtures";

export interface Call {
  method: string;
  /** Path and query, such as "/api/facts?state=proposed". */
  path: string;
  body: unknown;
}

type Reply = { status: number; body?: unknown };
type Handler = (call: Call, params: string[]) => Reply;

/**
 * An in-memory stand-in for the Worker's API, installed as the global fetch. It follows the vault's
 * rules where the UI depends on them: confirming a fact confirms its proposed role, rejecting a role
 * rejects its proposed facts, and facts and roles a person adds start confirmed.
 */
export class FakeApi {
  readonly calls: Call[] = [];
  private failures: { method: string; path: RegExp; reply: Reply; once: boolean }[] = [];
  private seq = 0;

  constructor(readonly state: Fixtures) {}

  /** Answers the next matching request (or every one, with once: false) with an error. */
  fail(method: string, path: RegExp, status: number, error: string, message: string, once = true): void {
    this.failures.push({ method, path, reply: { status, body: { error, message } }, once });
  }

  /** Calls made with this method to paths that match. */
  callsTo(method: string, path: RegExp): Call[] {
    return this.calls.filter((c) => c.method === method && path.test(c.path));
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : (init?.body ?? null);
    const call: Call = { method, path: url.pathname + url.search, body };
    this.calls.push(call);

    const failure = this.failures.find((f) => f.method === method && f.path.test(url.pathname));
    if (failure) {
      if (failure.once) this.failures.splice(this.failures.indexOf(failure), 1);
      return respond(failure.reply);
    }
    for (const [routeMethod, pattern, handler] of this.routes) {
      const match = routeMethod === method ? pattern.exec(url.pathname) : null;
      if (match) return respond(handler(call, match.slice(1).map(decodeURIComponent)));
    }
    return respond({ status: 404, body: { error: "not_found", message: "no such route" } });
  };

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-new-${this.seq}`;
  }

  private readonly routes: [string, RegExp, Handler][] = [
    ["GET", /^\/api\/me$/, () => ok(this.state.me)],
    ["GET", /^\/api\/v2\/vault$/, () => ok({ sources: this.state.sources, roles: this.state.roles, facts: this.state.facts })],
    ["GET", /^\/api\/billing$/, () => ok(this.state.billing ?? { enabled: false, plans: [], current: null })],
    ["GET", /^\/api\/shares$/, () => ok({ grants: this.state.shares ?? [] })],
    ["GET", /^\/api\/mcp\/grants$/, () => ok({ grants: this.state.mcpGrants ?? [] })],
    [
      "GET",
      /^\/api\/applications\/([^/]+)\/documents$/,
      (_call, [id]) => ok({ documents: (this.state.documents ?? []).filter((doc) => doc.applicationId === id) }),
    ],
    [
      "GET",
      /^\/api\/resumes\/([^/]+)\/versions$/,
      (_call, [id]) => {
        const resume = this.state.resumes[id];
        return resume ? ok({ versions: [{ version: resume.version, createdAt: resume.createdAt }] }) : notFound("no such resume");
      },
    ],
    ["GET", /^\/api\/profile$/, () => ok(this.state.me.profile)],
    [
      "PUT",
      /^\/api\/(?:v2\/)?profile$/,
      (call) => {
        const { expectedRevision: _revision, ...patch } = call.body as Partial<Profile> & { expectedRevision?: number };
        this.state.me.profile = { ...this.state.me.profile, ...patch, revision: (this.state.me.profile.revision ?? 0) + 1 };
        return ok(this.state.me.profile);
      },
    ],
    ["POST", /^\/api\/account\/sign-out-everywhere$/, () => ({ status: 204 })],
    ["POST", /^\/auth\/logout$/, () => ({ status: 204 })],
    ["DELETE", /^\/auth\/account$/, () => ({ status: 202, body: { deleting: true } })],

    ["GET", /^\/api\/sources$/, () => ok({ sources: this.state.sources })],
    [
      "POST",
      /^\/api\/sources$/,
      (call) => {
        const file = call.body instanceof FormData ? call.body.get("file") : null;
        const id = this.id("src");
        const filename = file instanceof File ? file.name : "upload.pdf";
        this.state.sources.unshift({ id, filename, state: "queued", error: null, createdAt: Date.now(), proposed: 0 });
        return { status: 201, body: { sourceId: id } };
      },
    ],

    ["GET", /^\/api\/roles$/, () => ok({ roles: this.state.roles })],
    [
      "POST",
      /^\/api\/(?:v3\/)?roles$/,
      (call) => {
        const role = call.body as NewRole;
        const id = this.id("role");
        this.state.roles.push({ ...role, id, state: "confirmed", quote: null, sourceId: null });
        return { status: 201, body: { roleId: id } };
      },
    ],
    [
      "PATCH",
      /^\/api\/(?:v2\/)?roles\/([^/]+)$/,
      (call, [id]) => {
        const role = this.state.roles.find((r) => r.id === id);
        if (!role) return notFound("no such role");
        const { expectedRevision: _revision, ...patch } = call.body as RolePatch;
        Object.assign(role, patch);
        return { status: 204 };
      },
    ],

    [
      "GET",
      /^\/api\/facts$/,
      (call) => {
        const state = new URL(call.path, "http://localhost").searchParams.get("state");
        return ok({ facts: state ? this.state.facts.filter((f) => f.state === state) : this.state.facts });
      },
    ],
    [
      "POST",
      /^\/api\/(?:v2\/)?facts$/,
      (call) => {
        const fact = call.body as NewFact;
        const id = this.id("fact");
        this.state.facts.unshift({ ...fact, id, origin: "user", state: "confirmed", quote: null, sourceId: null });
        return { status: 201, body: { factId: id } };
      },
    ],
    [
      "PATCH",
      /^\/api\/facts\/([^/]+)$/,
      (call, [id]) => {
        const fact = this.state.facts.find((f) => f.id === id);
        if (!fact) return notFound("no such fact");
        const patch = call.body as FactPatch;
        if (patch.text !== undefined) fact.text = patch.text;
        if (patch.roleId !== undefined) fact.roleId = patch.roleId;
        if (patch.level !== undefined) fact.level = patch.level;
        fact.origin = "user";
        return { status: 204 };
      },
    ],
    [
      "POST",
      /^\/api\/review$/,
      (call) => {
        const { confirm, reject } = call.body as ReviewRequest;
        for (const id of confirm) {
          const role = this.state.roles.find((r) => r.id === id);
          if (role) role.state = "confirmed";
          const fact = this.state.facts.find((f) => f.id === id);
          if (fact) {
            fact.state = "confirmed";
            const parent = this.state.roles.find((r) => r.id === fact.roleId);
            if (parent?.state === "proposed") parent.state = "confirmed";
          }
        }
        for (const id of reject) {
          const role = this.state.roles.find((r) => r.id === id);
          if (role) {
            role.state = "rejected";
            for (const f of this.state.facts) if (f.roleId === id && f.state === "proposed") f.state = "rejected";
          }
          const fact = this.state.facts.find((f) => f.id === id);
          if (fact) fact.state = "rejected";
        }
        this.recountSources();
        return { status: 204 };
      },
    ],

    ["GET", /^\/api\/applications$/, () => ok({ applications: this.state.applications })],
    [
      "POST",
      /^\/api\/(?:v2\/)?applications$/,
      (call) => {
        const { jdText } = call.body as { jdText: string };
        const id = this.id("app");
        this.state.applications.push({ id, company: null, title: null, excerpt: jdText.slice(0, 100), createdAt: Date.now(), resumes: [] });
        return { status: 201, body: { applicationId: id } };
      },
    ],
    [
      "PATCH",
      /^\/api\/applications\/([^/]+)$/,
      (call, [id]) => {
        const application = this.state.applications.find((a) => a.id === id);
        if (!application) return notFound("no such application");
        Object.assign(application, call.body as object);
        return { status: 204 };
      },
    ],
    [
      "POST",
      /^\/api\/applications\/([^/]+)\/resumes$/,
      (_call, [applicationId]) => {
        const application = this.state.applications.find((a) => a.id === applicationId);
        if (!application) return notFound("no such application");
        const quota = this.state.me.quota;
        if (quota.used >= quota.limit) {
          return { status: 429, body: { error: "quota", message: `You've used all ${quota.limit} tailored resumes for Nov 2026. You can tailor more from 1 Dec 2026.` } };
        }
        quota.used += 1;
        const id = this.id("res");
        const createdAt = Date.now();
        application.resumes.push({ id, state: "running", createdAt });
        this.state.resumes[id] = {
          id,
          applicationId,
          state: "running",
          step: null,
          error: null,
          version: 1,
          createdAt,
          body: null,
          report: null,
          facts: {},
        };
        return { status: 202, body: { resumeId: id } };
      },
    ],
    [
      "GET",
      /^\/api\/resumes\/([^/]+)$/,
      (_call, [id]) => {
        const resume = this.state.resumes[id];
        return resume ? ok(resume) : notFound("no such resume");
      },
    ],
    [
      "PATCH",
      /^\/api\/resumes\/([^/]+)\/lines\/([^/]+)$/,
      (call, [resumeId, lineId]) => {
        const body = this.state.resumes[resumeId]?.body;
        const line = body && [...(body.summary ? [body.summary] : []), ...body.sections.flatMap((s) => s.lines)].find((l) => l.id === lineId);
        if (!line) return notFound("no such line");
        line.text = (call.body as { text: string }).text;
        line.status = "edited";
        this.state.resumes[resumeId].version += 1;
        return { status: 204 };
      },
    ],
  ];

  /** Keeps SourceView.proposed in step with the facts, as the vault's query does. */
  private recountSources(): void {
    for (const source of this.state.sources) {
      source.proposed = this.state.facts.filter((f) => f.sourceId === source.id && f.state === "proposed").length;
    }
  }
}

/** Installs a fake API over the given fixtures as the global fetch, and returns it. */
export function installFakeApi(state: Fixtures): FakeApi {
  const api = new FakeApi(state);
  vi.stubGlobal("fetch", vi.fn(api.fetch));
  return api;
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const notFound = (message: string): Reply => ({ status: 404, body: { error: "not_found", message } });

function respond({ status, body }: Reply): Response {
  if (body === undefined || status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
