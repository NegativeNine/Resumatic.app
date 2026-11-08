import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../../src/web/App";
import { installFakeApi } from "./api-fake";
import { fixtures } from "./fixtures";

describe("the app shell", () => {
  it("signs in from /api/me and shows the first page with its data", async () => {
    installFakeApi(fixtures());
    render(<App />);
    expect(await screen.findByText("sam-rivera-2024.pdf")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(screen.getAllByText("Northwind Logistics").length).toBeGreaterThan(0);
  });

  it("shows the sign-in page when /api/me answers 401", async () => {
    const api = installFakeApi(fixtures());
    api.fail("GET", /^\/api\/me$/, 401, "unauthenticated", "sign in to continue");
    render(<App />);
    expect(await screen.findByRole("link", { name: "Sign in with Google" })).toHaveAttribute("href", "/auth/login");
  });
});
