import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FactView, RoleView } from "../../src/shared/api";
import { countByState } from "../../src/shared/review-groups";
import { VAULT_CHANGED } from "../../src/web/live";
import { FactsRecord } from "../../src/web/pages/facts/FactsRecord";
import { FactsReview } from "../../src/web/pages/facts/FactsReview";
import { FactsSkills } from "../../src/web/pages/facts/FactsSkills";
import { FactsSources } from "../../src/web/pages/facts/FactsSources";
import { installFakeApi, type FakeApi } from "./api-fake";
import { emptyVault, fixtures, type Fixtures } from "./fixtures";
import { renderWithSession } from "./render";

// Facts: To check asks one question at a time beside its file, All facts lists what was confirmed
// and left out, Skills lists the confirmed skills, and Your files lists what was added.

const NORTHWIND = "Senior Backend Engineer at Northwind Logistics";
const LATENCY = "Reduced p95 API latency from 900 ms to 210 ms by moving hot paths to Redis.";
const MIGRATION = "Led the migration of 40 services from Heroku to Kubernetes.";
const MENTORING = "Mentored four engineers through their first on-call rotations.";
const PIPELINE = "Built the claims-intake pipeline in Python and Apache Airflow, processing 2 million claims a month.";
const AUDIT = "Shipped audit logging that passed the 2020 HIPAA review.";
const PRIVATE_HINT =
  "Kept private. Never used in a new resume, letter, interview preparation or fit preview, never put in a shared copy and never shown to a connected app. Facts with the same words are kept private with it.";
const STOP_QUESTION =
  "It can be used again in resumes and documents, and connected apps can read it. Resumes that use it can be downloaded and shared again, and any shared copy that holds it opens again for anyone with its link. Facts with the same words stop being private with it.";

/**
 * Sam's vault with the text of sam-rivera-2024.pdf: every quote on a line of its own, and each
 * role's and fact's span where its quote first appears.
 */
function withText(state: Fixtures = fixtures()): Fixtures {
  const items: (RoleView | FactView)[] = [...state.roles, ...state.facts];
  const quotes = [...new Set(items.filter((item) => item.sourceId === "src-2024" && item.quote).map((item) => item.quote!))];
  const markdown = `Sam Rivera\nWaterloo, ON\n\n${quotes.join("\n")}\n`;
  state.sourceTexts = { ...state.sourceTexts, "src-2024": markdown };
  for (const item of items) {
    if (item.sourceId !== "src-2024" || !item.quote) continue;
    const start = markdown.indexOf(item.quote);
    item.span = [start, start + item.quote.length];
  }
  return state;
}

const reviewCalls = (api: FakeApi) => api.callsTo("POST", /^\/api\/review$/).map((c) => c.body);
const sensitiveCalls = (api: FakeApi) => api.callsTo("POST", /^\/api\/facts\/sensitive$/).map((c) => c.body);

// To check's parts.
const question = () => document.getElementById("facts-question")!;
const item = () => question().querySelector<HTMLElement>(".facts-ask__item")!;
const asked = () => question().querySelector(".facts-ask__text")?.textContent ?? null;
const where = () => question().querySelector(".facts-ask__meta .rs-meta")?.textContent ?? null;
const filePanel = () => document.querySelector<HTMLElement>(".facts-file")!;
const fileText = () => filePanel().querySelector<HTMLElement>("pre")!;
const upNext = () => screen.getByRole("region", { name: "Up next" });
const button = (name: string) => within(question()).getByRole("button", { name });

async function openCheck(state: Fixtures = withText()): Promise<FakeApi> {
  const api = installFakeApi(state);
  renderWithSession(<FactsReview />, state.me);
  await screen.findByText(NORTHWIND, { selector: ".facts-ask__text" });
  return api;
}

/** Skips until the question asks about `text`. */
async function skipTo(text: string) {
  for (let i = 0; i < 6 && asked() !== text; i++) await userEvent.click(button("Skip for now"));
  expect(asked()).toBe(text);
}

/** Opens More choices under the current fact. */
async function moreChoices() {
  await userEvent.click(within(question()).getByText("More choices"));
}

/** A pre's text as it is seen: without the words read out only to assistive technology. */
function seen(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll(".rs-visually-hidden")) hidden.remove();
  return copy.textContent ?? "";
}

describe("To check", () => {
  it("asks one question at a time, beginning with Northwind Logistics as a role", async () => {
    await openCheck();
    expect(within(question()).getByRole("heading", { level: 2 })).toHaveTextContent("Is this right?");
    expect(asked()).toBe(NORTHWIND);
    // One set of answers, each named by what it answers about.
    const answers = within(item()).getAllByRole("button").filter((b) => b.hasAttribute("data-review-action"));
    expect(answers.map((b) => b.textContent)).toEqual(["That’s right", "Fix it", "Leave it out"]);
    for (const answer of answers) expect(answer).toHaveAccessibleDescription(NORTHWIND);
    expect(question()).toHaveAccessibleDescription(NORTHWIND);
    // A role says what it is and where it came from.
    expect(within(item()).getByText("Job")).toBeInTheDocument();
    expect(within(item()).getByText("Mar 2021 – present")).toBeInTheDocument();
    expect(within(item()).getByText("From sam-rivera-2024.pdf")).toBeInTheDocument();
    // Nothing else on the page is a question, and That’s right is the one brand button.
    expect(screen.getAllByRole("button", { name: "That’s right" })).toHaveLength(1);
    expect(document.querySelectorAll(".rs-btn--primary")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Add a file" })).toHaveAttribute("href", "#/facts/files");
  });

  it("says where the question sits: 1 of 5 and the role it belongs to", async () => {
    await openCheck();
    expect(where()).toBe("1 of 5. A role. Saying one of its facts is right confirms the role too.");
    await userEvent.click(button("Skip for now"));
    expect(where()).toBe("2 of 5. From your time as Senior Backend Engineer at Northwind Logistics.");
    expect(asked()).toBe(LATENCY);
    await skipTo("PostgreSQL");
    expect(where()).toBe("5 of 5. Not tied to a role.");
  });

  it("names the role by its organisation alone when it has no title", async () => {
    const state = withText();
    state.roles.find((role) => role.id === "role-northwind")!.title = null;
    installFakeApi(state);
    renderWithSession(<FactsReview />, state.me);
    await screen.findByText("Northwind Logistics", { selector: ".facts-ask__text" });
    await userEvent.click(button("Skip for now"));
    expect(where()).toBe("2 of 5. From your time at Northwind Logistics.");
  });

  it("lists at most four in Up next, and links Add a fact or a role yourself to All facts", async () => {
    await openCheck();
    const rows = within(upNext()).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector(".app-q__t")!.textContent)).toEqual([LATENCY, MIGRATION, MENTORING, "PostgreSQL"]);
    expect(rows.map((row) => row.querySelector(".rs-meta")!.textContent)).toEqual([
      "Something you did, at Northwind Logistics",
      "Something you did, at Northwind Logistics",
      "Something you did, at Northwind Logistics",
      "A skill, not tied to a role",
    ]);
    for (const row of rows) expect(row.querySelector(".rs-tick")).toHaveClass("rs-tick--needs-you");
    // Read ahead only: nothing in it can be pressed but the way to add what isn't here.
    expect(within(upNext()).queryAllByRole("button")).toEqual([]);
    expect(within(upNext()).getByRole("link", { name: "Add a fact or a role yourself" })).toHaveAttribute("href", "#/facts/all");
    // Five questions, so never more than four after this one.
    await userEvent.click(button("Skip for now"));
    const after = within(upNext()).getAllByRole("listitem");
    expect(after.map((row) => row.querySelector(".app-q__t")!.textContent)).toEqual([MIGRATION, MENTORING, "PostgreSQL", NORTHWIND]);
    expect(after[3]).toHaveTextContent("A role. Saying one of its facts is right confirms the role too.");
  });

  it("links Add a fact or a role yourself even with nothing to check", async () => {
    const state = withText();
    for (const entry of [...state.roles, ...state.facts]) if (entry.state === "proposed") entry.state = "confirmed";
    installFakeApi(state);
    renderWithSession(<FactsReview />, state.me);
    expect(await screen.findByText("You’re all caught up")).toBeInTheDocument();
    expect(within(question()).getByRole("heading", { level: 2, name: "Nothing to check" })).toHaveClass("rs-visually-hidden");
    expect(within(question()).getByRole("link", { name: "add a job" })).toHaveAttribute("href", "#/jobs");
    expect(within(upNext()).queryAllByRole("listitem")).toEqual([]);
    expect(within(upNext()).getByRole("link", { name: "Add a fact or a role yourself" })).toHaveAttribute("href", "#/facts/all");
    expect(document.querySelector(".facts-file")).toBeNull();
  });

  it("says the file is being read while nothing waits yet", async () => {
    const state = withText();
    for (const entry of [...state.roles, ...state.facts]) if (entry.state === "proposed") entry.state = "confirmed";
    state.sources.unshift({ id: "src-new", filename: "new.pdf", state: "queued", error: null, createdAt: 1793990000000, proposed: 0 });
    installFakeApi(state);
    renderWithSession(<FactsReview />, state.me);
    expect(await screen.findByText("Resumatic is reading your file. What it finds will appear here for you to check.")).toBeInTheDocument();
  });

  it("offers only Everything and Roles and facts, each counting what the tab counts", async () => {
    const state = withText();
    await openCheck(state);
    const filter = screen.getByRole("group", { name: "What to check" });
    const options = within(filter).getAllByRole("radio");
    const proposed = countByState(state).proposed;
    expect(proposed).toBe(5);
    expect(options.map((option) => option.closest("label")!.textContent)).toEqual([`Everything ${proposed}`, `Roles and facts ${proposed}`]);
    expect(options[0]).toBeChecked();
    await userEvent.click(options[1]!);
    expect(options[1]).toBeChecked();
    // Both hold the same questions.
    expect(where()).toBe("1 of 5. A role. Saying one of its facts is right confirms the role too.");
  });

  it("shows Skills, Same fact twice, Lines that say two things and Questions only as a placeholder with no control", async () => {
    await openCheck();
    const kinds = screen.getByRole("region", { name: "More to check" });
    expect(kinds).toHaveTextContent(
      "Checking the skills Resumatic reads from your facts, joining the same fact found twice, and splitting a line that says two things open next. So does answering experience questions here. For now they’re asked on a job’s page.",
    );
    expect(within(kinds).getByText("Not available yet")).toHaveClass("rs-mark--note");
    expect(kinds.querySelectorAll("button, input, select, textarea, a")).toHaveLength(0);
    // None of them is a choice in the filter.
    const filter = screen.getByRole("group", { name: "What to check" });
    for (const name of [/^Skills/, /^Same fact twice/, /^Lines that say two things/, /^Questions/]) {
      expect(within(filter).queryByRole("radio", { name })).toBeNull();
    }
  });

  it("opens on one big dropzone before the first upload, keeps it after the first file is added, and asks about what was read under it", async () => {
    const state = emptyVault();
    installFakeApi(state);
    renderWithSession(<FactsReview />, state.me);
    await screen.findByRole("heading", { name: "What happens next" });
    const drop = () => document.querySelector(".app-drop--first-run");
    expect(drop()).not.toBeNull();
    expect(within(question()).getByText(/^Nothing to check yet\./)).toBeInTheDocument();
    const input = document.querySelector<HTMLInputElement>(".app-drop--first-run input[type=file]")!;
    await userEvent.upload(input, new File(["%PDF-1.4"], "cv.pdf", { type: "application/pdf" }));
    expect(await within(question()).findByText("Resumatic is reading your file. What it finds will appear here for you to check.")).toBeInTheDocument();
    // The dropzone stays for this visit, now that a file has been added.
    expect(drop()).not.toBeNull();
    // The file is read: what it holds is asked about under the dropzone.
    const source = state.sources[0]!;
    source.state = "ready";
    state.roles.push({ id: "role-new", kind: "job", org: "Contoso Health", title: "Software Engineer", startDate: "2018-06", endDate: null, state: "proposed", quote: null, sourceId: source.id });
    state.facts.push({ id: "fact-new", roleId: "role-new", kind: "accomplishment", text: "Built the claims pipeline.", level: null, origin: "extracted", state: "proposed", quote: null, sourceId: source.id });
    act(() => void window.dispatchEvent(new Event(VAULT_CHANGED)));
    await screen.findByText("Software Engineer at Contoso Health", { selector: ".facts-ask__text" });
    expect(drop()).not.toBeNull();
    const next = screen.getByRole("heading", { name: "What happens next" });
    expect(drop()!.compareDocumentPosition(question()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(question().compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("doesn’t open on the dropzone once anything is there", async () => {
    await openCheck();
    expect(document.querySelector(".app-drop--first-run")).toBeNull();
    expect(screen.queryByRole("heading", { name: "What happens next" })).toBeNull();
  });

  it("shows each copy’s quote with the file it came from", async () => {
    const state = withText();
    const copyQuote = "Migrated 40 services from Heroku to Kubernetes as the lead";
    const markdown = `Experience\n${copyQuote}\n`;
    state.sources.push({ id: "src-linkedin", filename: "linkedin-export.zip", state: "ready", error: null, createdAt: 1793800000000, proposed: 1 });
    state.sourceTexts!["src-linkedin"] = markdown;
    const migration = state.facts.find((fact) => fact.id === "fact-migration")!;
    const start = markdown.indexOf(copyQuote);
    state.facts.push({ ...migration, id: "fact-migration-copy", quote: copyQuote, sourceId: "src-linkedin", span: [start, start + copyQuote.length] });
    const api = await openCheck(state);
    // Two records, one question.
    expect(where()).toMatch(/^1 of 5\./);
    await skipTo(MIGRATION);
    const captions = [...item().querySelectorAll("figcaption")].map((caption) => caption.textContent);
    expect(captions).toEqual(["From sam-rivera-2024.pdf", "From linkedin-export.zip"]);
    expect(within(item()).getByText(copyQuote)).toBeInTheDocument();
    expect(item()).toHaveTextContent("This fact also appears in 1 other record. Your answer applies to every copy shown; Fix it changes this copy only.");
    // The copy in another file can be read in it; this question's own file is beside it already.
    const open = within(item()).getAllByRole("button", { name: "See where this came from" });
    expect(open).toHaveLength(1);
    await userEvent.click(open[0]!);
    expect(await within(item()).findByText(copyQuote, { selector: "pre mark" })).toBeInTheDocument();
    // That’s right answers for every copy shown.
    await userEvent.click(button("That’s right"));
    await waitFor(() => expect(reviewCalls(api)).toHaveLength(1));
    expect(reviewCalls(api)[0]).toMatchObject({ confirm: ["fact-migration", "fact-migration-copy"], reject: [] });
  });

  it("a fact under a left-out role: That’s right is disabled, Y does nothing, and the hint links to All facts", async () => {
    const state = withText();
    state.roles.find((role) => role.id === "role-northwind")!.state = "rejected";
    const api = installFakeApi(state);
    renderWithSession(<FactsReview />, state.me);
    await screen.findByText(LATENCY, { selector: ".facts-ask__text" });
    // Still asked, so the count agrees with Today's, but it can't be confirmed here.
    expect(where()).toBe("1 of 4. From your time as Senior Backend Engineer at Northwind Logistics.");
    expect(button("That’s right")).toBeDisabled();
    expect(button("Fix it")).toBeEnabled();
    expect(button("Leave it out")).toBeEnabled();
    question().focus();
    await userEvent.keyboard("y");
    expect(reviewCalls(api)).toHaveLength(0);
    const hint = within(item()).getByText(/^This fact can’t be used while its role is left out\./);
    expect(hint).toHaveTextContent(
      "This fact can’t be used while its role is left out. To use it, open All facts, choose Left out and say “That’s right” to the role.",
    );
    expect(within(hint).getByRole("link", { name: "All facts" })).toHaveAttribute("href", "#/facts/all");
    // Leaving it out still works.
    await userEvent.keyboard("l");
    await waitFor(() => expect(reviewCalls(api)).toHaveLength(1));
    expect(reviewCalls(api)[0]).toMatchObject({ confirm: [], reject: ["fact-latency"] });
  });
});

describe("To check’s keys", () => {
  it("Y confirms and moves focus to the next question", async () => {
    const api = await openCheck();
    await userEvent.click(button("Skip for now"));
    question().focus();
    await userEvent.keyboard("y");
    await waitFor(() => expect(reviewCalls(api)).toHaveLength(1));
    expect(reviewCalls(api)[0]).toMatchObject({ confirm: ["fact-latency"], reject: [] });
    // Confirming the fact confirmed its role, so the next question is the fact after it.
    await waitFor(() => expect(asked()).toBe(MIGRATION));
    expect(where()).toBe("1 of 3. From your time as Senior Backend Engineer at Northwind Logistics.");
    await waitFor(() => expect(question()).toHaveFocus());
    // And Y again answers the new question.
    await userEvent.keyboard("y");
    await waitFor(() => expect(reviewCalls(api)).toHaveLength(2));
    expect(reviewCalls(api)[1]).toMatchObject({ confirm: ["fact-migration"] });
    await waitFor(() => expect(asked()).toBe(MENTORING));
  });

  it("F opens the editor; Escape returns focus to the question", async () => {
    await openCheck();
    await userEvent.click(button("Skip for now"));
    question().focus();
    await userEvent.keyboard("f");
    const editor = await within(question()).findByLabelText("Fact", { selector: "textarea" });
    expect(editor).toHaveFocus();
    expect(screen.getByText(/^Checking is paused while you fix this\./)).toHaveAttribute("role", "status");
    await userEvent.keyboard("{Escape}");
    expect(within(question()).queryByLabelText("Fact", { selector: "textarea" })).toBeNull();
    expect(question()).toHaveFocus();
    expect(asked()).toBe(LATENCY);
    expect(screen.queryByText(/^Checking is paused/)).toBeNull();
  });

  it("Escape closes the role editor and returns focus to the question", async () => {
    await openCheck();
    question().focus();
    await userEvent.keyboard("f");
    const form = await within(question()).findByRole("form", { name: "Edit Northwind Logistics" });
    expect(within(form).getByRole("textbox", { name: "Organization" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(within(question()).queryByRole("form")).toBeNull();
    expect(question()).toHaveFocus();
    expect(asked()).toBe(NORTHWIND);
  });

  it("J skips and K goes back; Back is disabled at the first", async () => {
    await openCheck();
    expect(button("Back")).toBeDisabled();
    expect(button("Skip for now")).toBeEnabled();
    question().focus();
    await userEvent.keyboard("j");
    expect(asked()).toBe(LATENCY);
    await userEvent.keyboard("j");
    expect(asked()).toBe(MIGRATION);
    await userEvent.keyboard("k");
    expect(asked()).toBe(LATENCY);
    await userEvent.keyboard("k");
    expect(asked()).toBe(NORTHWIND);
    expect(button("Back")).toBeDisabled();
    // K at the first does nothing, and J wraps from the last to the first.
    await userEvent.keyboard("k");
    expect(asked()).toBe(NORTHWIND);
    await userEvent.keyboard("jjjj");
    expect(asked()).toBe("PostgreSQL");
    await userEvent.keyboard("j");
    expect(asked()).toBe(NORTHWIND);
    expect(question()).toHaveFocus();
  });

  it("keeps the keys working when J is pressed on an answer button", async () => {
    await openCheck();
    button("Fix it").focus();
    await userEvent.keyboard("j");
    expect(asked()).toBe(LATENCY);
    // The item that had focus is gone, so focus is on the question again.
    expect(question()).toHaveFocus();
    await userEvent.keyboard("j");
    expect(asked()).toBe(MIGRATION);
  });

  it("with Fix it open and focus on Save fact, Y, L, J and K change nothing and the draft stays", async () => {
    const api = await openCheck();
    await userEvent.click(button("Skip for now"));
    await userEvent.click(button("Fix it"));
    const editor = await within(question()).findByLabelText("Fact", { selector: "textarea" });
    await userEvent.type(editor, " draft");
    const save = within(question()).getByRole("button", { name: "Save fact" });
    save.focus();
    await userEvent.keyboard("yljk");
    expect(reviewCalls(api)).toHaveLength(0);
    expect(api.callsTo("PATCH", /^\/api\/facts\//)).toHaveLength(0);
    expect(editor).toHaveValue(`${LATENCY} draft`);
    expect(save).toHaveFocus();
    expect(where()).toMatch(/^2 of 5\./);
    // Nothing else moves while it is open: not the question, not the filter.
    expect(button("Skip for now")).toBeDisabled();
    expect(button("Back")).toBeDisabled();
    expect(screen.getByRole("group", { name: "What to check" })).toBeDisabled();
    // Pressed on the question itself, the keys do nothing either.
    question().focus();
    await userEvent.keyboard("yljk");
    expect(reviewCalls(api)).toHaveLength(0);
    expect(editor).toHaveValue(`${LATENCY} draft`);
    expect(asked()).toBeNull();
    expect(where()).toMatch(/^2 of 5\./);
  });

  it("a second Y while the answer saves sends no second request", async () => {
    const state = withText();
    const api = installFakeApi(state);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const fetch = api.fetch;
    let sent = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/review")) {
        sent++;
        await held;
      }
      return fetch(input, init);
    });
    renderWithSession(<FactsReview />, state.me);
    await screen.findByText(NORTHWIND, { selector: ".facts-ask__text" });
    await userEvent.click(button("Skip for now"));
    question().focus();
    await userEvent.keyboard("y");
    expect(await within(question()).findByRole("button", { name: "Saving…" })).toBeDisabled();
    for (const name of ["Fix it", "Leave it out", "Skip for now", "Back"]) expect(button(name)).toBeDisabled();
    await userEvent.keyboard("yjl");
    expect(sent).toBe(1);
    release();
    await waitFor(() => expect(asked()).toBe(MIGRATION));
    expect(reviewCalls(api)).toHaveLength(1);
  });

  it("leaves keys alone while typing, with a modifier, on repeat, in Up next and in the file panel", async () => {
    const api = await openCheck();
    await userEvent.click(button("Skip for now"));
    // Typing in the editor writes the letters.
    await userEvent.click(button("Fix it"));
    const editor = await within(question()).findByLabelText("Fact", { selector: "textarea" });
    await userEvent.clear(editor);
    await userEvent.type(editor, "yfljk");
    expect(editor).toHaveValue("yfljk");
    await userEvent.keyboard("{Escape}");
    // A modifier held.
    question().focus();
    await userEvent.keyboard("{Control>}y{/Control}{Meta>}l{/Meta}{Alt>}j{/Alt}");
    // A key held down.
    fireEvent.keyDown(question(), { key: "y", repeat: true });
    fireEvent.keyDown(question(), { key: "l", repeat: true });
    fireEvent.keyDown(question(), { key: "j", repeat: true });
    // Up next, and the file beside the question.
    within(upNext()).getByRole("link", { name: "Add a fact or a role yourself" }).focus();
    await userEvent.keyboard("yljk");
    await within(filePanel()).findByText(/^Cut p95/, { selector: "pre mark" });
    fileText().focus();
    await userEvent.keyboard("yljk");
    expect(reviewCalls(api)).toHaveLength(0);
    expect(asked()).toBe(LATENCY);
    expect(within(question()).queryByLabelText("Fact", { selector: "textarea" })).toBeNull();
    expect(screen.queryByRole("group", { name: /^Leave out/ })).toBeNull();
    // The same key, pressed once on the question, is an answer.
    fireEvent.keyDown(question(), { key: "y" });
    await waitFor(() => expect(reviewCalls(api)).toHaveLength(1));
  });

  it("ignores C, E and R", async () => {
    const api = await openCheck();
    question().focus();
    await userEvent.keyboard("cer");
    expect(screen.queryByRole("group", { name: "Leave out Northwind Logistics" })).toBeNull();
    expect(within(question()).queryByRole("form")).toBeNull();
    await userEvent.click(button("Skip for now"));
    question().focus();
    await userEvent.keyboard("cer");
    expect(reviewCalls(api)).toHaveLength(0);
    expect(within(question()).queryByLabelText("Fact", { selector: "textarea" })).toBeNull();
    expect(asked()).toBe(LATENCY);
  });

  it("names each key for assistive technology", async () => {
    await openCheck();
    expect(button("That’s right")).toHaveAttribute("aria-keyshortcuts", "Y");
    expect(button("Fix it")).toHaveAttribute("aria-keyshortcuts", "F");
    expect(button("Leave it out")).toHaveAttribute("aria-keyshortcuts", "L");
    expect(button("Skip for now")).toHaveAttribute("aria-keyshortcuts", "J");
    expect(button("Back")).toHaveAttribute("aria-keyshortcuts", "K");
    const keys = item().querySelector(".rs-actions__keys")!;
    expect([...keys.children].map((hint) => hint.textContent)).toEqual(["Y that’s right", "F fix it", "L leave it out", "JK next and previous"]);
  });
});

describe("To check, a role", () => {
  it("asks before L leaves out a role with facts still to check, naming 3 facts and Yes, leave out 4", async () => {
    const api = await openCheck();
    question().focus();
    await userEvent.keyboard("l");
    const well = screen.getByRole("group", { name: "Leave out Northwind Logistics" });
    expect(well).toHaveTextContent("Leave out Northwind Logistics and its 3 facts still to check? They’re kept under Left out and never used.");
    expect(reviewCalls(api)).toHaveLength(0);
    const yes = within(well).getByRole("button", { name: "Yes, leave out 4" });
    expect(yes).toHaveFocus();
    await userEvent.click(yes);
    await waitFor(() => expect(reviewCalls(api)).toHaveLength(1));
    expect(reviewCalls(api)[0]).toMatchObject({ confirm: [], reject: ["role-northwind"] });
    // Its facts went with it, so PostgreSQL is all that's left.
    await waitFor(() => expect(asked()).toBe("PostgreSQL"));
    expect(where()).toBe("1 of 1. Not tied to a role.");
  });

  it("Y in that question doesn’t say the role is right", async () => {
    const api = await openCheck();
    question().focus();
    await userEvent.keyboard("l");
    const yes = within(screen.getByRole("group", { name: "Leave out Northwind Logistics" })).getByRole("button", { name: "Yes, leave out 4" });
    expect(yes).toHaveFocus();
    await userEvent.keyboard("yflj");
    expect(reviewCalls(api)).toHaveLength(0);
    expect(within(question()).queryByRole("form")).toBeNull();
    expect(screen.getByRole("group", { name: "Leave out Northwind Logistics" })).toBeInTheDocument();
    expect(yes).toHaveFocus();
    expect(asked()).toBe(NORTHWIND);
    // Elsewhere in the question, too, the keys wait while it is open.
    question().focus();
    await userEvent.keyboard("yj");
    expect(reviewCalls(api)).toHaveLength(0);
    expect(asked()).toBe(NORTHWIND);
  });

  it("Cancel returns focus to Leave it out", async () => {
    await openCheck();
    await userEvent.click(button("Leave it out"));
    expect(button("Leave it out")).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(within(question()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Leave out Northwind Logistics" })).toBeNull();
    expect(button("Leave it out")).toHaveFocus();
    expect(button("Leave it out")).toHaveAttribute("aria-expanded", "false");
  });

  it("confirms a role on its own with That’s right", async () => {
    const api = await openCheck();
    await userEvent.click(button("That’s right"));
    await waitFor(() => expect(reviewCalls(api)).toHaveLength(1));
    expect(reviewCalls(api)[0]).toMatchObject({ confirm: ["role-northwind"], reject: [] });
    await waitFor(() => expect(asked()).toBe(LATENCY));
  });
});

describe("To check, the file beside the question", () => {
  it("highlights this fact’s words, underlines others still to check in amber and confirmed ones in green, each with its word", async () => {
    await openCheck();
    await userEvent.click(button("Skip for now"));
    expect(within(filePanel()).getByRole("heading", { level: 2, name: "sam-rivera-2024.pdf" })).toBeInTheDocument();
    expect(within(filePanel()).getByText("5 to check")).toHaveClass("rs-mark--needs-you");
    expect(filePanel()).toHaveTextContent(/The text Resumatic read from your file\. Added \d+ \w+ 2026\./);
    expect(within(filePanel()).getByRole("link", { name: "Download original" })).toHaveAttribute("href", "/api/sources/src-2024/file");
    const current = await within(filePanel()).findByText(/^Cut p95/, { selector: "pre mark" });
    expect(current).toHaveClass("rs-hl");
    expect(current.textContent).toBe("This fact: Cut p95 API latency from 900ms to 210ms by moving hot paths to Redis");
    expect(current.querySelector(".rs-visually-hidden")!.textContent).toBe("This fact: ");
    const waiting = [...fileText().querySelectorAll(".facts-u--waiting")].map((run) => run.textContent);
    expect(waiting).toEqual([
      "To check: Senior Backend Engineer, Northwind Logistics, March 2021 to present",
      "To check: Led migration of 40 services from Heroku to Kubernetes",
      "To check: Mentored 4 engineers through first on-call rotations",
      "To check: Skills: Python, Django, Redis, PostgreSQL",
    ]);
    const backed = [...fileText().querySelectorAll(".facts-u--backed")].map((run) => run.textContent);
    expect(backed).toContain("Confirmed: Software Engineer at Contoso Health (June 2018 to February 2021)");
    expect(backed).toContain("Confirmed: Built claims intake pipeline (Python, Airflow) processing 2M claims/month");
    // A fact left out marks nothing.
    expect(fileText().textContent).toContain("Wrote on-call runbook");
    expect([...fileText().querySelectorAll("mark, span")].some((run) => run.textContent?.includes("Wrote on-call runbook"))).toBe(false);
    // The whole file is there, as it was read.
    expect(seen(fileText())).toBe(withText().sourceTexts!["src-2024"]);
    expect(within(filePanel()).getAllByRole("listitem").map((key) => key.textContent)).toEqual([
      "The words behind the fact you’re checking",
      "Behind a fact that’s still to check",
      "Behind a fact you’ve confirmed",
    ]);
  });

  it("marks nothing where a saved span doesn’t match its quote", async () => {
    const state = withText();
    const latency = state.facts.find((fact) => fact.id === "fact-latency")!;
    latency.span = [latency.span![0] + 1, latency.span![1] + 1];
    await openCheck(state);
    await userEvent.click(button("Skip for now"));
    await within(filePanel()).findByText(/^Senior Backend Engineer, Northwind/, { selector: "pre span" });
    expect(fileText().querySelector("mark")).toBeNull();
    expect(seen(fileText())).toContain("Cut p95 API latency from 900ms to 210ms by moving hot paths to Redis");
    // The quote itself is still shown with the fact.
    expect(within(item()).getByText("Cut p95 API latency from 900ms to 210ms by moving hot paths to Redis")).toBeInTheDocument();
  });

  it("shows HTML in a file as text", async () => {
    const state = withText();
    const quote = "Led <b>migration</b> of 40 services <img src=x onerror=alert(1)>";
    const markdown = `<script>alert(1)</script>\n${quote}\n`;
    state.sourceTexts!["src-2024"] = markdown;
    const latency = state.facts.find((fact) => fact.id === "fact-latency")!;
    latency.quote = quote;
    latency.span = [markdown.indexOf(quote), markdown.indexOf(quote) + quote.length];
    await openCheck(state);
    await userEvent.click(button("Skip for now"));
    const current = await within(filePanel()).findByText(/^Led <b>/, { selector: "pre mark" });
    expect(current.textContent).toBe(`This fact: ${quote}`);
    expect(fileText().querySelector("script, img, b")).toBeNull();
    expect(seen(fileText())).toBe(markdown);
  });

  it("offers Try again when the file’s text fails to load, and loads it on retry", async () => {
    const state = withText();
    const api = installFakeApi(state);
    api.fail("GET", /^\/api\/sources\/src-2024\/text$/, 503, "unavailable", "Resumatic is busy right now. Try again in a few minutes.");
    renderWithSession(<FactsReview />, state.me);
    await waitFor(() => expect(document.querySelector(".facts-file")).not.toBeNull());
    const alert = await within(filePanel()).findByRole("alert");
    expect(filePanel().querySelector("pre")).toBeNull();
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await within(filePanel()).findByText(/^Senior Backend Engineer, Northwind/, { selector: "pre mark" })).toBeInTheDocument();
    expect(within(filePanel()).queryByRole("alert")).toBeNull();
    // The text is kept for the page: the next question from the file asks for nothing more.
    await userEvent.click(button("Skip for now"));
    await within(filePanel()).findByText(/^Cut p95/, { selector: "pre mark" });
    expect(api.callsTo("GET", /^\/api\/sources\/src-2024\/text$/)).toHaveLength(2);
  });

  it("Confirm all 5 from this file asks first, names the count and returns focus to the question", async () => {
    const api = await openCheck();
    const all = within(filePanel()).getByRole("button", { name: "Confirm all 5 from this file" });
    expect(within(filePanel()).getByText("Only do this once you’ve checked every one.")).toBeInTheDocument();
    await userEvent.click(all);
    expect(filePanel()).toHaveTextContent(
      "Confirm all 5 roles and facts from sam-rivera-2024.pdf? Only do this if you’ve checked that every one is true.",
    );
    expect(reviewCalls(api)).toHaveLength(0);
    await userEvent.click(within(filePanel()).getByRole("button", { name: "Yes, confirm 5" }));
    await waitFor(() => expect(reviewCalls(api)).toHaveLength(1));
    expect(reviewCalls(api)[0]).toMatchObject({
      confirm: ["role-northwind", "fact-latency", "fact-migration", "fact-mentoring", "fact-postgres"],
      reject: [],
    });
    expect(await screen.findByText("You’re all caught up")).toBeInTheDocument();
    await waitFor(() => expect(question()).toHaveFocus());
  });

  it("keeps the question and its draft while Confirm all changes the file’s count", async () => {
    await openCheck();
    await userEvent.click(button("Skip for now"));
    await userEvent.click(button("Fix it"));
    const editor = await within(question()).findByLabelText("Fact", { selector: "textarea" });
    await userEvent.type(editor, " draft");
    await userEvent.click(within(filePanel()).getByRole("button", { name: "Confirm all 5 from this file" }));
    await userEvent.click(within(filePanel()).getByRole("button", { name: "Yes, confirm 5" }));
    expect(await within(filePanel()).findByText("All checked")).toHaveClass("rs-mark--backed");
    // The panel is live; the question holds what it showed until the editor closes.
    expect(within(question()).getByLabelText("Fact", { selector: "textarea" })).toHaveValue(`${LATENCY} draft`);
    expect(where()).toMatch(/^2 of 5\./);
    expect(screen.getByText(/^Checking is paused while you fix this\./)).toHaveAttribute("role", "status");
    await userEvent.click(within(question()).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("You’re all caught up")).toBeInTheDocument();
  });

  it("says when an item came from no file", async () => {
    const state = withText();
    state.facts.find((fact) => fact.id === "fact-postgres")!.sourceId = null;
    await openCheck(state);
    await skipTo("PostgreSQL");
    expect(filePanel()).toHaveTextContent("This one came from no file.");
    expect(filePanel().querySelector("pre")).toBeNull();
  });
});

describe("To check, Keep private", () => {
  it("Keep private under More choices marks at once and shows Private with what it means", async () => {
    const api = await openCheck();
    await userEvent.click(button("Skip for now"));
    const more = question().querySelector("details")!;
    expect(more).toHaveClass("rs-more");
    expect(more.querySelector("summary")).toHaveTextContent("More choices Keep it private, or split it in two");
    await moreChoices();
    expect(more).toHaveTextContent(
      "Keep private: never used in a new resume, letter, interview preparation or fit preview, never put in a shared copy and never shown to a connected app. A resume that already uses it can’t be downloaded or shared until those lines go.",
    );
    expect(within(item()).queryByText("Private", { selector: ".rs-mark" })).toBeNull();
    await userEvent.click(within(more).getByRole("button", { name: "Keep private" }));
    await waitFor(() => expect(sensitiveCalls(api)).toHaveLength(1));
    expect(sensitiveCalls(api)[0]).toEqual({ ids: ["fact-latency"], sensitive: true, expectedRevisions: { "fact-latency": 1 } });
    const stop = await within(more).findByRole("button", { name: "Stop keeping it private" });
    expect(stop).toHaveAttribute("aria-expanded", "false");
    expect(stop).toHaveAccessibleDescription(LATENCY);
    expect(within(item()).getByText("Private", { selector: ".rs-mark" })).toHaveClass("rs-mark--note");
    expect(within(item()).getByText(PRIVATE_HINT)).toBeInTheDocument();
    await waitFor(() => expect(stop).toHaveFocus());
    // It is still a question to answer.
    expect(asked()).toBe(LATENCY);
    expect(reviewCalls(api)).toHaveLength(0);
  });

  it("asks before Stop keeping it private; Y on the answer neither unmarks nor confirms", async () => {
    const state = withText();
    state.facts.find((fact) => fact.id === "fact-latency")!.sensitive = true;
    const api = await openCheck(state);
    await userEvent.click(button("Skip for now"));
    await moreChoices();
    await userEvent.click(button("Stop keeping it private"));
    const well = screen.getByRole("group", { name: "Stop keeping this fact private" });
    expect(within(well).getByText(STOP_QUESTION)).toBeInTheDocument();
    expect(within(well).getAllByRole("button").map((b) => b.textContent)).toEqual(["Yes, stop keeping it private", "Cancel"]);
    const yes = within(well).getByRole("button", { name: "Yes, stop keeping it private" });
    expect(yes).toHaveFocus();
    await userEvent.keyboard("yflkj");
    expect(reviewCalls(api)).toHaveLength(0);
    expect(sensitiveCalls(api)).toHaveLength(0);
    expect(within(question()).queryByLabelText("Fact", { selector: "textarea" })).toBeNull();
    expect(screen.getByRole("group", { name: "Stop keeping this fact private" })).toBeInTheDocument();
    expect(yes).toHaveFocus();
    expect(asked()).toBe(LATENCY);
    await userEvent.click(within(well).getByRole("button", { name: "Cancel" }));
    expect(button("Stop keeping it private")).toHaveFocus();
    await userEvent.click(button("Stop keeping it private"));
    await userEvent.click(screen.getByRole("button", { name: "Yes, stop keeping it private" }));
    await waitFor(() => expect(sensitiveCalls(api)).toHaveLength(1));
    expect(sensitiveCalls(api)[0]).toEqual({ ids: ["fact-latency"], sensitive: false, expectedRevisions: { "fact-latency": 1 } });
    expect(await within(question()).findByRole("button", { name: "Keep private" })).toBeInTheDocument();
    expect(reviewCalls(api)).toHaveLength(0);
  });

  it("Split it in two has no button", async () => {
    await openCheck();
    await userEvent.click(button("Skip for now"));
    await moreChoices();
    const split = within(question()).getByRole("region", { name: "Split it in two" });
    expect(split).toHaveTextContent("Splitting a line into what you did and its result, each a fact in the same words, opens next.");
    expect(within(split).getByText("Not available yet")).toHaveClass("rs-mark--note");
    expect(split.querySelectorAll("button, input, select, textarea, a")).toHaveLength(0);
    // A role has no More choices.
    await userEvent.click(button("Back"));
    expect(question().querySelector("details")).toBeNull();
  });
});

describe("To check on a phone", () => {
  it("See where this came from toggles the file panel’s state and name", async () => {
    await openCheck();
    const toggle = within(question()).getByRole("button", { name: "See where this came from" });
    expect(toggle).toHaveClass("facts-ask__where");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", filePanel().id);
    expect(filePanel()).not.toHaveClass("is-open");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("Hide where this came from");
    expect(filePanel()).toHaveClass("is-open");
    await userEvent.click(toggle);
    expect(toggle).toHaveTextContent("See where this came from");
    expect(filePanel()).not.toHaveClass("is-open");
    // The file comes after the question, so on a phone it sits right under it.
    expect(question().compareDocumentPosition(filePanel()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(filePanel().compareDocumentPosition(upNext()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides the file panel below 600px until it is asked for, in the Facts room’s own stylesheet", () => {
    const css = readFileSync(resolve(process.cwd(), "src/web/styles/rooms/facts.css"), "utf8");
    const phone = css.slice(css.indexOf("@media (max-width: 600px)"));
    expect(phone).toMatch(/\.facts-file \{ display: none; \}/);
    expect(phone).toMatch(/\.facts-file\.is-open \{ display: grid; \}/);
    expect(phone).toMatch(/\.facts-ask__where \{ display: inline-flex; \}/);
    // Tokens only, as in every stylesheet of the app's own.
    expect(css.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g)).toBeNull();
  });
});

// All facts.

async function openRecord(state: Fixtures = withText()): Promise<FakeApi> {
  const api = installFakeApi(state);
  renderWithSession(<FactsRecord />, state.me);
  await screen.findByRole("heading", { name: "Confirmed, by role" });
  return api;
}

const factItem = (text: string) => screen.getByText(text).closest<HTMLElement>("[data-queue-item]")!;
/** A fact's answers in the list, in order, leaving out its file's text. */
const answers = (fact: HTMLElement) => [...fact.querySelectorAll(".rs-fact__body > .rs-actions button")].map((b) => b.textContent);

describe("All facts", () => {
  it("groups confirmed facts by role", async () => {
    await openRecord();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("All facts");
    const roles = [...document.querySelectorAll(".rs-role__title")].map((title) => title.textContent);
    expect(roles).toEqual(["Contoso Health", "Fabrikam Transit Data", "University of Waterloo", "Not tied to a role"]);
    const contoso = screen.getByRole("heading", { name: "Contoso Health" }).closest("section")!;
    expect(within(contoso).getByText(PIPELINE)).toBeInTheDocument();
    expect(within(contoso).getByText(AUDIT)).toBeInTheDocument();
    const loose = screen.getByRole("heading", { name: "Not tied to a role" }).closest("section")!;
    expect(within(loose).getByText("Python")).toBeInTheDocument();
    // Nothing still to check is listed here.
    expect(screen.queryByText(LATENCY)).toBeNull();
    expect(screen.queryByText("PostgreSQL")).toBeNull();
    expect(screen.queryByText(/^Check each one against the words it came from/)).toBeNull();
  });

  it("filters only Confirmed and Left out", async () => {
    const state = withText();
    await openRecord(state);
    const filter = screen.getByRole("group", { name: "Show" });
    const counts = countByState(state);
    expect(within(filter).getAllByRole("radio").map((radio) => radio.closest("label")!.textContent)).toEqual([
      `Confirmed ${counts.confirmed}`,
      `Left out ${counts.rejected}`,
    ]);
    await userEvent.click(within(filter).getByRole("radio", { name: /^Left out/ }));
    expect(await screen.findByRole("heading", { name: "Left out, by role" })).toBeInTheDocument();
    expect(factItem("Wrote the on-call runbook.")).toBeInTheDocument();
    expect(screen.queryByText(PIPELINE)).toBeNull();
  });

  it("orders Fix it, Leave it out, Keep private", async () => {
    await openRecord();
    expect(answers(factItem(PIPELINE))).toEqual(["Fix it", "Leave it out", "Keep private"]);
  });

  it("adds a fact and shows it under Confirmed", async () => {
    const api = await openRecord();
    await userEvent.click(screen.getByRole("radio", { name: /^Left out/ }));
    await userEvent.click(screen.getByRole("button", { name: "Add a fact yourself" }));
    await userEvent.type(screen.getByLabelText("Fact", { selector: "textarea" }), "Ran the hiring loop for the platform team.");
    await userEvent.click(screen.getByRole("button", { name: "Add fact" }));
    expect(await screen.findByText("Ran the hiring loop for the platform team.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Confirmed/ })).toBeChecked();
    expect(screen.getByRole("heading", { name: "Confirmed, by role" })).toBeInTheDocument();
    expect(api.callsTo("POST", /^\/api\/v2\/facts$/)).toHaveLength(1);
  });

  it("links Ask a colleague to #/facts/all/ask and to nothing else", async () => {
    await openRecord();
    const ask = screen.getAllByRole("link", { name: "Ask a colleague" });
    expect(ask).toHaveLength(1);
    expect(ask[0]).toHaveAttribute("href", "#/facts/all/ask");
    expect(ask[0]!.closest("p")).toHaveTextContent("Want someone who worked with you to back a fact? Ask a colleague.");
    expect(document.querySelectorAll('a[href="#/facts/all/ask"]')).toHaveLength(1);
  });

  it("offers That’s right on a left-out role and fact, and only that", async () => {
    const state = withText();
    state.roles.find((role) => role.id === "role-northwind")!.state = "rejected";
    for (const fact of state.facts) if (fact.roleId === "role-northwind") fact.state = "rejected";
    await openRecord(state);
    await userEvent.click(screen.getByRole("radio", { name: /^Left out/ }));
    const role = (await screen.findByRole("heading", { name: "Northwind Logistics" })).closest<HTMLElement>("[data-queue-item]")!;
    const head = role.querySelector<HTMLElement>(".rs-role__head")!;
    expect([...head.querySelectorAll(".rs-role__more > .rs-actions button")].map((b) => b.textContent)).toEqual(["That’s right"]);
    expect(answers(factItem(MIGRATION))).toEqual(["That’s right"]);
  });

  it("opens “See where this came from” on a fact, with its quote marked in its file", async () => {
    await openRecord();
    const fact = factItem(PIPELINE);
    await userEvent.click(within(fact).getByRole("button", { name: "See where this came from" }));
    expect(await within(fact).findByText("Built claims intake pipeline (Python, Airflow) processing 2M claims/month", { selector: "pre mark" })).toBeInTheDocument();
    expect(within(fact).getByRole("button", { name: "Hide where this came from" })).toHaveAttribute("aria-expanded", "true");
  });

  it("closes an added role’s form with Escape", async () => {
    await openRecord();
    await userEvent.click(screen.getByRole("button", { name: "Add a role" }));
    const form = screen.getByRole("form", { name: "Add a role" });
    expect(within(form).getByRole("textbox", { name: "Organization" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("form", { name: "Add a role" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add a role" })).toHaveFocus();
  });
});

describe("All facts, keeping a fact private", () => {
  /** Sam's vault with the pipeline fact already kept private. */
  function withPrivate(): Fixtures {
    const state = withText();
    state.facts.find((fact) => fact.id === "fact-pipeline")!.sensitive = true;
    return state;
  }

  it("keeps a fact private at once, with no question, and then says what that does", async () => {
    const api = await openRecord();
    const fact = () => factItem(PIPELINE);
    expect(within(fact()).queryByText("Private", { selector: ".rs-mark" })).toBeNull();
    await userEvent.click(within(fact()).getByRole("button", { name: "Keep private" }));
    await waitFor(() => expect(sensitiveCalls(api)).toHaveLength(1));
    expect(sensitiveCalls(api)[0]).toEqual({ ids: ["fact-pipeline"], sensitive: true, expectedRevisions: { "fact-pipeline": 1 } });
    const stop = await within(fact()).findByRole("button", { name: "Stop keeping it private" });
    expect(screen.queryByRole("group", { name: "Stop keeping this fact private" })).toBeNull();
    expect(within(fact()).getByText("Private", { selector: ".rs-mark" })).toHaveClass("rs-mark--note");
    expect(within(fact()).getByText(PRIVATE_HINT)).toBeInTheDocument();
    expect(answers(fact())).toEqual(["Fix it", "Leave it out", "Stop keeping it private"]);
    expect(stop).toHaveAttribute("aria-expanded", "false");
    expect(stop).not.toHaveAttribute("aria-keyshortcuts");
    await waitFor(() => expect(stop).toHaveFocus());
    expect(screen.getAllByText("Private", { selector: ".rs-mark" })).toHaveLength(1);
  });

  it("asks before Stop keeping it private, in fixed words, and Cancel returns focus to the button", async () => {
    const api = await openRecord(withPrivate());
    const fact = () => factItem(PIPELINE);
    const stop = within(fact()).getByRole("button", { name: "Stop keeping it private" });
    await userEvent.click(stop);
    const well = screen.getByRole("group", { name: "Stop keeping this fact private" });
    expect(within(well).getByText(STOP_QUESTION)).toBeInTheDocument();
    expect(within(well).getAllByRole("button").map((b) => b.textContent)).toEqual(["Yes, stop keeping it private", "Cancel"]);
    expect(within(well).getByRole("button", { name: "Yes, stop keeping it private" })).toHaveFocus();
    expect(stop).toHaveAttribute("aria-expanded", "true");
    expect(sensitiveCalls(api)).toHaveLength(0);
    const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    await userEvent.click(within(well).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Stop keeping this fact private" })).toBeNull();
    expect(within(fact()).getByRole("button", { name: "Stop keeping it private" })).toHaveFocus();
    expect(sensitiveCalls(api)).toHaveLength(0);

    await userEvent.click(within(fact()).getByRole("button", { name: "Stop keeping it private" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, stop keeping it private" }));
    await waitFor(() => expect(sensitiveCalls(api)).toHaveLength(1));
    expect(sensitiveCalls(api)[0]).toEqual({ ids: ["fact-pipeline"], sensitive: false, expectedRevisions: { "fact-pipeline": 1 } });
    const keep = await within(fact()).findByRole("button", { name: "Keep private" });
    await waitFor(() => expect(keep).toHaveFocus());
    expect(within(fact()).queryByText("Private", { selector: ".rs-mark" })).toBeNull();
    expect(within(fact()).queryByText(PRIVATE_HINT)).toBeNull();
  });

  it("leaves the keys to the question: Y on “Yes, stop keeping it private” neither changes it nor leaves the fact out", async () => {
    const api = await openRecord(withPrivate());
    await userEvent.click(within(factItem(PIPELINE)).getByRole("button", { name: "Stop keeping it private" }));
    const yes = screen.getByRole("button", { name: "Yes, stop keeping it private" });
    expect(yes).toHaveFocus();
    await userEvent.keyboard("yflk");
    expect(reviewCalls(api)).toHaveLength(0);
    expect(sensitiveCalls(api)).toHaveLength(0);
    expect(screen.queryByLabelText("Fact", { selector: "textarea" })).toBeNull();
    expect(screen.getByRole("group", { name: "Stop keeping this fact private" })).toBeInTheDocument();
    expect(yes).toHaveFocus();
  });

  it("sends the copies shown together as one request, each with its revision", async () => {
    const state = withText();
    const original = state.facts.find((fact) => fact.id === "fact-pipeline")!;
    original.revision = 2;
    state.facts.push({ ...original, id: "fact-pipeline-again", revision: 5 });
    const api = await openRecord(state);
    const fact = factItem(PIPELINE);
    expect(within(fact).getByText(/This fact also appears in 1 other record\./)).toBeInTheDocument();
    await userEvent.click(within(fact).getByRole("button", { name: "Keep private" }));
    await waitFor(() => expect(sensitiveCalls(api)).toHaveLength(1));
    expect(sensitiveCalls(api)[0]).toEqual({
      ids: ["fact-pipeline", "fact-pipeline-again"],
      sensitive: true,
      expectedRevisions: { "fact-pipeline": 2, "fact-pipeline-again": 5 },
    });
    await within(factItem(PIPELINE)).findByRole("button", { name: "Stop keeping it private" });
    expect(screen.getAllByText(PIPELINE)).toHaveLength(1);
    expect(state.facts.filter((item) => item.sensitive).map((item) => item.id)).toEqual(["fact-pipeline", "fact-pipeline-again"]);
  });

  it("shows the server’s sentence under the fact when the request is refused, with the facts as they now are", async () => {
    const api = await openRecord();
    api.fail("POST", /^\/api\/facts\/sensitive$/, 409, "conflict", "Your facts changed. Refresh the page, then try again.");
    const loads = api.callsTo("GET", /^\/api\/v2\/vault$/).length;
    const fact = () => factItem(PIPELINE);
    await userEvent.click(within(fact()).getByRole("button", { name: "Keep private" }));
    expect(await within(fact()).findByRole("alert")).toHaveTextContent("Your facts changed. Refresh the page, then try again.");
    expect(api.callsTo("GET", /^\/api\/v2\/vault$/).length).toBe(loads + 1);
    expect(within(fact()).getByRole("button", { name: "Keep private" })).toBeEnabled();
    expect(within(fact()).queryByText("Private", { selector: ".rs-mark" })).toBeNull();
  });

  it("says “Keeping it private…” while the request is on its way, and holds the fact’s other buttons", async () => {
    const state = withText();
    const api = installFakeApi(state);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const fetch = api.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/facts/sensitive")) await held;
      return fetch(input, init);
    });
    renderWithSession(<FactsRecord />, state.me);
    await screen.findByRole("heading", { name: "Confirmed, by role" });
    const fact = () => factItem(PIPELINE);
    await userEvent.click(within(fact()).getByRole("button", { name: "Keep private" }));
    expect(within(fact()).getByRole("button", { name: "Keeping it private…" })).toBeDisabled();
    for (const name of ["Fix it", "Leave it out"]) expect(within(fact()).getByRole("button", { name })).toBeDisabled();
    release();
    expect(await within(fact()).findByRole("button", { name: "Stop keeping it private" })).toBeEnabled();
    expect(within(fact()).getByRole("button", { name: "Fix it" })).toBeEnabled();
  });

  it("shows only the mark on a left-out fact, and offers the control again once it is confirmed", async () => {
    const state = withText();
    state.facts.find((fact) => fact.id === "fact-runbook")!.sensitive = true;
    await openRecord(state);
    await userEvent.click(screen.getByRole("radio", { name: /^Left out/ }));
    const rejected = factItem("Wrote the on-call runbook.");
    expect(within(rejected).getByText("Private", { selector: ".rs-mark" })).toBeInTheDocument();
    expect(answers(rejected)).toEqual(["That’s right"]);
    expect(within(rejected).queryByText(PRIVATE_HINT)).toBeNull();
    await userEvent.click(within(rejected).getByRole("button", { name: "That’s right" }));
    await userEvent.click(await screen.findByRole("radio", { name: /^Confirmed/ }));
    const confirmed = await waitFor(() => factItem("Wrote the on-call runbook."));
    expect(within(confirmed).getByRole("button", { name: "Stop keeping it private" })).toBeEnabled();
    expect(within(confirmed).getByText(PRIVATE_HINT)).toBeInTheDocument();
  });

  it("tells the editor of a private fact that it stays private, and locks the control while an editor is open", async () => {
    await openRecord(withPrivate());
    const fact = () => factItem(PIPELINE);
    await userEvent.click(within(fact()).getByRole("button", { name: "Stop keeping it private" }));
    expect(screen.getByRole("group", { name: "Stop keeping this fact private" })).toBeInTheDocument();
    fact().focus();
    await userEvent.keyboard("f");
    const editor = await screen.findByLabelText("Fact", { selector: "textarea" }, { timeout: 4000 });
    expect(screen.queryByRole("group", { name: "Stop keeping this fact private" })).toBeNull();
    const note = within(fact()).getByText("This fact stays private after you save. To use a different wording, add it as a new fact and keep this one private.");
    expect(editor.getAttribute("aria-describedby")!.split(" ")).toContain(note.id);
    expect(within(fact()).queryByRole("button", { name: "Stop keeping it private" })).toBeNull();
    const other = factItem(AUDIT);
    expect(within(other).getByRole("button", { name: "Keep private" })).toBeDisabled();
    expect(screen.getByText(/^This list is paused while you edit\./)).toHaveAttribute("role", "status");
    await userEvent.keyboard("{Escape}");
    expect(within(factItem(AUDIT)).getByRole("button", { name: "Keep private" })).toBeEnabled();
    expect(within(fact()).getByRole("button", { name: "Stop keeping it private" })).toHaveAttribute("aria-expanded", "false");
  });

  it("holds the answer to the question while another fact’s editor is open", async () => {
    const api = await openRecord(withPrivate());
    await userEvent.click(within(factItem(PIPELINE)).getByRole("button", { name: "Stop keeping it private" }));
    expect(screen.getByRole("button", { name: "Yes, stop keeping it private" })).toBeEnabled();
    const other = factItem(AUDIT);
    await userEvent.click(within(other).getByRole("button", { name: "Fix it" }));
    await screen.findByLabelText("Fact", { selector: "textarea" }, { timeout: 4000 });
    expect(screen.getByRole("button", { name: "Yes, stop keeping it private" })).toBeDisabled();
    expect(within(factItem(PIPELINE)).getByRole("button", { name: "Stop keeping it private" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Yes, stop keeping it private" }));
    expect(sensitiveCalls(api)).toHaveLength(0);
    await userEvent.click(within(other).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Yes, stop keeping it private" })).toBeEnabled();
    expect(within(factItem(PIPELINE)).getByText("Private", { selector: ".rs-mark" })).toBeInTheDocument();
  });

  it("gives an editor no such note when the fact isn’t private", async () => {
    await openRecord();
    const fact = factItem(PIPELINE);
    fact.focus();
    await userEvent.keyboard("f");
    await screen.findByLabelText("Fact", { selector: "textarea" }, { timeout: 4000 });
    expect(screen.queryByText(/This fact stays private after you save/)).toBeNull();
  });
});

// Skills.

describe("Skills", () => {
  /** A confirmed skill, read from sam-rivera-2024.pdf unless changed. */
  const skill = (id: string, text: string, change: Partial<FactView> = {}): FactView => ({
    id, roleId: null, kind: "skill", text, level: null, origin: "extracted", state: "confirmed", quote: text, sourceId: "src-2024", ...change,
  });

  async function openSkills(state: Fixtures) {
    installFakeApi(state);
    renderWithSession(<FactsSkills />, state.me);
    await screen.findByRole("heading", { level: 1, name: "Skills" });
  }
  const rows = () => [...document.querySelectorAll<HTMLElement>(".facts-skills__list > li")];
  const names = () => rows().map((row) => row.querySelector(".app-q__t")!.textContent);

  it("lists confirmed skills only, not proposed, left out or under a left-out role", async () => {
    const state = withText();
    state.roles.find((role) => role.id === "role-fabrikam")!.state = "rejected";
    state.facts.push(
      skill("skill-terraform", "Terraform", { roleId: "role-contoso" }),
      skill("skill-rust", "Rust", { state: "rejected" }),
      skill("skill-go", "Go", { roleId: "role-fabrikam" }),
      skill("skill-react", "React", { roleId: "role-northwind" }),
    );
    await openSkills(state);
    expect(await screen.findByRole("heading", { level: 2, name: "2 skills" })).toBeInTheDocument();
    // PostgreSQL is still to check, Rust was left out, Go's role was left out and React's isn't confirmed.
    expect(names()).toEqual(["Python", "Terraform"]);
  });

  it("says where each came from, joining the same skill from two files", async () => {
    const state = withText();
    state.sources.push({ id: "src-linkedin", filename: "linkedin-export.zip", state: "ready", error: null, createdAt: 1793800000000, proposed: 0 });
    const text = "Skills\npython\n";
    state.sourceTexts!["src-linkedin"] = text;
    state.facts.push(
      skill("skill-python-2", " python ", { quote: "python", sourceId: "src-linkedin", span: [text.indexOf("python"), text.indexOf("python") + 6] }),
      skill("skill-kubernetes", "Kubernetes", { roleId: "role-contoso", origin: "user", quote: null, sourceId: null }),
      skill("skill-airflow", "Apache Airflow", {
        origin: "user",
        quote: null,
        sourceId: null,
        interview: { documentId: "doc-1", questionId: "q-1", question: "Which tools did you use for the claims pipeline?", quote: "Apache Airflow" },
      }),
    );
    await openSkills(state);
    await screen.findByRole("heading", { level: 2, name: "3 skills" });
    expect(names()).toEqual(["Apache Airflow", "Kubernetes", "Python"]);
    const python = rows()[2]!;
    expect(within(python).getByText("Where it came from")).toBeInTheDocument();
    expect([...python.querySelectorAll(".facts-skills__from .rs-meta")].map((line) => line.textContent)).toEqual([
      "Not tied to a role. From sam-rivera-2024.pdf.",
      "Not tied to a role. From linkedin-export.zip.",
    ]);
    // Each copy with words in a file can be read there.
    expect(within(python).getAllByRole("button", { name: "See where this came from" })).toHaveLength(2);
    expect(rows()[1]!.querySelector(".facts-skills__from .rs-meta")!.textContent).toBe("At Contoso Health. Added by you.");
    expect(within(rows()[1]!).queryByRole("button")).toBeNull();
    expect(rows()[0]!.querySelector(".facts-skills__from .rs-meta")!.textContent).toBe(
      "Not tied to a role. From your answer to: Which tools did you use for the claims pipeline?",
    );
  });

  it("marks a private skill", async () => {
    const state = withText();
    state.facts.find((fact) => fact.id === "fact-python")!.sensitive = true;
    state.facts.push(skill("skill-terraform", "Terraform"));
    await openSkills(state);
    await screen.findByRole("heading", { level: 2, name: "2 skills" });
    expect(within(rows()[0]!).getByText("Private")).toHaveClass("rs-mark--note");
    expect(within(rows()[1]!).queryByText("Private")).toBeNull();
  });

  it("years are a placeholder with no control", async () => {
    await openSkills(withText());
    const years = await screen.findByRole("region", { name: "Years per skill" });
    expect(years).toHaveTextContent(
      "How long you used each skill opens next. It will count only years you’ve confirmed or a dated line shows, and never guess.",
    );
    expect(years.querySelectorAll("button, input, select, textarea, a")).toHaveLength(0);
    expect(await screen.findByRole("heading", { level: 2, name: "1 skill" })).toBeInTheDocument();
  });

  it("says nothing is confirmed yet", async () => {
    await openSkills(emptyVault());
    const empty = await screen.findByText("No confirmed skills yet");
    const note = empty.closest("p")!;
    expect(note).toHaveTextContent("No confirmed skills yetSay “That’s right” to a skill under To check, or add one yourself under All facts.");
    expect(within(note).getByRole("link", { name: "To check" })).toHaveAttribute("href", "#/facts/check");
    expect(within(note).getByRole("link", { name: "All facts" })).toHaveAttribute("href", "#/facts/all");
  });
});

// Your files.

async function openFiles(state: Fixtures = withText()): Promise<FakeApi> {
  const api = installFakeApi(state);
  renderWithSession(<FactsSources />, state.me);
  await screen.findByText("sam-rivera-2024.pdf");
  return api;
}

describe("Your files", () => {
  const row = (name: string) => screen.getByText(name, { selector: ".rs-source__name" }).closest("li")!;

  it("shows each file’s state, Cancel reading and Retry reading", async () => {
    const state = withText();
    state.sources.unshift({ id: "src-new", filename: "new.pdf", state: "queued", error: null, createdAt: 1793990000000, proposed: 0 });
    state.sources.find((source) => source.id === "src-cv")!.retryRunId = "run-cv";
    const api = await openFiles(state);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your files");
    expect(screen.getByRole("heading", { level: 2, name: "What you’ve added" })).toBeInTheDocument();
    expect(within(row("new.pdf")).getByText("Reading…")).toBeInTheDocument();
    expect(within(row("sam-rivera-cv.docx")).getByText("Reading stopped")).toBeInTheDocument();
    expect(within(row("sam-rivera-2024.pdf")).getByText("1 role and 4 facts to check")).toBeInTheDocument();
    // Confirm all counts the records it sends.
    expect(within(row("sam-rivera-2024.pdf")).getByRole("button", { name: "Confirm all 5 from this file" })).toBeInTheDocument();
    await userEvent.click(within(row("new.pdf")).getByRole("button", { name: "Cancel reading" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/sources\/src-new\/cancel$/)).toHaveLength(1));
    await userEvent.click(within(row("sam-rivera-cv.docx")).getByRole("button", { name: "Retry reading" }));
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/runs\/run-cv\/retry$/)).toHaveLength(1));
    // Adding a file is beside the list.
    const add = screen.getByRole("complementary", { name: "Add a file" });
    expect(within(add).getByRole("button", { name: "Choose a file" })).toBeInTheDocument();
  });

  it("downloads the original and the original PDF of a scan", async () => {
    const state = withText();
    state.sources.unshift({ id: "src-ocr", filename: "sam-rivera-2024.pdf (image transcription)", origin: "ocr", parentSourceId: "src-2024", state: "ready", error: null, createdAt: 1793990000000, proposed: 0 });
    await openFiles(state);
    expect(within(row("sam-rivera-2024.pdf")).getByRole("link", { name: "Download original" })).toHaveAttribute("href", "/api/sources/src-2024/file");
    const scan = row("sam-rivera-2024.pdf (image transcription)");
    expect(within(scan).getByRole("link", { name: "Download original PDF" })).toHaveAttribute("href", "/api/sources/src-2024/file");
    expect(within(scan).getByRole("link", { name: "Download image inputs (JSON)" })).toHaveAttribute("href", "/api/sources/src-ocr/file");
  });

  it("offers reading as images only with OCR on", async () => {
    const off = withText();
    off.me.capabilities = { connectedApps: false, ...off.me.capabilities, ocr: false };
    installFakeApi(off);
    const shown = renderWithSession(<FactsSources />, off.me);
    await screen.findByText("sam-rivera-2024.pdf");
    expect(screen.queryByText("Missing text or mixed-up columns?")).toBeNull();
    shown.unmount();
    const on = withText();
    on.me.capabilities = { connectedApps: false, ...on.me.capabilities, ocr: true };
    await openFiles(on);
    expect(within(row("sam-rivera-2024.pdf")).getByText("Missing text or mixed-up columns?")).toBeInTheDocument();
    // Only a PDF can be read as images.
    expect(within(row("sam-rivera-cv.docx")).queryByText("Missing text or mixed-up columns?")).toBeNull();
  });

  it("tells a failed file what to do, with and without a retry", async () => {
    const state = withText();
    state.sources.unshift({ id: "src-retry", filename: "retry.pdf", state: "failed", error: "No text could be read from this file.", retryRunId: "run-retry", createdAt: 1793990000000, proposed: 0 });
    await openFiles(state);
    const without = row("sam-rivera-cv.docx").querySelector<HTMLElement>(".facts-what-to-do")!;
    expect(without).toHaveClass("rs-hint");
    expect(without).toHaveTextContent(
      "Upload it again as a Word file (.docx) or a PDF with selectable text, or add what it holds yourself under All facts.",
    );
    expect(within(without).getByRole("link", { name: "All facts" })).toHaveAttribute("href", "#/facts/all");
    expect(row("retry.pdf").querySelector(".facts-what-to-do")).toHaveTextContent(
      "Retry reading, or upload it again as a Word file (.docx) or a PDF with selectable text.",
    );
    expect(within(row("retry.pdf")).getByText("No text could be read from this file.")).toBeInTheDocument();
  });

  it("sends No items shown to All facts", async () => {
    const state = withText();
    state.sources.unshift({ id: "src-empty", filename: "empty.pdf", state: "ready", error: null, createdAt: 1793990000000, proposed: 0 });
    await openFiles(state);
    const empty = row("empty.pdf");
    expect(within(empty).getByText("No items shown")).toBeInTheDocument();
    const said = within(empty).getByText(/^No roles or facts from this file are shown\./);
    expect(said).toHaveTextContent(
      "No roles or facts from this file are shown. Upload the file again, try a different format, or add your experience yourself under All facts.",
    );
    expect(within(said).getByRole("link", { name: "All facts" })).toHaveAttribute("href", "#/facts/all");
  });
});

// Pasting text: on Your files, and on To check before the first upload.

describe("pasting text", () => {
  const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
  const pastePanel = () => screen.getByRole("form", { name: "Paste text" });
  const textBox = () => within(pastePanel()).getByRole("textbox", { name: "Text to read" });
  const titleBox = () => within(pastePanel()).getByRole("textbox", { name: /^Title/ });
  const pasteCalls = (api: FakeApi) => api.callsTo("POST", /^\/api\/sources\/paste$/);
  const firstRun = () => document.querySelector<HTMLElement>(".facts-first-run")!;

  async function openPaste(state: Fixtures = withText()): Promise<FakeApi> {
    const api = await openFiles(state);
    await userEvent.click(screen.getByRole("button", { name: "Paste text" }));
    return api;
  }

  async function openFirstRun(): Promise<FakeApi> {
    const state = emptyVault();
    const api = installFakeApi(state);
    renderWithSession(<FactsReview />, state.me);
    await screen.findByRole("heading", { name: "What happens next" });
    return api;
  }

  async function pasteInto(box: HTMLElement, text: string) {
    await userEvent.click(box);
    await userEvent.paste(text);
  }

  it("offers Paste text beside Upload a file, with a textarea, a title and a count against 60,000", async () => {
    await openFiles();
    const group = screen.getByRole("group", { name: "Add a file" });
    const [file, paste] = within(group).getAllByRole("button");
    expect([file!.textContent, paste!.textContent]).toEqual(["Upload a file", "Paste text"]);
    expect(file).toHaveAttribute("aria-pressed", "true");
    expect(paste).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("form", { name: "Paste text" })).toBeNull();

    await userEvent.click(paste!);
    expect(paste).toHaveAttribute("aria-pressed", "true");
    expect(file).toHaveAttribute("aria-pressed", "false");
    expect(textBox().tagName).toBe("TEXTAREA");
    expect(titleBox()).toHaveAttribute("maxlength", "120");
    expect(within(pastePanel()).getByText("0 of 60,000 characters")).toBeInTheDocument();
    expect(textBox().getAttribute("aria-describedby")!.split(" ")).toContain(within(pastePanel()).getByText("0 of 60,000 characters").id);
    // The upload panel is hidden, not gone, so an upload under way survives the switch.
    expect(screen.queryByRole("button", { name: "Choose a file" })).toBeNull();
    expect(document.querySelector(".app-drop--rail")).not.toBeNull();
  });

  it("counts characters as they will be stored", async () => {
    await openPaste();
    fireEvent.change(textBox(), { target: { value: `a\r\nb${ZERO_WIDTH_SPACE}` } });
    expect(within(pastePanel()).getByText("3 of 60,000 characters")).toBeInTheDocument();
    fireEvent.change(textBox(), { target: { value: "  \n\t " } });
    expect(within(pastePanel()).getByText("0 of 60,000 characters")).toBeInTheDocument();
  });

  it("says Paste some text first without sending anything", async () => {
    const api = await openPaste();
    await pasteInto(textBox(), `   ${ZERO_WIDTH_SPACE}\n `);
    await userEvent.click(within(pastePanel()).getByRole("button", { name: "Add text" }));
    expect(within(pastePanel()).getByRole("alert")).toHaveTextContent("Paste some text first.");
    expect(pasteCalls(api)).toHaveLength(0);
  });

  it("holds Add text and says how far over the text is", async () => {
    const api = await openPaste();
    fireEvent.change(textBox(), { target: { value: "a".repeat(60_005) } });
    expect(within(pastePanel()).getByText("5 characters over the 60,000 limit")).toBeInTheDocument();
    expect(textBox()).toHaveAttribute("aria-invalid", "true");
    const add = within(pastePanel()).getByRole("button", { name: "Add text" });
    expect(add).toBeDisabled();
    fireEvent.submit(pastePanel());
    expect(pasteCalls(api)).toHaveLength(0);
    fireEvent.change(textBox(), { target: { value: "a".repeat(60_000) } });
    expect(add).toBeEnabled();
    expect(textBox()).toHaveAttribute("aria-invalid", "false");
  });

  it("sends the text and title with an idempotency key, then says it is being read", async () => {
    const api = await openPaste();
    await pasteInto(titleBox(), "Q3 review");
    await pasteInto(textBox(), "Led the Q3 launch of the carrier rates service.");
    await userEvent.click(within(pastePanel()).getByRole("button", { name: "Add text" }));
    expect(
      await within(pastePanel()).findByText("Added your text. Resumatic is reading it now, and its roles and facts will appear for you to review."),
    ).toHaveAttribute("role", "status");
    const [call] = pasteCalls(api);
    expect(call!.body).toEqual({ text: "Led the Q3 launch of the carrier rates service.", title: "Q3 review" });
    expect(call!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(textBox()).toHaveValue("");
    expect(titleBox()).toHaveValue("");
    // The list is read again, and shows the source by the name its title gave.
    const list = screen.getByRole("region", { name: "What you’ve added" });
    expect(await within(list).findByText("Q3 review.txt")).toBeInTheDocument();
  });

  it("sends no title when none is given", async () => {
    const api = await openPaste();
    await pasteInto(textBox(), "Mentored four engineers.");
    await userEvent.click(within(pastePanel()).getByRole("button", { name: "Add text" }));
    await within(pastePanel()).findByText(/^Added your text\./);
    expect(pasteCalls(api)[0]!.body).toEqual({ text: "Mentored four engineers.", title: null });
  });

  it("uses a new key for each Add text and the same key for Retry adding text", async () => {
    const api = await openPaste();
    api.fail("POST", /^\/api\/sources\/paste$/, 503, "unavailable", "Resumatic is busy right now.");
    await pasteInto(textBox(), "Wrote the on-call runbook.");
    await userEvent.click(within(pastePanel()).getByRole("button", { name: "Add text" }));
    const retry = await within(pastePanel()).findByRole("button", { name: "Retry adding text" });
    await userEvent.click(retry);
    await within(pastePanel()).findByText(/^Added your text\./);
    expect(within(pastePanel()).queryByRole("button", { name: "Retry adding text" })).toBeNull();
    const [first, again] = pasteCalls(api);
    expect(again!.key).toBe(first!.key);
    expect(again!.body).toEqual(first!.body);

    await pasteInto(textBox(), "Ran the hiring loop for the platform team.");
    await userEvent.click(within(pastePanel()).getByRole("button", { name: "Add text" }));
    await waitFor(() => expect(pasteCalls(api)).toHaveLength(3));
    expect(pasteCalls(api)[2]!.key).not.toBe(first!.key);
  });

  it("takes Retry adding text away once the text or title is changed, so the change is what gets added", async () => {
    const api = await openPaste();
    api.fail("POST", /^\/api\/sources\/paste$/, 503, "unavailable", "Resumatic is busy right now.");
    await pasteInto(textBox(), "Wrote the on-call runbok.");
    await userEvent.click(within(pastePanel()).getByRole("button", { name: "Add text" }));
    await within(pastePanel()).findByRole("button", { name: "Retry adding text" });
    fireEvent.change(textBox(), { target: { value: "Wrote the on-call runbook." } });
    expect(within(pastePanel()).queryByRole("button", { name: "Retry adding text" })).toBeNull();
    expect(textBox()).toHaveValue("Wrote the on-call runbook.");
    await userEvent.click(within(pastePanel()).getByRole("button", { name: "Add text" }));
    await within(pastePanel()).findByText(/^Added your text\./);
    const [first, second] = pasteCalls(api);
    expect(second!.body).toEqual({ text: "Wrote the on-call runbook.", title: null });
    expect(second!.key).not.toBe(first!.key);

    // A changed title takes it away too.
    api.fail("POST", /^\/api\/sources\/paste$/, 503, "unavailable", "Resumatic is busy right now.");
    await pasteInto(textBox(), "Ran the hiring loop.");
    await userEvent.click(within(pastePanel()).getByRole("button", { name: "Add text" }));
    await within(pastePanel()).findByRole("button", { name: "Retry adding text" });
    await pasteInto(titleBox(), "Hiring");
    expect(within(pastePanel()).queryByRole("button", { name: "Retry adding text" })).toBeNull();
  });

  it("shows This text wasn’t added after an expired paste, without a retry", async () => {
    const api = await openPaste();
    api.fail("POST", /^\/api\/sources\/paste$/, 503, "unavailable", "Resumatic is busy right now.");
    await pasteInto(textBox(), "Wrote the on-call runbook.");
    await userEvent.click(within(pastePanel()).getByRole("button", { name: "Add text" }));
    const retry = await within(pastePanel()).findByRole("button", { name: "Retry adding text" });
    // A day passes: the first press's reservation has expired.
    api.expiredPasteKeys.add(pasteCalls(api)[0]!.key!);
    await userEvent.click(retry);
    expect(await within(pastePanel()).findByRole("alert")).toHaveTextContent("This text wasn’t added. Add it again.");
    expect(within(pastePanel()).queryByRole("button", { name: "Retry adding text" })).toBeNull();
    expect(textBox()).toHaveValue("Wrote the on-call runbook.");
    // The next press is a new paste, under a new key.
    await userEvent.click(within(pastePanel()).getByRole("button", { name: "Add text" }));
    await within(pastePanel()).findByText(/^Added your text\./);
    expect(pasteCalls(api)[2]!.key).not.toBe(pasteCalls(api)[0]!.key);
  });

  it("shows the server’s sentence when the same text is pasted twice", async () => {
    const api = await openPaste();
    await pasteInto(textBox(), "Wrote the on-call runbook.");
    await userEvent.click(within(pastePanel()).getByRole("button", { name: "Add text" }));
    await within(pastePanel()).findByText(/^Added your text\./);
    await pasteInto(titleBox(), "Another title");
    await pasteInto(textBox(), "Wrote the on-call runbook.");
    await userEvent.click(within(pastePanel()).getByRole("button", { name: "Add text" }));
    expect(await within(pastePanel()).findByRole("alert")).toHaveTextContent("You’ve already pasted this text.");
    expect(within(pastePanel()).queryByRole("button", { name: "Retry adding text" })).toBeNull();
    expect(pasteCalls(api)).toHaveLength(2);
  });

  it("passes axe with the paste panel open", async () => {
    await openPaste();
    fireEvent.change(textBox(), { target: { value: "a".repeat(60_001) } });
    const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("says the text was added when it was the first source, and keeps Paste text chosen", async () => {
    await openFirstRun();
    await userEvent.click(within(screen.getByRole("group", { name: "Add a file" })).getByRole("button", { name: "Paste text" }));
    await pasteInto(textBox(), "Led the Q3 launch of the carrier rates service.");
    await userEvent.click(within(pastePanel()).getByRole("button", { name: "Add text" }));
    expect(
      await within(firstRun()).findByText("Added your text. Resumatic is reading it now, and its roles and facts will appear for you to review."),
    ).toHaveAttribute("role", "status");
    expect(within(firstRun()).getByRole("button", { name: "Paste text" })).toHaveAttribute("aria-pressed", "true");
    expect(textBox()).toHaveValue("");
    expect(await within(question()).findByText("Resumatic is reading your file. What it finds will appear here for you to check.")).toBeInTheDocument();
  });

  it("says a file was uploaded when it was the first source", async () => {
    await openFirstRun();
    const input = document.querySelector<HTMLInputElement>(".app-drop--first-run input[type=file]")!;
    await userEvent.upload(input, new File(["%PDF-1.4"], "cv.pdf", { type: "application/pdf" }));
    expect(
      await within(firstRun()).findByText("Uploaded cv.pdf. Resumatic is reading it now, and its roles and facts will appear for you to review."),
    ).toHaveAttribute("role", "status");
    expect(within(firstRun()).getByRole("button", { name: "Upload a file" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps what was being pasted when an upload makes the first source", async () => {
    await openFirstRun();
    const input = document.querySelector<HTMLInputElement>(".app-drop--first-run input[type=file]")!;
    await userEvent.click(within(screen.getByRole("group", { name: "Add a file" })).getByRole("button", { name: "Paste text" }));
    await pasteInto(titleBox(), "Q3 review");
    await pasteInto(textBox(), "Led the Q3 launch.");
    await userEvent.upload(input, new File(["%PDF-1.4"], "cv.pdf", { type: "application/pdf" }));
    await within(question()).findByText("Resumatic is reading your file. What it finds will appear here for you to check.");
    expect(textBox()).toHaveValue("Led the Q3 launch.");
    expect(titleBox()).toHaveValue("Q3 review");
  });

  it("keeps the first-run dropzone and adds the toggle above it", async () => {
    await openFirstRun();
    const drop = document.querySelector(".app-drop--first-run")!;
    expect(drop).not.toBeNull();
    const group = screen.getByRole("group", { name: "Add a file" });
    expect(group.compareDocumentPosition(drop) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(within(group).getByRole("button", { name: "Paste text" }));
    expect(textBox()).toHaveAttribute("rows", "12");
  });

  it("shows a pasted source’s text beside its question, with the quote highlighted", async () => {
    const state = withText();
    const quote = "Shipped the carrier rates service to 12 regions.";
    const markdown = `Q3 review\n\nWhat I did\n\t- ${quote}\n- Mentored two engineers.`;
    const start = markdown.indexOf(quote);
    state.sources.unshift({ id: "src-paste", filename: "Q3 review.txt", origin: "paste", state: "ready", error: null, createdAt: 1793990000000, proposed: 1 });
    state.facts.push({
      id: "fact-pasted", roleId: "role-northwind", kind: "accomplishment", text: "Shipped carrier rates to 12 regions.", level: null,
      origin: "extracted", state: "proposed", quote, span: [start, start + quote.length], sourceId: "src-paste",
    });
    state.sourceTexts!["src-paste"] = markdown;
    await openCheck(state);
    await skipTo("Shipped carrier rates to 12 regions.");
    expect(within(filePanel()).getByRole("heading", { level: 2, name: "Q3 review.txt" })).toBeInTheDocument();
    const mark = await within(filePanel()).findByText(/^Shipped the carrier/, { selector: "pre mark" });
    expect(mark.textContent).toBe(`This fact: ${quote}`);
    expect(seen(fileText())).toBe(markdown);
  });
});
