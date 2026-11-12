import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { ShareSnapshotContent } from "../../src/web/components/ShareSnapshotContent";
import { AccountPage } from "../../src/web/pages/AccountPage";
import { JobsPage } from "../../src/web/pages/JobsPage";
import { LegalPage } from "../../src/web/pages/LegalPage";
import { ResumePage } from "../../src/web/pages/ResumePage";
import { SignedOut } from "../../src/web/pages/SignedOut";
import { SourcesPage } from "../../src/web/pages/SourcesPage";
import { RulesInterim } from "../../src/web/pages/interim/jobs";
import { SharingApps } from "../../src/web/pages/sharing/SharingApps";
import { SharingCoaches } from "../../src/web/pages/sharing/SharingCoaches";
import { SharingOverview } from "../../src/web/pages/sharing/SharingOverview";
import { SharingRecruiters } from "../../src/web/pages/sharing/SharingRecruiters";
import { PlaceholderPage } from "../../src/web/components/Placeholder";
import { Shell } from "../../src/web/components/Shell";
import { PLACEHOLDERS, type PlaceholderName } from "../../src/web/placeholders";
import { parseRoute } from "../../src/web/router";
import { installFakeApi } from "./api-fake";
import { emptyVault, fullVault, sharedView } from "./fixtures";
import { renderWithSession } from "./render";

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

  it("Jobs, with a workspace and every kind of document open", async () => {
    const state = fullVault();
    installFakeApi(state);
    renderWithSession(<JobsPage />, state.me);
    const job = (await screen.findByRole("heading", { name: "Platform Engineer at Litware" })).closest("li")!;
    await userEvent.click(job.querySelector<HTMLButtonElement>("button[aria-expanded]")!);
    await screen.findByText("Read cover letter");
    // The application kit loads by itself, with a question in each state.
    await screen.findByRole("heading", { name: "Application kit" });
    await screen.findByRole("button", { name: "Approve kit" });
    await screen.findByText("Asked every time");
    for (const details of document.querySelectorAll("details")) details.open = true;
    expect(await violations()).toEqual([]);
  });

  it("Jobs, as a board", async () => {
    const state = fullVault();
    installFakeApi(state);
    renderWithSession(<JobsPage />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Board" }));
    await screen.findByRole("region", { name: "Jobs by status" });
    expect(await violations()).toEqual([]);
  });

  it("a tailored resume, with its margin notes and documents", async () => {
    const state = fullVault();
    installFakeApi(state);
    renderWithSession(<ResumePage id="res-ready" />, state.me);
    await screen.findByRole("heading", { name: "Prepare your application" });
    expect(await violations()).toEqual([]);
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

  it("the Sharing pages", async () => {
    const state = fullVault();
    state.today!.waiting.push({ kind: "suggestions", grantId: "sh-1", coachName: "Dana Okafor", coachEmail: "dana.okafor@example.com", count: 1, latest: 1794051720000 });
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

  // Until stage 5 replaces it with its own page.
  it("Rules and answers (interim)", async () => {
    const state = fullVault();
    installFakeApi(state);
    renderWithSession(<RulesInterim />, state.me);
    await screen.findByText("Portfolio link", { selector: "strong" });
    expect(await violations()).toEqual([]);
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
