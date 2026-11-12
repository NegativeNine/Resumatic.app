import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import type { ResumeView } from "../../src/shared/api";
import type { OwnerCommentThread, ShareSuggestion } from "../../src/shared/sharing";
import { App } from "../../src/web/App";
import { isWrittenAnswer } from "../../src/web/components/ResumeReport";
import { VAULT_CHANGED } from "../../src/web/live";
import { JobPage } from "../../src/web/pages/jobs/JobPage";
import { checkSentence } from "../../src/web/resume-check";
import { installFakeApi, type FakeApi } from "./api-fake";
import { fixtures, fullVault, type Fixtures } from "./fixtures";
import { goTo, renderWithSession } from "./render";

// A resume on its job's Resume tab: the sheet as the PDF prints it, one sentence about its check, a
// mark beside each line that differs, and the one card that says where a chosen line came from.

async function openResume(state: Fixtures = fixtures()): Promise<FakeApi> {
  const api = installFakeApi(state);
  renderWithSession(<JobPage id="app-litware" tab="resume" />, state.me);
  await screen.findByRole("article", { name: "Resume preview" });
  return api;
}

const sheet = () => screen.getByRole("article", { name: "Resume preview" });
const marks = () => document.querySelector<HTMLUListElement>(".app-line-marks")!;
/** A line's mark, by the line's ID. */
const mark = (lineId: string) => document.querySelector<HTMLButtonElement>(`[data-note-for="${lineId}"] button`)!;
const card = () => screen.queryByRole("region", { name: "Where this line came from" });
const sentence = () => document.querySelector(".app-check-sentence")?.textContent ?? null;

const LATENCY = "Reduced p95 API latency from 900 ms to 210 ms by moving hot paths to Redis.";
const MIGRATION = "Led the migration of 40 services from Heroku to Kubernetes.";

/** Every line of the fixture resume backed as written. */
function allBacked(state: Fixtures): Fixtures {
  const resume = state.resumes["res-ready"]!;
  for (const line of [resume.body!.summary!, ...resume.body!.sections.flatMap((section) => section.lines)]) {
    line.status = "kept";
    delete line.finding;
  }
  resume.report = { ...resume.report!, repaired: 0, replaced: 0, dropped: 0 };
  return state;
}

/** A coach's suggested wording waiting on a line of the fixture resume. */
function suggestion(lineId: string, state: ShareSuggestion = { state: "waiting" }): OwnerCommentThread {
  return {
    target: { kind: "line", resumeId: "res-ready", version: 2, lineId },
    quote: LATENCY,
    grantId: "sh-1",
    coachEmail: "dana@example.test",
    open: true,
    comments: [{ id: `s-${lineId}`, author: "coach", body: "Cut p95 latency from 900 ms to 210 ms with Redis.", createdAt: 1794000000000, name: "Dana Okafor", seen: false, suggestion: state }],
  };
}

describe("the resume sheet", () => {
  it("prints the profile header, like the PDF", async () => {
    await openResume();
    expect(within(sheet()).getByRole("heading", { level: 1, name: "Sam Rivera" })).toBeInTheDocument();
    expect(within(sheet()).getByText("sam.rivera@example.com · Waterloo, ON · linkedin.com/in/samrivera")).toBeInTheDocument();
  });

  it("prints the contact details captured with the version, not today’s", async () => {
    const state = fixtures();
    state.resumes["res-ready"]!.profile = { ...state.me.profile, name: "Samantha Rivera", location: "Toronto, ON" };
    await openResume(state);
    expect(within(sheet()).getByRole("heading", { level: 1, name: "Samantha Rivera" })).toBeInTheDocument();
    expect(within(sheet()).getByText(/Toronto, ON/)).toBeInTheDocument();
  });

  it("orders sections as the template does, with every non-education role under Experience", async () => {
    await openResume();
    expect(within(sheet()).getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Experience", "Education", "Skills"]);
    expect(within(sheet()).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Senior Backend Engineer, Northwind Logistics",
      "Software Engineer, Contoso Health",
      "Volunteer data engineer, Fabrikam Transit Data",
      "BASc, Computer Engineering, University of Waterloo",
    ]);
    expect(within(sheet()).getByText("Mar 2021 – Present")).toBeInTheDocument();
    expect(within(sheet()).getByText("Python · Apache Airflow · Redis · PostgreSQL · Kubernetes")).toBeInTheDocument();
  });

  it("keeps marks and tools off the paper", async () => {
    await openResume();
    expect(sheet().querySelector("button, .rs-mark, [role='button']")).toBeNull();
    await userEvent.click(within(sheet()).getByText(LATENCY));
    expect(sheet().querySelector("button, .rs-mark, [role='button']")).toBeNull();
  });
});

describe("the check sentence", () => {
  const resume = (version: number, statuses: ("kept" | "repaired" | "replaced")[], dropped: number): [ResumeView, NonNullable<ResumeView["body"]>] => {
    const state = fixtures();
    const base = state.resumes["res-ready"]!;
    const lines = statuses.map((status, i) => ({ id: `l${i}`, text: `Line ${i}`, factIds: ["fact-migration"], status }));
    const body = { ...base.body!, summary: null, sections: [{ ...base.body!.sections[0]!, lines }], skills: [] };
    return [{ ...base, version, body, report: { ...base.report!, dropped } }, body];
  };
  const say = (version: number, statuses: ("kept" | "repaired" | "replaced")[], dropped = 0) => checkSentence(...resume(version, statuses, dropped));

  it("says every line is backed, then each kind of difference, singular and plural", () => {
    expect(say(2, ["kept", "kept"])).toBe("Every line is backed by your record.");
    expect(say(2, ["repaired"])).toBe("Every line is backed by your record; 1 was corrected.");
    expect(say(2, ["repaired", "repaired"])).toBe("Every line is backed by your record; 2 were corrected.");
    expect(say(2, ["replaced"])).toBe("Every line is backed by your record; 1 uses your record’s own words.");
    expect(say(2, ["replaced", "replaced", "replaced"])).toBe("Every line is backed by your record; 3 use your record’s own words.");
    expect(say(2, ["repaired", "replaced"])).toBe("Every line is backed by your record; 1 was corrected and 1 uses your record’s own words.");
    expect(say(1, ["kept"], 1)).toBe("Every line is backed by your record; 1 draft line was left out.");
    expect(say(1, ["kept"], 2)).toBe("Every line is backed by your record; 2 draft lines were left out.");
    expect(say(1, ["repaired", "replaced"], 1)).toBe(
      "Every line is backed by your record; 1 was corrected, 1 uses your record’s own words and 1 draft line was left out.",
    );
    expect(say(1, ["repaired", "repaired", "replaced", "replaced"], 3)).toBe(
      "Every line is backed by your record; 2 were corrected, 2 use your record’s own words and 3 draft lines were left out.",
    );
  });

  it("says what was left out only on version 1, tailoring’s own", () => {
    expect(say(2, ["kept"], 4)).toBe("Every line is backed by your record.");
    expect(say(3, ["repaired"], 1)).toBe("Every line is backed by your record; 1 was corrected.");
  });

  it("says nothing for a version with wording that wasn’t checked", () => {
    const [view, body] = resume(1, ["kept"], 1);
    body.sections[0]!.lines[0]!.status = "edited";
    expect(checkSentence(view, body)).toBeNull();
    expect(checkSentence({ ...view, provenance: "legacy" }, resume(1, ["kept"], 0)[1])).toBeNull();
  });

  it("says once that every line is backed when nothing differs", async () => {
    await openResume(allBacked(fixtures()));
    expect(sentence()).toBe("Every line is backed by your record.");
    expect(screen.getAllByText("Every line is backed by your record.")).toHaveLength(1);
    // No line carries a mark, and no line says Backed beside the page.
    expect(marks().querySelectorAll(".rs-mark")).toHaveLength(0);
    expect(within(marks()).queryByText("Backed")).toBeNull();
  });

  it("names what differs in one sentence", async () => {
    await openResume();
    expect(sentence()).toBe("Every line is backed by your record; 1 was corrected and 1 uses your record’s own words.");
    // Tailoring's own version also says what it left out.
    const state = fixtures();
    state.resumes["res-ready"]!.version = 1;
    cleanup();
    await openResume(state);
    expect(sentence()).toBe("Every line is backed by your record; 1 was corrected, 1 uses your record’s own words and 1 draft line was left out.");
    // The strip of counts and its legend are gone.
    expect(document.querySelector(".app-check-strip, .app-legend, .rs-report__stats")).toBeNull();
  });

  it("says no backed sentence for a version with unchecked wording", async () => {
    const state = fixtures();
    state.resumes["res-ready"]!.body!.sections[0]!.lines[0]!.status = "edited";
    await openResume(state);
    expect(sentence()).toBeNull();
    expect(screen.queryByText(/Every line is backed/)).toBeNull();
    expect(screen.getByText(/haven’t been checked against your record/)).toBeInTheDocument();
    expect(within(mark("line-migration")).getByText("Edited by you")).toBeInTheDocument();
  });
});

describe("the margin", () => {
  it("marks only the lines that differ", async () => {
    await openResume();
    const exceptions = [...marks().querySelectorAll("li")].filter((item) => !item.querySelector(".app-mark--quiet"));
    expect(exceptions.map((item) => [item.dataset.noteFor, item.querySelector("button")!.textContent])).toEqual([
      ["line-latency", expect.stringMatching(/^Corrected/)],
      ["line-mentoring", expect.stringMatching(/^Your wording/)],
    ]);
    expect(within(mark("line-latency")).getByText("Corrected")).toHaveClass("rs-mark--note");
    expect(mark("line-latency")).toHaveAccessibleName("Corrected");
    expect(mark("line-latency")).toHaveAccessibleDescription(LATENCY);
    // Every other line has its way in for the keyboard, and no mark.
    for (const id of ["line-summary", "line-migration", "line-pipeline", "line-audit", "line-dashboard"]) {
      expect(mark(id)).toHaveAccessibleName("Where this line came from");
      expect(mark(id)).toHaveClass("app-mark--quiet");
    }
  });

  it("keeps the marks a valid list with the card open beside it", async () => {
    await openResume();
    await userEvent.click(mark("line-latency"));
    const opened = card()!;
    const list = marks();
    expect([...list.children].every((child) => child.tagName === "LI")).toBe(true);
    expect(list.contains(opened)).toBe(false);
    expect(opened.parentElement).toBe(list.parentElement);
    expect(opened.parentElement).toHaveClass("app-margin-stack");
    expect(opened).not.toHaveAttribute("data-note-for");
    expect(opened).toHaveAttribute("data-card-for", "line-latency");
    expect(document.querySelector('[data-note-for="line-latency"]')).toHaveClass("is-chosen");
    const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("opens one card from the sheet or a mark, and Escape closes it, focus returning", async () => {
    await openResume();
    expect(card()).toBeNull();
    await userEvent.click(within(sheet()).getByText(LATENCY));
    const opened = card()!;
    expect(within(opened).getByRole("heading", { name: "Where this line came from" })).toHaveFocus();
    expect(within(opened).getByText(LATENCY, { selector: ".app-line-card__line" })).toBeInTheDocument();
    expect(mark("line-latency")).toHaveAttribute("aria-expanded", "true");
    expect(mark("line-latency")).toHaveAttribute("aria-controls", opened.id);
    // Only the chosen line is tinted on the sheet.
    expect([...sheet().querySelectorAll(".rs-line.is-open")].map((line) => line.getAttribute("data-line-id"))).toEqual(["line-latency"]);
    // Why it changed, in Resumatic's own words.
    expect(within(opened).getByText("The draft said 85%. Your record doesn’t include that number. Resumatic rewrote the line to match.")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(card()).toBeNull();
    expect(mark("line-latency")).toHaveFocus();
    expect(mark("line-latency")).toHaveAttribute("aria-expanded", "false");
    // From its mark, and Close.
    await userEvent.click(mark("line-mentoring"));
    expect(within(card()!).getByText(
      "The draft said you led it, which is more than your record shows. This line uses your fact’s own words instead.",
    )).toBeInTheDocument();
    await userEvent.click(within(card()!).getByRole("button", { name: "Close" }));
    expect(card()).toBeNull();
    expect(mark("line-mentoring")).toHaveFocus();
  });

  it("opening another line replaces the card", async () => {
    await openResume();
    await userEvent.click(mark("line-latency"));
    await userEvent.click(within(sheet()).getByText(MIGRATION));
    expect(screen.getAllByRole("region", { name: "Where this line came from" })).toHaveLength(1);
    expect(card()).toHaveAttribute("data-card-for", "line-migration");
    expect(mark("line-latency")).toHaveAttribute("aria-expanded", "false");
    expect(mark("line-migration")).toHaveAttribute("aria-expanded", "true");
    expect(within(card()!).getByRole("heading", { name: "Where this line came from" })).toHaveFocus();
  });

  it("a backed line’s card, reached by keyboard, says Backed and where it came from", async () => {
    await openResume();
    mark("line-latency").focus();
    await userEvent.tab();
    expect(mark("line-mentoring")).toHaveFocus();
    await userEvent.tab();
    expect(mark("line-pipeline")).toHaveFocus();
    expect(mark("line-pipeline")).toHaveAccessibleName("Where this line came from");
    await userEvent.keyboard("{Enter}");
    const opened = card()!;
    expect(within(opened).getByText("Backed")).toHaveClass("rs-mark--backed");
    expect(within(opened).getByText("Backed by your record as written.")).toBeInTheDocument();
    expect(within(opened).getByText("Fact")).toBeInTheDocument();
    expect(within(opened).getByRole("figure")).toHaveTextContent("Built claims intake pipeline (Python, Airflow) processing 2M claims/month");
    expect(within(opened).getByRole("button", { name: "Edit line" })).toBeInTheDocument();
  });

  it("makes room for a backed line’s mark while it is focused, so the card below never covers it", async () => {
    // jsdom lays nothing out and reads no stylesheet: the margin is placed as beside a wide page, a
    // hidden mark measures nothing, a focused one its button, a visible one its marks, and the card
    // its own height. Every line is at the top of the page.
    const computed = window.getComputedStyle;
    const styles = vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
      const style = computed(element, pseudo);
      const position = (element as HTMLElement).classList.contains("app-margin-stack") ? "relative" : "absolute";
      return new Proxy(style, {
        get: (target, key) => {
          if (key === "position") return position;
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    const heights = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("app-line-card")) return 200;
      if (!this.matches(".app-line-marks > li")) return 0;
      const button = this.querySelector("button")!;
      if (!button.classList.contains("app-mark--quiet")) return 24;
      return button === document.activeElement ? 32 : 0;
    });
    try {
      await openResume();
      const items = [...marks().querySelectorAll<HTMLLIElement>(":scope > li")];
      const at = items.findIndex((item, index) => item.querySelector(".app-mark--quiet") && items[index + 1]);
      const quiet = items[at]!;
      const below = items[at + 1]!;
      await userEvent.click(mark(below.dataset.noteFor!));
      const top = (element: HTMLElement) => parseFloat(element.style.top);
      expect(top(below)).toBeLessThan(top(quiet) + 32);
      act(() => mark(quiet.dataset.noteFor!).focus());
      await waitFor(() => expect(top(below)).toBeGreaterThanOrEqual(top(quiet) + 32));
      expect(top(card()!)).toBeGreaterThanOrEqual(top(quiet) + 32);
      // Focus moving on gives the room back.
      act(() => mark(below.dataset.noteFor!).focus());
      await waitFor(() => expect(top(below)).toBeLessThan(top(quiet) + 32));
    } finally {
      heights.mockRestore();
      styles.mockRestore();
    }
  });

  it("says a line check counts toward your documents for this period", async () => {
    await openResume();
    await userEvent.click(mark("line-migration"));
    await userEvent.click(within(card()!).getByRole("button", { name: "Edit line" }));
    expect(
      await within(card()!).findByText(
        "Your wording is checked against the cited facts before it replaces this line. A completed check counts toward your documents for this period.",
      ),
    ).toBeInTheDocument();
  });

  it("won't switch or close while a line is being edited, keeps the draft when a newer version arrives, and after the check reopens the same line’s card with focus on its heading", async () => {
    const state = fixtures();
    const api = await openResume(state);
    await userEvent.click(mark("line-latency"));
    await userEvent.click(within(card()!).getByRole("button", { name: "Edit line" }));
    const box = within(card()!).getByRole("textbox", { name: "Line" });
    await userEvent.clear(box);
    await userEvent.type(box, "Cut p95 API latency from 900 ms to 210 ms with Redis.");
    // Neither Escape, Close nor another line takes the card away.
    expect(within(card()!).getByText("Finish or cancel your edit to see another line.")).toBeInTheDocument();
    expect(within(card()!).getByRole("button", { name: "Close" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(sheet()).getByText(MIGRATION));
    await userEvent.click(mark("line-mentoring"));
    expect(card()).toHaveAttribute("data-card-for", "line-latency");
    expect(screen.getByRole("combobox", { name: "Saved version" })).toBeDisabled();
    // A newer version arrives: the draft stays, with a note.
    state.resumes["res-ready"]!.version = 3;
    act(() => window.dispatchEvent(new Event(VAULT_CHANGED)));
    expect(await screen.findByText(/A newer resume version is available\. Your draft is still here/)).toBeInTheDocument();
    expect(within(card()!).getByRole("textbox", { name: "Line" })).toHaveValue("Cut p95 API latency from 900 ms to 210 ms with Redis.");
    expect(within(card()!).getByRole("button", { name: "Check and save" })).toBeDisabled();
    await userEvent.click(within(card()!).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText(/A newer resume version is available/)).toBeNull());
    // Edited again against the newest version, and checked: the same line's card comes back, focus on its heading.
    state.lineChecks = "pass";
    await userEvent.click(within(card()!).getByRole("button", { name: "Edit line" }));
    const again = within(card()!).getByRole("textbox", { name: "Line" });
    await userEvent.clear(again);
    await userEvent.type(again, "Cut p95 API latency from 900 ms to 210 ms with Redis.");
    await userEvent.click(within(card()!).getByRole("button", { name: "Check and save" }));
    await waitFor(() => expect(within(sheet()).getByText("Cut p95 API latency from 900 ms to 210 ms with Redis.")).toBeInTheDocument());
    await waitFor(() => expect(within(card()!).getByRole("heading", { name: "Where this line came from" })).toHaveFocus());
    expect(card()).toHaveAttribute("data-card-for", "line-latency");
    expect(api.callsTo("POST", /^\/api\/applications\/app-litware\/documents$/).at(-1)!.body).toMatchObject({
      kind: "refine", resumeId: "res-ready", expectedVersion: 3, lineIds: ["line-latency"], manualText: "Cut p95 API latency from 900 ms to 210 ms with Redis.",
    });
  });

  it("after a line edit, the edited line reads Backed and is unmarked, and the sentence and Not in your record say what is true of the new version", async () => {
    const state = fixtures();
    state.lineChecks = "pass";
    await openResume(state);
    expect(sentence()).toBe("Every line is backed by your record; 1 was corrected and 1 uses your record’s own words.");
    await userEvent.click(mark("line-latency"));
    await userEvent.click(within(card()!).getByRole("button", { name: "Edit line" }));
    const box = within(card()!).getByRole("textbox", { name: "Line" });
    await userEvent.clear(box);
    await userEvent.type(box, "Cut p95 API latency from 900 ms to 210 ms with Redis.");
    // The check works out what's missing again for the version it makes.
    state.resumes["res-ready"]!.report!.gaps = ["Terraform"];
    await userEvent.click(within(card()!).getByRole("button", { name: "Check and save" }));
    await waitFor(() => expect(sentence()).toBe("Every line is backed by your record; 1 uses your record’s own words."));
    expect(within(card()!).getByText("Backed")).toHaveClass("rs-mark--backed");
    expect(mark("line-latency")).toHaveClass("app-mark--quiet");
    expect(mark("line-latency")).toHaveAccessibleName("Where this line came from");
    const gaps = screen.getByRole("heading", { name: "Not in your record" }).closest("section")!;
    expect(within(gaps).getAllByRole("button", { name: /^Add a fact for/ }).map((button) => button.getAttribute("aria-label"))).toEqual(["Add a fact for Terraform"]);
  });

  it("shows a coach’s waiting suggestion on its line, struck and inserted, and Accept starts the owner’s check", async () => {
    const state = fixtures();
    state.shareComments = [suggestion("line-latency")];
    const api = await openResume(state);
    await waitFor(() => expect(within(mark("line-latency")).getByText("Suggested wording")).toHaveClass("rs-mark--needs-you"));
    expect(mark("line-latency")).toHaveAccessibleName("Corrected Suggested wording");
    await userEvent.click(mark("line-latency"));
    const opened = card()!;
    expect(within(opened).getByRole("deletion")).toHaveTextContent(`Line in the copy: ${LATENCY}`);
    expect(within(opened).getByRole("insertion")).toHaveTextContent("Suggested: Cut p95 latency from 900 ms to 210 ms with Redis.");
    expect(within(opened).getByText("From Dana Okafor")).toBeInTheDocument();
    const accept = within(opened).getByRole("button", { name: "Accept and check" });
    expect(accept).not.toHaveClass("rs-btn--primary");
    // Opening the card doesn't mark the comment seen: Sharing does that.
    await userEvent.click(accept);
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/shares\/suggestions\/s-line-latency\/accept$/)).toHaveLength(1));
    expect(await within(card()!).findByText("Checking this wording against the cited facts…")).toBeInTheDocument();
    expect(api.callsTo("POST", /\/comments\/seen$/)).toHaveLength(0);
    // Other lines have no suggestion.
    expect(within(mark("line-mentoring")).queryByText("Suggested wording")).toBeNull();
  });

  it("says suggestions couldn’t be loaded when the comments read fails, and still shows the resume", async () => {
    const state = fixtures();
    const api = installFakeApi(state);
    api.fail("GET", /^\/api\/shares\/comments$/, 503, "unavailable", "busy");
    renderWithSession(<JobPage id="app-litware" tab="resume" />, state.me);
    await screen.findByRole("article", { name: "Resume preview" });
    const note = await screen.findByText("Suggestions from your coach couldn’t be loaded.");
    // Above the sheet, not in a card.
    expect(note.compareDocumentPosition(sheet()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mark("line-latency")).toBeInTheDocument();
    await userEvent.click(mark("line-latency"));
    expect(card()).not.toBeNull();
    expect(within(card()!).queryByText(/couldn’t be loaded/)).toBeNull();
    // A server without comments has none, and says nothing.
    cleanup();
    const quiet = installFakeApi(fixtures());
    quiet.fail("GET", /^\/api\/shares\/comments$/, 404, "not_found", "no such route");
    renderWithSession(<JobPage id="app-litware" tab="resume" />, fixtures().me);
    await screen.findByRole("article", { name: "Resume preview" });
    await waitFor(() => expect(quiet.callsTo("GET", /^\/api\/shares\/comments$/)).toHaveLength(1));
    expect(screen.queryByText(/couldn’t be loaded/)).toBeNull();
  });

  it("opens the card as a sheet from the bottom below 860px", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(max-width: 860px)", media: query, addEventListener() {}, removeEventListener() {} }));
    await openResume();
    await userEvent.click(mark("line-latency"));
    const opened = screen.getByRole("dialog", { name: "Where this line came from" });
    expect(opened).toHaveAttribute("data-presentation", "sheet");
    expect(opened).toHaveAttribute("aria-modal", "false");
    expect(opened.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mark("line-latency")).toHaveFocus();
  });

  it("lists what’s not in your record at the end, with Add a fact", async () => {
    await openResume();
    const heading = screen.getByRole("heading", { name: "Not in your record" });
    const panel = heading.closest("section")!;
    expect(within(panel).getByText(
      "What this job asks for that your confirmed facts didn’t cover when this version’s lines were last checked. Facts you’ve added since aren’t counted here.",
    )).toBeInTheDocument();
    expect(within(panel).getAllByRole("button", { name: /^Add a fact for/ })).toHaveLength(2);
    expect(within(panel).getByText(/Resumatic never fills in what’s missing by itself\./)).toBeInTheDocument();
    // After the sheet, beside it.
    expect(sheet().compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing listed is said plainly, without claiming more.
    const state = fixtures();
    state.resumes["res-ready"]!.report!.gaps = [];
    cleanup();
    await openResume(state);
    expect(screen.getByText("Nothing is listed as missing for this version. That isn’t a check against the whole job description, so read the two side by side.")).toBeInTheDocument();
  });

  it("offers PDF, Word and print preview only for a version every check passed", async () => {
    await openResume();
    expect(screen.getByRole("link", { name: "Download PDF" })).toHaveAttribute("href", "/api/resumes/res-ready/pdf?version=2");
    expect(screen.getByRole("link", { name: "Download Word" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Print preview" })).toBeInTheDocument();
    const state = fixtures();
    state.resumes["res-ready"]!.body!.sections[0]!.lines[0]!.status = "edited";
    cleanup();
    await openResume(state);
    for (const name of ["Download PDF", "Download Word", "Print preview"]) expect(screen.queryByRole("link", { name })).toBeNull();
  });
});

describe("a version that uses a fact kept private", () => {
  const NOTICE =
    "This version uses a fact you keep private, or was checked against the line of an upload one was read from, so it can’t be downloaded or shared, and connected apps can’t read it.";
  /** The fixture resume as the server sends it once one cited fact and one printed skill are marked. */
  function marked(): Fixtures {
    const state = fixtures();
    state.resumes["res-ready"]!.sensitiveUse = { lineIds: ["line-migration"], skills: ["Redis"] };
    return state;
  }

  it("offers its downloads as usual while nothing it uses is marked", async () => {
    await openResume();
    for (const name of ["Download PDF", "Download Word", "Print preview"]) expect(screen.getByRole("link", { name })).toBeInTheDocument();
    expect(screen.queryByText(/keep private/)).toBeNull();
    expect(screen.queryByText("Private fact")).toBeNull();
  });

  it("says why it can’t be downloaded or shared and what to do, and offers no download", async () => {
    await openResume(marked());
    const notice = screen.getByText(new RegExp(`^${NOTICE.replace(/[.’]/g, (c) => (c === "." ? "\\." : c))}`));
    expect(notice).toHaveTextContent(
      `${NOTICE} Remove the lines and skills marked ‘Private fact’, or tailor a new version. Your text is still here.`,
    );
    expect(notice).toHaveAttribute("role", "status");
    for (const name of ["Download PDF", "Download Word", "Print preview"]) expect(screen.queryByRole("link", { name })).toBeNull();
    // The text is still on the sheet, and a new version can still be tailored.
    expect(within(sheet()).getByText(MIGRATION)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Tailor a new version" }).length).toBeGreaterThan(0);
    // It is not the notice for unchecked wording, and no line-by-line review is offered.
    expect(screen.queryByText(/haven’t been checked against your record/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Start review" })).toBeNull();
  });

  it("marks the lines that use it, and lets them be removed but not reworded", async () => {
    const state = marked();
    const api = await openResume(state);
    // The line that uses it carries its mark beside the page, and only that line.
    expect(within(mark("line-migration")).getByText("Private fact")).toHaveClass("rs-mark--note");
    expect(within(marks()).getAllByText("Private fact")).toHaveLength(1);
    await userEvent.click(mark("line-migration"));
    const opened = card()!;
    expect(within(opened).getByText("Private fact")).toBeInTheDocument();
    expect(within(opened).getByText("Led migration of 40 services from Heroku to Kubernetes")).toBeVisible();
    expect(within(opened).queryByRole("button", { name: "Edit line" })).toBeNull();
    expect(within(opened).getByRole("button", { name: "Remove line (keeps earlier versions)" })).toBeVisible();
    // Every other line is as it always is: editable once its card is open.
    await userEvent.click(mark("line-latency"));
    expect(within(card()!).getByRole("button", { name: "Edit line" })).toBeVisible();
    await userEvent.click(mark("line-migration"));
    // Removing the line is the existing request, for this line and this version.
    await userEvent.click(within(card()!).getByRole("button", { name: "Remove line (keeps earlier versions)" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/resumes\/res-ready\/remove-line$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/resumes\/res-ready\/remove-line$/)[0]!.body).toEqual({ lineId: "line-migration", expectedVersion: 2 });
    // The new version has no such line, so no card; focus goes to the resume's heading.
    await waitFor(() => expect(document.querySelector('[data-note-for="line-migration"]')).toBeNull());
    expect(card()).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: /^Tailored / })).toHaveFocus();
    // A marked skill still holds it back.
    expect(screen.getByText(/keep private, or was checked against/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Download PDF" })).toBeNull();
    // With the skill removed as well, nothing does, and the downloads are back.
    await userEvent.click(screen.getByRole("button", { name: "Remove skill Redis" }));
    expect(await screen.findByRole("link", { name: "Download PDF" })).toHaveAttribute("href", "/api/resumes/res-ready/pdf?version=4");
    expect(screen.queryByText(/keep private/)).toBeNull();
    expect(screen.queryByText("Private fact")).toBeNull();
    expect(api.callsTo("POST", /^\/api\/resumes\/res-ready\/remove-skill$/)[0]!.body).toEqual({ skillIndex: 2, expectedVersion: 3 });
  });

  it("marks the printed skills only marked facts stand behind, under Change this version", async () => {
    await openResume(marked());
    const tools = screen.getByRole("region", { name: "Change this version" });
    const skill = (name: string) => within(tools).getByRole("button", { name: `Remove skill ${name}` }).closest("li")!;
    expect(within(skill("Redis")).getByText("Private fact")).toHaveClass("rs-mark--note");
    for (const name of ["Python", "Apache Airflow", "PostgreSQL", "Kubernetes"]) expect(within(skill(name)).queryByText("Private fact")).toBeNull();
    expect(within(skill("Redis")).getByRole("button", { name: "Remove skill Redis" })).toBeEnabled();
  });

  it("tells the reader of a saved version to go to Latest to change it", async () => {
    const state = marked();
    const api = installFakeApi(state);
    // An earlier version is saved too.
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "/api/resumes/res-ready/versions"
        ? new Response(JSON.stringify({ versions: [{ version: 1, createdAt: 1794040000000 }, { version: 2, createdAt: 1794044520000 }] }), { headers: { "content-type": "application/json" } })
        : api.fetch(input, init)));
    renderWithSession(<JobPage id="app-litware" tab="resume" />, state.me);
    await screen.findByRole("article", { name: "Resume preview" });
    // The saved version reads as it was saved, and is only read.
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Saved version" }), await screen.findByRole("option", { name: /^Version 1, saved/ }));
    await waitFor(() => expect(api.callsTo("GET", /^\/api\/resumes\/res-ready\?version=1$/)).toHaveLength(1));
    const notice = await screen.findByText(new RegExp(`^${NOTICE.replace(/[.’]/g, (c) => (c === "." ? "\\." : c))}`));
    expect(notice).toHaveTextContent(`${NOTICE} Your text is still here. Select Latest to change it.`);
    expect(screen.queryByRole("link", { name: "Download PDF" })).toBeNull();
    await userEvent.click(mark("line-migration"));
    expect(within(card()!).getByText("Private fact")).toBeInTheDocument();
    expect(within(card()!).queryByRole("button", { name: /Edit line|Remove line/ })).toBeNull();
  });

  it("keeps Review line on a line of an older version under review", async () => {
    const state = marked();
    const resume = state.resumes["res-ready"]!;
    resume.provenance = "legacy";
    resume.legacyReview = { verifiedLineIds: [], totalLines: 7, headersReady: true, skillsReady: true };
    await openResume(state);
    expect(within(mark("line-migration")).getByText("Needs review")).toHaveClass("rs-mark--needs-you");
    expect(within(mark("line-migration")).getByText("Private fact")).toBeInTheDocument();
    await userEvent.click(mark("line-migration"));
    expect(within(card()!).getByRole("button", { name: "Review line" })).toBeVisible();
    expect(within(card()!).getByRole("button", { name: "Remove line (keeps earlier versions)" })).toBeVisible();
  });

  it("doesn’t offer a marked fact as evidence for a line", async () => {
    const state = fixtures();
    // An older version under review: each line is checked against facts the person chooses.
    const resume = state.resumes["res-ready"]!;
    resume.provenance = "legacy";
    resume.legacyReview = { verifiedLineIds: [], totalLines: 7, headersReady: true, skillsReady: true };
    state.facts.find((fact) => fact.id === "fact-audit")!.sensitive = true;
    await openResume(state);
    await userEvent.click(mark("line-pipeline"));
    await userEvent.click(within(card()!).getByRole("button", { name: "Review line" }));
    const choices = await within(card()!).findByRole("group", { name: "Supporting facts for this role" });
    // The role has two confirmed facts. Only the one that isn't marked can be chosen.
    await within(choices).findByRole("checkbox", { name: /Built the claims-intake pipeline/ });
    expect(within(choices).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(choices).queryByText(/audit logging/)).toBeNull();
  });

  it("says what to do for a line with nothing linked", async () => {
    const state = fixtures();
    const resume = state.resumes["res-ready"]!;
    resume.body!.sections[0]!.lines[0]!.factIds = [];
    await openResume(state);
    await userEvent.click(mark("line-migration"));
    await userEvent.click(within(card()!).getByRole("button", { name: "Edit line" }));
    expect(await within(card()!).findByText(
      "Nothing in your record is linked to this line yet. Choose up to four confirmed facts that back it. The check counts toward your documents for this period.",
    )).toBeInTheDocument();
  });

  it("is structurally accessible with its notice, marks and open card", async () => {
    await openResume(marked());
    await userEvent.click(mark("line-migration"));
    const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

describe("closing a gap", () => {
  it("asks for the person’s own words, not a bare yes", async () => {
    const api = await openResume();
    await userEvent.click(screen.getByRole("button", { name: "Add a fact for Terraform" }));
    const answer = screen.getByLabelText("Terraform: describe what you did, in your own words");
    const add = screen.getByRole("button", { name: "Add fact" });
    await userEvent.type(answer, "Yes");
    expect(add).toBeDisabled();
    await userEvent.clear(answer);
    await userEvent.type(answer, "Wrote Terraform modules for our staging network.");
    expect(add).toBeEnabled();
    await userEvent.click(add);
    expect(await screen.findByText("Fact added.")).toBeInTheDocument();
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/v2\/facts$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/v2\/facts$/)[0]!.body).toMatchObject({ text: "Wrote Terraform modules for our staging network.", roleId: null });
    const gap = screen.getByText("Fact added.").closest<HTMLElement>(".app-gap-answer")!;
    // A plain button: the page's one brand button is Download PDF.
    expect(within(gap).getByRole("button", { name: "Tailor a new version" })).not.toHaveClass("rs-btn--primary");
  });

  it("knows a written answer from a bare one", () => {
    expect(isWrittenAnswer("yes")).toBe(false);
    expect(isWrittenAnswer("Yep!")).toBe(false);
    expect(isWrittenAnswer("I did")).toBe(false);
    expect(isWrittenAnswer("Ran Kafka clusters")).toBe(true);
  });
});

describe("the resumes for a job", () => {
  it("lists every resume, newest marked Latest, and opens the newest", async () => {
    await openResume();
    const list = screen.getByRole("heading", { name: "Resumes for this job" }).closest("section")!;
    const links = within(list).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href"), link.getAttribute("aria-current")])).toEqual([
      [expect.stringMatching(/^Tailored /), "#/jobs/app-litware/resume/res-ready", "page"],
      [expect.stringMatching(/^Tailored /), "#/jobs/app-litware/resume/res-first", null],
    ]);
    expect(within(links[0]!.closest("li")!).getByText("Latest")).toBeInTheDocument();
    expect(within(links[1]!.closest("li")!).queryByText("Latest")).toBeNull();
    // The newest is the one shown, headed by when it was tailored.
    expect(screen.getByRole("heading", { level: 2, name: links[0]!.textContent! })).toBeInTheDocument();
    expect(screen.getByText("Resumes tailored to this job from your confirmed facts, every line checked.")).toBeInTheDocument();
  });

  it("says a job has no resume yet, and offers to tailor one", async () => {
    const state = fixtures();
    installFakeApi(state);
    renderWithSession(<JobPage id="app-unnamed" tab="resume" />, state.me);
    expect(await screen.findByText("No resume for this job yet. Tailoring writes one from your confirmed facts and checks every line.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tailor a resume" })).toHaveClass("primary");
  });

  it("Tailor opens the new run on the job’s page", async () => {
    const state = fixtures();
    const api = installFakeApi(state);
    goTo("#/jobs/app-unnamed/resume");
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Tailor a resume" }));
    await waitFor(() => expect(window.location.hash).toBe("#/jobs/app-unnamed/resume/res-new-1"));
    expect(api.callsTo("POST", /^\/api\/applications\/app-unnamed\/resumes$/)).toHaveLength(1);
    expect(await screen.findByRole("button", { name: "Cancel tailoring" })).toBeInTheDocument();
  });

  it("shows a running and a failed wording check under Refine wording, with Cancel and Retry", async () => {
    const state = fixtures();
    state.documents = [
      { id: "doc-check", applicationId: "app-litware", kind: "refine", state: "running", version: 1, createdAt: 1794000000000, error: null, result: null, facts: {} },
      { id: "doc-refine-failed", applicationId: "app-litware", kind: "refine", state: "failed", retryRunId: "run-refine", version: 1, createdAt: 1793000000000, error: "unavailable", result: null, facts: {} },
    ];
    const api = await openResume(state);
    const refine = screen.getByRole("region", { name: "Refine wording" });
    await userEvent.click(await within(refine).findByRole("button", { name: "Cancel this document" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/runs\/doc-check\/cancel$/)).toHaveLength(1));
    // While one runs, nothing else starts, Retry included.
    expect(within(refine).getByRole("button", { name: "Retry resume refinement" })).toBeDisabled();
    state.documents = state.documents.filter((held) => held.id !== "doc-check");
    act(() => window.dispatchEvent(new Event(VAULT_CHANGED)));
    await waitFor(() => expect(within(refine).getByRole("button", { name: "Retry resume refinement" })).toBeEnabled());
    await userEvent.click(within(refine).getByRole("button", { name: "Retry resume refinement" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/runs\/run-refine\/retry$/)).toHaveLength(1));
    // A finished check is the resume's new version, not a card here.
    expect(within(refine).queryByText("Read resume refinement")).toBeNull();
  });

  it("keeps Cancel and Retry for wording checks when the resume shown failed, or is a saved version", async () => {
    const state = fixtures();
    // The newest resume failed; a wording check on the earlier one runs, and another failed.
    state.applications[0]!.resumes.push({ id: "res-failed", state: "failed", createdAt: 1794100000000 });
    state.resumes["res-failed"] = { ...state.resumes["res-ready"]!, id: "res-failed", state: "failed", body: null, error: "unavailable", createdAt: 1794100000000 };
    state.documents = [
      { id: "doc-check", applicationId: "app-litware", kind: "refine", state: "running", version: 1, createdAt: 1794000000000, error: null, result: null, facts: {} },
      { id: "doc-refine-failed", applicationId: "app-litware", kind: "refine", state: "failed", retryRunId: "run-refine", version: 1, createdAt: 1793000000000, error: "unavailable", result: null, facts: {} },
    ];
    const api = installFakeApi(state);
    let shown = renderWithSession(<JobPage id="app-litware" tab="resume" />, state.me);
    await screen.findByText("This resume couldn’t be finished");
    let refine = await screen.findByRole("region", { name: "Refine wording" });
    // Nothing to refine here, but the runs can still be stopped and tried again.
    expect(within(refine).queryByRole("textbox")).toBeNull();
    await userEvent.click(await within(refine).findByRole("button", { name: "Cancel this document" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/runs\/doc-check\/cancel$/)).toHaveLength(1));
    expect(within(refine).getByRole("button", { name: "Retry resume refinement" })).toBeDisabled();
    shown.unmount();

    // A saved version of a ready resume.
    state.applications[0]!.resumes = state.applications[0]!.resumes.filter((resume) => resume.id !== "res-failed");
    state.documents = state.documents.filter((held) => held.id !== "doc-check");
    // An earlier version is saved too.
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "/api/resumes/res-ready/versions"
        ? new Response(JSON.stringify({ versions: [{ version: 1, createdAt: 1794040000000 }, { version: 2, createdAt: 1794044520000 }] }), { headers: { "content-type": "application/json" } })
        : api.fetch(input, init)));
    shown = renderWithSession(<JobPage id="app-litware" tab="resume" />, state.me);
    await screen.findByRole("article", { name: "Resume preview" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Saved version" }), await screen.findByRole("option", { name: /^Version 1, saved/ }));
    await screen.findByText(/This is a saved version\./);
    refine = await screen.findByRole("region", { name: "Refine wording" });
    expect(within(refine).queryByRole("textbox")).toBeNull();
    await waitFor(() => expect(within(refine).getByRole("button", { name: "Retry resume refinement" })).toBeEnabled());
    await userEvent.click(within(refine).getByRole("button", { name: "Retry resume refinement" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/runs\/run-refine\/retry$/)).toHaveLength(1));
    shown.unmount();
  });

  it("keeps the resume being edited when a newer resume for the job arrives, then shows the newest", async () => {
    const state = fixtures();
    await openResume(state);
    await userEvent.click(mark("line-latency"));
    await userEvent.click(within(card()!).getByRole("button", { name: "Edit line" }));
    const box = within(card()!).getByRole("textbox", { name: "Line" });
    await userEvent.clear(box);
    await userEvent.type(box, "Cut p95 API latency with Redis.");
    // A resume for this job is tailored elsewhere, by another window or a connected app.
    state.applications[0]!.resumes.push({ id: "res-new", state: "running", createdAt: 1794100000000 });
    state.resumes["res-new"] = { ...state.resumes["res-ready"]!, id: "res-new", state: "running", body: null, createdAt: 1794100000000 };
    act(() => window.dispatchEvent(new Event(VAULT_CHANGED)));
    expect(await screen.findByText("A newer resume for this job was started. Finish or cancel your edit to see it.")).toBeInTheDocument();
    expect(within(card()!).getByRole("textbox", { name: "Line" })).toHaveValue("Cut p95 API latency with Redis.");
    expect(sheet()).toBeInTheDocument();
    await userEvent.click(within(card()!).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Cancel tailoring" })).toBeInTheDocument();
    expect(screen.queryByText(/A newer resume for this job was started/)).toBeNull();
  });
});

describe("a resume's address", () => {
  it("puts the job in an old resume link's address once it loads, focus unmoved", async () => {
    const state = fixtures();
    const api = installFakeApi(state);
    // The resume answers only when the test lets it, so focus can be put somewhere first.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/resumes/res-ready")) await held;
      return api.fetch(input, init);
    }));
    goTo("#/resumes/res-ready");
    render(<App />);
    expect(await screen.findByText("Loading this resume…")).toBeInTheDocument();
    const back = screen.getByRole("link", { name: "Back to Jobs" });
    back.focus();
    expect(window.location.hash).toBe("#/resumes/res-ready");
    release();
    await waitFor(() => expect(window.location.hash).toBe("#/jobs/app-litware/resume/res-ready"));
    await screen.findByRole("article", { name: "Resume preview" });
    // The same page, not a new one: focus is where it was, and the resume was read once.
    expect(screen.getByRole("link", { name: "Back to Jobs" })).toBe(back);
    expect(document.activeElement).toBe(back);
    expect(api.callsTo("GET", /^\/api\/resumes\/res-ready$/)).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Platform Engineer" })).toBeInTheDocument();
  });

  it("corrects an address that names the wrong job", async () => {
    installFakeApi(fixtures());
    goTo("#/jobs/app-tailspin/resume/res-ready");
    render(<App />);
    await screen.findByRole("article", { name: "Resume preview" });
    await waitFor(() => expect(window.location.hash).toBe("#/jobs/app-litware/resume/res-ready"));
    // The header is the resume's own job's, never the one the address named.
    expect(screen.getByRole("heading", { level: 1, name: "Platform Engineer" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Senior Data Engineer" })).toBeNull();
  });
});

describe("a resume with the full vault", () => {
  it("opens a line’s card on a resume that has documents beside it", async () => {
    await openResume(fullVault());
    await userEvent.click(mark("line-latency"));
    expect(card()).not.toBeNull();
  });
});
