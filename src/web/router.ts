import { useEffect, useMemo, useSyncExternalStore } from "react";

// Every room, page and workspace has an address here, in one table. ROUTES says what each address
// is called and where it sits; which screen it shows is src/web/screens.tsx's, so pages can import
// `href` from this file without importing one another. Nothing here renders.

/**
 * Whether Today is open. While it is closed, signing in lands on To check and each room carries its
 * own count in the first row; once it opens, Today is where people land and carries the one count.
 */
export const TODAY_OPEN = true;

/** Where an empty address goes: where signing in lands. */
export const DEFAULT_HASH = TODAY_OPEN ? "#/today" : "#/facts/check";

/** Looking for work, coaching or hiring. Each has its own first row. */
export type Workspace = "seeking" | "coaching" | "hiring";
/** A room of a workspace. Coaching and hiring are one room each. */
export type RoomName = "today" | "facts" | "jobs" | "sharing" | "coaching" | "hiring";
export type TabName =
  | "check" | "all" | "skills" | "files"
  | "yours" | "find" | "applications"
  | "overview" | "coaches" | "recruiters" | "apps"
  | "clients" | "organisation"
  | "openings" | "candidates" | "introductions";

/** The pages of one job. */
export const JOB_TABS = ["fit", "resume", "letter", "interview", "application"] as const;
export type JobTab = (typeof JOB_TABS)[number];

/** The sections of Account, each of which has its own address. */
export const ACCOUNT_SECTIONS = ["profile", "plan", "notifications", "appearance", "data", "signing-in"] as const;
export type AccountSection = (typeof ACCOUNT_SECTIONS)[number];

/** The element on Account that each section's address scrolls to and focuses. */
export const ACCOUNT_ANCHORS: Readonly<Record<AccountSection, string>> = {
  profile: "account-profile",
  plan: "account-plan",
  notifications: "account-notifications",
  appearance: "account-appearance",
  data: "account-data",
  "signing-in": "account-signing-in",
};

/** Addresses under #/jobs/ that are pages of the room, never a job's ID. */
const RESERVED_JOB_IDS: readonly string[] = ["find", "applications", "rules"];

/** A capability in `me.capabilities` an address needs. Without it, the address is not found. */
export type Needs = "connectedApps";

interface RouteEntry {
  name: string;
  /** Its addresses: a segment starting with ":" is a parameter. */
  paths: readonly string[];
  room: RoomName | null;
  tab: TabName | null;
  workspace: Workspace;
  needs?: Needs;
}

/** Every address, in the order they are tried. Each name has one screen in SCREENS. */
export const ROUTES = [
  { name: "today", paths: ["#/today"], room: "today", tab: null, workspace: "seeking" },

  { name: "factsCheck", paths: ["#/facts/check"], room: "facts", tab: "check", workspace: "seeking" },
  { name: "factsAll", paths: ["#/facts/all"], room: "facts", tab: "all", workspace: "seeking" },
  { name: "attest", paths: ["#/facts/all/ask"], room: "facts", tab: "all", workspace: "seeking" },
  { name: "factsSkills", paths: ["#/facts/skills"], room: "facts", tab: "skills", workspace: "seeking" },
  { name: "factsFiles", paths: ["#/facts/files"], room: "facts", tab: "files", workspace: "seeking" },

  { name: "jobs", paths: ["#/jobs"], room: "jobs", tab: "yours", workspace: "seeking" },
  { name: "jobsFind", paths: ["#/jobs/find"], room: "jobs", tab: "find", workspace: "seeking" },
  { name: "jobsApplications", paths: ["#/jobs/applications"], room: "jobs", tab: "applications", workspace: "seeking" },
  { name: "jobsRules", paths: ["#/jobs/rules"], room: "jobs", tab: "applications", workspace: "seeking" },
  { name: "job", paths: ["#/jobs/:id/:jobTab"], room: "jobs", tab: "yours", workspace: "seeking" },
  // A resume belongs to the job it was tailored for. The old address names no job, and the page
  // puts the job in the address once the resume has loaded.
  { name: "resume", paths: ["#/jobs/:id/resume/:resumeId", "#/resumes/:resumeId"], room: "jobs", tab: "yours", workspace: "seeking" },

  { name: "sharing", paths: ["#/sharing"], room: "sharing", tab: "overview", workspace: "seeking" },
  { name: "sharingCoaches", paths: ["#/sharing/coaches"], room: "sharing", tab: "coaches", workspace: "seeking" },
  { name: "sharingRecruiters", paths: ["#/sharing/recruiters"], room: "sharing", tab: "recruiters", workspace: "seeking" },
  { name: "introRequest", paths: ["#/sharing/recruiters/request/:id"], room: "sharing", tab: "recruiters", workspace: "seeking" },
  { name: "sharingApps", paths: ["#/sharing/apps"], room: "sharing", tab: "apps", workspace: "seeking", needs: "connectedApps" },

  { name: "account", paths: ["#/account", "#/account/:section"], room: null, tab: null, workspace: "seeking" },

  { name: "coachingClients", paths: ["#/coaching/clients"], room: "coaching", tab: "clients", workspace: "coaching" },
  { name: "coachingClient", paths: ["#/coaching/clients/:id"], room: "coaching", tab: "clients", workspace: "coaching" },
  { name: "coachingOrganisation", paths: ["#/coaching/organisation"], room: "coaching", tab: "organisation", workspace: "coaching" },

  { name: "hiringOpenings", paths: ["#/hiring/openings"], room: "hiring", tab: "openings", workspace: "hiring" },
  { name: "hiringCandidates", paths: ["#/hiring/candidates"], room: "hiring", tab: "candidates", workspace: "hiring" },
  { name: "hiringIntroductions", paths: ["#/hiring/introductions"], room: "hiring", tab: "introductions", workspace: "hiring" },
  { name: "hiringOrganisation", paths: ["#/hiring/organisation"], room: "hiring", tab: "organisation", workspace: "hiring" },

  { name: "privacy", paths: ["#/privacy"], room: null, tab: null, workspace: "seeking" },
  { name: "terms", paths: ["#/terms"], room: null, tab: null, workspace: "seeking" },
] as const satisfies readonly RouteEntry[];

export type RouteName = (typeof ROUTES)[number]["name"] | "notFound";

export interface RouteParams {
  /** A job's ID on a job's pages, a client's on a client's, a request's on a request's. */
  id?: string;
  resumeId?: string;
  jobTab?: JobTab;
  section?: AccountSection;
}

export interface Route {
  name: RouteName;
  room: RoomName | null;
  tab: TabName | null;
  workspace: Workspace;
  params: RouteParams;
}

/** An address that names nothing, or a page whose capability is off. */
export const NOT_FOUND_ROUTE: Route = { name: "notFound", room: null, tab: null, workspace: "seeking", params: {} };

/** The longest parameter an address may carry, decoded. */
const MAX_PARAM_CHARS = 200;

const enc = encodeURIComponent;

export const href = {
  /** Where signing in lands. */
  home: DEFAULT_HASH,
  today: "#/today",
  /** Facts › To check, which every link to Facts opens. */
  facts: "#/facts/check",
  factsAll: "#/facts/all",
  skills: "#/facts/skills",
  files: "#/facts/files",
  attest: "#/facts/all/ask",
  jobs: "#/jobs",
  findJobs: "#/jobs/find",
  applications: "#/jobs/applications",
  rules: "#/jobs/rules",
  job: (id: string, tab: JobTab = "fit") => `#/jobs/${enc(id)}/${tab}`,
  jobResume: (jobId: string, resumeId: string) => `#/jobs/${enc(jobId)}/resume/${enc(resumeId)}`,
  /** A resume, for a link that doesn't know its job. The page adds the job once it loads. */
  resume: (id: string) => `#/resumes/${enc(id)}`,
  sharing: "#/sharing",
  coaches: "#/sharing/coaches",
  recruiters: "#/sharing/recruiters",
  apps: "#/sharing/apps",
  introRequest: (id: string) => `#/sharing/recruiters/request/${enc(id)}`,
  account: "#/account",
  accountSection: (section: AccountSection) => `#/account/${section}`,
  clients: "#/coaching/clients",
  client: (id: string) => `#/coaching/clients/${enc(id)}`,
  coachingOrganisation: "#/coaching/organisation",
  hiringOpenings: "#/hiring/openings",
  hiringCandidates: "#/hiring/candidates",
  hiringIntroductions: "#/hiring/introductions",
  hiringOrganisation: "#/hiring/organisation",
  privacy: "#/privacy",
  terms: "#/terms",
};

/** A link in the first or second row. `key` is a room in Looking for work's first row, otherwise a tab. */
export interface NavItem {
  key: RoomName | TabName;
  label: string;
  to: string;
  needs?: Needs;
}

/** Each room's pages: its second row, or for coaching and hiring their first. */
export const ROOM_TABS: Readonly<Partial<Record<RoomName, readonly NavItem[]>>> = {
  facts: [
    { key: "check", label: "To check", to: href.facts },
    { key: "all", label: "All facts", to: href.factsAll },
    { key: "skills", label: "Skills", to: href.skills },
    { key: "files", label: "Your files", to: href.files },
  ],
  jobs: [
    { key: "yours", label: "Your jobs", to: href.jobs },
    { key: "find", label: "Find jobs", to: href.findJobs },
    { key: "applications", label: "Applications", to: href.applications },
  ],
  sharing: [
    { key: "overview", label: "Overview", to: href.sharing },
    { key: "coaches", label: "Coaches", to: href.coaches },
    { key: "recruiters", label: "Recruiters", to: href.recruiters },
    { key: "apps", label: "Connected apps", to: href.apps, needs: "connectedApps" },
  ],
  coaching: [
    { key: "clients", label: "Clients", to: href.clients },
    { key: "organisation", label: "Organisation", to: href.coachingOrganisation },
  ],
  hiring: [
    { key: "openings", label: "Openings", to: href.hiringOpenings },
    { key: "candidates", label: "Candidates", to: href.hiringCandidates },
    { key: "introductions", label: "Introductions", to: href.hiringIntroductions },
    { key: "organisation", label: "Organisation", to: href.hiringOrganisation },
  ],
};

/** Each workspace's first row: the rooms of Looking for work, and the pages of the other two. */
export const ROOMS: Readonly<Record<Workspace, readonly NavItem[]>> = {
  seeking: [
    { key: "today", label: "Today", to: href.today },
    { key: "facts", label: "Facts", to: href.facts },
    { key: "jobs", label: "Jobs", to: href.jobs },
    { key: "sharing", label: "Sharing", to: href.sharing },
  ],
  coaching: ROOM_TABS.coaching!,
  hiring: ROOM_TABS.hiring!,
};

/** The earlier addresses, still honoured so old links and bookmarks land on their pages. */
const ALIASES: Readonly<Record<string, string>> = {
  sources: href.facts,
  facts: href.facts,
  applications: href.jobs,
  clients: href.clients,
  coaching: href.clients,
  hiring: href.hiringOpenings,
  "sign-in": href.home,
};

function segments(hash: string): string[] {
  return hash.replace(/^#\/?/, "").split("/").filter(Boolean);
}

/** The address an earlier or empty one should show instead, such as "#/facts/check" for "#/sources"; otherwise null. */
export function canonicalHash(hash: string): string | null {
  const parts = segments(hash);
  if (parts.length === 0) return DEFAULT_HASH;
  // Only the table's own names: "#/constructor" names something every object inherits, not an address.
  if (parts.length === 1) return Object.hasOwn(ALIASES, parts[0]!) ? ALIASES[parts[0]!]! : null;
  // A job's own address opens its first page.
  if (parts.length === 2 && parts[0] === "jobs" && !RESERVED_JOB_IDS.includes(parts[1]!)) return `#/jobs/${parts[1]}/fit`;
  return null;
}

/** A parameter as the address carries it, decoded, or null if it can't be one. */
function param(name: string, raw: string, pattern: readonly string[]): string | null {
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (value.length === 0 || value.length > MAX_PARAM_CHARS) return null;
  if (name === "jobTab" && !(JOB_TABS as readonly string[]).includes(value)) return null;
  if (name === "section" && !(ACCOUNT_SECTIONS as readonly string[]).includes(value)) return null;
  if (name === "id" && pattern[0] === "jobs" && RESERVED_JOB_IDS.includes(value)) return null;
  return value;
}

function match(path: string, parts: readonly string[]): RouteParams | null {
  const pattern = segments(path);
  if (pattern.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (const [index, piece] of pattern.entries()) {
    const raw = parts[index]!;
    if (!piece.startsWith(":")) {
      if (piece !== raw) return null;
      continue;
    }
    const value = param(piece.slice(1), raw, pattern);
    if (value === null) return null;
    params[piece.slice(1)] = value;
  }
  return params as RouteParams;
}

export function parseRoute(hash: string): Route {
  const parts = segments(canonicalHash(hash) ?? hash);
  for (const entry of ROUTES) {
    for (const path of entry.paths) {
      const params = match(path, parts);
      if (params) return { name: entry.name, room: entry.room, tab: entry.tab, workspace: entry.workspace, params };
    }
  }
  return NOT_FOUND_ROUTE;
}

/** The capability a route needs, if any. */
export function routeNeeds(route: Route): Needs | undefined {
  const entry: RouteEntry | undefined = ROUTES.find((item) => item.name === route.name);
  return entry?.needs;
}

/**
 * What identifies the screen on show. A new key remounts the screen and moves focus to it, so a
 * job's pages share one key, as do a resume's addresses and every section of Account.
 */
export function routeKey(route: Route): string {
  if (route.name === "job") return `job/${route.params.id}`;
  if (route.name === "resume") return `resume/${route.params.resumeId}`;
  if (route.name === "account") return "account";
  return route.params.id === undefined ? route.name : `${route.name}/${route.params.id}`;
}

/** Rewrites an earlier address in place, so the address bar and copied links use the new names. */
function canonicalize(): void {
  const canonical = canonicalHash(window.location.hash);
  if (canonical) window.history.replaceState(window.history.state, "", canonical);
}

const listeners = new Set<() => void>();

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("hashchange", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("hashchange", onChange);
  };
}

function currentHash(): string {
  canonicalize();
  return window.location.hash;
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, currentHash);
  return useMemo(() => parseRoute(hash), [hash]);
}

export function navigate(to: string) {
  window.location.hash = to;
}

/** Changes the address without a new history entry, and tells every page reading the route. */
export function replaceRoute(to: string): void {
  window.history.replaceState(window.history.state, "", to);
  for (const listener of [...listeners]) listener();
}

/**
 * Once a resume has loaded, puts its job in the address: an old link names none, and a link can
 * name the wrong one. The resume's key stays the same, so nothing remounts and focus stays put.
 */
export function useCanonicalResumeAddress(resume: { id: string; applicationId: string } | undefined): void {
  const route = useRoute();
  const id = resume?.id;
  const jobId = resume?.applicationId;
  useEffect(() => {
    if (!id || !jobId || route.name !== "resume" || route.params.resumeId !== id || route.params.id === jobId) return;
    replaceRoute(href.jobResume(jobId, id));
  }, [route, id, jobId]);
}
