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

  it("adds Clients for someone who is a coach, and on the Clients page itself", () => {
    installFakeApi(fixtures());
    const coach = { ...fixtures().me, clients: 2 };
    const first = renderWithSession(<Shell route={parseRoute("#/jobs")} title="Jobs">content</Shell>, coach);
    const names = () => within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link").map((a) => a.textContent);
    expect(names()).toEqual(["Facts", "Jobs", "Clients", "Account"]);
    expect(screen.getByRole("link", { name: "Clients" })).toHaveAttribute("href", "#/clients");
    first.unmount();
    // Someone with no clients who follows a link here still sees where they are.
    renderWithSession(<Shell route={parseRoute("#/clients")} title="Clients">content</Shell>, { ...fixtures().me, clients: 0 });
    expect(names()).toEqual(["Facts", "Jobs", "Clients", "Account"]);
    expect(screen.getByRole("link", { name: "Clients" })).toHaveAttribute("aria-current", "page");
  });

  it("marks Account while a coach's comment is unseen", () => {
    installFakeApi(fixtures());
    const names = () => within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link").map((a) => a.textContent);
    const first = renderWithSession(<Shell route={parseRoute("#/facts")} title="Facts">content</Shell>, { ...fixtures().me, newFromCoach: 2 });
    // The mark is beside the word, and the link's name says what it counts.
    const account = screen.getByRole("link", { name: "Account, 2 new from your coach" });
    expect(account).toHaveAttribute("href", "#/account");
    expect(account.querySelector(".rs-mark")).toHaveTextContent(/^2 new$/);
    // It waits for the person, so it is amber: a needs-you mark.
    expect(account.querySelector(".rs-mark")).toHaveClass("rs-mark--needs-you");
    expect(names()).toEqual(["Facts", "Jobs", "Account2 new"]);
    first.unmount();
    // It stays on the Account page itself, until the comments there have been shown.
    const second = renderWithSession(<Shell route={parseRoute("#/account")} title="Account">content</Shell>, { ...fixtures().me, newFromCoach: 1, clients: 3 });
    expect(screen.getByRole("link", { name: "Account, 1 new from your coach" })).toHaveAttribute("aria-current", "page");
    expect(names()).toEqual(["Facts", "Jobs", "Clients", "Account1 new"]);
    second.unmount();
    // Nothing unseen, or a server that doesn't count: Account is the plain link it was.
    for (const me of [{ ...fixtures().me, newFromCoach: 0 }, fixtures().me]) {
      const plain = renderWithSession(<Shell route={parseRoute("#/facts")} title="Facts">content</Shell>, me);
      expect(names()).toEqual(["Facts", "Jobs", "Account"]);
      expect(screen.getByRole("link", { name: "Account" })).not.toHaveAttribute("aria-label");
      expect(document.querySelector(".rs-nav .rs-mark")).toBeNull();
      plain.unmount();
    }
  });

  it("keeps Jobs current on a resume page, because a resume belongs to its job", () => {
    installFakeApi(fixtures());
    renderWithSession(<Shell route={parseRoute("#/resumes/res-ready")} title="Tailored resume">content</Shell>, fixtures().me);
    expect(screen.getByRole("link", { name: "Jobs" })).toHaveAttribute("aria-current", "page");
  });

  it("links the lockup to Facts and marks the private beta", () => {
    installFakeApi(fixtures());
    renderWithSession(<Shell route={parseRoute("#/jobs")} title="Jobs">content</Shell>, fixtures().me);
    const brand = screen.getByRole("link", { name: "Resumatic, go to Facts" });
    expect(brand).toHaveAttribute("href", "#/facts");
    expect(brand).toHaveClass("rs-brand");
    // The lockup: the tile, then the wordmark, which hides on a narrow screen and leaves the tile.
    expect(brand.querySelector(".rs-brand__tile")).toHaveAttribute("aria-hidden", "true");
    expect(brand.querySelector("svg")).toHaveClass("app-brand-wordmark");
    expect(brand.querySelectorAll("svg")).toHaveLength(1);
    expect(screen.getByText("Private beta")).toHaveClass("rs-mark--beta");
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
