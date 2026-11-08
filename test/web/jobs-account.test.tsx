import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AccountPage } from "../../src/web/pages/AccountPage";
import { JobsPage } from "../../src/web/pages/JobsPage";
import { SignedOut } from "../../src/web/pages/SignedOut";
import { THEME_KEY } from "../../src/web/theme";
import { installFakeApi } from "./api-fake";
import { fixtures } from "./fixtures";
import { renderWithSession } from "./render";

describe("Jobs", () => {
  it("marks only the newest resume of a job as Latest", async () => {
    const state = fixtures();
    installFakeApi(state);
    renderWithSession(<JobsPage />, state.me);
    const job = (await screen.findByRole("heading", { name: "Platform Engineer at Litware" })).closest("li")!;
    const rows = within(job).getAllByRole("link", { name: /^Resume tailored/ }).map((a) => a.closest("li")!);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Latest")).toBeInTheDocument();
    expect(within(rows[1]!).queryByText("Latest")).toBeNull();
  });

  it("explains a used-up quota at the top, and keeps every Tailor button working", async () => {
    const state = fixtures();
    state.me.quota.used = state.me.quota.limit;
    installFakeApi(state);
    renderWithSession(<JobsPage />, state.me);
    await screen.findByRole("heading", { name: "Platform Engineer at Litware" });
    expect(screen.getByText(/You've used all 20/)).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "Tailor a resume" })) expect(button).toBeEnabled();
  });

  it("shows which view is on, and switches between List and Board", async () => {
    const state = fixtures();
    installFakeApi(state);
    renderWithSession(<JobsPage />, state.me);
    const list = await screen.findByRole("button", { name: "List" });
    const board = screen.getByRole("button", { name: "Board" });
    expect(list).toHaveAttribute("aria-pressed", "true");
    expect(board).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(board);
    expect(board).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "Jobs by status" })).toBeInTheDocument();
  });

  it("joins a job's meta without middle dots", async () => {
    const state = fixtures();
    installFakeApi(state);
    renderWithSession(<JobsPage />, state.me);
    await screen.findByText(/The title and company appear once a resume has been tailored/);
    for (const meta of document.querySelectorAll(".app-job-meta")) expect(meta.textContent).not.toContain("·");
  });
});

describe("signing in", () => {
  it("puts notes and errors above the button", () => {
    render(<SignedOut note="You've signed out." error="Sign-in was cancelled. You can try again whenever you're ready." />);
    const button = screen.getByRole("link", { name: "Sign in with Google" });
    expect(button.textContent).toBe("Sign in with Google");
    const status = screen.getByRole("status");
    const alert = screen.getByRole("alert");
    expect(status.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tailored resumes, built only from what you've done.");
  });
});

describe("Account", () => {
  it("switches the theme at once and keeps the choice in this browser", async () => {
    const state = fixtures();
    installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    await userEvent.click(await screen.findByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
    await userEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("follows the device when the choice is Match system", async () => {
    const dark = vi.fn((query: string) => ({ matches: query.includes("dark"), media: query, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal("matchMedia", dark);
    const state = fixtures();
    installFakeApi(state);
    window.localStorage.setItem(THEME_KEY, "light");
    renderWithSession(<AccountPage />, state.me);
    await userEvent.click(await screen.findByRole("radio", { name: "Match system" }));
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
  });

  it("keeps Delete my account disabled until the phrase is typed", async () => {
    const state = fixtures();
    installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    const remove = await screen.findByRole("button", { name: "Delete my account" });
    expect(remove).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/to confirm/), "delete my account");
    expect(remove).toBeEnabled();
  });
});
