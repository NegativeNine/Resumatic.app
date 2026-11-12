import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../../src/web/App";
import { installFakeApi } from "./api-fake";
import { fixtures } from "./fixtures";
import { goTo } from "./render";

describe("the app shell", () => {
  it("signs in and opens To check", async () => {
    installFakeApi(fixtures());
    render(<App />);
    expect(await screen.findByText("sam-rivera-2024.pdf")).toBeInTheDocument();
    expect(window.location.hash).toBe("#/facts/check");
    const rooms = screen.getByRole("navigation", { name: "Rooms" });
    expect(within(rooms).getByRole("link", { name: "Facts" })).toHaveAttribute("aria-current", "page");
    expect(within(screen.getByRole("navigation", { name: "Facts" })).getByRole("link", { name: "To check" })).toHaveAttribute("aria-current", "page");
    expect(screen.getAllByText("Northwind Logistics").length).toBeGreaterThan(0);
    await waitFor(() => expect(document.title).toBe("Facts – Resumatic"));
  });

  it("#/today shows its placeholder", async () => {
    installFakeApi(fixtures());
    goTo("#/today");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Today", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("Not available yet")).toHaveClass("rs-mark--note");
    expect(screen.getByRole("link", { name: "Check your facts" })).toHaveAttribute("href", "#/facts/check");
    expect(within(screen.getByRole("navigation", { name: "Rooms" })).getByRole("link", { name: "Today" })).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(document.title).toBe("Today – Resumatic"));
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
    render(<App />);
    expect(await screen.findByRole("link", { name: "Sign in with Google" })).toHaveAttribute("href", "/auth/login");
  });
});
