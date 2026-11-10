import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MCP_GRANT_TTL_MS } from "../../src/shared/mcp";
import { SESSION_TTL_MS } from "../../src/shared/session";
import { COACH_CLIENT_KEPT_MS, SHARE_READ_INTERVAL_MS, SHARE_SESSION_TTL_MS, SHARE_TTL_MS } from "../../src/shared/sharing";
import { LegalPage } from "../../src/web/pages/LegalPage";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A section of the notice, by its heading, as one run of text with single spaces. */
function section(title: string): string {
  const heading = screen.getByRole("heading", { level: 2, name: title });
  return heading.closest("section")!.textContent!.replace(/\s+/g, " ");
}

describe("the privacy notice", () => {
  it("covers each way career data is read by someone else", () => {
    render(<LegalPage doc="privacy" />);
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "What we keep",
      "Where it is kept",
      "How AI is used",
      "Sharing a copy",
      "Connecting an app",
      "Your choices",
    ]);
    const kept = section("What we keep");
    expect(kept).toContain("The job site sees a request from Resumatic, not from you, and nothing about you is sent with it.");
    for (const item of ["the status you set, the date you applied and your notes", "cover letters, interview preparation", "the label you give it and when it was last opened", "The apps you connect", "We never see your card number"])
      expect(kept).toContain(item);
    // The directory is described by everything it holds, not only what it held before paid plans.
    expect(section("Where it is kept")).toContain("if you have a paid plan, the Stripe IDs and billing period");
    expect(section("Where it is kept")).toContain("the credentials it uses are kept in a separate Cloudflare store");
    const sharing = section("Sharing a copy");
    expect(sharing).toContain("only if you choose that");
    expect(sharing).toContain("It cannot take back what someone has already read or saved.");
    // Someone reading a copy has no account, so the notice speaks to them where they will look.
    expect(sharing).toContain("If you are reading a copy someone shared with you: we don’t ask who you are.");
    // A coach is the one reader with an account, and both sides are told what the other sees.
    expect(kept).toContain("If you name a coach on a link, their sign-in address is kept with it.");
    expect(kept).toContain("If someone names you as their coach and you add their copy to your client list");
    expect(sharing).toContain("Naming a coach doesn’t close the link to anyone else who has it.");
    expect(sharing).toContain("we check whether your sign-in address is the one the copy names as its coach, and keep nothing from that check");
    expect(sharing).toContain("the owner sees that name and when you added it");
    const apps = section("Connecting an app");
    expect(apps).toContain("never receives your uploaded files, the words a fact came from, or your notes on a job");
    expect(apps).toContain("revoking access does not remove it from there");
    expect(within(screen.getByRole("heading", { name: "Connecting an app" }).closest("section")!).getByRole("link", { name: "Account" })).toHaveAttribute("href", "#/account");
    expect(section("Your choices")).toContain("cancels a paid plan, ends every shared copy and app connection");
  });

  // Each sentence is checked beside the constant it describes. Change one, and change the other.
  it("states the limits the code enforces", () => {
    render(<LegalPage doc="privacy" />);
    expect(SESSION_TTL_MS).toBe(7 * DAY);
    expect(section("What we keep")).toContain("keep you signed in for up to seven days");
    expect(SHARE_TTL_MS).toBe(7 * DAY);
    expect(section("Sharing a copy")).toContain("A link lasts seven days at most.");
    expect(SHARE_SESSION_TTL_MS).toBe(HOUR);
    expect(section("What we keep")).toContain("keep that copy open in their browser for up to an hour");
    expect(section("Sharing a copy")).toContain("Cookies keep the copy open in your browser for up to an hour.");
    expect(SHARE_READ_INTERVAL_MS).toBe(MINUTE);
    expect(section("Sharing a copy")).toContain("We keep when a copy was last opened, to the minute");
    expect(COACH_CLIENT_KEPT_MS).toBe(30 * DAY);
    expect(section("Sharing a copy")).toContain("An entry leaves your list when you remove it, or thirty days after the copy’s last day.");
    expect(MCP_GRANT_TTL_MS).toBe(30 * DAY);
    expect(section("Connecting an app")).toContain("Its access lasts an hour, or up to thirty days if you allow it to continue");
  });
});
