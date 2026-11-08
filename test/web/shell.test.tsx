import { screen, within } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";
import { Shell } from "../../src/web/components/Shell";
import { parseRoute, useRoute } from "../../src/web/router";
import { installFakeApi } from "./api-fake";
import { fixtures } from "./fixtures";
import { goTo, renderWithSession } from "./render";

function RoutedShell() {
  const route = useRoute();
  return (
    <Shell route={route} title="Test">
      <p>Page for {route.page}</p>
    </Shell>
  );
}

describe("the header", () => {
  it("names the three places, with the current one marked", () => {
    installFakeApi(fixtures());
    renderWithSession(<Shell route={parseRoute("#/facts")} title="Facts">content</Shell>, fixtures().me);
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Facts", "Jobs", "Account"]);
    expect(within(nav).getByRole("link", { name: "Facts" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Jobs" })).not.toHaveAttribute("aria-current");
  });

  it("keeps Jobs current on a resume page, because a resume belongs to its job", () => {
    installFakeApi(fixtures());
    renderWithSession(<Shell route={parseRoute("#/resumes/res-ready")} title="Tailored resume">content</Shell>, fixtures().me);
    expect(screen.getByRole("link", { name: "Jobs" })).toHaveAttribute("aria-current", "page");
  });

  it("links the lockup to Facts and marks the private beta", () => {
    installFakeApi(fixtures());
    renderWithSession(<Shell route={parseRoute("#/jobs")} title="Jobs">content</Shell>, fixtures().me);
    expect(screen.getByRole("link", { name: "Resumatic, go to Facts" })).toHaveAttribute("href", "#/facts");
    expect(screen.getByText("Private beta")).toBeInTheDocument();
  });

  it("puts the skip link first and moves focus to main when the route changes", () => {
    installFakeApi(fixtures());
    goTo("#/facts");
    renderWithSession(<RoutedShell />, fixtures().me);
    const focusable = document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea");
    expect(focusable[0]).toHaveTextContent("Skip to content");
    act(() => goTo("#/jobs"));
    expect(screen.getByText("Page for jobs")).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("rewrites a v1 address to its new name", () => {
    installFakeApi(fixtures());
    goTo("#/applications");
    renderWithSession(<RoutedShell />, fixtures().me);
    expect(screen.getByText("Page for jobs")).toBeInTheDocument();
    expect(window.location.hash).toBe("#/jobs");
  });
});

describe("the footer", () => {
  it("links the privacy notice, the terms and feedback", () => {
    installFakeApi(fixtures());
    renderWithSession(<Shell route={parseRoute("#/facts")} title="Facts">content</Shell>, fixtures().me);
    const footer = screen.getByRole("navigation", { name: "About Resumatic" });
    expect(within(footer).getAllByRole("link").map((a) => a.textContent)).toEqual(["Privacy", "Terms", "Send feedback"]);
  });
});
