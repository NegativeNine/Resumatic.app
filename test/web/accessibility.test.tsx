import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/web/App";
import { ShareSnapshotContent } from "../../src/web/components/ShareSnapshotContent";
import { AccountPage } from "../../src/web/pages/AccountPage";
import { JobsPage } from "../../src/web/pages/JobsPage";
import { LegalPage } from "../../src/web/pages/LegalPage";
import { JobPage } from "../../src/web/pages/jobs/JobPage";
import { RulesPage } from "../../src/web/pages/jobs/RulesPage";
import { SignedOut } from "../../src/web/pages/SignedOut";
import { FactsRecord } from "../../src/web/pages/facts/FactsRecord";
import { FactsReview } from "../../src/web/pages/facts/FactsReview";
import { FactsSkills } from "../../src/web/pages/facts/FactsSkills";
import { FactsSources } from "../../src/web/pages/facts/FactsSources";
import { SharingApps } from "../../src/web/pages/sharing/SharingApps";
import { SharingCoaches } from "../../src/web/pages/sharing/SharingCoaches";
import { SharingOverview } from "../../src/web/pages/sharing/SharingOverview";
import { SharingRecruiters } from "../../src/web/pages/sharing/SharingRecruiters";
import { TodayPage } from "../../src/web/pages/today/TodayPage";
import { CoachClients } from "../../src/web/pages/outside/CoachClients";
import { CoachCopy } from "../../src/web/pages/outside/CoachCopy";
import { Landing } from "../../src/web/pages/outside/Landing";
import { signInErrorMessage } from "../../src/web/errors";
import type { CoachClient } from "../../src/shared/sharing";
import { PlaceholderPage } from "../../src/web/components/Placeholder";
import { Shell } from "../../src/web/components/Shell";
import { PLACEHOLDERS, type PlaceholderName } from "../../src/web/placeholders";
import { parseRoute } from "../../src/web/router";
import { installFakeApi } from "./api-fake";
import { emptyVault, fixtures, fullVault, sharedView } from "./fixtures";
import { goTo, renderWithSession } from "./render";

// Structure only: names, roles, labels, headings, ARIA. jsdom has no layout, so contrast is covered by
// the token tests, and "region" is off because a page is rendered here without the app shell's landmarks.
async function violations(region = false): Promise<string[]> {
  const results = await axe.run(document.body, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: region } },
  });
  return results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join("; ")})`);
}

describe("accessibility", () => {
  it("To check, with the role's question open, then a fact's More choices", async () => {
    const state = fullVault();
    installFakeApi(state);
    renderWithSession(<FactsReview />, state.me);
    await screen.findByRole("heading", { name: "To check", level: 1 });
    await userEvent.click(await screen.findByRole("button", { name: "Leave it out" }));
    await screen.findByRole("group", { name: "Leave out Northwind Logistics" });
    await screen.findByText(/^The text Resumatic read from your file\./);
    expect(await violations()).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await userEvent.click(await screen.findByText("More choices"));
    await screen.findByRole("button", { name: "Keep private" });
    expect(await violations()).toEqual([]);
  });

  it("To check, before anything is uploaded", async () => {
    const state = emptyVault();
    installFakeApi(state);
    renderWithSession(<FactsReview />, state.me);
    await screen.findByRole("heading", { name: "What happens next" });
    expect(await violations()).toEqual([]);
  });

  it("All facts, under each filter", async () => {
    const state = fullVault();
    installFakeApi(state);
    renderWithSession(<FactsRecord />, state.me);
    for (const filter of ["Confirmed", "Left out"]) {
      await userEvent.click(await screen.findByRole("radio", { name: new RegExp(`^${filter}`) }));
      await screen.findByRole("heading", { name: `${filter}, by role` });
      expect(await violations(), filter).toEqual([]);
    }
  });

  it("Skills", async () => {
    const state = fullVault();
    installFakeApi(state);
    renderWithSession(<FactsSkills />, state.me);
    await screen.findByRole("heading", { name: /^\d+ skills?$/ });
    expect(await violations()).toEqual([]);
  });

  it("Your files, with the paste panel open", async () => {
    const state = fullVault();
    installFakeApi(state);
    renderWithSession(<FactsSources />, state.me);
    await screen.findByText("sam-rivera-2024.pdf");
    await userEvent.click(screen.getByRole("button", { name: "Paste text" }));
    await screen.findByRole("form", { name: "Paste text" });
    expect(await violations()).toEqual([]);
  });

  it("Your jobs, as a list and as a board", async () => {
    const state = fullVault();
    state.applications[0]!.url = "https://careers.litware.example/platform-engineer";
    installFakeApi(state);
    renderWithSession(<JobsPage />, state.me);
    await screen.findByRole("link", { name: "Platform Engineer" });
    expect(await violations()).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Board" }));
    await screen.findByRole("region", { name: "Jobs by status" });
    expect(await violations()).toEqual([]);
  });

  it("a job’s page, on each of its five tabs", async () => {
    const state = fullVault();
    state.applications[0]!.url = "https://careers.litware.example/platform-engineer";
    installFakeApi(state);
    goTo("#/jobs/app-litware/fit");
    render(<App />);
    // Fit, with its fit check, experience questions and the job description.
    await screen.findByRole("region", { name: "Job description" });
    await screen.findByLabelText("Have you managed infrastructure with Terraform? Describe what you did.");
    for (const details of document.querySelectorAll("details")) details.open = true;
    expect(await violations(true), "fit").toEqual([]);
    // Resume, with its marks, its gaps and wording checks.
    act(() => goTo("#/jobs/app-litware/resume"));
    await screen.findByRole("article", { name: "Resume preview" });
    await screen.findByRole("heading", { name: "Refine wording" });
    expect(await violations(true), "resume").toEqual([]);
    // Cover letter: a failed one, the newest open, and none earlier.
    act(() => goTo("#/jobs/app-litware/letter"));
    await screen.findByText("Where these sentences came from");
    for (const details of document.querySelectorAll("details")) details.open = true;
    expect(await violations(true), "letter").toEqual([]);
    // Interview, with one running.
    act(() => goTo("#/jobs/app-litware/interview"));
    await screen.findByRole("button", { name: "Cancel this document" });
    for (const details of document.querySelectorAll("details")) details.open = true;
    expect(await violations(true), "interview").toEqual([]);
    // Application: tracking, the kit with a question in each state, and sending.
    act(() => goTo("#/jobs/app-litware/application"));
    await screen.findByRole("button", { name: "Approve kit" });
    await screen.findByText("Asked every time");
    expect(await violations(true), "application").toEqual([]);
  });

  it("a resume with a line card open, and as a sheet", async () => {
    const state = fullVault();
    installFakeApi(state);
    const page = renderWithSession(<main><JobPage id="app-litware" tab="resume" /></main>, state.me);
    await screen.findByRole("article", { name: "Resume preview" });
    await userEvent.click(document.querySelector<HTMLButtonElement>('[data-note-for="line-latency"] button')!);
    const card = await screen.findByRole("region", { name: "Where this line came from" });
    await userEvent.click(within(card).getByRole("button", { name: "Edit line" }));
    expect(await violations(true)).toEqual([]);
    page.unmount();
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(max-width: 860px)", media: query, addEventListener() {}, removeEventListener() {} }));
    renderWithSession(<main><JobPage id="app-litware" tab="resume" /></main>, state.me);
    await screen.findByRole("article", { name: "Resume preview" });
    await userEvent.click(document.querySelector<HTMLButtonElement>('[data-note-for="line-mentoring"] button')!);
    await screen.findByRole("dialog", { name: "Where this line came from" });
    expect(await violations(true)).toEqual([]);
  });

  it("Rules and answers", async () => {
    const state = fullVault();
    installFakeApi(state);
    renderWithSession(<main><RulesPage /></main>, state.me);
    // The saved answers card, with an answer the list now refuses.
    await screen.findByText("Portfolio link", { selector: "strong" });
    await screen.findByText(/can’t be offered any more/);
    expect(await violations(true)).toEqual([]);
  });

  it("the rooms’ empty, failed, stopped and ended states", async () => {
    // Jobs with no jobs yet, and the month's documents used up.
    const empty = emptyVault();
    empty.me.quota.used = empty.me.quota.limit;
    installFakeApi(empty);
    let shown = renderWithSession(<main><JobsPage /></main>, empty.me);
    await screen.findByText("No jobs yet.");
    await screen.findByText(/You’ve used all/);
    expect(await violations(true), "Jobs").toEqual([]);
    shown.unmount();

    // Your files with nothing in it, then with a file that couldn't be read.
    installFakeApi(emptyVault());
    shown = renderWithSession(<main><FactsSources /></main>, emptyVault().me);
    await screen.findByText("No files yet.");
    expect(await violations(true), "Your files, empty").toEqual([]);
    shown.unmount();
    const files = fixtures();
    files.sources.find((source) => source.id === "src-cv")!.retryRunId = "run-cv";
    installFakeApi(files);
    shown = renderWithSession(<main><FactsSources /></main>, files.me);
    await screen.findByText("Reading stopped");
    expect(await violations(true), "Your files, a failed file").toEqual([]);
    shown.unmount();

    // Coaches with no share links.
    const unshared = fullVault();
    unshared.shares = [];
    installFakeApi(unshared);
    shown = renderWithSession(<main><SharingCoaches /></main>, unshared.me);
    await screen.findByText("You have no share links.");
    expect(await violations(true), "Coaches").toEqual([]);
    shown.unmount();

    // A job's Interview tab with preparation that failed.
    const failed = fullVault();
    failed.documents = [
      { id: "doc-prep-failed", applicationId: "app-litware", kind: "prep", state: "failed", retryRunId: "run-prep", version: 1, createdAt: 1794000000000, error: "unavailable", result: null, facts: {} },
    ];
    installFakeApi(failed);
    renderWithSession(<main><JobPage id="app-litware" tab="interview" /></main>, failed.me);
    await screen.findByRole("button", { name: "Retry interview preparation" });
    expect(await violations(true), "Interview").toEqual([]);
  });

  it("Account, with every section and its More choices open", async () => {
    const state = fullVault();
    state.me.signInEmail = "sam.rivera@example.com";
    installFakeApi(state);
    renderWithSession(<AccountPage section="plan" />, state.me);
    await screen.findByRole("combobox", { name: "Choose a plan" });
    // The email notices load by themselves, so their form is waited for too.
    await screen.findByRole("checkbox", { name: "A coach comments on a copy you shared" });
    for (const details of document.querySelectorAll("details")) details.open = true;
    expect(await violations()).toEqual([]);
  });

  it("the shell, menu open, counts shown", async () => {
    const state = fullVault();
    state.me.clients = 2;
    state.me.signInEmail = "sam.rivera@example.com";
    installFakeApi(state);
    renderWithSession(
      <Shell route={parseRoute("#/sharing/coaches")} title="Coaches">
        <TodayPage />
      </Shell>,
      state.me,
    );
    await screen.findByRole("link", { name: "Today, 11 waiting for you" });
    await screen.findByRole("link", { name: "Coaches, 3 waiting for you" });
    await screen.findByRole("heading", { name: "Where things stand" });
    await userEvent.click(screen.getByRole("button", { name: /account and workspaces$/ }));
    // The whole page is in its landmarks here, so the region rule is on.
    expect(await violations(true)).toEqual([]);
  });

  it("Today, with something in every section", async () => {
    const state = fullVault();
    // More waits than the lists show, so the closing line is drawn too.
    state.today!.counts.today += 3;
    state.today!.working.push(
      { kind: "reading", sourceId: "src-new", filename: "linkedin-export.zip", startedAt: 1794044520000 },
      { kind: "document", documentId: "doc-new", documentKind: "letter", startedAt: 1794044520000, applicationId: "app-litware", title: "Platform Engineer", company: "Litware" },
    );
    installFakeApi(state);
    renderWithSession(
      <Shell route={parseRoute("#/today")} title="Today">
        <TodayPage />
      </Shell>,
      state.me,
    );
    await screen.findByRole("heading", { name: "See why sam-rivera-cv.docx couldn’t be read" });
    await screen.findByText(/More are waiting than this list shows/);
    await screen.findByRole("heading", { name: "Resumatic is working on" });
    await screen.findByRole("heading", { name: /^Since / });
    await screen.findByRole("heading", { name: "By email" });
    expect(await violations(true)).toEqual([]);
  });

  it("Today, the first time", async () => {
    const state = emptyVault();
    installFakeApi(state);
    renderWithSession(
      <Shell route={parseRoute("#/today")} title="Today">
        <TodayPage />
      </Shell>,
      state.me,
    );
    await screen.findByRole("heading", { name: "1. Add the resume you have" });
    expect(await violations(true)).toEqual([]);
    // With the paste panel open too.
    await userEvent.click(screen.getByRole("button", { name: "Paste text" }));
    expect(await violations(true)).toEqual([]);
  });

  it("every placeholder page", async () => {
    const state = fullVault();
    installFakeApi(state);
    for (const name of Object.keys(PLACEHOLDERS) as PlaceholderName[]) {
      const page = renderWithSession(<main><PlaceholderPage name={name} /></main>, state.me);
      expect(await violations(true), name).toEqual([]);
      page.unmount();
    }
  });

  it("the Sharing pages", async () => {
    const state = fullVault();
    installFakeApi(state);
    // The overview in its shell, so the whole page is in its landmarks and the region rule is on.
    const overview = renderWithSession(
      <Shell route={parseRoute("#/sharing")} title="Sharing">
        <SharingOverview />
      </Shell>,
      state.me,
    );
    await screen.findByText("1 connected");
    await screen.findByText(/^Dana Okafor: /);
    await screen.findByText("2 new comments and 1 line of suggested wording.");
    expect(await violations(true), "Overview").toEqual([]);
    overview.unmount();
    // Coaches, with the form for a new copy open.
    const coaches = renderWithSession(<SharingCoaches />, state.me);
    await screen.findByText("Dana Okafor");
    await userEvent.click(screen.getByRole("button", { name: "Choose what to share" }));
    await screen.findByRole("checkbox", { name: "Say which job each resume and document is for" });
    expect(await violations(), "Coaches").toEqual([]);
    coaches.unmount();
    const pages: [string, () => React.ReactNode, () => Promise<unknown>][] = [
      ["Recruiters", () => <SharingRecruiters />, async () => {
        await screen.findByText("Web platform development software");
        await screen.findByRole("button", { name: "Save preferences" });
      }],
      ["Connected apps", () => <SharingApps />, () => screen.findByText("Career Notebook")],
    ];
    for (const [name, page, loaded] of pages) {
      const shown = renderWithSession(<>{page()}</>, state.me);
      await loaded();
      expect(await violations(), name).toEqual([]);
      shown.unmount();
    }
  });

  it("the shared copy a coach reads", async () => {
    const view = sharedView();
    const unnamed = render(<ShareSnapshotContent view={view} />);
    expect(screen.getByRole("heading", { level: 1, name: "A shared copy" })).toBeInTheDocument();
    expect(await violations()).toEqual([]);
    unnamed.unmount();
    // The same copy with its owner’s name and the job its resume is for.
    view.snapshot.schemaVersion = 2;
    view.snapshot.owner = { name: "Sam Rivera" };
    view.snapshot.resumes[0]!.job = { title: "Platform Engineer", company: "Litware" };
    // And with a cover letter and interview preparation beside the resume.
    view.snapshot.schemaVersion = 3;
    view.snapshot.documents = [
      { id: "doc-letter", version: 1, kind: "letter", paragraphs: ["Led the migration of 40 services from Heroku to Kubernetes."], questions: [], job: { title: "Platform Engineer", company: "Litware" } },
      { id: "doc-prep", version: 1, kind: "prep", paragraphs: [], questions: [{ question: "How would you discuss your experience relevant to Terraform?", points: [] }], job: null },
    ];
    render(<ShareSnapshotContent view={view} />);
    expect(screen.getByText("Tailored for Platform Engineer at Litware")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Interview preparation" })).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  });

  it("signing in, and the legal pages", async () => {
    const signIn = render(<SignedOut note={null} error="Sign-in was cancelled. You can try again whenever you’re ready." />);
    expect(await violations()).toEqual([]);
    signIn.unmount();
    // Every refusal the callback can send, an unknown code, and the notes, each alone above the button.
    for (const code of ["unauthenticated", "conflict", "forbidden", "unavailable", "access_denied", "something-else"]) {
      const refused = render(<SignedOut note={null} error={signInErrorMessage(code)} />);
      expect(await violations(true), code).toEqual([]);
      refused.unmount();
    }
    for (const note of ["You’ve signed out.", "Your session has ended. Sign in again to carry on.", "This account has been deleted."]) {
      const noted = render(<SignedOut note={note} error={null} />);
      expect(await violations(true), note).toEqual([]);
      noted.unmount();
    }
    for (const doc of ["privacy", "terms"] as const) {
      const page = render(<LegalPage doc={doc} />);
      expect(await violations()).toEqual([]);
      page.unmount();
    }
  });

  it("the landing page, signed out", async () => {
    render(<Landing />);
    // The whole page is in its landmarks, so the region rule is on.
    expect(await violations(true)).toEqual([]);
  });

  it("a coach's clients in every state", async () => {
    const state = fullVault();
    state.me.signInEmail = "dana@example.test";
    const added = Date.UTC(2026, 10, 8, 15);
    const client = (extra: Partial<CoachClient>): CoachClient => ({
      grantId: crypto.randomUUID(), ownerName: "Sam Rivera", addedAt: added, expiresAt: added + 5 * 86_400_000, active: true, factCount: 3, resumeCount: 1, documentCount: 1, ...extra,
    });
    state.clients = [client({}), client({ ownerName: null }), client({ ownerName: "Alex Kim", active: false, factCount: 0, resumeCount: 0, documentCount: 0 })];
    const api = installFakeApi(state);
    const every = renderWithSession(<main><CoachClients /></main>, state.me);
    await screen.findByText("Ended");
    // A row asking whether to remove it.
    await userEvent.click(screen.getByRole("button", { name: "Remove Alex Kim from my list" }));
    expect(await violations(true)).toEqual([]);
    every.unmount();
    // A session from before coaches had an address.
    api.coachNeedsSignIn = true;
    const unknown = renderWithSession(<main><CoachClients /></main>, state.me);
    await screen.findByText(/^Sign out and in again/);
    expect(await violations(true)).toEqual([]);
    unknown.unmount();
    // And none at all.
    state.clients = [];
    api.coachNeedsSignIn = false;
    renderWithSession(<main><CoachClients /></main>, state.me);
    await screen.findByText("No clients yet");
    expect(await violations(true)).toEqual([]);
  });

  it("a client's copy with comments", async () => {
    const state = fullVault();
    const grantId = "0653389a-0d6d-4e90-94eb-23cc98b95c19";
    state.clients = [{ grantId, ownerName: null, addedAt: 1, expiresAt: 2, active: true, factCount: 3, resumeCount: 1, documentCount: 0 }];
    state.coachComments = [{ target: { kind: "fact", factId: "f1" }, quote: "Led the migration of 40 services from Heroku to Kubernetes.", comments: [{ id: "c1", author: "coach", body: "Say what it saved.", createdAt: 1 }] }];
    installFakeApi(state);
    renderWithSession(<main><CoachCopy grantId={grantId} /></main>, state.me);
    await screen.findByRole("article", { name: /^On “Led the migration/ });
    await userEvent.click(screen.getAllByRole("button", { pressed: false })[0]!);
    expect(await violations(true)).toEqual([]);
  });

  it("the shared copy's framed cards", async () => {
    const cards: [string, (seen: { method: string }) => { status: number; body?: unknown }][] = [
      ["This link isn’t available", (seen) => (seen.method === "POST" ? { status: 410, body: { error: "gone" } } : { status: 200 })],
      ["This copy isn’t open any more", (seen) => (seen.method === "POST" ? { status: 200, body: { grantId: "g" } } : { status: 410, body: { error: "gone" } })],
      ["This copy couldn’t be opened", () => ({ status: 503, body: { error: "unavailable" } })],
    ];
    for (const [title, answer] of cards) {
      vi.resetModules();
      window.history.replaceState(null, "", "/share#synthetic-token");
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          const reply = answer({ method: (init?.method ?? "GET").toUpperCase() });
          return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
        }),
      );
      const rtl = await import("@testing-library/react");
      const { SharePage } = await import("../../src/web/pages/SharePage");
      const page = rtl.render(<SharePage />);
      await rtl.screen.findByRole("heading", { level: 1, name: title });
      const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
      expect(results.violations.map((v) => v.id), title).toEqual([]);
      page.unmount();
    }
  });
});

