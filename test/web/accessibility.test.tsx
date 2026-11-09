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
import { installFakeApi } from "./api-fake";
import { emptyVault, fullVault, sharedView } from "./fixtures";
import { renderWithSession } from "./render";

// Structure only: names, roles, labels, headings, ARIA. jsdom has no layout, so contrast is covered by
// the token tests, and "region" is off because a page is rendered here without the app shell's landmarks.
async function violations(): Promise<string[]> {
  const results = await axe.run(document.body, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  return results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join("; ")})`);
}

describe("accessibility", () => {
  it("Facts, with sources, roles and facts in every state", async () => {
    const state = fullVault();
    installFakeApi(state);
    renderWithSession(<SourcesPage />, state.me);
    await screen.findByRole("heading", { name: "Facts", level: 1 });
    await screen.findAllByRole("button", { name: /Confirm/ });
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

  it("Account, with plans, share links and connected apps", async () => {
    const state = fullVault();
    installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    await screen.findByText("6 facts and 1 resume version");
    await screen.findByText("Career Notebook");
    await screen.findByRole("combobox", { name: "Choose a plan" });
    expect(await violations()).toEqual([]);
  });

  it("the shared copy a coach reads", async () => {
    render(<ShareSnapshotContent view={sharedView()} />);
    expect(screen.getByRole("heading", { name: "Shared career snapshot" })).toBeInTheDocument();
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
