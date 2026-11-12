import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { describe, expect, it } from "vitest";
import type { Me } from "../../src/shared/api";
import type { Today } from "../../src/shared/today";
import { COUNTS_CHANGED } from "../../src/web/live";
import { Shell } from "../../src/web/components/Shell";
import { parseRoute, useRoute } from "../../src/web/router";
import { SCREENS, shownRoute } from "../../src/web/screens";
import { useSession } from "../../src/web/session";
import { installFakeApi } from "./api-fake";
import { fixtures, fullVault, type Fixtures } from "./fixtures";
import { goTo, renderWithSession } from "./render";

/** A shell whose page says which route it is on. */
function RoutedShell() {
  const route = useRoute();
  return (
    <Shell route={route} title="Test">
      <p>Page for {route.name}</p>
    </Shell>
  );
}

/** The shell with each route's real screen, as the signed-in app shows it. */
function Routed() {
  const { me } = useSession();
  const route = shownRoute(useRoute(), me);
  const shown = SCREENS[route.name];
  return (
    <Shell route={route} title={shown.title}>
      {shown.render(route)}
    </Shell>
  );
}

/** Something waiting in each room: four to check in one file and a file that couldn't be read, a kit, and a coach's comments. */
function waiting(): Today {
  return {
    waiting: [
      { kind: "check", sourceId: "src-2024", filename: "sam-rivera-2024.pdf", roles: 1, facts: 3 },
      { kind: "unreadable", sourceId: "src-cv", filename: "sam-rivera-cv.docx", createdAt: 1 },
      { kind: "kit", applicationId: "app-litware", title: "Platform Engineer", company: "Litware", unanswered: 2, sensitive: 0 },
      { kind: "comments", grantId: "sh-1", coachName: "Dana Okafor", coachEmail: "dana@example.test", count: 2, latest: 1 },
      { kind: "suggestions", grantId: "sh-1", coachName: "Dana Okafor", coachEmail: "dana@example.test", count: 1, latest: 1 },
    ],
    working: [],
    recent: [],
    counts: { facts: 5, jobs: 2, sharing: 3, today: 10 },
    since: 0,
  };
}

function withToday(today: Today = waiting(), me: Partial<Me> = {}): Fixtures {
  const state = fixtures();
  state.today = today;
  state.me = { ...state.me, ...me };
  return state;
}

/** What a link is called aloud: its words, without what is hidden from assistive technology. */
function spoken(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll("[aria-hidden='true']")) hidden.remove();
  return copy.textContent ?? "";
}
const rooms = () => screen.getByRole("navigation", { name: "Rooms" });
const roomNames = () => within(rooms()).getAllByRole("link").map(spoken);
const menuButton = () => screen.getByRole("button", { name: /account and workspaces$/ });

describe("the header", () => {
  it("names the four rooms, with the current one marked", () => {
    installFakeApi(fixtures());
    renderWithSession(<Shell route={parseRoute("#/facts/check")} title="Facts">content</Shell>, fixtures().me);
    expect(within(rooms()).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Today", "#/today"],
      ["Facts", "#/facts/check"],
      ["Jobs", "#/jobs"],
      ["Sharing", "#/sharing"],
    ]);
    expect(within(rooms()).getByRole("link", { name: "Facts" })).toHaveAttribute("aria-current", "page");
    for (const name of ["Today", "Jobs", "Sharing"]) expect(within(rooms()).getByRole("link", { name })).not.toHaveAttribute("aria-current");
    expect(screen.getByText("Private beta")).toHaveClass("rs-mark", "rs-mark--beta");
  });

  it("counts Facts, Jobs and Sharing only where something waits, named in words, while Today is closed", async () => {
    installFakeApi(withToday());
    const first = renderWithSession(<Shell route={parseRoute("#/jobs")} title="Jobs">content</Shell>, fixtures().me);
    await within(rooms()).findByRole("link", { name: "Facts, 5 waiting for you" });
    expect(roomNames()).toEqual(["Today", "Facts, 5 waiting for you", "Jobs, 2 waiting for you", "Sharing, 3 waiting for you"]);
    // The number is for the eye, amber, and hidden from the link's name, which says it in words.
    const count = within(rooms()).getByRole("link", { name: "Facts, 5 waiting for you" }).querySelector(".rs-nav__count")!;
    expect(count).toHaveTextContent(/^5$/);
    expect(count).toHaveAttribute("aria-hidden", "true");
    // Today carries none of its own until it opens.
    expect(within(rooms()).getByRole("link", { name: "Today" }).querySelector(".rs-nav__count")).toBeNull();
    first.unmount();

    // Where nothing waits, nothing is counted.
    installFakeApi(withToday({ ...waiting(), waiting: [], counts: { facts: 0, jobs: 0, sharing: 0, today: 0 } }));
    renderWithSession(<Shell route={parseRoute("#/jobs")} title="Jobs">content</Shell>, fixtures().me);
    await waitFor(() => expect(roomNames()).toEqual(["Today", "Facts", "Jobs", "Sharing"]));
    expect(document.querySelector(".rs-nav__count")).toBeNull();
  });

  it("reaches a waiting coach comment from the header in one click", async () => {
    const state = fullVault();
    state.today = { ...waiting(), counts: { facts: 0, jobs: 0, sharing: 1, today: 1 } };
    state.shareComments = [
      {
        target: { kind: "fact", factId: "fact-migration" },
        quote: "Led the migration",
        grantId: "sh-1",
        coachEmail: "dana@example.test",
        open: true,
        comments: [{ id: "c1", author: "coach", body: "How long did it take?", createdAt: 1794051720000, name: "Dana Okafor", seen: false }],
      },
    ];
    installFakeApi(state);
    goTo("#/facts/check");
    renderWithSession(<Routed />, state.me);
    await userEvent.click(await within(rooms()).findByRole("link", { name: "Sharing, 1 waiting for you" }));
    expect(window.location.hash).toBe("#/sharing");
    expect(await screen.findByRole("region", { name: "Comments from your coach" })).toBeInTheDocument();
    expect(screen.getByText("How long did it take?")).toBeInTheDocument();
  });

  it("keeps the Sharing count from the session when the Today API fails or isn't there", async () => {
    for (const [status, error] of [[404, "not_found"], [500, "internal"], [503, "unavailable"]] as const) {
      const api = installFakeApi(withToday());
      api.fail("GET", /^\/api\/v2\/today$/, status, error, "no such route", false);
      const shown = renderWithSession(<Shell route={parseRoute("#/jobs")} title="Jobs">content</Shell>, { ...fixtures().me, newFromCoach: 2 });
      await waitFor(() => expect(api.callsTo("GET", /^\/api\/v2\/today$/).length).toBeGreaterThan(0));
      expect(roomNames()).toEqual(["Today", "Facts", "Jobs", "Sharing, 2 waiting for you"]);
      // No error is shown for it, and the session goes on.
      expect(screen.queryByRole("alert")).toBeNull();
      expect(shown.ended).toEqual([]);
      shown.unmount();
    }
    // Before Today has answered, the session's count stands too.
    installFakeApi(withToday());
    renderWithSession(<Shell route={parseRoute("#/jobs")} title="Jobs">content</Shell>, { ...fixtures().me, newFromCoach: 4 });
    expect(roomNames()).toContain("Sharing, 4 waiting for you");
    // Once it has, Today's count is the one shown.
    await within(rooms()).findByRole("link", { name: "Sharing, 3 waiting for you" });
  });

  it("shows the room's tabs with To check and Coaches counts", async () => {
    installFakeApi(withToday());
    const tabsOf = (room: string) => within(screen.getByRole("navigation", { name: room })).getAllByRole("link");
    const facts = renderWithSession(<Shell route={parseRoute("#/facts/all")} title="Facts">content</Shell>, fixtures().me);
    await screen.findByRole("link", { name: "To check, 4 waiting for you" });
    expect(tabsOf("Facts").map((link) => [spoken(link), link.getAttribute("href")])).toEqual([
      ["To check, 4 waiting for you", "#/facts/check"],
      ["All facts", "#/facts/all"],
      ["Skills", "#/facts/skills"],
      ["Your files", "#/facts/files"],
    ]);
    expect(screen.getByRole("link", { name: "All facts" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "To check, 4 waiting for you" }).querySelector(".app-n")).toHaveAttribute("aria-hidden", "true");
    facts.unmount();

    const jobs = renderWithSession(<Shell route={parseRoute("#/jobs/rules")} title="Rules and answers">content</Shell>, fixtures().me);
    expect(tabsOf("Jobs").map((link) => link.textContent)).toEqual(["Your jobs", "Find jobs", "Applications"]);
    expect(screen.getByRole("link", { name: "Applications" })).toHaveAttribute("aria-current", "page");
    jobs.unmount();

    // Connected apps is a tab only where the deployment has them.
    const sharing = renderWithSession(<Shell route={parseRoute("#/sharing/coaches")} title="Coaches">content</Shell>, fixtures().me);
    await screen.findByRole("link", { name: "Coaches, 3 waiting for you" });
    expect(tabsOf("Sharing").map((link) => spoken(link))).toEqual(["Overview", "Coaches, 3 waiting for you", "Recruiters"]);
    sharing.unmount();
    const apps = { ...fixtures().me, capabilities: { ocr: false, connectedApps: true } };
    const withApps = renderWithSession(<Shell route={parseRoute("#/sharing/apps")} title="Connected apps">content</Shell>, apps);
    expect(tabsOf("Sharing").map(spoken)).toEqual(["Overview", "Coaches", "Recruiters", "Connected apps"]);
    expect(screen.getByRole("link", { name: "Connected apps" })).toHaveAttribute("aria-current", "page");
    withApps.unmount();

    // Today, Account and the legal pages have no second row.
    for (const hash of ["#/today", "#/account", "#/privacy"]) {
      const page = renderWithSession(<Shell route={parseRoute(hash)} title="Page">content</Shell>, fixtures().me);
      expect(document.querySelector(".app-sub"), hash).toBeNull();
      page.unmount();
    }
  });

  it("reloads Today on a room change, not a tab change", async () => {
    const api = installFakeApi(withToday());
    const reads = () => api.callsTo("GET", /^\/api\/v2\/today$/).length;
    goTo("#/facts/check");
    renderWithSession(<RoutedShell />, fixtures().me);
    await waitFor(() => expect(reads()).toBe(1));
    act(() => goTo("#/facts/all"));
    act(() => goTo("#/facts/files"));
    await screen.findByText("Page for factsFiles");
    expect(reads()).toBe(1);
    act(() => goTo("#/jobs"));
    await waitFor(() => expect(reads()).toBe(2));
    act(() => goTo("#/jobs/app-litware/fit"));
    act(() => goTo("#/jobs/app-litware/letter"));
    expect(reads()).toBe(2);
    act(() => goTo("#/coaching/clients"));
    await waitFor(() => expect(reads()).toBe(3));
    // And after this tab changes something.
    act(() => void window.dispatchEvent(new Event(COUNTS_CHANGED)));
    await waitFor(() => expect(reads()).toBe(4));
  });

  it("reads Today again shortly after a change made through the API, and not after signing out", async () => {
    const api = installFakeApi(withToday());
    const reads = () => api.callsTo("GET", /^\/api\/v2\/today$/).length;
    goTo("#/facts/check");
    renderWithSession(<RoutedShell />, fixtures().me);
    await waitFor(() => expect(reads()).toBe(1));
    const { api: client } = await import("../../src/web/api");
    await client.review({ confirm: ["fact-latency"], reject: [] });
    await client.markSensitive({ ids: ["fact-latency"], sensitive: true });
    // Two changes together are told once.
    await waitFor(() => expect(reads()).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reads()).toBe(2);
    await client.logout();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reads()).toBe(2);
  });

  it("keeps Jobs current on a job's page and a resume", () => {
    installFakeApi(fixtures());
    for (const hash of ["#/jobs/app-litware/fit", "#/jobs/app-litware/interview", "#/resumes/res-ready", "#/jobs/app-litware/resume/res-ready", "#/jobs/find"]) {
      const shown = renderWithSession(<Shell route={parseRoute(hash)} title="Jobs">content</Shell>, fixtures().me);
      expect(within(rooms()).getByRole("link", { name: "Jobs" }), hash).toHaveAttribute("aria-current", "page");
      expect(within(screen.getByRole("navigation", { name: "Jobs" })).getByRole("link", { name: hash === "#/jobs/find" ? "Find jobs" : "Your jobs" }), hash).toHaveAttribute("aria-current", "page");
      shown.unmount();
    }
  });

  it("links the lockup to Today", () => {
    installFakeApi(fixtures());
    for (const hash of ["#/jobs", "#/coaching/clients", "#/hiring/openings"]) {
      const shown = renderWithSession(<Shell route={parseRoute(hash)} title="Page">content</Shell>, fixtures().me);
      const brand = screen.getByRole("link", { name: "Resumatic, go to Today" });
      expect(brand).toHaveAttribute("href", "#/today");
      expect(brand).toHaveClass("rs-brand");
      // The lockup: the tile, then the wordmark, which hides on a narrow screen and leaves the tile.
      expect(brand.querySelector(".rs-brand__tile")).toHaveAttribute("aria-hidden", "true");
      expect(brand.querySelector("svg")).toHaveClass("app-brand-wordmark");
      shown.unmount();
    }
  });

  it("gives the coaching and hiring workspaces their own rooms and no quota", () => {
    installFakeApi(withToday());
    const coaching = renderWithSession(<Shell route={parseRoute("#/coaching/organisation")} title="Organisation">content</Shell>, { ...fixtures().me, clients: 2, newFromCoach: 3 });
    const coachRooms = screen.getByRole("navigation", { name: "Coaching" });
    expect(within(coachRooms).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Clients", "#/coaching/clients"],
      ["Organisation", "#/coaching/organisation"],
    ]);
    expect(within(coachRooms).getByRole("link", { name: "Organisation" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Coaching", { selector: ".rs-mark" })).toHaveClass("rs-mark--beta");
    expect(screen.queryByRole("navigation", { name: "Rooms" })).toBeNull();
    expect(document.querySelector(".rs-quota")).toBeNull();
    // Counts belong to looking for work.
    expect(document.querySelector(".rs-nav__count, .app-n")).toBeNull();
    expect(document.querySelector(".app-sub")).toBeNull();
    coaching.unmount();

    renderWithSession(<Shell route={parseRoute("#/hiring/introductions")} title="Introductions">content</Shell>, fixtures().me);
    const hiring = screen.getByRole("navigation", { name: "Hiring" });
    expect(within(hiring).getAllByRole("link").map((link) => link.textContent)).toEqual(["Openings", "Candidates", "Introductions", "Organisation"]);
    expect(within(hiring).getByRole("link", { name: "Introductions" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Hiring", { selector: ".rs-mark" })).toBeInTheDocument();
    expect(document.querySelector(".rs-quota")).toBeNull();
  });

  it("puts the skip link first and moves focus to main", async () => {
    installFakeApi(fixtures());
    goTo("#/facts/check");
    renderWithSession(<RoutedShell />, fixtures().me);
    const focusable = document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea");
    expect(focusable[0]).toHaveTextContent("Skip to content");
    // The first page leaves focus where the browser put it.
    expect(document.activeElement).toBe(document.body);
    act(() => goTo("#/jobs"));
    expect(screen.getByText("Page for jobs")).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("main"));
    // A job's tabs are one page: moving between them leaves focus where it is.
    act(() => goTo("#/jobs/app-litware/fit"));
    expect(document.activeElement).toBe(screen.getByRole("main"));
    const skip = screen.getByRole("link", { name: "Skip to content" });
    skip.focus();
    act(() => goTo("#/jobs/app-litware/letter"));
    expect(document.activeElement).toBe(skip);
  });

  it("focuses an Account section named in the address", async () => {
    const state = fixtures();
    installFakeApi(state);
    goTo("#/account/plan");
    renderWithSession(<Routed />, state.me);
    // On the first page too.
    expect(document.activeElement).toHaveAttribute("id", "account-plan");
    act(() => goTo("#/account/data"));
    expect(document.activeElement).toHaveAttribute("id", "account-data");
    expect(within(document.activeElement as HTMLElement).getByRole("heading", { name: "Your data" })).toBeInTheDocument();
    act(() => goTo("#/account/signing-in"));
    expect(document.activeElement).toHaveAttribute("id", "account-signing-in");
    // A section this deployment doesn't show leaves focus on the page.
    act(() => goTo("#/account/notifications"));
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("rewrites a v1 address to its new name", () => {
    installFakeApi(fixtures());
    for (const [old, now, name] of [["#/applications", "#/jobs", "jobs"], ["#/sources", "#/facts/check", "factsCheck"], ["#/clients", "#/coaching/clients", "coachingClients"], ["/", "#/facts/check", "factsCheck"]]) {
      goTo(old!);
      const shown = renderWithSession(<RoutedShell />, fixtures().me);
      expect(screen.getByText(`Page for ${name}`)).toBeInTheDocument();
      expect(window.location.hash).toBe(now);
      shown.unmount();
    }
  });
});

describe("the account menu", () => {
  it("opens the name menu from a button, closes it with Escape and returns focus", async () => {
    installFakeApi(fixtures());
    renderWithSession(<Shell route={parseRoute("#/jobs")} title="Jobs">content</Shell>, fixtures().me);
    const button = menuButton();
    expect(button).toHaveTextContent("Sam Rivera, account and workspaces");
    expect(button).toHaveAttribute("aria-expanded", "false");
    const panel = document.getElementById(button.getAttribute("aria-controls")!)!;
    expect(panel).not.toBeVisible();
    // A disclosure, not a menu: the panel follows the button, and holds headings.
    expect(button.nextElementSibling).toBe(panel);
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(panel).toBeVisible();
    expect(within(panel).getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Workspaces", "Account"]);
    await userEvent.tab();
    expect(panel).toContainElement(document.activeElement as HTMLElement);
    await userEvent.keyboard("{Escape}");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(button);
    // A press outside closes it without moving focus.
    await userEvent.click(button);
    await userEvent.click(screen.getByText("content"));
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).not.toBe(button);
    // The button opens and closes it.
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on a change of page and when focus leaves it", async () => {
    installFakeApi(fixtures());
    goTo("#/jobs");
    renderWithSession(<RoutedShell />, fixtures().me);
    await userEvent.click(menuButton());
    act(() => goTo("#/facts/check"));
    expect(menuButton()).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(menuButton());
    const links = within(document.querySelector<HTMLElement>(".app-menu")!).getAllByRole("link");
    act(() => links[0]!.focus());
    // Moving between the panel and its button keeps it open.
    act(() => menuButton().focus());
    expect(menuButton()).toHaveAttribute("aria-expanded", "true");
    const skip = screen.getByRole("link", { name: "Skip to content" });
    act(() => skip.focus());
    expect(menuButton()).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(skip);
  });

  it("names the person by their name, else the address they signed in with", async () => {
    installFakeApi(fixtures());
    const named = { ...fixtures().me, signInEmail: "sam@example.test" };
    const first = renderWithSession(<Shell route={parseRoute("#/jobs")} title="Jobs">content</Shell>, named);
    await userEvent.click(menuButton());
    expect(screen.getByText("Signed in as sam@example.test")).toBeInTheDocument();
    first.unmount();
    const unnamed = { ...named, profile: { ...named.profile, name: "  " } };
    const second = renderWithSession(<Shell route={parseRoute("#/jobs")} title="Jobs">content</Shell>, unnamed);
    expect(menuButton()).toHaveTextContent(/^sam@example\.test/);
    second.unmount();
    renderWithSession(<Shell route={parseRoute("#/jobs")} title="Jobs">content</Shell>, { ...fixtures().me, profile: { ...named.profile, name: "" } });
    expect(menuButton()).toHaveTextContent(/^Your account/);
    await userEvent.click(menuButton());
    expect(screen.queryByText(/^Signed in as/)).toBeNull();
  });

  it("lists Coaching only for a coach or inside it, and Hiring as Not open yet", async () => {
    installFakeApi(fixtures());
    const workspaces = () => {
      const panel = document.querySelector<HTMLElement>(".app-menu")!;
      return within(panel).getAllByRole("link").slice(0, -3).map((link) => [link.textContent, link.getAttribute("href"), link.getAttribute("aria-current")]);
    };
    const first = renderWithSession(<Shell route={parseRoute("#/jobs")} title="Jobs">content</Shell>, fixtures().me);
    await userEvent.click(menuButton());
    expect(workspaces()).toEqual([
      ["Looking for work", "#/facts/check", "true"],
      ["HiringNot open yet", "#/hiring/openings", null],
    ]);
    expect(document.querySelector(".app-menu a[aria-current='true'] .rs-g--check")).not.toBeNull();
    first.unmount();
    const coach = renderWithSession(<Shell route={parseRoute("#/jobs")} title="Jobs">content</Shell>, { ...fixtures().me, clients: 2 });
    await userEvent.click(menuButton());
    expect(workspaces()).toEqual([
      ["Looking for work", "#/facts/check", "true"],
      ["Coaching2 clients", "#/coaching/clients", null],
      ["HiringNot open yet", "#/hiring/openings", null],
    ]);
    coach.unmount();
    const one = renderWithSession(<Shell route={parseRoute("#/coaching/clients")} title="Clients">content</Shell>, { ...fixtures().me, clients: 1 });
    await userEvent.click(menuButton());
    expect(workspaces()).toEqual([
      ["Looking for work", "#/facts/check", null],
      ["Coaching1 client", "#/coaching/clients", "true"],
      ["HiringNot open yet", "#/hiring/openings", null],
    ]);
    one.unmount();
    // Someone with no clients who follows a link into coaching still sees where they are.
    renderWithSession(<Shell route={parseRoute("#/coaching/clients")} title="Clients">content</Shell>, { ...fixtures().me, clients: 0 });
    await userEvent.click(menuButton());
    expect(workspaces()).toEqual([
      ["Looking for work", "#/facts/check", null],
      ["Coaching", "#/coaching/clients", "true"],
      ["HiringNot open yet", "#/hiring/openings", null],
    ]);
  });

  it("lists Notifications only where email notices are configured", async () => {
    installFakeApi(fixtures());
    const account = () => {
      const links = within(document.querySelector<HTMLElement>(".app-menu")!).getAllByRole("link");
      return links.slice(links.findIndex((link) => link.textContent === "Profile")).map((link) => link.textContent);
    };
    const off = renderWithSession(<Shell route={parseRoute("#/jobs")} title="Jobs">content</Shell>, fixtures().me);
    await userEvent.click(menuButton());
    expect(account()).toEqual(["Profile", "Plan12 of 20 documents used", "Your data"]);
    off.unmount();
    renderWithSession(<Shell route={parseRoute("#/jobs")} title="Jobs">content</Shell>, { ...fixtures().me, capabilities: { ocr: false, connectedApps: false, emailNotices: true } });
    await userEvent.click(menuButton());
    expect(account()).toEqual(["Profile", "Plan12 of 20 documents used", "Notifications", "Your data"]);
  });

  it("moves Account into the menu", async () => {
    installFakeApi(fixtures());
    renderWithSession(<Shell route={parseRoute("#/account/plan")} title="Account">content</Shell>, fixtures().me);
    // No room is current on Account, and Account is not a room.
    expect(within(rooms()).queryByRole("link", { name: /Account/ })).toBeNull();
    expect(within(rooms()).queryAllByRole("link").filter((link) => link.getAttribute("aria-current"))).toEqual([]);
    await userEvent.click(menuButton());
    const panel = document.querySelector<HTMLElement>(".app-menu")!;
    expect(within(panel).getByRole("link", { name: "Profile" })).toHaveAttribute("href", "#/account/profile");
    expect(within(panel).getByRole("link", { name: "Your data" })).toHaveAttribute("href", "#/account/data");
    const plan = within(panel).getByRole("link", { name: /^Plan/ });
    expect(plan).toHaveAttribute("href", "#/account/plan");
    expect(plan).toHaveAttribute("aria-current", "page");
    expect(within(panel).getByRole("link", { name: "Profile" })).not.toHaveAttribute("aria-current");
  });

  it("signs out from the menu", async () => {
    const api = installFakeApi(fixtures());
    const { ended } = renderWithSession(<Shell route={parseRoute("#/jobs")} title="Jobs">content</Shell>, fixtures().me);
    await userEvent.click(menuButton());
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(ended).toEqual(["You’ve signed out."]));
    expect(api.callsTo("POST", /^\/auth\/logout$/)).toHaveLength(1);
  });

  it("says so in the menu when signing out fails", async () => {
    const api = installFakeApi(fixtures());
    api.fail("POST", /^\/auth\/logout$/, 503, "unavailable", "Resumatic is unavailable right now. Try again in a few minutes.");
    const { ended } = renderWithSession(<Shell route={parseRoute("#/jobs")} title="Jobs">content</Shell>, fixtures().me);
    await userEvent.click(menuButton());
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    const panel = document.querySelector<HTMLElement>(".app-menu")!;
    expect(await within(panel).findByRole("alert")).toBeInTheDocument();
    expect(ended).toEqual([]);
  });
});

describe("the footer", () => {
  it("links the privacy notice, the terms and feedback", () => {
    installFakeApi(fixtures());
    renderWithSession(<Shell route={parseRoute("#/facts/check")} title="Facts">content</Shell>, fixtures().me);
    const footer = screen.getByRole("navigation", { name: "About Resumatic" });
    expect(within(footer).getAllByRole("link").map((a) => a.textContent)).toEqual(["Privacy", "Terms", "Send feedback"]);
  });
});
