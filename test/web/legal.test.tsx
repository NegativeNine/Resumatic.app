import { readFileSync } from "node:fs";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MAX_APP_FIT_STARTS_PER_DAY, MCP_GRANT_TTL_MS } from "../../src/shared/mcp";
import { SESSION_TTL_MS } from "../../src/shared/session";
import { COACH_CLIENT_KEPT_MS, SHARE_READ_INTERVAL_MS, SHARE_SESSION_TTL_MS, SHARE_TTL_MS } from "../../src/shared/sharing";
import { LegalPage, TAXONOMY_NOTICES } from "../../src/web/pages/LegalPage";

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
      "Credits",
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
    // A fact the person keeps to themselves: what the mark does, and the two things it doesn't.
    expect(apps).toContain("or your notes on a job. It never receives a fact you have marked sensitive, or a resume that uses one. It never receives a coach’s comments or suggested wording either. Its access lasts");
    const choices = section("Your choices");
    expect(choices).toContain(
      "Keep a fact to yourself: mark a fact sensitive under Facts and it is left out of every new resume, letter, interview preparation and fit preview, never put in a shared copy and never shown to a connected app.",
    );
    expect(choices).toContain("A resume that already uses it can’t be downloaded, shared or read by an app until you remove those lines.");
    expect(choices).toContain("It stays in your search index, so the model that indexes your facts can still receive its words when you edit it or the index is rebuilt.");
    expect(choices).toContain("Marking cannot take back what a model, a reader or an app received before.");
    const items = [...screen.getByRole("heading", { level: 2, name: "Your choices" }).closest("section")!.querySelectorAll("li > strong")].map((item) => item.textContent);
    expect(items).toEqual(["See and correct it:", "Keep a fact to yourself:", "Take it with you:", "Delete it:"]);
    expect(within(screen.getByRole("heading", { name: "Connecting an app" }).closest("section")!).getByRole("link", { name: "Account" })).toHaveAttribute("href", "#/account");
    expect(section("Your choices")).toContain("cancels a paid plan, ends every shared copy and app connection");
  });

  it("says who reads a coach's comments, where they are kept and where they never go", () => {
    render(<LegalPage doc="privacy" />);
    const items = (title: string) => [...screen.getByRole("heading", { level: 2, name: title }).closest("section")!.querySelectorAll("li")].map((item) => item.textContent!.replace(/\s+/g, " ").trim());
    // Kept, with what each is about and who wrote it, listed after the coach's own list.
    const kept = items("What we keep");
    const comments = "Comments a coach writes on a copy you shared and wording they suggest, and your replies, with the line or fact each is about and the coach’s name and sign-in address.";
    expect(kept).toContain(comments);
    expect(kept[kept.indexOf(comments) - 1]).toMatch(/^If someone names you as their coach and you add their copy to your client list/);
    // Never a model's input, said where the notice says what models are sent.
    const ai = screen.getByRole("heading", { level: 2, name: "How AI is used" }).closest("section")!.querySelector("p")!.textContent!.replace(/\s+/g, " ").trim();
    expect(ai.endsWith("a line those facts do not support is never shown to you. Comments on a shared copy are never sent to a language model or used to write or check a resume.")).toBe(true);
    // Who can comment, who can't, where the owner answers, and that nothing is sent to tell them.
    expect(items("Sharing a copy").at(-2)).toBe(
      "The coach you name can comment on a line or a fact in the copy once they have added it to their client list. Nobody else with the link can read or write comments. You answer and delete them under Account, where they stay after the copy ends until you delete them. We don’t send email: a count of new comments shows the next time you open Resumatic.",
    );
    // The coach is told, where they will look, that their words are kept in someone else's account.
    const sharing = section("Sharing a copy");
    expect(sharing).toContain(
      "thirty days after the copy’s last day. If you comment, your words are kept in the owner’s account, not yours, with your name, sign-in address and account ID. You can delete a comment while the copy is open to you. After that the owner keeps it until they delete it or their account, even if you delete yours.",
    );
    // A connected app is given none of it.
    expect(section("Connecting an app")).toContain("or a resume that uses one. It never receives a coach’s comments or suggested wording either. Its access lasts an hour");
  });

  it("says what a coach's suggested wording can change, who is told what, and when it reaches a model", () => {
    render(<LegalPage doc="privacy" />);
    const items = (title: string) => [...screen.getByRole("heading", { level: 2, name: title }).closest("section")!.querySelectorAll("li")].map((item) => item.textContent!.replace(/\s+/g, " ").trim());
    // Its own paragraph, straight after the one that says comments never reach a model.
    const ai = [...screen.getByRole("heading", { level: 2, name: "How AI is used" }).closest("section")!.querySelectorAll("p")].map((p) => p.textContent!.replace(/\s+/g, " ").trim());
    expect(ai[1]).toBe("Wording a coach suggests is sent to a model only if you accept it, to be checked against your facts like any edit you make.");
    // After the comments item: nothing changes unless the owner accepts, and the coach is told one thing.
    expect(items("Sharing a copy").at(-1)).toBe(
      "A coach you name can suggest new wording for a line. Nothing changes unless you accept it, and then it is checked against your confirmed facts first. Your coach is told whether you used it, and nothing else.",
    );
    // The coach is told, after what is said of comments, where their wording is kept and what a delete leaves.
    expect(section("Sharing a copy")).toContain(
      "even if you delete yours. If you suggest wording, it is kept in the owner’s account like a comment and shown to them with the name on your account. If they accept it, it is sent to a model to be checked. You are told whether they used it. You can delete a suggestion while the copy is open to you; if the owner had already accepted it, the check they started, and any resume line it became, keep the wording.",
    );
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
    expect(MAX_APP_FIT_STARTS_PER_DAY).toBe(20);
    expect(section("Connecting an app")).toContain("Connected apps together can start at most 20 fit checks a day.");
  });

  it("says what a fit check gives a connected app, and that it uses none of the plan's limit", () => {
    render(<LegalPage doc="privacy" />);
    const items = [...screen.getByRole("heading", { level: 2, name: "Connecting an app" }).closest("section")!.querySelectorAll("li")].map((item) => item.textContent!.replace(/\s+/g, " ").trim());
    expect(items.at(-1)).toBe("create documents, which count toward your plan’s limit, and check your fit for the saved jobs it can see, which doesn’t.");
    // Said before what an app never receives, so the one sentence about what it is given comes first.
    expect(section("Connecting an app")).toContain(
      "A fit check gives the app each requirement read from a job’s posting and the confirmed facts matched to it. Connected apps together can start at most 20 fit checks a day. A connected app never receives your uploaded files",
    );
  });

  it("names the job preferences that are kept, and says that nothing reads them", () => {
    render(<LegalPage doc="privacy" />);
    const kept = section("What we keep");
    expect(kept).toContain("The job preferences you enter: a place, job types, when you’re available and a pay floor.");
    expect(kept).toContain(
      "They stay in your database. They are not shown to anyone, not put in a resume or a shared copy, not sent to a connected app or an AI model, and nothing uses them yet.",
    );
    // With the other details a person types about themselves, directly after the profile's.
    const items = [...screen.getByRole("heading", { level: 2, name: "What we keep" }).closest("section")!.querySelectorAll("li")].map((item) => item.textContent!.replace(/\s+/g, " "));
    const item = items.findIndex((text) => text.startsWith("The job preferences you enter"));
    expect(items[item - 1]).toBe("The profile details you enter: name, email, phone, location and links.");
    // Each of the four things stored is named, and nothing that isn't stored is.
    for (const stored of ["a place", "job types", "when you’re available", "a pay floor"]) expect(items[item], stored).toContain(stored);
    expect(items[item]).not.toMatch(/remote|authori[sz]|visa|citizen|permit|salary history/i);
    expect(document.querySelector("article")!.textContent).not.toMatch(/remote work|work authori[sz]ation|right to work/i);
    expect(section("Your choices")).toContain("every fact, role, profile detail and job preference can be edited, rejected or cleared under Facts and Account.");
    // No app is given them, so what an app may do says nothing about them.
    expect(section("Connecting an app")).not.toMatch(/preference/i);
  });
});

describe("the credits", () => {
  // The latest build's manifest is the record of what the sources ask to be said. A rebuild that
  // changes a notice changes the manifest, and this test then fails until the pages say it too.
  const manifest = JSON.parse(readFileSync("docs/taxonomy-build-2026-11-11.json", "utf8")) as {
    notices: string[];
    licences: { source: string; terms: string; url: string }[];
  };

  it("credits ESCO and O*NET on both pages, word for word as the latest manifest has them", () => {
    expect(TAXONOMY_NOTICES).toEqual(manifest.notices);
    const [esco, onet] = manifest.licences;
    expect(esco).toMatchObject({ source: "ESCO", url: "https://esco.ec.europa.eu/en/use-esco/download" });
    expect(onet).toMatchObject({ source: "O*NET 31.0 Database", url: "https://creativecommons.org/licenses/by/4.0/" });
    for (const doc of ["privacy", "terms"] as const) {
      const page = render(<LegalPage doc={doc} />);
      const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
      // The last section of each page.
      expect(headings.at(-1), doc).toBe("Credits");
      const credits = screen.getByRole("heading", { level: 2, name: "Credits" }).closest("section")!;
      // Each notice in a quotation of its own, exactly.
      expect([...credits.querySelectorAll("blockquote")].map((quote) => quote.textContent), doc).toEqual(manifest.notices);
      // Each licence linked where the manifest says, under the name of its terms.
      const ec = within(credits).getByRole("link", { name: "Commission Decision 2011/833/EU" });
      expect(ec).toHaveAttribute("href", esco!.url);
      expect(esco!.terms.startsWith(ec.textContent!)).toBe(true);
      const cc = within(credits).getByRole("link", { name: `${onet!.terms} licence` });
      expect(cc).toHaveAttribute("href", onet!.url);
      const text = credits.textContent!.replace(/\s+/g, " ");
      expect(text).toContain("Resumatic describes work in the terms of two public classifications.");
      expect(text).toContain("We hold the two in one set and add labels and links of our own, each marked as ours; we reword nothing in either.");
      page.unmount();
    }
  });
});
