import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { CardPreview, PrivateCard } from "../../src/shared/card";
import { isCardPreview } from "../../src/web/card-preview";
import { CardPreviewSection } from "../../src/web/components/CardPreview";
import { SharingRecruiters } from "../../src/web/pages/sharing/SharingRecruiters";
import { installFakeApi } from "./api-fake";
import { fixtures, fullVault, type Fixtures } from "./fixtures";
import { renderWithSession } from "./render";

const ROUTE = /^\/api\/v2\/card-preview$/;
const ALWAYS =
  "Only you can see this. Nothing is published: there’s no way to make an anonymous profile visible to anyone, and this preview doesn’t change that.";
const INTRO =
  "If you ever chose to be found, recruiters would see an anonymous profile like this instead of your resume. It’s built only from tags you’ve confirmed on your jobs and facts. It never holds your name, employers, dates or your own words, or anything from a fact you keep private.";
const EMPTY =
  "Your anonymous profile is empty. It uses only confirmed tags, and none of yours are confirmed: tags are still being tested, and nobody can confirm one in Resumatic yet.";
const UNAVAILABLE = "This preview isn’t available here yet. It needs the list of occupations and skills that tags come from, and that isn’t connected.";
const LEFT_OUT =
  "An anonymous profile would also say where you’d work, the kinds of job you want and when you could start. Those come from what you’re looking for, which this preview doesn’t read.";
const TITLE = "What a recruiter would see";
const LOADING = "Loading the preview…";
const CREDITS = "Occupations and skills come from ESCO and O*NET. See the credits";
const EXPERIENCE_HINT = "Counted from your confirmed jobs’ dates, with overlaps counted once.";
const SKILLS_HINT = "Each is shown as the broader group it belongs to, and only if a confirmed fact shows it.";
/** What the page says for a fault and for a reply it won't take: fixed sentences, never the server's detail. */
const FAULT = "Something went wrong in Resumatic. Try again in a moment.";
const BUSY = "Resumatic is busy right now. Try again in a minute.";
const VERSION = "esco-1.2.1+onet-31.0+3f810824";
const ready = (card: Partial<PrivateCard> = {}): CardPreview => ({ state: "ready", taxonomyVersion: VERSION, card: { occupation: null, experience: null, skills: [], ...card } });
const full = () => fullVault().cardPreview as Extract<CardPreview, { state: "ready" }>;

/** The section by itself, in a signed-in session, over the fake API, once it has loaded. */
async function open(change: (state: Fixtures) => void = () => {}) {
  const state = fixtures();
  state.me.capabilities = { ocr: false, connectedApps: false, cardPreview: true };
  change(state);
  const api = installFakeApi(state);
  const page = renderWithSession(<CardPreviewSection />, state.me);
  const section = await screen.findByRole("region", { name: TITLE });
  await waitFor(() => expect(within(section).queryByText(LOADING)).toBeNull());
  return { state, api, page, section, text: () => section.textContent!.replace(/\s+/g, " ") };
}
/** Each element's words, and a list's items, one after another with a space between. */
const words = (element: Element): string =>
  element.children.length ? [...element.children].map(words).join(" ") : element.textContent!.replace(/\s+/g, " ").trim();
/** The fields of the card, each as its term and what it reads. */
const fields = (section: HTMLElement) => [...section.querySelectorAll("dl > div")].map((entry) => [words(entry.querySelector("dt")!), words(entry.querySelector("dd")!)]);

describe("the card preview on Recruiters", () => {
  it("is absent from Recruiters when the preview is off", async () => {
    for (const capabilities of [undefined, { ocr: false, connectedApps: true }, { ocr: false, connectedApps: true, cardPreview: false }]) {
      const state = fullVault();
      state.me.capabilities = capabilities;
      const api = installFakeApi(state);
      const page = renderWithSession(<SharingRecruiters />, state.me);
      await screen.findByRole("button", { name: "Save preferences" });
      expect(screen.queryByRole("heading", { name: TITLE })).toBeNull();
      // Nothing asked for it either.
      expect(api.callsTo("GET", ROUTE)).toEqual([]);
      page.unmount();
    }
    // Switched on, it sits in the main column, under whether recruiters can find you.
    const state = fullVault();
    const api = installFakeApi(state);
    renderWithSession(<SharingRecruiters />, state.me);
    await screen.findByText("Web platform development software");
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Can recruiters find you?",
      TITLE,
      "Requests to meet you",
      "What you’re looking for",
    ]);
    expect(api.callsTo("GET", ROUTE)).toHaveLength(1);
  });

  it("always says only the owner can see it and nothing is published", async () => {
    for (const cardPreview of [undefined, { state: "unavailable" } as const, full()]) {
      const { page, section, text } = await open((state) => (state.cardPreview = cardPreview));
      expect(section.querySelector(".rs-msg")!.textContent!.replace(/\s+/g, " ")).toBe(ALWAYS);
      // Part of the section, not an announcement each time the page opens.
      expect(section.querySelector(".rs-msg")).not.toHaveAttribute("role");
      expect(text()).toContain(INTRO);
      expect(text()).toContain(LEFT_OUT);
      expect(text()).toContain(CREDITS);
      page.unmount();
    }
    // While it loads, and when loading fails, too.
    const state = fixtures();
    state.me.capabilities = { ocr: false, connectedApps: false, cardPreview: true };
    installFakeApi(state).fail("GET", ROUTE, 500, "internal", "boom");
    renderWithSession(<CardPreviewSection />, state.me);
    expect(screen.getByText(LOADING)).toBeInTheDocument();
    expect(screen.getByText(ALWAYS)).toBeInTheDocument();
    await screen.findByRole("alert");
    expect(screen.getByText(ALWAYS)).toBeInTheDocument();
  });

  it("says why an empty card is empty", async () => {
    const { page, section, api } = await open();
    expect(within(section).getByText(EMPTY)).toBeInTheDocument();
    expect(fields(section)).toEqual([
      ["Occupation", "Not known yet"],
      ["Experience", `No confirmed jobs yet ${EXPERIENCE_HINT}`],
      ["Skills", `None confirmed yet ${SKILLS_HINT}`],
    ]);
    expect(api.callsTo("GET", ROUTE)).toHaveLength(1);
    page.unmount();
    // A band alone comes from dates, not tags: the card is still empty of everything a tag gives.
    const banded = await open((state) => (state.cardPreview = ready({ experience: "unknown" })));
    expect(within(banded.section).getByText(EMPTY)).toBeInTheDocument();
    expect(fields(banded.section)[1]).toEqual(["Experience", `Unknown: a confirmed job is missing a date ${EXPERIENCE_HINT}`]);
    banded.page.unmount();
    // One skill and it is no longer empty.
    const one = await open((state) => (state.cardPreview = ready({ skills: [{ id: "esco:skill:S1", label: "management skills" }] })));
    expect(one.text()).not.toContain(EMPTY);
  });

  it("says when the preview is unavailable", async () => {
    const { section, text } = await open((state) => (state.cardPreview = { state: "unavailable" }));
    expect(within(section).getByText(UNAVAILABLE)).toBeInTheDocument();
    expect(section.querySelector("dl")).toBeNull();
    expect(text()).not.toContain(EMPTY);
  });

  it("shows the occupation, band and skill groups and nothing else", async () => {
    const { page, section, text } = await open((state) => (state.cardPreview = full()));
    expect(fields(section)).toEqual([
      ["Occupation", "software developer"],
      ["Experience", `5 to 10 years ${EXPERIENCE_HINT}`],
      ["Skills", `Web platform development software leading and motivating ${SKILLS_HINT}`],
    ]);
    expect(within(section).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Web platform development software", "leading and motivating"]);
    // Three fields, no IDs, no version, and no empty card's explanation.
    expect(text()).not.toMatch(/esco:|onet:|3f810824/);
    expect(text()).not.toContain(EMPTY);
    // The credits are a link away.
    expect(within(section).getByRole("link", { name: "See the credits" })).toHaveAttribute("href", "#/privacy");
    page.unmount();
    // Each band in words.
    for (const [band, words] of [["under-2", "Under 2 years"], ["2-5", "2 to 5 years"], ["5-10", "5 to 10 years"], ["10-plus", "10 years or more"]] as const) {
      const other = await open((state) => (state.cardPreview = ready({ experience: band })));
      expect(fields(other.section)[1]).toEqual(["Experience", `${words} ${EXPERIENCE_HINT}`]);
      other.page.unmount();
    }
  });

  it("shows a fixed sentence when loading fails", async () => {
    const state = fixtures();
    state.me.capabilities = { ocr: false, connectedApps: false, cardPreview: true };
    const api = installFakeApi(state);
    // A fault carries none of its own words to the page.
    api.fail("GET", ROUTE, 500, "internal", "D1_ERROR: no such table: concepts");
    renderWithSession(<CardPreviewSection />, state.me);
    expect(await screen.findByRole("alert")).toHaveTextContent(FAULT);
    expect(document.body.textContent).not.toContain("D1_ERROR");
    expect(document.querySelector("dl")).toBeNull();
    // Switched off where the page still offered it: the busy sentence, and it can be tried again.
    api.fail("GET", ROUTE, 503, "unavailable", "The card preview is switched off.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(BUSY);
    // And once it answers, the card.
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(EMPTY)).toBeInTheDocument();
  });

  it("refuses an incomplete reply", async () => {
    const { card } = full();
    const long = "x".repeat(301);
    const skill = { id: "esco:skill:S1", label: "management skills" };
    const refused: unknown[] = [
      null,
      {},
      [{ state: "unavailable" }],
      { state: "unknown" },
      { state: "unavailable", reason: "no taxonomy" },
      { state: "ready", taxonomyVersion: VERSION },
      { state: "ready", card },
      { state: "ready", taxonomyVersion: "", card },
      { state: "ready", taxonomyVersion: VERSION, card, extra: true },
      { state: "ready", taxonomyVersion: VERSION, card: { occupation: null, skills: [] } },
      { state: "ready", taxonomyVersion: VERSION, card: { ...card, seniority: "senior" } },
      { state: "ready", taxonomyVersion: VERSION, card: { ...card, experience: "3-4" } },
      { state: "ready", taxonomyVersion: VERSION, card: { ...card, experience: 7 } },
      { state: "ready", taxonomyVersion: VERSION, card: { ...card, occupation: "software developer" } },
      { state: "ready", taxonomyVersion: VERSION, card: { ...card, occupation: { id: "esco:occupation:x" } } },
      { state: "ready", taxonomyVersion: VERSION, card: { ...card, occupation: { id: "esco:occupation:x", label: "x", evidence: "self-declared" } } },
      { state: "ready", taxonomyVersion: VERSION, card: { ...card, skills: "management skills" } },
      { state: "ready", taxonomyVersion: VERSION, card: { ...card, skills: [{ ...skill, label: "" }] } },
      { state: "ready", taxonomyVersion: VERSION, card: { ...card, skills: [{ ...skill, label: long }] } },
      { state: "ready", taxonomyVersion: VERSION, card: { ...card, skills: [{ ...skill, id: long }] } },
      { state: "ready", taxonomyVersion: VERSION, card: { ...card, skills: [{ ...skill, label: 4 }] } },
      { state: "ready", taxonomyVersion: VERSION, card: { ...card, skills: Array.from({ length: 13 }, (_, n) => ({ id: `esco:skill:S${n}`, label: `group ${n}` })) } },
    ];
    for (const value of refused) expect(isCardPreview(value), JSON.stringify(value)).toBe(false);
    const twelve = Array.from({ length: 12 }, (_, n) => ({ id: `esco:skill:S${n}`, label: "x".repeat(300) }));
    for (const value of [{ state: "unavailable" }, full(), ready(), ready({ experience: "unknown", skills: twelve })]) expect(isCardPreview(value), JSON.stringify(value)).toBe(true);

    // On the page, a reply that isn't whole is never shown as a card.
    const { section } = await open((state) => (state.cardPreview = { ...full(), card: { ...card, seniority: "senior" } } as unknown as CardPreview));
    expect(within(section).getByRole("alert")).toHaveTextContent(BUSY);
    expect(section.querySelector("dl")).toBeNull();
    expect(section.textContent).not.toContain("software developer");
  });
});
