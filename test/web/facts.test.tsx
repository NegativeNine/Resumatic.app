import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { SourcesPage } from "../../src/web/pages/SourcesPage";
import { installFakeApi, type FakeApi } from "./api-fake";
import { emptyVault, fixtures, type Fixtures } from "./fixtures";
import { renderWithSession } from "./render";

async function openFacts(state: Fixtures = fixtures()): Promise<FakeApi> {
  const api = installFakeApi(state);
  renderWithSession(<SourcesPage />, state.me);
  await screen.findByRole("heading", { name: "Northwind Logistics" });
  return api;
}

const reviewCalls = (api: FakeApi) => api.callsTo("POST", /^\/api\/review$/).map((c) => c.body);
const factItem = (text: string) => screen.getByText(text).closest<HTMLElement>("[data-queue-item]")!;

describe("the Facts page", () => {
  it("puts the sources in a rail beside the review queue", async () => {
    await openFacts();
    const rail = screen.getByRole("complementary", { name: "Your sources" });
    expect(within(rail).getByText("sam-rivera-2024.pdf")).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Choose a file" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Review roles and facts" })).toBeInTheDocument();
  });

  it("orders the review buttons as the copy does: Confirm, Edit, Reject, then Mark sensitive", async () => {
    await openFacts();
    const fact = factItem("Led the migration of 40 services from Heroku to Kubernetes.");
    expect(within(fact).getAllByRole("button").map((b) => b.textContent)).toEqual(["Confirm", "Edit", "Reject", "Mark sensitive"]);
  });

  it("joins meta with space and rules, never middle dots", async () => {
    await openFacts();
    for (const meta of document.querySelectorAll(".rs-fact__meta, .rs-role__detail, .rs-source__meta")) {
      expect(meta.textContent).not.toContain("·");
    }
    expect(screen.getByText("Senior Backend Engineer").tagName).toBe("SPAN");
  });

  it("opens on one big dropzone before the first upload", async () => {
    const state = emptyVault();
    installFakeApi(state);
    renderWithSession(<SourcesPage />, state.me);
    expect(await screen.findByRole("heading", { name: "What happens next" })).toBeInTheDocument();
    expect(document.querySelector(".app-drop--first-run")).not.toBeNull();
    expect(screen.queryByRole("complementary", { name: "Your sources" })).toBeNull();
  });
});

describe("the keyboard queue", () => {
  it("moves between items with J and K", async () => {
    await openFacts();
    const role = screen.getByRole("heading", { name: "Northwind Logistics" }).closest<HTMLElement>("[data-queue-item]")!;
    role.focus();
    await userEvent.keyboard("j");
    expect(document.activeElement).toBe(factItem("Reduced p95 API latency from 900 ms to 210 ms by moving hot paths to Redis."));
    await userEvent.keyboard("j");
    expect(document.activeElement).toBe(factItem("Led the migration of 40 services from Heroku to Kubernetes."));
    await userEvent.keyboard("k");
    expect(document.activeElement).toBe(factItem("Reduced p95 API latency from 900 ms to 210 ms by moving hot paths to Redis."));
    expect(document.activeElement).toHaveClass("is-active");
  });

  it("confirms the active fact with C", async () => {
    const api = await openFacts();
    factItem("Led the migration of 40 services from Heroku to Kubernetes.").focus();
    await userEvent.keyboard("c");
    await waitFor(() => expect(reviewCalls(api)).toHaveLength(1));
    expect(reviewCalls(api)[0]).toMatchObject({ confirm: ["fact-migration"], reject: [] });
    await waitFor(() => expect(screen.queryByText("Led the migration of 40 services from Heroku to Kubernetes.")).toBeNull());
  });

  it("edits with E, and Escape cancels the edit and returns focus to the fact", async () => {
    await openFacts();
    const fact = factItem("Mentored four engineers through their first on-call rotations.");
    fact.focus();
    await userEvent.keyboard("e");
    // ByLabelText rather than ByRole: computing every accessible name is slow on a page this size.
    const editor = await screen.findByLabelText("Fact", { selector: "textarea" }, { timeout: 4000 });
    expect(editor).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByLabelText("Fact", { selector: "textarea" })).toBeNull();
    expect(document.activeElement).toBe(factItem("Mentored four engineers through their first on-call rotations."));
  });

  it("asks before R rejects a role with proposed facts under it", async () => {
    const api = await openFacts();
    const role = screen.getByRole("heading", { name: "Northwind Logistics" }).closest<HTMLElement>("[data-queue-item]")!;
    role.focus();
    await userEvent.keyboard("r");
    const well = screen.getByRole("group", { name: "Reject Northwind Logistics" });
    expect(well).toHaveTextContent("Reject Northwind Logistics and its 3 proposed facts? Rejected items are kept here and never used.");
    expect(reviewCalls(api)).toHaveLength(0);
    const yes = within(well).getByRole("button", { name: "Yes, reject 4" });
    expect(yes).toHaveFocus();
    await userEvent.click(yes);
    await waitFor(() => expect(reviewCalls(api)).toHaveLength(1));
    expect(reviewCalls(api)[0]).toMatchObject({ confirm: [], reject: ["role-northwind"] });
  });

  it("returns focus to Reject role when the question is cancelled", async () => {
    await openFacts();
    await userEvent.click(screen.getByRole("button", { name: "Reject role" }));
    expect(screen.getByRole("button", { name: "Reject role" })).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Reject Northwind Logistics" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reject role" })).toHaveFocus();
  });

  it("leaves keys alone while someone types, or holds a modifier", async () => {
    const api = await openFacts();
    await userEvent.click(screen.getByRole("button", { name: "Add a fact yourself" }));
    const text = screen.getByLabelText("Fact", { selector: "textarea" });
    await userEvent.type(text, "crjk");
    expect(text).toHaveValue("crjk");
    factItem("Led the migration of 40 services from Heroku to Kubernetes.").focus();
    await userEvent.keyboard("{Control>}c{/Control}{Meta>}r{/Meta}");
    expect(reviewCalls(api)).toHaveLength(0);
  });

  it("names each button’s key for assistive technology", async () => {
    await openFacts();
    const fact = factItem("Led the migration of 40 services from Heroku to Kubernetes.");
    expect(within(fact).getByRole("button", { name: "Confirm" })).toHaveAttribute("aria-keyshortcuts", "C");
    expect(within(fact).getByRole("button", { name: "Edit" })).toHaveAttribute("aria-keyshortcuts", "E");
    expect(within(fact).getByRole("button", { name: "Reject" })).toHaveAttribute("aria-keyshortcuts", "R");
  });
});

describe("marking a fact sensitive", () => {
  const MIGRATION = "Led the migration of 40 services from Heroku to Kubernetes.";
  const HINT =
    "Sensitive. Left out of every new resume, letter, interview preparation and fit preview, never put in a shared copy and never shown to a connected app. Facts with the same words are marked with it.";
  const QUESTION =
    "It can be used again in resumes and documents, and connected apps can read it. Resumes that use it can be downloaded and shared again, and any shared copy that holds it opens again for anyone with its link. Facts with the same words are unmarked with it.";
  const sensitiveCalls = (api: FakeApi) => api.callsTo("POST", /^\/api\/facts\/sensitive$/).map((c) => c.body);
  /** Sam's vault with the migration fact already marked. */
  function withMarked(change: (state: Fixtures) => void = () => {}): Fixtures {
    const state = fixtures();
    state.facts.find((fact) => fact.id === "fact-migration")!.sensitive = true;
    change(state);
    return state;
  }

  it("marks at once, with no question, and then says what the mark does", async () => {
    const api = await openFacts();
    const fact = () => factItem(MIGRATION);
    expect(within(fact()).queryByText("Sensitive")).toBeNull();
    await userEvent.click(within(fact()).getByRole("button", { name: "Mark sensitive" }));
    await waitFor(() => expect(sensitiveCalls(api)).toHaveLength(1));
    // The fact as shown, with the revision the page had.
    expect(sensitiveCalls(api)[0]).toEqual({ ids: ["fact-migration"], sensitive: true, expectedRevisions: { "fact-migration": 1 } });
    const unmark = await within(fact()).findByRole("button", { name: "Unmark sensitive" });
    expect(screen.queryByRole("group", { name: "Unmark this fact" })).toBeNull();
    expect(within(fact()).getByText("Sensitive", { selector: ".rs-mark" })).toHaveClass("rs-mark--dropped");
    expect(within(fact()).getByText(HINT)).toBeInTheDocument();
    // It is still a fact to review: the mark is one more button, after the others.
    expect(within(fact()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Confirm", "Edit", "Reject", "Unmark sensitive"]);
    expect(unmark).toHaveAttribute("aria-expanded", "false");
    expect(unmark).not.toHaveAttribute("aria-keyshortcuts");
    // Focus is where the person left it: on the button they pressed.
    await waitFor(() => expect(unmark).toHaveFocus());
    // No other fact took the mark.
    expect(screen.getAllByText("Sensitive", { selector: ".rs-mark" })).toHaveLength(1);
  });

  it("asks before unmarking, in fixed words, and Cancel returns focus to the button", async () => {
    const api = await openFacts(withMarked());
    const fact = () => factItem(MIGRATION);
    const unmark = within(fact()).getByRole("button", { name: "Unmark sensitive" });
    await userEvent.click(unmark);
    const well = screen.getByRole("group", { name: "Unmark this fact" });
    expect(within(well).getByText(QUESTION)).toBeInTheDocument();
    expect(within(well).getAllByRole("button").map((b) => b.textContent)).toEqual(["Yes, unmark it", "Cancel"]);
    expect(within(well).getByRole("button", { name: "Yes, unmark it" })).toHaveFocus();
    expect(unmark).toHaveAttribute("aria-expanded", "true");
    // Nothing has been asked of the server yet.
    expect(sensitiveCalls(api)).toHaveLength(0);
    const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    await userEvent.click(within(well).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Unmark this fact" })).toBeNull();
    expect(within(fact()).getByRole("button", { name: "Unmark sensitive" })).toHaveFocus();
    expect(sensitiveCalls(api)).toHaveLength(0);
    expect(within(fact()).getByText("Sensitive", { selector: ".rs-mark" })).toBeInTheDocument();

    // Asked again and answered yes, it is unmarked, and focus is back on the one button.
    await userEvent.click(within(fact()).getByRole("button", { name: "Unmark sensitive" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, unmark it" }));
    await waitFor(() => expect(sensitiveCalls(api)).toHaveLength(1));
    expect(sensitiveCalls(api)[0]).toEqual({ ids: ["fact-migration"], sensitive: false, expectedRevisions: { "fact-migration": 1 } });
    const mark = await within(fact()).findByRole("button", { name: "Mark sensitive" });
    await waitFor(() => expect(mark).toHaveFocus());
    expect(within(fact()).queryByText("Sensitive", { selector: ".rs-mark" })).toBeNull();
    expect(within(fact()).queryByText(HINT)).toBeNull();
    expect(screen.queryByRole("group", { name: "Unmark this fact" })).toBeNull();
  });

  it("sends the copies shown together as one request, each with its revision", async () => {
    const state = fixtures();
    const original = state.facts.find((fact) => fact.id === "fact-migration")!;
    original.revision = 2;
    state.facts.push({ ...original, id: "fact-migration-again", revision: 5 });
    const api = await openFacts(state);
    const fact = factItem(MIGRATION);
    expect(within(fact).getByText(/This fact also appears in 1 other record\./)).toBeInTheDocument();
    await userEvent.click(within(fact).getByRole("button", { name: "Mark sensitive" }));
    await waitFor(() => expect(sensitiveCalls(api)).toHaveLength(1));
    expect(sensitiveCalls(api)[0]).toEqual({
      ids: ["fact-migration", "fact-migration-again"],
      sensitive: true,
      expectedRevisions: { "fact-migration": 2, "fact-migration-again": 5 },
    });
    // Both copies are marked, so they are still shown as one fact.
    await within(factItem(MIGRATION)).findByRole("button", { name: "Unmark sensitive" });
    expect(screen.getAllByText(MIGRATION)).toHaveLength(1);
    expect(state.facts.filter((item) => item.sensitive).map((item) => item.id)).toEqual(["fact-migration", "fact-migration-again"]);
  });

  it("shows the server’s sentence under the fact when the request is refused, with the facts as they now are", async () => {
    const api = await openFacts();
    api.fail("POST", /^\/api\/facts\/sensitive$/, 409, "conflict", "Your facts changed. Refresh the page, then try again.");
    const loads = api.callsTo("GET", /^\/api\/v2\/vault$/).length;
    const fact = () => factItem(MIGRATION);
    await userEvent.click(within(fact()).getByRole("button", { name: "Mark sensitive" }));
    expect(await within(fact()).findByRole("alert")).toHaveTextContent("Your facts changed. Refresh the page, then try again.");
    // The page read the facts again before saying so, and the fact is as that reading shows it.
    expect(api.callsTo("GET", /^\/api\/v2\/vault$/).length).toBe(loads + 1);
    expect(within(fact()).getByRole("button", { name: "Mark sensitive" })).toBeEnabled();
    expect(within(fact()).queryByText("Sensitive", { selector: ".rs-mark" })).toBeNull();
  });

  it("says “Marking…” while the request is on its way, and holds the fact’s other buttons", async () => {
    const state = fixtures();
    const api = installFakeApi(state);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const fetch = api.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/facts/sensitive")) await held;
      return fetch(input, init);
    });
    renderWithSession(<SourcesPage />, state.me);
    await screen.findByRole("heading", { name: "Northwind Logistics" });
    const fact = () => factItem(MIGRATION);
    await userEvent.click(within(fact()).getByRole("button", { name: "Mark sensitive" }));
    const pending = within(fact()).getByRole("button", { name: "Marking…" });
    expect(pending).toBeDisabled();
    for (const name of ["Confirm", "Edit", "Reject"]) expect(within(fact()).getByRole("button", { name })).toBeDisabled();
    release();
    expect(await within(fact()).findByRole("button", { name: "Unmark sensitive" })).toBeEnabled();
    expect(within(fact()).getByRole("button", { name: "Confirm" })).toBeEnabled();
  });

  it("shows only the mark on a rejected fact, and offers the control again once it is confirmed", async () => {
    const state = fixtures();
    state.facts.find((fact) => fact.id === "fact-runbook")!.sensitive = true;
    await openFacts(state);
    await userEvent.click(screen.getByRole("radio", { name: /^Rejected/ }));
    const rejected = factItem("Wrote the on-call runbook.");
    expect(within(rejected).getByText("Sensitive", { selector: ".rs-mark" })).toBeInTheDocument();
    expect(within(rejected).getAllByRole("button").map((b) => b.textContent)).toEqual(["Confirm"]);
    expect(within(rejected).queryByText(HINT)).toBeNull();
    await userEvent.click(within(rejected).getByRole("button", { name: "Confirm" }));
    await userEvent.click(await screen.findByRole("radio", { name: /^Confirmed/ }));
    const confirmed = await waitFor(() => factItem("Wrote the on-call runbook."));
    expect(within(confirmed).getByRole("button", { name: "Unmark sensitive" })).toBeEnabled();
    expect(within(confirmed).getByText(HINT)).toBeInTheDocument();
  });

  it("tells the editor of a marked fact that it stays marked, and locks the control while an editor is open", async () => {
    await openFacts(withMarked());
    const fact = () => factItem(MIGRATION);
    await userEvent.click(within(fact()).getByRole("button", { name: "Unmark sensitive" }));
    expect(screen.getByRole("group", { name: "Unmark this fact" })).toBeInTheDocument();
    // Opening the editor closes the question, and the editor says what saving will leave as it is.
    fact().focus();
    await userEvent.keyboard("e");
    const editor = await screen.findByLabelText("Fact", { selector: "textarea" }, { timeout: 4000 });
    expect(screen.queryByRole("group", { name: "Unmark this fact" })).toBeNull();
    const note = within(fact()).getByText("This fact stays sensitive after you save. To use a different wording, add it as a new fact and leave this one marked.");
    expect(editor.getAttribute("aria-describedby")!.split(" ")).toContain(note.id);
    expect(within(fact()).queryByRole("button", { name: "Unmark sensitive" })).toBeNull();
    // Every other fact's control waits for the editor to close, as its review buttons do.
    const other = factItem("Mentored four engineers through their first on-call rotations.");
    expect(within(other).getByRole("button", { name: "Mark sensitive" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(within(factItem("Mentored four engineers through their first on-call rotations.")).getByRole("button", { name: "Mark sensitive" })).toBeEnabled();
    expect(within(fact()).getByRole("button", { name: "Unmark sensitive" })).toHaveAttribute("aria-expanded", "false");
  });

  it("holds the answer to the question while another fact’s editor is open", async () => {
    const api = await openFacts(withMarked());
    await userEvent.click(within(factItem(MIGRATION)).getByRole("button", { name: "Unmark sensitive" }));
    const answer = screen.getByRole("button", { name: "Yes, unmark it" });
    expect(answer).toBeEnabled();
    // An open editor holds the list as it is, so nothing in it may change underneath: the question
    // stays, and its answer waits with the fact's other buttons.
    const other = factItem("Mentored four engineers through their first on-call rotations.");
    await userEvent.click(within(other).getByRole("button", { name: "Edit" }));
    await screen.findByLabelText("Fact", { selector: "textarea" }, { timeout: 4000 });
    expect(screen.getByRole("button", { name: "Yes, unmark it" })).toBeDisabled();
    expect(within(factItem(MIGRATION)).getByRole("button", { name: "Unmark sensitive" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Yes, unmark it" }));
    expect(sensitiveCalls(api)).toHaveLength(0);
    await userEvent.click(within(other).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Yes, unmark it" })).toBeEnabled();
    expect(within(factItem(MIGRATION)).getByText("Sensitive", { selector: ".rs-mark" })).toBeInTheDocument();
  });

  it("gives an unmarked fact’s editor no such note", async () => {
    await openFacts();
    const fact = factItem(MIGRATION);
    fact.focus();
    await userEvent.keyboard("e");
    await screen.findByLabelText("Fact", { selector: "textarea" }, { timeout: 4000 });
    expect(screen.queryByText(/This fact stays sensitive after you save/)).toBeNull();
  });
});

describe("pasting text", () => {
  const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
  const pastePanel = () => screen.getByRole("form", { name: "Paste text" });
  const textBox = () => within(pastePanel()).getByRole("textbox", { name: "Text to read" });
  const titleBox = () => within(pastePanel()).getByRole("textbox", { name: /^Title/ });
  const pasteCalls = (api: FakeApi) => api.callsTo("POST", /^\/api\/sources\/paste$/);

  async function openPaste(state: Fixtures = fixtures()): Promise<FakeApi> {
    const api = await openFacts(state);
    await userEvent.click(screen.getByRole("button", { name: "Paste text" }));
    return api;
  }

  async function pasteInto(box: HTMLElement, text: string) {
    await userEvent.click(box);
    await userEvent.paste(text);
  }

  it("offers Paste text beside Upload a file, with a textarea, a title and a count against 60,000", async () => {
    await openFacts();
    const group = screen.getByRole("group", { name: "Add a source" });
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
    const rail = screen.getByRole("complementary", { name: "Your sources" });
    expect(await within(rail).findByText("Q3 review.txt")).toBeInTheDocument();
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

  it("keeps the first-run dropzone and adds the toggle above it", async () => {
    const state = emptyVault();
    installFakeApi(state);
    renderWithSession(<SourcesPage />, state.me);
    await screen.findByRole("heading", { name: "What happens next" });
    const drop = document.querySelector(".app-drop--first-run")!;
    expect(drop).not.toBeNull();
    const group = screen.getByRole("group", { name: "Add a source" });
    expect(group.compareDocumentPosition(drop) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(within(group).getByRole("button", { name: "Paste text" }));
    expect(textBox()).toHaveAttribute("rows", "12");
  });

  it("passes axe with the paste panel open", async () => {
    await openPaste();
    fireEvent.change(textBox(), { target: { value: "a".repeat(60_001) } });
    const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("shows a pasted source’s text with the quote highlighted", async () => {
    const state = fixtures();
    const quote = "Shipped the carrier rates service to 12 regions.";
    const markdown = `Q3 review\n\nWhat I did\n\t- ${quote}\n- Mentored two engineers.`;
    const start = markdown.indexOf(quote);
    state.sources.unshift({ id: "src-paste", filename: "Q3 review.txt", origin: "paste", state: "ready", error: null, createdAt: 1793990000000, proposed: 1 });
    state.facts.push({
      id: "fact-pasted", roleId: "role-northwind", kind: "accomplishment", text: "Shipped carrier rates to 12 regions.", level: null,
      origin: "extracted", state: "proposed", quote, span: [start, start + quote.length], sourceId: "src-paste",
    });
    state.sourceTexts = { "src-paste": markdown };
    await openFacts(state);
    expect(within(screen.getByRole("complementary", { name: "Your sources" })).getByText("Q3 review.txt")).toBeInTheDocument();
    const fact = factItem("Shipped carrier rates to 12 regions.");
    await userEvent.click(within(fact).getByRole("button", { name: "See this quote in its source" }));
    const shown = await within(fact).findByLabelText("Source text with the evidence highlighted");
    expect(shown.querySelector("mark")!.textContent).toBe(quote);
    expect(shown.textContent).toBe(markdown);
  });
});
