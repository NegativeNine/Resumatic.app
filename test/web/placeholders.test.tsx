import { screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { RulesInterim } from "../../src/web/pages/interim/jobs";
import { CoachesInterim, RecruitersInterim } from "../../src/web/pages/interim/sharing";
import { PLACEHOLDERS, PLACEHOLDER_SECTIONS, type PlaceholderName, type PlaceholderSectionName } from "../../src/web/placeholders";
import { parseRoute, ROUTES, type RouteParams } from "../../src/web/router";
import { SCREENS } from "../../src/web/screens";
import { installFakeApi } from "./api-fake";
import { fullVault } from "./fixtures";
import { renderWithSession } from "./render";

// Every page and section that isn't built yet says so plainly: its name, what it is for, that it
// isn't available, and what it waits for. It offers nothing to press or fill in, no sample and no
// count, and at most one plain way back. Each room's stage adds its own placeholders to the lists
// these tests read, and a placeholder section's page to the map below.

/** The real page each placeholder section is shown on. */
const SECTION_PAGES: Record<PlaceholderSectionName, () => ReactNode> = {
  rules: () => <RulesInterim />,
  liveAccess: () => <CoachesInterim />,
  recruitersVisibility: () => <RecruitersInterim />,
};

const SAMPLE: Required<RouteParams> = { id: "sample-id", resumeId: "res-ready", jobTab: "fit", section: "profile" };

/** A placeholder's address, with any parameter filled in. */
function addressOf(name: PlaceholderName): string {
  const entry = ROUTES.find((route) => route.name === name)!;
  return entry.paths[0]!.replace(/:(\w+)/g, (_, param: keyof RouteParams) => encodeURIComponent(SAMPLE[param]));
}

/** Nothing in `within` a person could press or fill in, and no count. */
function nothingToDo(within: HTMLElement) {
  expect(within.querySelectorAll("input, select, textarea, button, [role='button'], form")).toHaveLength(0);
  expect(within.querySelectorAll(".rs-nav__count, .app-n, .rs-num")).toHaveLength(0);
}

describe("placeholders", () => {
  it("renders every placeholder page with its title, lede, mark and note, and no input, select, textarea, button, count or link but its one way back", () => {
    const state = fullVault();
    installFakeApi(state);
    const names = Object.keys(PLACEHOLDERS) as PlaceholderName[];
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) {
      const copy: { title: string; lede: string; note: string; back?: { label: string; to: string } } = PLACEHOLDERS[name];
      const route = parseRoute(addressOf(name));
      expect(route.name, name).toBe(name);
      expect(SCREENS[name].title, name).toBe(copy.title);
      const shown = renderWithSession(<main>{SCREENS[name].render(route)}</main>, state.me);
      const page = shown.container;
      expect(screen.getByRole("heading", { level: 1 }), name).toHaveTextContent(copy.title);
      expect(page.querySelector(".rs-lede"), name).toHaveTextContent(copy.lede);
      const mark = page.querySelector(".rs-mark");
      expect(mark, name).toHaveTextContent("Not available yet");
      expect(mark, name).toHaveClass("rs-mark--note");
      expect(page.querySelectorAll(".rs-mark"), name).toHaveLength(1);
      expect(screen.getByText(copy.note), name).toBeInTheDocument();
      nothingToDo(page);
      const links = within(page).queryAllByRole("link");
      if (copy.back) {
        expect(links.map((link) => [link.textContent, link.getAttribute("href")]), name).toEqual([[copy.back.label, copy.back.to]]);
        // The way back leads to a page that is built.
        const back = parseRoute(copy.back.to).name;
        expect(Object.keys(PLACEHOLDERS), name).not.toContain(back);
      } else expect(links, name).toEqual([]);
      // Its words are the interface's: curly quotes, no exclamation, no "please".
      expect(page.textContent, name).not.toMatch(/'|!|please/i);
      shown.unmount();
    }
  });

  it("does the same for each placeholder section inside its real page", async () => {
    const state = fullVault();
    installFakeApi(state);
    for (const name of Object.keys(PLACEHOLDER_SECTIONS) as PlaceholderSectionName[]) {
      const copy = PLACEHOLDER_SECTIONS[name];
      const shown = renderWithSession(<main>{SECTION_PAGES[name]()}</main>, state.me);
      // The real page is there around it, with its own heading.
      expect(screen.getByRole("heading", { level: 1 }), name).toBeInTheDocument();
      const section = await screen.findByRole("region", { name: copy.title });
      expect(within(section).getByRole("heading", { level: 2, name: copy.title }), name).toBeInTheDocument();
      expect(section.querySelector(".rs-mark--note"), name).toHaveTextContent("Not available yet");
      expect(within(section).getByText(copy.note), name).toBeInTheDocument();
      nothingToDo(section);
      expect(within(section).queryAllByRole("link"), name).toEqual([]);
      expect(section.textContent, name).not.toMatch(/'|!|please/i);
      shown.unmount();
    }
  });

  it("every placeholder's address is in the route table", () => {
    const routed = new Set<string>(ROUTES.map((route) => route.name));
    for (const name of Object.keys(PLACEHOLDERS)) expect(routed.has(name), name).toBe(true);
    // And each placeholder section has the page it is shown on.
    expect(Object.keys(SECTION_PAGES).sort()).toEqual(Object.keys(PLACEHOLDER_SECTIONS).sort());
  });

  it("each hiring page says what it waits for, with no control", () => {
    const state = fullVault();
    installFakeApi(state);
    const waits: Record<string, RegExp> = {
      hiringOpenings: /^The hiring workspace isn’t open yet\. Openings wait for organisation verification, legal sign-off and the result of a paid pilot\.$/,
      hiringCandidates: /^The hiring workspace isn’t open yet\. Searching for candidates waits for legal sign-off and the result of a paid pilot\.$/,
      hiringIntroductions: /^The hiring workspace isn’t open yet\. Introductions open first, arranged by hand in a small paid pilot, once it has legal sign-off\.$/,
      hiringOrganisation: /^The hiring workspace isn’t open yet\. Organisations wait for verification checks and legal sign-off\.$/,
    };
    const hiring = ROUTES.filter((route) => route.workspace === "hiring").map((route) => route.name);
    expect(hiring.sort()).toEqual(Object.keys(waits).sort());
    // There is no page for an opening's applicants: the board marks it Later, and it has no address.
    expect(ROUTES.flatMap((route) => route.paths).filter((path) => /applicant/i.test(path))).toEqual([]);
    for (const name of hiring) {
      const route = parseRoute(addressOf(name as PlaceholderName));
      const shown = renderWithSession(<main>{SCREENS[name].render(route)}</main>, state.me);
      expect(shown.container.querySelector(".app-placeholder__note")!.textContent, name).toMatch(waits[name]!);
      nothingToDo(shown.container);
      // Its one way back is to looking for work.
      expect(within(shown.container).getAllByRole("link").map((link) => link.textContent), name).toEqual(["Back to looking for work"]);
      shown.unmount();
    }
    // Coaching's organisation is a placeholder too, and leads back to the clients that are real.
    const organisation = renderWithSession(<main>{SCREENS.coachingOrganisation.render(parseRoute("#/coaching/organisation"))}</main>, state.me);
    expect(screen.getByText("A coaching practice shares one client list, so a colleague can pick up where you left off.")).toBeInTheDocument();
    expect(screen.getByText("Coaching organisations and seats open later. A client will still choose who may read their copy.")).toBeInTheDocument();
    expect(within(organisation.container).getByRole("link", { name: "Back to your clients" })).toHaveAttribute("href", "#/coaching/clients");
  });
});
