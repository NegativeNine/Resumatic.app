import { describe, expect, it } from "vitest";
import {
  ACCOUNT_SECTIONS,
  DEFAULT_HASH,
  JOB_TABS,
  ROUTES,
  TODAY_OPEN,
  canonicalHash,
  href,
  parseRoute,
  routeKey,
  type RouteName,
  type RouteParams,
} from "../../src/web/router";

/** A value for each parameter an address can carry. */
const SAMPLE: Required<RouteParams> = { id: "job 1/2", resumeId: "res-1", jobTab: "letter", section: "plan" };

/** An address with its parameters filled in, as a link would write it. */
function filled(path: string): { address: string; params: RouteParams } {
  const params: Record<string, string> = {};
  const address = path
    .split("/")
    .map((piece) => {
      if (!piece.startsWith(":")) return piece;
      const name = piece.slice(1) as keyof RouteParams;
      params[name] = SAMPLE[name];
      return encodeURIComponent(SAMPLE[name]);
    })
    .join("/");
  return { address, params };
}

describe("the route table", () => {
  it("parses every row of ROUTES from its own address", () => {
    expect(ROUTES.length).toBeGreaterThan(25);
    for (const entry of ROUTES) {
      for (const path of entry.paths) {
        const { address, params } = filled(path);
        expect(parseRoute(address), address).toEqual({ name: entry.name, room: entry.room, tab: entry.tab, workspace: entry.workspace, params });
        // A current address is never rewritten.
        expect(canonicalHash(address), address).toBeNull();
      }
    }
    // Every name is one row, so it has one screen.
    const names = ROUTES.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("rewrites every old address", () => {
    const old: [string, string, RouteName][] = [
      ["", DEFAULT_HASH, "today"],
      ["#/", DEFAULT_HASH, "today"],
      ["#/sources", "#/facts/check", "factsCheck"],
      ["#/facts", "#/facts/check", "factsCheck"],
      ["#/applications", "#/jobs", "jobs"],
      ["#/clients", "#/coaching/clients", "coachingClients"],
      ["#/coaching", "#/coaching/clients", "coachingClients"],
      ["#/hiring", "#/hiring/openings", "hiringOpenings"],
      ["#/jobs/app-litware", "#/jobs/app-litware/fit", "job"],
    ];
    for (const [from, to, name] of old) {
      expect(canonicalHash(from), from).toBe(to);
      expect(parseRoute(from).name, from).toBe(name);
    }
    expect(parseRoute("#/jobs/app-litware").params).toEqual({ id: "app-litware", jobTab: "fit" });
    // The room's own pages under #/jobs are not jobs.
    for (const page of ["find", "applications", "rules"]) expect(canonicalHash(`#/jobs/${page}`), page).toBeNull();
    expect(canonicalHash("#/resumes/abc")).toBeNull();
    expect(canonicalHash("#/account/plan")).toBeNull();
  });

  it("sends an empty address to Today, now that it is open", () => {
    expect(TODAY_OPEN).toBe(true);
    expect(DEFAULT_HASH).toBe("#/today");
    expect(href.home).toBe("#/today");
    for (const empty of ["", "#", "#/", "#//"]) {
      expect(canonicalHash(empty), empty).toBe("#/today");
      expect(parseRoute(empty).name, empty).toBe("today");
    }
    expect(parseRoute("#/today")).toMatchObject({ name: "today", room: "today", tab: null });
  });

  it("parses an old resume address without a job and leaves it for the page", () => {
    expect(parseRoute(href.resume("res 1/2"))).toEqual({ name: "resume", room: "jobs", tab: "yours", workspace: "seeking", params: { resumeId: "res 1/2" } });
    expect(canonicalHash(href.resume("res 1/2"))).toBeNull();
    expect(parseRoute(href.jobResume("app 1", "res 1/2")).params).toEqual({ id: "app 1", resumeId: "res 1/2" });
  });

  it("answers notFound for a bad encoding, an unknown job tab or account section, and extra segments", () => {
    for (const hash of [
      "#/nope",
      "#/resumes",
      "#/resumes/%E0%A4%A",
      "#/resumes/a/b",
      "#/jobs/abc/cv",
      "#/jobs/%E0%A4%A/fit",
      "#/jobs/find/fit",
      "#/jobs/abc/resume/%E0%A4%A",
      "#/account/billing",
      "#/account/plan/more",
      "#/facts/check/extra",
      "#/jobs/abc/fit/extra",
      "#/sources/extra",
      `#/resumes/${"x".repeat(201)}`,
      "#/coaching/clients/a/b",
      // Names every object inherits are not old addresses.
      "#/constructor",
      "#/__proto__",
      "#/toString",
      "#/hasOwnProperty",
    ])
      expect(parseRoute(hash), hash).toEqual({ name: "notFound", room: null, tab: null, workspace: "seeking", params: {} });
    for (const hash of ["#/constructor", "#/__proto__", "#/toString"]) expect(canonicalHash(hash), hash).toBeNull();
    // Two hundred characters is the most a parameter may be.
    expect(parseRoute(`#/resumes/${"x".repeat(200)}`).name).toBe("resume");
  });

  it("builds every href that parses back to its route", () => {
    const built: [string, RouteName, RouteParams?][] = [
      [href.home, "today"],
      [href.today, "today"],
      [href.facts, "factsCheck"],
      [href.factsAll, "factsAll"],
      [href.skills, "factsSkills"],
      [href.files, "factsFiles"],
      [href.attest, "attest"],
      [href.jobs, "jobs"],
      [href.findJobs, "jobsFind"],
      [href.applications, "jobsApplications"],
      [href.rules, "jobsRules"],
      [href.job("app/1"), "job", { id: "app/1", jobTab: "fit" }],
      ...JOB_TABS.map((tab): [string, RouteName, RouteParams] => [href.job("app/1", tab), "job", { id: "app/1", jobTab: tab }]),
      [href.jobResume("app/1", "res/1"), "resume", { id: "app/1", resumeId: "res/1" }],
      [href.resume("res/1"), "resume", { resumeId: "res/1" }],
      [href.sharing, "sharing"],
      [href.coaches, "sharingCoaches"],
      [href.recruiters, "sharingRecruiters"],
      [href.apps, "sharingApps"],
      [href.introRequest("req 1"), "introRequest", { id: "req 1" }],
      [href.account, "account"],
      ...ACCOUNT_SECTIONS.map((section): [string, RouteName, RouteParams] => [href.accountSection(section), "account", { section }]),
      [href.clients, "coachingClients"],
      [href.client("grant 1"), "coachingClient", { id: "grant 1" }],
      [href.coachingOrganisation, "coachingOrganisation"],
      [href.hiringOpenings, "hiringOpenings"],
      [href.hiringCandidates, "hiringCandidates"],
      [href.hiringIntroductions, "hiringIntroductions"],
      [href.hiringOrganisation, "hiringOrganisation"],
      [href.privacy, "privacy"],
      [href.terms, "terms"],
    ];
    for (const [address, name, params = {}] of built) {
      expect(parseRoute(address), address).toMatchObject({ name, params });
      expect(canonicalHash(address), address).toBeNull();
    }
    // Every row of the table is reached by some href.
    const reached = new Set(built.map(([, name]) => name));
    expect(ROUTES.filter((entry) => !reached.has(entry.name)).map((entry) => entry.name)).toEqual([]);
  });

  it("keys a job's tabs as one screen", () => {
    const keys = JOB_TABS.map((tab) => routeKey(parseRoute(href.job("app-1", tab))));
    expect(new Set(keys)).toEqual(new Set(["job/app-1"]));
    expect(routeKey(parseRoute(href.job("app-2")))).toBe("job/app-2");
    // A resume is one screen at either of its addresses, and every Account section is Account.
    expect(routeKey(parseRoute(href.resume("res-1")))).toBe("resume/res-1");
    expect(routeKey(parseRoute(href.jobResume("app-1", "res-1")))).toBe("resume/res-1");
    expect(new Set(ACCOUNT_SECTIONS.map((section) => routeKey(parseRoute(href.accountSection(section)))))).toEqual(new Set(["account"]));
    expect(routeKey(parseRoute(href.account))).toBe("account");
    // Tabs of a room are screens of their own.
    expect(routeKey(parseRoute(href.facts))).not.toBe(routeKey(parseRoute(href.factsAll)));
    expect(routeKey(parseRoute(href.client("g1")))).toBe("coachingClient/g1");
  });
});
