import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { ShareSnapshotContent } from "../../src/web/components/ShareSnapshotContent";
import { AccountPage } from "../../src/web/pages/AccountPage";
import { JobsPage } from "../../src/web/pages/JobsPage";
import { LegalPage } from "../../src/web/pages/LegalPage";
import { ResumePage } from "../../src/web/pages/ResumePage";
import { SignedOut } from "../../src/web/pages/SignedOut";
import { CoachClients } from "../../src/web/pages/outside/CoachClients";
import { CoachCopy } from "../../src/web/pages/outside/CoachCopy";
import { Landing } from "../../src/web/pages/outside/Landing";
import { signInErrorMessage } from "../../src/web/errors";
import type { CoachClient } from "../../src/shared/sharing";
import { SourcesPage } from "../../src/web/pages/SourcesPage";
import { RulesInterim } from "../../src/web/pages/interim/jobs";
import { AppsInterim, CoachesInterim, RecruitersInterim, SharingInterim } from "../../src/web/pages/interim/sharing";
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
    // So is the saved answers card, with an answer the list now refuses.
    await screen.findByText("Portfolio link", { selector: "strong" });
    await screen.findByText(/can’t be offered any more/);
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

  it("the interim Sharing pages and Rules and answers", async () => {
    const state = fullVault();
    installFakeApi(state);
    const pages: [string, () => React.ReactNode, () => Promise<unknown>][] = [
      ["Sharing", () => <SharingInterim />, () => screen.findByRole("heading", { name: "Sharing", level: 1 })],
      ["Coaches", () => <CoachesInterim />, () => screen.findByText("Dana Okafor")],
      ["Recruiters", () => <RecruitersInterim />, () => screen.findByText("Web platform development software")],
      ["Connected apps", () => <AppsInterim />, () => screen.findByText("Career Notebook")],
      ["Rules and answers", () => <RulesInterim />, () => screen.findByText("Portfolio link", { selector: "strong" })],
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

