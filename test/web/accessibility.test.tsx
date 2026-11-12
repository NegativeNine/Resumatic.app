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
import { SourcesPage } from "../../src/web/pages/SourcesPage";
import { AppsInterim, CoachesInterim, RecruitersInterim, SharingInterim } from "../../src/web/pages/interim/sharing";
import { PlaceholderPage } from "../../src/web/components/Placeholder";
import { Shell } from "../../src/web/components/Shell";
import { PLACEHOLDERS, type PlaceholderName } from "../../src/web/placeholders";
import { parseRoute } from "../../src/web/router";
import { installFakeApi } from "./api-fake";
import { emptyVault, fullVault, sharedView } from "./fixtures";
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
  it("Facts, with sources, roles and facts in every state", async () => {
    const state = fullVault();
    installFakeApi(state);
    renderWithSession(<SourcesPage />, state.me);
    await screen.findByRole("heading", { name: "Facts", level: 1 });
    await screen.findAllByRole("button", { name: /That’s right/ });
    expect(await violations()).toEqual([]);
  });

  it("Facts, before anything is uploaded", async () => {
    const state = emptyVault();
    installFakeApi(state);
    renderWithSession(<SourcesPage />, state.me);
    await screen.findByRole("heading", { name: "Facts", level: 1 });
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

  it("Account, with plans, share links, connected apps and the card preview", async () => {
    const state = fullVault();
    installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    await screen.findByText("Dana Okafor");
    await screen.findByText("Career Notebook");
    await screen.findByRole("combobox", { name: "Choose a plan" });
    // The job preferences card loads by itself, so its form is waited for too.
    await screen.findByRole("button", { name: "Save preferences" });
    // So does the card preview, with an occupation, a band and two skill groups.
    await screen.findByText("Web platform development software");
    // So does the email notices card.
    await screen.findByRole("checkbox", { name: "A coach comments on a copy you shared" });
    expect(await violations()).toEqual([]);
    // The form for a new link: what to share, who it’s for and what the copy should say.
    await userEvent.click(screen.getByRole("button", { name: "Choose what to share" }));
    await screen.findByRole("checkbox", { name: "Say which job each resume and document is for" });
    expect(await violations()).toEqual([]);
  });

  it("the shell, menu open, counts shown", async () => {
    const state = fullVault();
    state.me.clients = 2;
    state.me.signInEmail = "sam.rivera@example.com";
    installFakeApi(state);
    renderWithSession(
      <Shell route={parseRoute("#/sharing/coaches")} title="Coaches">
        <PlaceholderPage name="today" />
      </Shell>,
      state.me,
    );
    await screen.findByRole("link", { name: "Facts, 6 waiting for you" });
    await screen.findByRole("link", { name: "Coaches, 2 waiting for you" });
    await userEvent.click(screen.getByRole("button", { name: /account and workspaces$/ }));
    // The whole page is in its landmarks here, so the region rule is on.
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

  it("the interim Sharing pages", async () => {
    const state = fullVault();
    installFakeApi(state);
    const pages: [string, () => React.ReactNode, () => Promise<unknown>][] = [
      ["Sharing", () => <SharingInterim />, () => screen.findByRole("heading", { name: "Sharing", level: 1 })],
      ["Coaches", () => <CoachesInterim />, () => screen.findByText("Dana Okafor")],
      ["Recruiters", () => <RecruitersInterim />, () => screen.findByText("Web platform development software")],
      ["Connected apps", () => <AppsInterim />, () => screen.findByText("Career Notebook")],
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
    expect(screen.getByRole("heading", { name: "Shared career snapshot" })).toBeInTheDocument();
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
    for (const doc of ["privacy", "terms"] as const) {
      const page = render(<LegalPage doc={doc} />);
      expect(await violations()).toEqual([]);
      page.unmount();
    }
  });
});
