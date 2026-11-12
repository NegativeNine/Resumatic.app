import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { describe, expect, it } from "vitest";
import type { Me } from "../../src/shared/api";
import { emptyStanding, emptyToday, MAX_TODAY_LIST, TODAY_RECENT_MS, type Today, type TodayStanding, type TodayWaiting } from "../../src/shared/today";
import { Shell } from "../../src/web/components/Shell";
import { formatDate, formatDateTime } from "../../src/web/format";
import { COUNTS_CHANGED } from "../../src/web/live";
import { NEXT_PRIORITY, nextStep, units, waitingRow } from "../../src/web/pages/today/rows";
import { TodayPage } from "../../src/web/pages/today/TodayPage";
import { parseRoute } from "../../src/web/router";
import { installFakeApi, standingOf, type FakeApi } from "./api-fake";
import { emptyVault, fixtures, fullVault, type Fixtures } from "./fixtures";
import { renderWithSession } from "./render";

// Today, as the signed-in app shows it: inside the shell, reading the Today the shell loaded.

const NOW = 1794051720000;
const dana = { grantId: "sh-1", coachName: "Dana Okafor", coachEmail: "dana@example.test" };
const KINDS: TodayWaiting["kind"][] = ["unreadable", "suggestions", "check", "kit", "comments"];

/** Where things stand in a record with a little of everything. */
function standing(change: Partial<TodayStanding> = {}): TodayStanding {
  return { files: 2, confirmed: 9, leftOut: 1, jobs: { saved: 2, applied: 1, interview: 1, offer: 1, closed: 3 }, copies: 2, coachCopies: 1, apps: 1, ...change };
}

/** One item of every kind, listed in the server's order, which is not the order they are chosen in: eleven things in all. */
function everyKind(): Today {
  return {
    waiting: [
      { kind: "check", sourceId: "src-2024", filename: "sam-rivera-2024.pdf", roles: 1, facts: 4 },
      { kind: "unreadable", sourceId: "src-cv", filename: "sam-rivera-cv.docx", createdAt: NOW },
      { kind: "comments", ...dana, count: 2, latest: NOW },
      { kind: "suggestions", ...dana, count: 1, latest: NOW },
      { kind: "kit", applicationId: "app-litware", title: "Platform Engineer", company: "Litware", unanswered: 1, sensitive: 1 },
    ],
    working: [],
    recent: [],
    counts: { today: 11, facts: 6, jobs: 2, sharing: 3 },
    since: NOW - TODAY_RECENT_MS,
    standing: standing(),
  };
}

/** Today with these items waiting, its counts worked out from them as the server works them out. */
function waitingOnly(waiting: TodayWaiting[], extra = 0): Today {
  const sum = (kinds: string[]) => waiting.filter((item) => kinds.includes(item.kind)).reduce((total, item) => total + units(item), 0);
  const counts = { facts: sum(["check", "unreadable"]), jobs: sum(["kit"]), sharing: sum(["comments", "suggestions"]), today: 0 };
  counts.today = counts.facts + counts.jobs + counts.sharing + extra;
  return { ...everyKind(), waiting, counts };
}

function withToday(today: Today, me: Partial<Me> = {}): Fixtures {
  const state = fixtures();
  state.today = today;
  state.me = { ...state.me, ...me };
  return state;
}

/** Today in the shell, as #/today shows it, over a fake API that `prepare` may set up first. */
function showToday(state: Fixtures, prepare?: (api: FakeApi) => void) {
  const api = installFakeApi(state);
  prepare?.(api);
  const shown = renderWithSession(
    <Shell route={parseRoute("#/today")} title="Today">
      <TodayPage />
    </Shell>,
    state.me,
  );
  return { ...shown, api };
}

/** The page's lede, once Today has loaded. */
async function lede(): Promise<string> {
  await screen.findByRole("complementary", { name: /Where things stand|What to expect/ });
  return document.querySelector(".page-head .rs-lede")?.textContent ?? "";
}

const next = () => document.querySelector<HTMLElement>(".rs-next");
const nextTitle = () => next()?.querySelector("h2")?.textContent ?? null;
const section = (name: string | RegExp) => screen.queryByRole("region", { name });
const alsoWaiting = () => section(/^Also waiting for you/);
const rowsOf = (region: HTMLElement | null) => (region ? [...region.querySelectorAll<HTMLElement>("li.app-q")] : []);
const rooms = () => screen.getByRole("navigation", { name: "Rooms" });
/** What a link is called aloud: its words, without what is hidden from assistive technology. */
function spoken(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll("[aria-hidden='true']")) hidden.remove();
  return copy.textContent ?? "";
}

describe("Today's next step", () => {
  it("chooses a file that couldn't be read, then a coach's suggestion, then facts to check, then a kit, then comments", async () => {
    const titles: Record<TodayWaiting["kind"], string> = {
      unreadable: "See why sam-rivera-cv.docx couldn’t be read",
      suggestions: "Read a suggestion from Dana Okafor",
      check: "Check 1 role and 4 facts",
      kit: "Answer 2 questions for Platform Engineer at Litware",
      comments: "Read 2 new comments from Dana Okafor",
    };
    // Each time the winner is taken away, the next in the order wins.
    let waiting = everyKind().waiting;
    for (const kind of KINDS) {
      const today = waitingOnly(waiting);
      expect(nextStep(today)?.kind).toBe(kind);
      const shown = showToday(withToday(today));
      await waitFor(() => expect(nextTitle()).toBe(titles[kind]));
      expect(within(next()!).getByText("Next for you")).toBeInTheDocument();
      expect(next()!.querySelector(".rs-next__label .rs-tick--needs-you")).not.toBeNull();
      shown.unmount();
      waiting = waiting.filter((item) => item.kind !== kind);
    }
    expect(nextStep(waitingOnly([]))).toBeNull();
  });

  it("ranks every kind of waiting item exactly once", () => {
    expect(Object.keys(NEXT_PRIORITY).sort()).toEqual([...KINDS].sort());
    expect(Object.values(NEXT_PRIORITY).sort()).toEqual([0, 1, 2, 3, 4]);
    expect([...KINDS].sort((a, b) => NEXT_PRIORITY[a] - NEXT_PRIORITY[b])).toEqual(KINDS);
    // The fixture holds one of each, so every kind is drawn somewhere.
    expect(new Set(everyKind().waiting.map((item) => item.kind))).toEqual(new Set(KINDS));
  });

  it("takes the first item of a kind in the order the server lists", async () => {
    const older = { kind: "unreadable", sourceId: "old", filename: "old.docx", createdAt: NOW - 5 } as const;
    const newer = { kind: "unreadable", sourceId: "new", filename: "new.docx", createdAt: NOW } as const;
    // Newest file first, as the server lists them; a check item listed earlier still comes after.
    const today = waitingOnly([everyKind().waiting[0]!, newer, older]);
    expect(nextStep(today)).toEqual(newer);
    showToday(withToday(today));
    await waitFor(() => expect(nextTitle()).toBe("See why new.docx couldn’t be read"));
    expect(rowsOf(alsoWaiting()).map((row) => row.querySelector(".app-q__t")!.textContent)).toEqual(["old.docx couldn’t be read", "Check 1 role and 4 facts"]);
    // Two coaches' suggestions: the copy listed first.
    const lee = { grantId: "sh-2", coachName: null, coachEmail: "lee@example.test" };
    expect(nextStep(waitingOnly([{ kind: "suggestions", ...lee, count: 3, latest: NOW }, { kind: "suggestions", ...dana, count: 1, latest: NOW }]))).toMatchObject({ grantId: "sh-2" });
  });

  it("links each kind to the page that resolves it", async () => {
    expect(Object.fromEntries(everyKind().waiting.map((item) => [item.kind, waitingRow(item).to]))).toEqual({
      unreadable: "#/facts/files",
      suggestions: "#/sharing/coaches",
      check: "#/facts/check",
      kit: "#/jobs/app-litware/application",
      comments: "#/sharing/coaches",
    });
    showToday(withToday(everyKind()));
    await waitFor(() => expect(next()).not.toBeNull());
    const buttons = [next()!.querySelector("a")!, ...rowsOf(alsoWaiting()).map((row) => row.querySelector("a")!)];
    expect(buttons.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["See what to do", "#/facts/files"],
      ["Read it", "#/sharing/coaches"],
      ["Check them", "#/facts/check"],
      ["Answer", "#/jobs/app-litware/application"],
      ["Read them", "#/sharing/coaches"],
    ]);
    // The next step's is the page's one green button.
    expect(document.querySelectorAll(".rs-btn--primary")).toHaveLength(1);
    expect(next()!.querySelector("a")).toHaveClass("rs-btn", "rs-btn--primary");
  });

  it("says nothing needs you, with no green button, when nothing waits", async () => {
    showToday(withToday({ ...everyKind(), waiting: [], counts: { today: 0, facts: 0, jobs: 0, sharing: 0 } }));
    expect(await screen.findByText("Nothing needs you right now.")).toHaveClass("app-today-clear");
    expect(await lede()).toBe("Nothing is used, sent or shared until you say so.");
    expect(next()).toBeNull();
    expect(document.querySelector(".rs-btn--primary")).toBeNull();
    expect(document.querySelector(".rs-next--clear")).toBeNull();
    expect(alsoWaiting()).toBeNull();
    expect(within(rooms()).getByRole("link", { name: "Today" }).querySelector(".rs-nav__count")).toBeNull();
  });
});

describe("what else waits", () => {
  it("lists every other waiting item once, each with its tick, title, one sentence and one button", async () => {
    showToday(withToday(everyKind()));
    await waitFor(() => expect(rowsOf(alsoWaiting())).toHaveLength(4));
    const rows = rowsOf(alsoWaiting());
    expect(
      rows.map((row) => [row.querySelector(".app-q__t")!.textContent, row.querySelector(".rs-meta")!.textContent, row.querySelector("a")!.textContent]),
    ).toEqual([
      ["Read a suggestion from Dana Okafor", "New wording for a line of a copy you shared. Nothing changes unless you accept it.", "Read it"],
      ["Check 1 role and 4 facts", "From sam-rivera-2024.pdf. Your resumes can use them once you say they’re right.", "Check them"],
      [
        "Answer 2 questions for Platform Engineer at Litware",
        "Its kit stopped there. Resumatic never guesses an answer. One question asks about something whose answer is never saved.",
        "Answer",
      ],
      ["Read 2 new comments from Dana Okafor", "On a copy you shared with them.", "Read them"],
    ]);
    for (const row of rows) {
      expect(row.querySelectorAll(".rs-tick")).toHaveLength(1);
      expect(row.querySelectorAll(".app-q__t")).toHaveLength(1);
      expect(row.querySelectorAll("p.rs-meta")).toHaveLength(1);
      const links = row.querySelectorAll("a");
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveClass("rs-btn", "rs-btn--sm");
      // The button is described by its row's title, so "Read it" says what it reads.
      const title = row.querySelector(".app-q__t")!;
      expect(title.id).not.toBe("");
      expect(links[0]).toHaveAttribute("aria-describedby", title.id);
      expect(links[0]).toHaveAccessibleDescription(title.textContent!);
    }
    // The next step is not listed again.
    expect(rows.map((row) => row.textContent).join(" ")).not.toContain("sam-rivera-cv.docx");
    // Its other wordings: many of each, and facts from no file.
    expect(waitingRow({ kind: "suggestions", ...dana, count: 3, latest: NOW })).toMatchObject({
      title: "Read 3 suggestions from Dana Okafor",
      sentence: "New wording for lines of a copy you shared. Nothing changes unless you accept it.",
      action: "Read them",
    });
    expect(waitingRow({ kind: "comments", ...dana, coachName: "  ", count: 1, latest: NOW })).toMatchObject({ title: "Read a new comment from dana@example.test", action: "Read it" });
    expect(waitingRow({ kind: "check", sourceId: null, filename: null, roles: 0, facts: 1 })).toMatchObject({
      title: "Check 1 fact",
      sentence: "Not from any of your files. Your resumes can use them once you say they’re right.",
      action: "Check it",
    });
    expect(waitingRow({ kind: "check", sourceId: "s", filename: null, roles: 2, facts: 0 }).title).toBe("Check 2 roles");
    expect(waitingRow({ kind: "kit", applicationId: "a", title: null, company: null, unanswered: 1, sensitive: 0 })).toMatchObject({
      title: "Answer 1 question for a job you saved",
      sentence: "Its kit stopped there. Resumatic never guesses an answer.",
    });
    expect(waitingRow({ kind: "kit", applicationId: "a", title: null, company: "Fabrikam", unanswered: 0, sensitive: 3 }).sentence).toBe(
      "Its kit stopped there. Resumatic never guesses an answer. 3 questions ask about something whose answer is never saved.",
    );
    expect(waitingRow({ kind: "kit", applicationId: "a", title: null, company: "Fabrikam", unanswered: 1, sensitive: 0 }).title).toBe("Answer 1 question for Fabrikam");
  });

  it("marks a file that couldn't be read as a problem, and the rest as waiting for you", async () => {
    const second = { kind: "unreadable", sourceId: "src-old", filename: "old-cv.docx", createdAt: NOW - 1 } as const;
    const today = waitingOnly([...everyKind().waiting, second]);
    showToday(withToday(today));
    await waitFor(() => expect(rowsOf(alsoWaiting())).toHaveLength(5));
    const ticks = rowsOf(alsoWaiting()).map((row) => [row.querySelector(".app-q__t")!.textContent, row.querySelector(".rs-tick")!.className]);
    expect(ticks).toEqual([
      ["old-cv.docx couldn’t be read", "rs-tick rs-tick--problem"],
      ["Read a suggestion from Dana Okafor", "rs-tick rs-tick--needs-you"],
      ["Check 1 role and 4 facts", "rs-tick rs-tick--needs-you"],
      ["Answer 2 questions for Platform Engineer at Litware", "rs-tick rs-tick--needs-you"],
      ["Read 2 new comments from Dana Okafor", "rs-tick rs-tick--needs-you"],
    ]);
    expect(rowsOf(alsoWaiting())[0]!.querySelector("a")).toHaveTextContent("See what to do");
  });

  it("counts what waits as the header does", async () => {
    const today = everyKind();
    showToday(withToday(today));
    const header = await within(rooms()).findByRole("link", { name: "Today, 11 waiting for you" });
    expect(header.querySelector(".rs-nav__count")).toHaveTextContent("11");
    expect(await lede()).toBe("11 things are waiting for you. Nothing is used, sent or shared until you say so.");
    // The next step stands for one of them, so the list counts ten, in the header's units: not its four rows.
    const heading = within(alsoWaiting()!).getByRole("heading");
    expect(spoken(heading)).toBe("Also waiting for you, 10");
    expect(heading.querySelector(".app-n")).toHaveAttribute("aria-hidden", "true");
    expect(heading.querySelector(".app-n")).toHaveTextContent(/^10$/);
    expect(units(nextStep(today)) + 10).toBe(today.counts.today);
    expect(rowsOf(alsoWaiting())).toHaveLength(4);
  });

  it("says one thing waits in the singular", async () => {
    showToday(withToday(waitingOnly([{ kind: "unreadable", sourceId: "src-cv", filename: "sam-rivera-cv.docx", createdAt: NOW }])));
    expect(await lede()).toBe("1 thing is waiting for you. Nothing is used, sent or shared until you say so.");
    // Nothing else waits, so there is no list under the next step.
    expect(alsoWaiting()).toBeNull();
  });

  it("says more are waiting when a list stops at its cap, naming Facts, Jobs and Sharing", async () => {
    const comments: TodayWaiting[] = Array.from({ length: MAX_TODAY_LIST }, (_, i) => ({ kind: "comments", grantId: `g${i}`, coachName: null, coachEmail: `coach${i}@example.test`, count: 1, latest: NOW - i }));
    // Sixty coaches wrote, and the list stops at fifty.
    const today = waitingOnly(comments, 10);
    showToday(withToday(today));
    await waitFor(() => expect(rowsOf(alsoWaiting())).toHaveLength(MAX_TODAY_LIST - 1));
    expect(spoken(within(alsoWaiting()!).getByRole("heading"))).toBe("Also waiting for you, 59");
    const closing = within(alsoWaiting()!).getByText(/^More are waiting than this list shows\./);
    expect(closing).toHaveClass("rs-meta");
    expect(closing).toHaveTextContent("More are waiting than this list shows. Facts, Jobs and Sharing each list all of theirs.");
    expect(within(closing).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Facts", "#/facts/check"],
      ["Jobs", "#/jobs"],
      ["Sharing", "#/sharing"],
    ]);
  });

  it("says nothing more is waiting when every one is listed", async () => {
    showToday(withToday(everyKind()));
    await waitFor(() => expect(rowsOf(alsoWaiting())).toHaveLength(4));
    expect(screen.queryByText(/More are waiting/)).toBeNull();
  });

  it("shows no kind that isn't built", async () => {
    const unbuilt = [
      { kind: "applications", count: 3, title: "Check 3 applications before they go" },
      { kind: "introduction", requestId: "r1", company: "Litware", title: "Litware would like to meet you" },
      { kind: "skills", count: 8, title: "Check 8 skills" },
    ] as unknown as TodayWaiting[];
    // An unknown kind first, and its things counted, as a newer server would send them: thirteen more.
    const today = waitingOnly([...unbuilt, ...everyKind().waiting], 13);
    showToday(withToday(today));
    await waitFor(() => expect(nextTitle()).toBe("See why sam-rivera-cv.docx couldn’t be read"));
    for (const words of [/applications? to approve/i, /introduction/i, /skills? to confirm/i, /Litware would like/, /Check 3 applications/, /Check 8 skills/])
      expect(document.body.textContent, String(words)).not.toMatch(words);
    expect(rowsOf(alsoWaiting())).toHaveLength(4);
    // Its things are counted all the same, so the page agrees with the header, and the closing line says where they are.
    await within(rooms()).findByRole("link", { name: "Today, 24 waiting for you" });
    expect(await lede()).toMatch(/^24 things are waiting for you\./);
    expect(spoken(within(alsoWaiting()!).getByRole("heading"))).toBe("Also waiting for you, 23");
    expect(within(alsoWaiting()!).getByText(/^More are waiting than this list shows\./)).toBeInTheDocument();
  });

  it("shows only the closing line when only a kind that isn't built waits", async () => {
    const unbuilt = [{ kind: "skills", count: 8 }] as unknown as TodayWaiting[];
    showToday(withToday({ ...everyKind(), waiting: unbuilt, counts: { today: 8, facts: 8, jobs: 0, sharing: 0 } }));
    await waitFor(() => expect(alsoWaiting()).not.toBeNull());
    expect(next()).toBeNull();
    expect(screen.queryByText("Nothing needs you right now.")).toBeNull();
    expect(rowsOf(alsoWaiting())).toEqual([]);
    expect(alsoWaiting()!.querySelectorAll("p")).toHaveLength(1);
    expect(alsoWaiting()!.querySelector("p")).toHaveTextContent(/^More are waiting than this list shows\./);
    expect(document.querySelector(".rs-btn--primary")).toBeNull();
  });
});

describe("work in progress and what happened", () => {
  it("lists work in progress, each with a status line", async () => {
    const job = { applicationId: "app-litware", title: "Platform Engineer", company: "Litware" };
    const today: Today = {
      ...everyKind(),
      working: [
        { kind: "tailoring", resumeId: "res-running", step: "analyze", startedAt: NOW, ...job },
        { kind: "reading", sourceId: "src-new", filename: "linkedin-export.zip", startedAt: NOW - 1 },
        { kind: "document", documentId: "d1", documentKind: "letter", startedAt: NOW - 2, ...job },
        { kind: "document", documentId: "d2", documentKind: "prep", startedAt: NOW - 3, ...job },
        { kind: "document", documentId: "d3", documentKind: "questions", startedAt: NOW - 4, ...job },
        { kind: "document", documentId: "d4", documentKind: "refine", startedAt: NOW - 5, applicationId: "app-x", title: null, company: null },
        { kind: "document", documentId: "d5", documentKind: "fit", startedAt: NOW - 6, applicationId: "app-y", title: null, company: "Fabrikam" },
      ],
    };
    showToday(withToday(today));
    const working = await screen.findByRole("region", { name: "Resumatic is working on" });
    expect(within(working).getAllByRole("status")).toHaveLength(today.working.length);
    expect(
      rowsOf(working).map((row) => [
        row.querySelector(".app-q__t")!.textContent,
        row.querySelector("[role=status]")!.textContent,
        row.querySelector("a")!.getAttribute("href"),
        row.querySelector(".rs-tick")!.className,
      ]),
    ).toEqual([
      [
        "A resume for Platform Engineer at Litware",
        "Step 2 of 5: Choose your most relevant confirmed facts. You can leave this page. Tailoring carries on.",
        "#/jobs/app-litware/resume/res-running",
        "rs-tick rs-tick--working",
      ],
      ["Reading linkedin-export.zip", "What it finds will appear under Facts for you to check.", "#/facts/files", "rs-tick rs-tick--working"],
      ["A cover letter for Platform Engineer at Litware", "Resumatic is working on it. You can leave this page.", "#/jobs/app-litware/letter", "rs-tick rs-tick--working"],
      ["Interview preparation for Platform Engineer at Litware", "Resumatic is working on it. You can leave this page.", "#/jobs/app-litware/interview", "rs-tick rs-tick--working"],
      ["Questions about your experience for Platform Engineer at Litware", "Resumatic is working on it. You can leave this page.", "#/jobs/app-litware/fit", "rs-tick rs-tick--working"],
      ["New wording for your resume for a job you saved", "Resumatic is working on it. You can leave this page.", "#/jobs/app-x/resume", "rs-tick rs-tick--working"],
      ["Fit for Fabrikam", "Resumatic is working on it. You can leave this page.", "#/jobs/app-y/fit", "rs-tick rs-tick--working"],
    ]);
    for (const row of rowsOf(working)) {
      expect(row.querySelector("a")).toHaveTextContent(/^Open$/);
      expect(row.querySelector("a")).toHaveAccessibleDescription(row.querySelector(".app-q__t")!.textContent!);
    }
    // Work in progress waits for nobody: it adds no button of the brand's.
    expect(working.querySelector(".rs-btn--primary")).toBeNull();
  });

  it("names the tailoring step as the resume's own page does", async () => {
    // The full fixture's run has finished choosing facts, so it is writing lines: step 3.
    const state = fullVault();
    showToday(state);
    const working = await screen.findByRole("region", { name: "Resumatic is working on" });
    expect(within(working).getByRole("status")).toHaveTextContent(/^Step 3 of 5: Write lines from those facts\./);
  });

  it("lists recent events under Since and the date, newest first", async () => {
    const job = { applicationId: "app-litware", title: "Platform Engineer", company: "Litware" };
    const today: Today = {
      ...everyKind(),
      recent: [
        { kind: "copyOpened", grantId: "sh-1", label: "For Dana", coachName: "Dana Okafor", coachEmail: "dana@example.test", at: NOW },
        { kind: "coachCommented", grantId: "sh-1", coachName: null, coachEmail: "dana@example.test", at: NOW - 60_000 },
        { kind: "resumeReady", resumeId: "r1", version: 2, at: NOW - 120_000, ...job },
        { kind: "copyOpened", grantId: "sh-2", label: "Recruiter at Fabrikam", coachName: null, coachEmail: null, at: NOW - 180_000 },
        { kind: "resumeReady", resumeId: "r2", version: 1, at: NOW - 240_000, applicationId: "app-x", title: "Site Reliability Engineer", company: null },
        { kind: "copyOpened", grantId: "sh-3", label: null, coachName: null, coachEmail: null, at: NOW - 300_000 },
      ],
    };
    showToday(withToday(today));
    const recent = await screen.findByRole("region", { name: `Since ${formatDate(today.since)}` });
    const items = [...recent.querySelectorAll("li")];
    expect(items.map((item) => [item.querySelector("span")!.textContent, item.querySelector("time")!.textContent])).toEqual([
      // The copy names its coach, but anyone with the link may have opened it, so the reader isn't named.
      ["The copy you shared with Dana Okafor was opened.", formatDateTime(NOW)],
      ["dana@example.test wrote on the copy you shared.", formatDateTime(NOW - 60_000)],
      ["A new version of your resume for Platform Engineer at Litware is ready.", formatDateTime(NOW - 120_000)],
      ["The copy you shared as “Recruiter at Fabrikam” was opened.", formatDateTime(NOW - 180_000)],
      ["A resume for Site Reliability Engineer is ready.", formatDateTime(NOW - 240_000)],
      ["A copy you shared was opened.", formatDateTime(NOW - 300_000)],
    ]);
    expect(items[0]!.querySelector("time")).toHaveAttribute("dateTime", new Date(NOW).toISOString());
    // They are said, not linked.
    expect(recent.querySelectorAll("a")).toHaveLength(0);
  });

  it("leaves out an empty section: nothing else waiting", async () => {
    showToday(withToday(waitingOnly([everyKind().waiting[1]!])));
    await waitFor(() => expect(next()).not.toBeNull());
    expect(alsoWaiting()).toBeNull();
  });

  it("leaves out an empty section: nothing in progress", async () => {
    showToday(withToday(everyKind()));
    await waitFor(() => expect(next()).not.toBeNull());
    expect(section("Resumatic is working on")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("leaves out an empty section: nothing recent", async () => {
    showToday(withToday(everyKind()));
    await waitFor(() => expect(next()).not.toBeNull());
    expect(section(/^Since /)).toBeNull();
    expect(screen.queryByText(/^Since /)).toBeNull();
  });

  it("puts the next step before every list and the side panel", async () => {
    const state = fullVault();
    showToday(state);
    await screen.findByRole("region", { name: /^Since / });
    const order = [
      document.querySelector(".page-head"),
      next(),
      alsoWaiting(),
      section("Resumatic is working on"),
      section(/^Since /),
      screen.getByRole("complementary", { name: "Where things stand" }),
    ];
    expect(order.every(Boolean)).toBe(true);
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING, `${i}`).toBeTruthy();
    // On a phone the columns wrap into one, in this order: the main column, then the side.
    const columns = document.querySelector(".app-cols")!;
    expect([...columns.children].map((child) => child.className)).toEqual(["app-main app-stack", "app-side app-stack"]);
  });
});

describe("where things stand", () => {
  const lines = () =>
    within(screen.getByRole("complementary", { name: "Where things stand" }))
      .getAllByRole("listitem")
      .map((item) => [item.querySelector("a")!.textContent, item.querySelector("a")!.getAttribute("href"), item.querySelector(".rs-meta")!.textContent]);

  it("shows where things stand: facts, jobs by status, copies and the plan", async () => {
    showToday(withToday(everyKind()));
    await screen.findByRole("heading", { name: "Where things stand" });
    expect(lines()).toEqual([
      ["Facts", "#/facts/all", "9 confirmed, 5 to check, 1 left out"],
      ["Jobs", "#/jobs", "2 saved, 1 applied, 1 at interview, 1 with an offer, 3 closed."],
      ["Sharing", "#/sharing", "2 copies shared, 1 with a coach."],
      ["Plan", "#/account/plan", "12 of 20 documents used this month."],
    ]);
    expect(document.querySelector(".app-today-stand")).toHaveClass("app-list");
  });

  it("says when there are no jobs and nothing is shared, and leaves out a status with none", async () => {
    const none = showToday(withToday({ ...everyKind(), standing: standing({ jobs: { ...emptyStanding().jobs }, copies: 0, coachCopies: 0 }) }));
    await screen.findByRole("heading", { name: "Where things stand" });
    expect(lines().slice(1, 3).map((line) => line[2])).toEqual(["No jobs yet.", "Nothing shared."]);
    none.unmount();
    showToday(withToday({ ...everyKind(), standing: standing({ jobs: { ...emptyStanding().jobs, interview: 1 }, copies: 1, coachCopies: 0 }) }));
    await screen.findByRole("heading", { name: "Where things stand" });
    expect(lines().slice(1, 3).map((line) => line[2])).toEqual(["1 at interview.", "1 copy shared."]);
  });

  it("says nothing about recruiters unless the card preview is on, and then only that a private preview exists", async () => {
    const off = showToday(withToday(everyKind()));
    await screen.findByRole("heading", { name: "Where things stand" });
    expect(document.body.textContent).not.toMatch(/recruiter|anonymous profile|preview/i);
    off.unmount();
    showToday(withToday(everyKind(), { capabilities: { ocr: false, connectedApps: false, cardPreview: true } }));
    await screen.findByRole("heading", { name: "Where things stand" });
    expect(lines()[2]![2]).toBe("2 copies shared, 1 with a coach. Your anonymous profile has a private preview only you can see.");
    expect(document.body.textContent).not.toMatch(/recruiter|can find|visible/i);
  });

  it("names connected apps only where they are switched on", async () => {
    const off = showToday(withToday(everyKind()));
    await screen.findByRole("heading", { name: "Where things stand" });
    expect(document.body.textContent).not.toMatch(/connected app/i);
    off.unmount();
    const on = { capabilities: { ocr: false, connectedApps: true } };
    const one = showToday(withToday(everyKind(), on));
    await screen.findByRole("heading", { name: "Where things stand" });
    expect(lines()[2]![2]).toBe("2 copies shared, 1 with a coach. 1 connected app.");
    one.unmount();
    showToday(withToday({ ...everyKind(), standing: standing({ apps: 0, copies: 0, coachCopies: 0 }) }, on));
    await screen.findByRole("heading", { name: "Where things stand" });
    expect(lines()[2]![2]).toBe("Nothing shared. No connected apps.");
  });

  it("shows By email only where email notices are on, linking to Account › Notifications", async () => {
    const off = showToday(withToday(everyKind()));
    await screen.findByRole("heading", { name: "Where things stand" });
    expect(screen.queryByRole("heading", { name: "By email" })).toBeNull();
    off.unmount();
    showToday(withToday(everyKind(), { capabilities: { ocr: false, connectedApps: false, emailNotices: true } }));
    const email = (await screen.findByRole("heading", { name: "By email" })).closest("section")!;
    expect(email.closest("aside")).toHaveAccessibleName("Where things stand");
    expect(email).toHaveTextContent(
      "Resumatic can email you when a coach comments or suggests new wording, and when facts have waited 3 days for you to check them. An email says only that something is waiting, never what it says.",
    );
    const link = within(email).getByRole("link", { name: "Choose what to email" });
    expect(link).toHaveAttribute("href", "#/account/notifications");
    expect(link).toHaveClass("rs-btn", "rs-btn--sm");
    expect(link).not.toHaveClass("rs-btn--primary");
  });

  it("shows no first run and only the plan from a server without standing", async () => {
    const older: Today = emptyToday(NOW);
    delete older.standing;
    const state = emptyVault();
    state.today = older;
    showToday(state);
    await screen.findByRole("heading", { name: "Where things stand" });
    expect(screen.queryByRole("heading", { name: "1. Add the resume you have" })).toBeNull();
    expect(screen.getByText("Nothing needs you right now.")).toBeInTheDocument();
    expect(lines()).toEqual([["Plan", "#/account/plan", "12 of 20 documents used this month."]]);
  });

  it("the full fixture's standing is what the fake works out from its record", () => {
    const state = fullVault();
    // The moment the fixture's Today was read: fourteen days after where its recent events start.
    expect(standingOf(state, state.today!.since + TODAY_RECENT_MS)).toEqual(state.today!.standing);
    // And its counts are what its waiting items add up to.
    const today = state.today!;
    expect(today.counts.today).toBe(today.waiting.reduce((sum, item) => sum + units(item), 0));
    expect(today.counts.today).toBe(today.counts.facts + today.counts.jobs + today.counts.sharing);
  });
});

describe("Today the first time", () => {
  it("shows three steps with the file and paste choices when the record has no files, roles or facts", async () => {
    const state = emptyVault();
    expect(state.today).toBeUndefined();
    showToday(state);
    const steps = await screen.findByRole("region", { name: "Three steps to a tailored resume" });
    expect(await lede()).toBe("Three steps to a tailored resume you can stand behind. Start with the resume you have.");
    expect(within(steps).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "1. Add the resume you have",
      "2. Check what Resumatic found",
      "3. Tailor it to a job",
    ]);
    const items = [...steps.querySelectorAll("ol.app-today-steps > li.app-q")];
    expect(items.map((item) => item.querySelector(".rs-tick")!.className)).toEqual(["rs-tick rs-tick--needs-you", "rs-tick rs-tick--todo", "rs-tick rs-tick--todo"]);
    expect(items[1]).toHaveTextContent("“Is this right?”, one fact at a time. Nothing is used until you say it is.");
    expect(items[2]).toHaveTextContent("Add a job description and get a resume that uses only what’s in your record, with every line checked.");
    // The first step offers a file or pasted text, and a fact typed in.
    const choices = within(items[0] as HTMLElement).getByRole("group", { name: "Add a file" });
    expect(within(choices).getAllByRole("button").map((button) => button.textContent)).toEqual(["Upload a file", "Paste text"]);
    expect(items[0]!.querySelector(".app-drop--first-run input[type=file]")).not.toBeNull();
    expect(within(items[0] as HTMLElement).getByRole("link", { name: "Add a fact yourself" })).toHaveAttribute("href", "#/facts/all");
    // One green button: the dropzone's.
    expect([...document.querySelectorAll(".rs-btn--primary")].map((button) => button.textContent)).toEqual(["Choose a file"]);
    expect(next()).toBeNull();
    const aside = screen.getByRole("complementary", { name: "What to expect" });
    expect(within(aside).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Make up a number, a title or a skill. If a job asks for something your record doesn’t show, it tells you.",
      "Share or send anything until you choose to.",
      "Sell your data, or share it for marketing.",
    ]);
    expect(within(aside).getByRole("link", { name: "See your data" })).toHaveAttribute("href", "#/account/data");
    expect(screen.queryByRole("complementary", { name: "Where things stand" })).toBeNull();
  });

  it("lists what waits under the steps, counted as the header counts it", async () => {
    const kit: TodayWaiting = { kind: "kit", applicationId: "app-litware", title: "Platform Engineer", company: "Litware", unanswered: 2, sensitive: 0 };
    const state = emptyVault();
    state.today = { ...emptyToday(NOW), waiting: [kit], counts: { today: 2, facts: 0, jobs: 2, sharing: 0 } };
    showToday(state);
    await screen.findByRole("region", { name: "Three steps to a tailored resume" });
    expect(next()).toBeNull();
    expect(spoken(within(alsoWaiting()!).getByRole("heading"))).toBe("Also waiting for you, 2");
    expect(rowsOf(alsoWaiting()).map((row) => row.querySelector(".app-q__t")!.textContent)).toEqual(["Answer 2 questions for Platform Engineer at Litware"]);
    const steps = screen.getByRole("region", { name: "Three steps to a tailored resume" });
    expect(steps.compareDocumentPosition(alsoWaiting()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the full page once there is a file, a confirmed fact, a left-out fact or something to check", async () => {
    const base = fixtures();
    const fact = base.facts.find((item) => item.state === "confirmed")!;
    const cases: [string, (state: Fixtures) => void][] = [
      ["a file", (state) => void state.sources.push(base.sources[1]!)],
      ["a file that couldn't be read", (state) => void state.sources.push(base.sources[0]!)],
      ["a confirmed fact", (state) => void state.facts.push({ ...fact, roleId: null })],
      ["a left-out fact", (state) => void state.facts.push({ ...fact, roleId: null, state: "rejected" })],
      ["a confirmed role", (state) => void state.roles.push(base.roles.find((role) => role.state === "confirmed")!)],
      [
        "something to check",
        (state) => {
          state.today = {
            ...emptyToday(NOW),
            waiting: [{ kind: "check", sourceId: null, filename: null, roles: 0, facts: 1 }],
            counts: { today: 1, facts: 1, jobs: 0, sharing: 0 },
          };
        },
      ],
    ];
    for (const [what, seed] of cases) {
      const state = emptyVault();
      seed(state);
      const shown = showToday(state);
      await screen.findByRole("complementary", { name: "Where things stand" });
      expect(screen.queryByRole("heading", { name: "1. Add the resume you have" }), what).toBeNull();
      shown.unmount();
    }
  });

  it("opens the full page after the first file, with its sentence focused", async () => {
    const state = emptyVault();
    const { api } = showToday(state);
    await screen.findByRole("heading", { name: "1. Add the resume you have" });
    const input = document.querySelector<HTMLInputElement>(".app-drop--first-run input[type=file]")!;
    await userEvent.upload(input, new File(["%PDF-1.4"], "cv.pdf", { type: "application/pdf" }));
    const sentence = await screen.findByText("Uploaded cv.pdf. Resumatic is reading it now, and its roles and facts will appear for you to review.");
    expect(sentence).toHaveClass("success");
    expect(sentence).toHaveAttribute("role", "status");
    expect(sentence).toHaveAttribute("tabindex", "-1");
    await waitFor(() => expect(sentence).toHaveFocus());
    expect(screen.queryByRole("heading", { name: "1. Add the resume you have" })).toBeNull();
    expect(screen.getByRole("complementary", { name: "Where things stand" })).toHaveTextContent("Facts0 confirmed, 0 to check, 0 left out");
    // It sits above the next step, or here the line saying nothing needs you.
    expect(sentence.compareDocumentPosition(screen.getByText("Nothing needs you right now.")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(api.callsTo("POST", /^\/api\/sources$/)).toHaveLength(1);
  });

  it("opens the full page after pasted text, with its sentence focused", async () => {
    const state = emptyVault();
    showToday(state);
    await screen.findByRole("heading", { name: "1. Add the resume you have" });
    await userEvent.click(screen.getByRole("button", { name: "Paste text" }));
    const form = screen.getByRole("form", { name: "Paste text" });
    await userEvent.click(within(form).getByRole("textbox", { name: "Text to read" }));
    await userEvent.paste("Led the Q3 launch of the payments service.");
    await userEvent.click(within(form).getByRole("button", { name: "Add text" }));
    const sentence = await screen.findByText("Added your text. Resumatic is reading it now, and its roles and facts will appear for you to review.");
    await waitFor(() => expect(sentence).toHaveFocus());
    expect(sentence).toHaveClass("success");
    expect(screen.queryByRole("heading", { name: "1. Add the resume you have" })).toBeNull();
  });
});

describe("when Today can't be read", () => {
  it("keeps the page, with Try again above it, when a refresh fails", async () => {
    const state = emptyVault();
    const { api } = showToday(state);
    await screen.findByRole("heading", { name: "1. Add the resume you have" });
    const input = document.querySelector<HTMLInputElement>(".app-drop--first-run input[type=file]")!;
    await userEvent.upload(input, new File(["%PDF-1.4"], "cv.pdf", { type: "application/pdf" }));
    const sentence = await screen.findByText(/^Uploaded cv\.pdf\./);
    await waitFor(() => expect(sentence).toHaveFocus());
    // Now something waits in every list.
    state.today = { ...fullVault().today!, standing: standingOf(state, NOW) };
    act(() => void window.dispatchEvent(new Event(COUNTS_CHANGED)));
    await within(rooms()).findByRole("link", { name: "Today, 11 waiting for you" });
    await screen.findByRole("region", { name: /^Since / });
    const shownBefore = () => [next(), alsoWaiting(), section("Resumatic is working on"), section(/^Since /), screen.queryByRole("complementary", { name: "Where things stand" })];
    const before = shownBefore();
    expect(before.every(Boolean)).toBe(true);
    expect(sentence).toHaveFocus();

    // Every read fails until Try again, so a refresh that something else starts can’t answer first.
    api.fail("GET", /\/api\/v2\/today$/, 503, "unavailable", "Upstream exception 7f3a", false);
    act(() => void window.dispatchEvent(new Event(COUNTS_CHANGED)));
    // Wait for the retry itself: under load the alert can be found before its button renders.
    const retry = await screen.findByRole("button", { name: "Try again" });
    const alert = retry.closest<HTMLElement>('[role="alert"]')!;
    expect(alert).not.toBeNull();
    expect(screen.getAllByRole("alert")).toEqual([alert]);
    // Directly under the page's name, above the sentence and the next step.
    expect(document.querySelector(".page-head")!.nextElementSibling).toBe(alert);
    // Every section stays where it was, the sentence keeps focus, and the header keeps the count the
    // page still shows.
    expect(shownBefore()).toEqual(before);
    expect(sentence).toHaveFocus();
    expect(sentence).toBeInTheDocument();
    expect(spoken(within(rooms()).getByRole("link", { name: /^Today/ }))).toBe("Today, 11 waiting for you");

    api.recover("GET", /\/api\/v2\/today$/);
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await within(rooms()).findByRole("link", { name: "Today, 11 waiting for you" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(shownBefore()).toEqual(before);
  });

  it("shows Try again when Today can't load at first, and a loading line before it answers", async () => {
    // Every read fails until Try again, so a second read that something else starts can’t answer first.
    const { api } = showToday(withToday(everyKind()), (api) => api.fail("GET", /\/api\/v2\/today$/, 503, "unavailable", "Upstream exception 7f3a", false));
    // Before it answers, a loading line, and nothing else.
    expect(screen.getByRole("status")).toHaveTextContent("Loading what’s waiting for you…");
    expect(screen.getByRole("heading", { name: "Today", level: 1 })).toBeInTheDocument();
    const alert = await screen.findByRole("alert");
    expect(screen.queryByText("Loading what’s waiting for you…")).toBeNull();
    expect(next()).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    // Its words are the interface's own, never the server's text for an outage.
    expect(alert).toHaveTextContent("Resumatic is busy right now. Try again in a minute.");
    expect(alert).not.toHaveTextContent("Upstream");
    api.recover("GET", /\/api\/v2\/today$/);
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(nextTitle()).toBe("See why sam-rivera-cv.docx couldn’t be read"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
