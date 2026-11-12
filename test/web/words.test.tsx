import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { App } from "../../src/web/App";
import { ShareSnapshotContent } from "../../src/web/components/ShareSnapshotContent";
import { AccountPage } from "../../src/web/pages/AccountPage";
import { JobsPage } from "../../src/web/pages/JobsPage";
import { SourcesPage } from "../../src/web/pages/SourcesPage";
import { installFakeApi } from "./api-fake";
import { fullVault, sharedView } from "./fixtures";
import { goTo, renderWithSession } from "./render";

// The plain words (voice and writing): every label the interface writes itself uses them. A label
// is a button, link, heading, legend, summary, caption, mark, filter option, aria-label, field hint
// or status line. Stage 1 changed the words for the review states, the review answers, the line
// statuses, and five nouns: source (the person's file), vault, evidence, gap and output.

const LABELS =
  "button, a, h1, h2, h3, h4, h5, h6, legend, summary, figcaption, .rs-mark, .rs-filter__opt, .hint, .rs-hint, [role=status]";

/** Earlier words no label may use. */
const EARLIER =
  /^(Confirm|Edit|Reject)( role)?$|Proposed|Rejected|\bKept\b|Repaired|Dropped|own claim|\bvault\b|\bsources?\b|evidence|\bgaps?\b|\boutputs?\b/;

/** Earlier words that their own room stage renames. A label using one must be on the list below. */
const LATER = /\b(postings?|snapshots?|[Cc]ard|[Ss]ensitive|[Aa]pplications?)\b/;

/**
 * Labels that keep an earlier word until the stage that owns their room, by stage. Each stage
 * removes its own entries here and from docs/redesign-words.md when it renames them.
 */
const DEFERRED: Readonly<Record<string, string>> = {
  // Stage 4, facts: sensitive becomes private, with the privacy notice.
  Sensitive: "stage 4",
  "Sensitive fact": "stage 4",
  "Mark sensitive": "stage 4",
  "Unmark sensitive": "stage 4",
  // Stage 6, sharing and account: card becomes anonymous profile.
  "Card preview": "stage 6",
  // Stage 7, outside: snapshot becomes shared copy.
  "Shared career snapshot": "stage 7",
};

/**
 * The boards' own names for a job's tab and for the room's page of prepared applications: names of
 * places, used exactly so, not the earlier word for a job.
 */
const BOARD_NAMES = new Set(["Application", "Applications"]);

/** Every label on the page now, as a person reads it. */
function labels(): string[] {
  const texts = [...document.body.querySelectorAll(LABELS)].map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());
  const aria = [...document.body.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label")!.trim());
  return [...texts, ...aria].filter(Boolean);
}

/** Facts in each filter, Your jobs, a job's five tabs with a line's card open, Account and a shared copy, with fullVault(). */
async function everyScreen(): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const take = (where: string) => {
    for (const label of labels()) if (!seen.has(label)) seen.set(label, where);
  };

  let state = fullVault();
  installFakeApi(state);
  let page = renderWithSession(<SourcesPage />, state.me);
  await screen.findAllByRole("button", { name: /That’s right/ });
  for (const filter of ["To check", "Confirmed", "Left out"]) {
    await userEvent.click(screen.getByRole("radio", { name: new RegExp(`^${filter}`) }));
    take(`Facts, ${filter}`);
  }
  page.unmount();

  state = fullVault();
  installFakeApi(state);
  page = renderWithSession(<JobsPage />, state.me);
  await screen.findByRole("link", { name: "Platform Engineer" });
  take("Your jobs");
  page.unmount();

  // A job's page, through the app so its tabs and the room's are read too.
  state = fullVault();
  state.applications[0]!.url = "https://careers.litware.example/platform-engineer";
  installFakeApi(state);
  goTo("#/jobs/app-litware/fit");
  const app = render(<App />);
  await screen.findByRole("region", { name: "Job description" });
  await userEvent.click(screen.getByRole("button", { name: "Edit details" }));
  for (const details of document.querySelectorAll("details")) details.open = true;
  take("a job, Fit");
  act(() => goTo("#/jobs/app-litware/resume"));
  await screen.findByRole("article", { name: "Resume preview" });
  // A backed line's card, and a changed one's.
  await userEvent.click(document.querySelector<HTMLButtonElement>('[data-note-for="line-migration"] button')!);
  await screen.findByRole("region", { name: "Where this line came from" });
  take("a job, Resume, a backed line");
  await userEvent.click(document.querySelector<HTMLButtonElement>('[data-note-for="line-latency"] button')!);
  take("a job, Resume, a corrected line");
  act(() => goTo("#/jobs/app-litware/letter"));
  await screen.findByText("Where these sentences came from");
  for (const details of document.querySelectorAll("details")) details.open = true;
  take("a job, Cover letter");
  act(() => goTo("#/jobs/app-litware/interview"));
  await screen.findByRole("button", { name: "Cancel this document" });
  for (const details of document.querySelectorAll("details")) details.open = true;
  take("a job, Interview");
  act(() => goTo("#/jobs/app-litware/application"));
  await screen.findByRole("button", { name: "Approve kit" });
  await screen.findByText("Asked every time");
  take("a job, Application");
  app.unmount();

  state = fullVault();
  installFakeApi(state);
  page = renderWithSession(<AccountPage />, state.me);
  await screen.findByText("Dana Okafor");
  await screen.findByRole("combobox", { name: "Choose a plan" });
  await screen.findByRole("button", { name: "Save preferences" });
  await screen.findByText("Web platform development software");
  await screen.findByRole("checkbox", { name: "A coach comments on a copy you shared" });
  take("Account");
  page.unmount();

  const copy = render(<ShareSnapshotContent view={sharedView()} />);
  take("a shared copy");
  copy.unmount();
  return seen;
}

describe("the interface's words", () => {
  let seen: Map<string, string>;
  beforeAll(async () => {
    seen = await everyScreen();
  }, 30_000);

  it("labels use the plain words", () => {
    // Enough of every screen was read for the check to mean something.
    expect(seen.size).toBeGreaterThan(150);
    for (const label of ["That’s right", "Fix it", "Leave it out", "Your files", "To check", "Backed"]) {
      expect([...seen.keys()], label).toContain(label);
    }
    // Left out names the Facts filter, with its count beside it. A resume says what was left out in its one sentence.
    expect([...seen.keys()].filter((label) => /^Left out \d+$/.test(label)), "Left out").not.toEqual([]);
    const earlier = [...seen].filter(([label]) => EARLIER.test(label)).map(([label, where]) => `${where}: ${label}`);
    expect(earlier).toEqual([]);
  });

  it("keeps every deferred label on its list", () => {
    const unlisted = [...seen].filter(([label]) => LATER.test(label) && !(label in DEFERRED) && !BOARD_NAMES.has(label)).map(([label, where]) => `${where}: ${label}`);
    expect(unlisted).toEqual([]);
    // The word list names each one, in quotation marks, with its stage.
    const doc = readFileSync(resolve(process.cwd(), "docs/redesign-words.md"), "utf8");
    const undocumented = Object.keys(DEFERRED).filter((label) => !doc.includes(`“${label}”`));
    expect(undocumented).toEqual([]);
  });
});
