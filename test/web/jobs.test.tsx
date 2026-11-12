import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { emptyToday, type Today, type TodayWaiting } from "../../src/shared/today";
import { JobsPage } from "../../src/web/pages/JobsPage";
import { TodayContext } from "../../src/web/today";
import { installFakeApi } from "./api-fake";
import { fixtures, type Fixtures } from "./fixtures";
import { renderWithSession } from "./render";

// Your jobs: every job as a row that opens its own page. Fit is never shown here, and no job is
// sorted, filtered or hidden by it.

/** Your jobs as the shell shows it, with what Today last said waits. */
function open(state: Fixtures = fixtures(), today?: Today) {
  installFakeApi(state);
  const withToday = (ui: ReactNode) => (today ? <TodayContext value={{ today, last: today, error: null, reload: async () => undefined }}>{ui}</TodayContext> : ui);
  return renderWithSession(withToday(<JobsPage />), state.me);
}

const row = async (name: string) => (await screen.findByRole("link", { name })).closest("li")!;

/** Today, with a kit waiting on the Litware job. */
function waitingKit(unanswered: number, sensitive: number): Today {
  const kit: TodayWaiting = { kind: "kit", applicationId: "app-litware", title: "Platform Engineer", company: "Litware", unanswered, sensitive };
  return { ...emptyToday(Date.now()), waiting: [kit], counts: { today: 1, facts: 0, jobs: 1, sharing: 0 } };
}

describe("Your jobs", () => {
  it("lists each job as a row that opens its page, with its status as a neutral mark", async () => {
    const state = fixtures();
    state.applications[0]!.status = "interview";
    open(state);
    const litware = await row("Platform Engineer");
    expect(within(litware).getByRole("heading", { name: "Platform Engineer" })).toBeInTheDocument();
    expect(within(litware).getByRole("link", { name: "Platform Engineer" })).toHaveAttribute("href", "#/jobs/app-litware/fit");
    expect(within(litware).getByText("Litware")).toBeInTheDocument();
    // The person's own tracking status is a neutral outline, not a check result.
    expect(within(litware).getByText("Interview")).toHaveClass("rs-mark", "rs-mark--status");
    expect(within(litware).getByText(/^Added /)).toBeInTheDocument();
    // The latest resume's state, which opens it on the job's page.
    expect(within(litware).getByRole("link", { name: "Latest resume: Ready" })).toHaveAttribute("href", "#/jobs/app-litware/resume/res-ready");
    // Tailoring from the list is a plain button; the page's one brand button is the form's.
    expect(within(litware).getByRole("button", { name: "Tailor a resume" })).not.toHaveClass("primary");
    // A failed tailoring says so, and links to the resume.
    const tailspin = await row("Senior Data Engineer");
    expect(within(tailspin).getByRole("link", { name: "Latest resume: Failed" })).toHaveAttribute("href", "#/jobs/app-tailspin/resume/res-failed");
    // An unnamed job is named by its description, and says how it gets a name.
    const unnamed = await row("We are looking for a Staff Engineer to lead our payments platform. You will own the ledger and…");
    expect(within(unnamed).getByText("It’s named from its job description when a resume is tailored, or name it under Edit details.")).toBeInTheDocument();
    expect(within(unnamed).queryByRole("link", { name: /^Latest resume/ })).toBeNull();
    // No workspace opens on the list any more.
    expect(screen.queryByRole("button", { name: /Track and prepare|Close workspace/ })).toBeNull();
    // The lede’s confirmed facts are on All facts, not To check.
    expect(screen.getByRole("link", { name: "Facts" })).toHaveAttribute("href", "#/facts/all");
  });

  it("shows no fit on the list and keeps every job, newest first", async () => {
    const state = fixtures();
    // A job with a fit check made is listed as any other, where its date puts it.
    state.documents = [
      {
        id: "doc-fit", applicationId: "app-tailspin", kind: "fit", state: "ready", version: 1, createdAt: 1, error: null, facts: {},
        result: { kind: "fit", units: [], questions: [], report: { kept: 0, repaired: 0, replaced: 0, dropped: 0, gaps: [] }, fit: { requirements: [{ text: "Kafka", factIds: [] }] } },
      },
    ];
    open(state);
    await row("Platform Engineer");
    const names = [...document.querySelectorAll(".app-job-row h3")].map((heading) => heading.textContent);
    expect(names).toEqual([
      "Platform Engineer",
      "Senior Data Engineer",
      "We are looking for a Staff Engineer to lead our payments platform. You will own the ledger and…",
    ]);
    expect(document.body.textContent).not.toMatch(/\bfit\b|covers|%|score|match/i);
  });

  it("explains a used-up allowance at the top, and keeps every Tailor button working", async () => {
    const state = fixtures();
    state.me.quota.used = state.me.quota.limit;
    open(state);
    await row("Platform Engineer");
    expect(screen.getByText(/You’ve used all 20/)).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "Tailor a resume" })) expect(button).toBeEnabled();
  });

  it("shows which view is on, and switches between List and Board", async () => {
    open();
    const list = await screen.findByRole("button", { name: "List" });
    const board = screen.getByRole("button", { name: "Board" });
    expect(list).toHaveAttribute("aria-pressed", "true");
    expect(board).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(board);
    expect(board).toHaveAttribute("aria-pressed", "true");
    const byStatus = screen.getByRole("region", { name: "Jobs by status" });
    // Every job is still a row that opens its page.
    expect(within(byStatus).getByRole("link", { name: "Platform Engineer" })).toHaveAttribute("href", "#/jobs/app-litware/fit");
  });

  it("marks a job whose kit waits for answers with Today’s count, linking to its Application tab", async () => {
    open(fixtures(), waitingKit(2, 1));
    const litware = await row("Platform Engineer");
    const mark = within(litware).getByRole("link", { name: "3 questions to answer" });
    expect(mark).toHaveAttribute("href", "#/jobs/app-litware/application");
    expect(mark.querySelector(".rs-mark")).toHaveClass("rs-mark--needs-you");
    // Only that job's row.
    expect(within(await row("Senior Data Engineer")).queryByRole("link", { name: /questions? to answer/ })).toBeNull();
  });

  it("marks a kit waiting only on a question asked every time", async () => {
    open(fixtures(), waitingKit(0, 1));
    const litware = await row("Platform Engineer");
    expect(within(litware).getByRole("link", { name: "1 question to answer" })).toHaveAttribute("href", "#/jobs/app-litware/application");
  });

  it("joins a job’s meta without middle dots", async () => {
    open();
    await screen.findByText(/It’s named from its job description when a resume is tailored/);
    for (const meta of document.querySelectorAll(".app-job-meta")) expect(meta.textContent).not.toContain("·");
  });
});
