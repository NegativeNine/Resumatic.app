import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/web/App";
import { installFakeApi } from "./api-fake";
import { fixtures } from "./fixtures";
import { goTo } from "./render";

describe("the app shell", () => {
  it("signs in and opens Today", async () => {
    installFakeApi(fixtures());
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Today", level: 1 })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/today");
    const rooms = screen.getByRole("navigation", { name: "Rooms" });
    expect(within(rooms).getByRole("link", { name: "Today" })).toHaveAttribute("aria-current", "page");
    // Today has no second row.
    expect(document.querySelector(".app-sub")).toBeNull();
    // The record holds files and facts, so it is the full page, worked out from the record: nothing waits.
    expect(await screen.findByText("Nothing needs you right now.")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Where things stand" })).toHaveTextContent("9 confirmed");
    await waitFor(() => expect(document.title).toBe("Today – Resumatic"));
  });

  it("#/today shows Today", async () => {
    installFakeApi(fixtures());
    goTo("#/today");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Today", level: 1 })).toBeInTheDocument();
    expect(screen.queryByText("Not available yet")).toBeNull();
    await screen.findByRole("heading", { name: "Where things stand" });
    expect(within(screen.getByRole("navigation", { name: "Rooms" })).getByRole("link", { name: "Today" })).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(document.title).toBe("Today – Resumatic"));
  });

  it("#/facts/check shows To check", async () => {
    installFakeApi(fixtures());
    goTo("#/facts/check");
    render(<App />);
    expect(await screen.findByText("Senior Backend Engineer at Northwind Logistics")).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Rooms" })).getByRole("link", { name: "Facts" })).toHaveAttribute("aria-current", "page");
    expect(within(screen.getByRole("navigation", { name: "Facts" })).getByRole("link", { name: "To check" })).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(document.title).toBe("To check – Resumatic"));
  });

  it("answers Page not found for Connected apps where the deployment has none", async () => {
    const state = fixtures();
    installFakeApi(state);
    goTo("#/sharing/apps");
    const first = render(<App />);
    expect(await screen.findByRole("heading", { name: "Page not found", level: 1 })).toBeInTheDocument();
    first.unmount();
    state.me.capabilities = { ocr: false, connectedApps: true };
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Connected apps", level: 1 })).toBeInTheDocument();
  });

  it("shows the sign-in page when /api/me answers 401", async () => {
    const api = installFakeApi(fixtures());
    api.fail("GET", /^\/api\/me$/, 401, "unauthenticated", "sign in to continue");
    goTo("#/sign-in");
    render(<App />);
    expect(await screen.findByRole("link", { name: "Sign in with Google" })).toHaveAttribute("href", "/auth/login");
  });
});

describe("signed out", () => {
  const signedOut = () => {
    const api = installFakeApi(fixtures());
    api.fail("GET", /^\/api\/me$/, 401, "unauthenticated", "sign in to continue");
    return api;
  };

  it("shows the landing page at the root when signed out", async () => {
    signedOut();
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "A tailored resume you can stand behind." })).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveClass("app-landing");
    expect(screen.queryByRole("link", { name: "Sign in with Google" })).toBeNull();
    for (const link of screen.getAllByRole("link", { name: "Sign in" })) expect(link).toHaveAttribute("href", "#/sign-in");
    // The empty address stays empty: it isn't rewritten to a page that needs an account.
    expect(window.location.hash).toBe("");
    await waitFor(() => expect(document.title).toBe("A tailored resume you can stand behind – Resumatic"));
  });

  it("shows sign-in for a deep link while signed out, and leaves the address", async () => {
    signedOut();
    goTo("#/jobs/app-litware/fit");
    render(<App />);
    expect(await screen.findByRole("link", { name: "Sign in with Google" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("A tailored resume you can stand behind.");
    // Signing in comes back to the page the link named.
    expect(window.location.hash).toBe("#/jobs/app-litware/fit");
    await waitFor(() => expect(document.title).toBe("Sign in – Resumatic"));
  });

  it("shows sign-in at the root with the note after signing out", async () => {
    installFakeApi(fixtures());
    render(<App />);
    await screen.findByRole("heading", { name: "Today", level: 1 });
    await userEvent.click(screen.getByRole("button", { name: /account and workspaces$/ }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("You’ve signed out.")).toBeInTheDocument();
    // At the root too, the note is said on the sign-in page, not left behind for the landing page.
    act(() => goTo("#/"));
    expect(screen.getByText("You’ve signed out.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in with Google" })).toBeInTheDocument();
    expect(screen.queryByRole("main")).not.toHaveClass("app-landing");
  });

  it("shows sign-in at the root with a refused sign-in's sentence", async () => {
    // The page reads the callback's code as its module loads, so it is loaded afresh at that address.
    vi.resetModules();
    window.history.replaceState(null, "", "/?error=forbidden");
    signedOut();
    const rtl = await import("@testing-library/react");
    const { App: Fresh } = await import("../../src/web/App");
    const page = rtl.render(<Fresh />);
    const alert = await rtl.screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "This Google account can’t sign in yet. During the beta, Resumatic needs an invitation for your email address, and the address must be verified with Google.",
    );
    expect(rtl.screen.getByRole("link", { name: "Sign in with Google" })).toBeInTheDocument();
    // The code is taken out of the address once read.
    expect(window.location.search).toBe("");
    page.unmount();
  });

  it("moves from the landing page to sign-in and focuses it", async () => {
    signedOut();
    render(<App />);
    const signIn = (await screen.findAllByRole("link", { name: "Sign in" }))[0]!;
    await userEvent.click(signIn);
    expect(await screen.findByRole("link", { name: "Sign in with Google" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/sign-in");
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("main")));
    // And on to the privacy notice and back, which returns to the landing page.
    await userEvent.click(within(screen.getByRole("navigation", { name: "About Resumatic" })).getByRole("link", { name: "Privacy" }));
    const back = await screen.findByRole("link", { name: "← Back to Resumatic" });
    expect(back).toHaveAttribute("href", "#/");
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("main")));
    await userEvent.click(back);
    expect(await screen.findByRole("heading", { level: 1, name: "A tailored resume you can stand behind." })).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveClass("app-landing");
  });

  it("opens where signing in lands for a signed-in person at #/sign-in", async () => {
    installFakeApi(fixtures());
    goTo("#/sign-in");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Today", level: 1 })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/today");
    expect(screen.queryByRole("link", { name: "Sign in with Google" })).toBeNull();
  });
});
