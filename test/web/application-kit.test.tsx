import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KIT_CHANGED, SAVED_ANSWER_CHANGED, SAVED_ANSWER_LABEL_TAKEN, type KitView } from "../../src/shared/kit";
import { ApplicationKit } from "../../src/web/components/ApplicationKit";
import { SavedAnswers } from "../../src/web/components/SavedAnswers";
import { formatDate, typeset } from "../../src/web/format";
import { kitWriteObserved } from "../../src/web/kit-save";
import { VAULT_CHANGED } from "../../src/web/live";
import { installFakeApi, type FakeApi } from "./api-fake";
import { fullVault, type Fixtures } from "./fixtures";
import { renderWithSession } from "./render";

// The Application kit panel and the Saved answers card, over the fake API. An employer's questions
// are someone else's text and are shown in a quote; every state says what the person can do.

afterEach(() => vi.unstubAllGlobals());

const JOB = "app-litware";

function openKit(change: (state: Fixtures) => void = () => {}) {
  const state = fullVault();
  change(state);
  const api = installFakeApi(state);
  const session = renderWithSession(<ApplicationKit applicationId={JOB} />, state.me);
  return { state, api, session };
}
const panel = () => screen.getByRole("region", { name: "Application kit" });
/** The list item holding the question with these words, as its quote shows them. */
const item = (words: string) => screen.getAllByText(words).find((node) => node.closest("blockquote"))!.closest("li")! as HTMLElement;
/** Lets every request through to the fake API, after `before` has had its say about it. */
function intercept(api: FakeApi, before: (method: string, path: string, respond: () => Promise<Response>) => Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      before((init?.method ?? "GET").toUpperCase(), String(input), () => api.fetch(input, init)),
    ),
  );
}

describe("the application kit panel", () => {
  it("says what the kit is, that nothing is sent, and shows each question's state in its own words", async () => {
    openKit();
    await screen.findByRole("button", { name: "Approve kit" });
    expect(
      within(panel()).getByText(
        "Put together what you’ll send for this job: a resume, a cover letter and interview preparation if you want them, and your answers to the employer’s questions. Nothing is sent from here. Once you approve the kit, download it and send it yourself.",
      ),
    ).toBeInTheDocument();
    // The parts: each version offered by its number and date, and the optional parts with None.
    const resume = screen.getByRole("combobox", { name: "Resume" });
    expect(within(resume).getAllByRole("option").map((option) => option.textContent)).toEqual([
      `Version 2, made ${formatDate(1794044520000)}`,
      `Version 1, made ${formatDate(1794040000000)}`,
    ]);
    expect(within(screen.getByRole("combobox", { name: "Cover letter (optional)" })).getAllByRole("option")[0]).toHaveTextContent("None");
    expect(within(screen.getByRole("combobox", { name: "Interview preparation (optional)" })).getAllByRole("option")[0]).toHaveTextContent("None");
    expect(screen.getByRole("button", { name: "Save choices" })).toBeDisabled();

    // Each question is the employer's text, in a quote.
    for (const words of ["What is your notice period?", "Portfolio link", "Why do you want to work at Litware?", "Will you now or in the future require visa sponsorship?"])
      expect(item(words)).toBeInstanceOf(HTMLLIElement);

    // Matched by the judge, not yet checked.
    const notice = item("What is your notice period?");
    expect(within(notice).getByText("Saved answer")).toBeInTheDocument();
    expect(within(notice).getByText("Matched to your saved answer “Notice period”.")).toBeInTheDocument();
    expect(within(notice).getByText("Four weeks, from the day I accept an offer.")).toBeInTheDocument();
    expect(within(notice).getByText("Suggested from your answers’ labels. Check that it fits.")).toBeInTheDocument();
    expect(within(notice).getByRole("button", { name: "Use this answer" })).toBeEnabled();
    expect(within(notice).getByRole("button", { name: "Not this one" })).toBeEnabled();
    // Matched by its label, and checked.
    const portfolio = item("Portfolio link");
    expect(within(portfolio).getByText("You’ve checked this answer.")).toBeInTheDocument();
    expect(within(portfolio).queryByText("Suggested from your answers’ labels. Check that it fits.")).toBeNull();
    expect(within(portfolio).queryByRole("button", { name: "Use this answer" })).toBeNull();
    // Asks.
    const why = item("Why do you want to work at Litware?");
    expect(within(why).getByText("Needs your answer")).toBeInTheDocument();
    expect(within(why).getByText("None of your saved answers fits this question. Type your answer, or choose a saved answer.")).toBeInTheDocument();
    expect(within(why).getByRole("textbox", { name: "Your answer" })).toBeInTheDocument();
    // A saved answer the list now refuses is never offered.
    expect(within(within(why).getByRole("combobox", { name: "Use a saved answer" })).getAllByRole("option").map((option) => option.textContent)).toEqual(["None", "Notice period", "Portfolio link"]);
    expect(within(why).getByRole("checkbox", { name: "Also keep this as a saved answer" })).not.toBeChecked();
    // Sensitive: asked every time, explained, and answered for this application only.
    const visa = item("Will you now or in the future require visa sponsorship?");
    expect(within(visa).getByText("Asked every time")).toBeInTheDocument();
    expect(
      within(visa).getByText(
        "This question asks about work authorisation, visas, sponsorship or citizenship. Answers to questions like this are never saved or matched. Type your answer for this application only.",
      ),
    ).toBeInTheDocument();
    expect(within(visa).getByRole("textbox", { name: "Your answer" })).toHaveValue("No.");
    expect(within(visa).queryByRole("combobox", { name: "Use a saved answer" })).toBeNull();
    expect(within(visa).queryByRole("checkbox", { name: "Also keep this as a saved answer" })).toBeNull();

    // The draft line, and approval held until every question is answered.
    expect(within(panel()).getByText("Draft. Approve the kit when every question has an answer you’ve typed or checked.")).toBeInTheDocument();
    expect(within(panel()).getByText(typeset("Every question needs an answer you've typed or checked before the kit can be approved."))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve kit" })).toBeDisabled();
  });

  it("explains a question the judge said is sensitive", async () => {
    openKit((state) => {
      const visa = state.kits![JOB]!.questions[3]!;
      visa.sensitiveKind = "judge";
    });
    await screen.findByText("Asked every time");
    expect(
      screen.getByText(
        "This question asks about something answers are never saved for: work authorisation, pay or personal details. Answers to questions like this are never saved or matched. Type your answer for this application only.",
      ),
    ).toBeInTheDocument();
  });

  it("enables approval once every question is answered, approves, and offers the download", async () => {
    const { api } = openKit();
    await screen.findByRole("button", { name: "Approve kit" });
    await userEvent.click(within(item("What is your notice period?")).getByRole("button", { name: "Use this answer" }));
    await waitFor(() => expect(within(item("What is your notice period?")).getByText("You’ve checked this answer.")).toBeInTheDocument());
    const why = item("Why do you want to work at Litware?");
    await userEvent.type(within(why).getByRole("textbox", { name: "Your answer" }), "The platform team's work.");
    await userEvent.click(within(why).getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve kit" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Approve kit" }));
    const download = await screen.findByRole("link", { name: "Download kit (ZIP)" });
    expect(download).toHaveAttribute("href", "/api/applications/app-litware/kit/archive");
    expect(screen.getByText(new RegExp(`^Approved ${formatDate(Date.now())}\\. Download it and send it yourself\\.$`))).toBeInTheDocument();
    // Each write named the revision on screen.
    expect(api.callsTo("POST", /\/kit\/questions\/kq-notice$/)[0]!.body).toEqual({ change: { kind: "confirm" }, expectedRevision: 6 });
    expect(api.callsTo("POST", /\/kit\/questions\/kq-why$/)[0]!.body).toEqual({ change: { kind: "type", answer: "The platform team's work." }, expectedRevision: 7 });
    expect(api.callsTo("POST", /\/kit\/approve$/)[0]!.body).toEqual({ expectedRevision: 8 });
  });

  it("says an approved kit that a check now refuses needs attention, and why", async () => {
    openKit((state) => {
      Object.assign(state.kits![JOB]!, { state: "approved", approvedAt: Date.now(), problems: [{ code: "resume_refused" }], ready: false });
    });
    await screen.findByText("This kit needs attention before it can be downloaded.");
    expect(
      screen.getByText(typeset("This resume version can't go in a kit: it uses a fact you've marked sensitive, or a line its facts don't back. Choose another version.")),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Download kit (ZIP)" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve kit" })).toBeNull();
  });

  it("asks for a resume first when the job has none that can go in a kit", async () => {
    openKit((state) => {
      Object.assign(state.kits![JOB]!, { resume: null, choices: { resumes: [], letters: [], preps: [] } });
    });
    await screen.findByText("Make a resume for this job first. Only a version whose every line is backed by your facts can go in a kit.");
    expect(screen.queryByRole("combobox", { name: "Resume" })).toBeNull();
  });

  it("adds pasted questions one per line, edits, moves and removes them, then saves them in order", async () => {
    const { api } = openKit();
    await screen.findByRole("button", { name: "Approve kit" });
    await userEvent.type(screen.getByRole("textbox", { name: "Paste the employer’s questions, one per line" }), "Are you willing to travel?{enter}{enter}  Salary expectations  ");
    await userEvent.click(screen.getByRole("button", { name: "Add questions" }));
    // Not yet saved, so not yet answered.
    expect(within(item("Are you willing to travel?")).getByText("Save the questions to answer this one.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove question 2" }));
    await userEvent.click(screen.getByRole("button", { name: "Move up question 4" }));
    await userEvent.click(screen.getByRole("button", { name: "Edit question 1" }));
    const editing = screen.getByRole("textbox", { name: "Question 1" });
    await userEvent.clear(editing);
    await userEvent.type(editing, "What notice do you need to give?");
    await userEvent.click(screen.getByRole("button", { name: "Done editing question 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Save questions" }));
    await waitFor(() => expect(api.callsTo("PUT", /\/kit\/questions$/)).toHaveLength(1));
    expect(api.callsTo("PUT", /\/kit\/questions$/)[0]!.body).toEqual({
      questions: [
        { id: "kq-notice", text: "What notice do you need to give?" },
        { id: "kq-why", text: "Why do you want to work at Litware?" },
        { text: "Are you willing to travel?" },
        { id: "kq-visa", text: "Will you now or in the future require visa sponsorship?" },
        { text: "Salary expectations" },
      ],
      expectedRevision: 6,
    });
    // As saved: the pay question is asked every time.
    await waitFor(() => expect(within(item("Salary expectations")).getByText("Asked every time")).toBeInTheDocument());
    expect(within(item("Salary expectations")).getByText(/^This question asks about salary, pay or compensation\./)).toBeInTheDocument();
  });

  it("accepts a lost reply only when a fresh read shows the kit at the next revision with what was sent", async () => {
    const { api } = openKit();
    await screen.findByRole("button", { name: "Approve kit" });
    // The write lands, and its reply is lost.
    intercept(api, async (method, path, respond) => {
      const answered = await respond();
      if (method === "POST" && path.endsWith("/kit/questions/kq-notice")) return new Response(null, { status: 503 });
      return answered;
    });
    await userEvent.click(within(item("What is your notice period?")).getByRole("button", { name: "Use this answer" }));
    await waitFor(() => expect(within(item("What is your notice period?")).getByText("You’ve checked this answer.")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).toBeNull();
    // The write didn't land: the fresh read is where it was, and the failure is said.
    intercept(api, async (method, path, respond) => {
      if (method === "POST" && path.endsWith("/kit/questions/kq-portfolio")) return new Response(null, { status: 503 });
      return respond();
    });
    await userEvent.click(within(item("Portfolio link")).getByRole("button", { name: "Not this one" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong in Resumatic. Try again in a moment.");
    expect(within(item("Portfolio link")).getByText("You’ve checked this answer.")).toBeInTheDocument();
  });

  it("settles a lost reply by the rule: the next revision, holding exactly the values sent", () => {
    const view = fullVault().kits![JOB]!;
    const next: KitView = { ...view, revision: view.revision + 1 };
    const questions = view.questions.map((question) => ({ id: question.id, text: question.text }));
    expect(kitWriteObserved(next, view.revision, { kind: "questions", questions })).toBe(true);
    // Not at the next revision: another write, or none.
    expect(kitWriteObserved(view, view.revision, { kind: "questions", questions })).toBe(false);
    expect(kitWriteObserved({ ...next, revision: view.revision + 2 }, view.revision, { kind: "questions", questions })).toBe(false);
    // At the next revision, but without what was sent.
    expect(kitWriteObserved(next, view.revision, { kind: "questions", questions: questions.slice(1) })).toBe(false);
    expect(kitWriteObserved(next, view.revision, { kind: "parts", resume: view.resume, letter: null, prep: null })).toBe(false);
    expect(kitWriteObserved(next, view.revision, { kind: "parts", resume: view.resume, letter: view.letter, prep: null })).toBe(true);
    expect(kitWriteObserved(next, view.revision, { kind: "answer", questionId: "kq-notice", change: { kind: "confirm" } })).toBe(false);
    expect(kitWriteObserved(next, view.revision, { kind: "answer", questionId: "kq-visa", change: { kind: "type", answer: " No. " } })).toBe(true);
    expect(kitWriteObserved(next, view.revision, { kind: "approve" })).toBe(false);
    expect(kitWriteObserved(null, view.revision, { kind: "approve" })).toBe(false);
  });

  it("settles a lost save by its label as the vault keys it: the saved answer kept under the same label, written differently", () => {
    const view = fullVault().kits![JOB]!;
    const notice = view.questions[0]!.savedAnswer!;
    const why = { ...view.questions[2]!, state: "matched" as const, matchedBy: "owner" as const, savedAnswer: notice, confirmed: true };
    const next: KitView = { ...view, revision: view.revision + 1, questions: view.questions.map((question) => (question.id === why.id ? why : question)) };
    const save = (label: string, answer: string) => kitWriteObserved(next, view.revision, { kind: "answer", questionId: why.id, change: { kind: "save", label, answer } });
    expect(save("NOTICE—period!", ` ${notice.answer} `)).toBe(true);
    expect(save("Notice period", "Two weeks.")).toBe(false);
    expect(save("Notice", notice.answer)).toBe(false);
  });

  it("says a stale write's sentence as the server wrote it, curled", async () => {
    const { api } = openKit();
    await screen.findByRole("button", { name: "Approve kit" });
    api.fail("POST", /\/kit\/questions\/kq-notice$/, 409, "conflict", KIT_CHANGED);
    await userEvent.click(within(item("What is your notice period?")).getByRole("button", { name: "Use this answer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(typeset(KIT_CHANGED));
  });

  it("shows what a fresh read at the same revision says after a write: a letter written since is offered", async () => {
    const { state } = openKit();
    await screen.findByRole("button", { name: "Approve kit" });
    await userEvent.click(within(item("What is your notice period?")).getByRole("button", { name: "Use this answer" }));
    await waitFor(() => expect(within(item("What is your notice period?")).getByText("You’ve checked this answer.")).toBeInTheDocument());
    // A letter finished for the job: what can be chosen changes, the kit's revision doesn't.
    state.kits![JOB]!.choices.letters.unshift({ id: "doc-letter-2", version: 3, createdAt: 1795000000000 });
    window.dispatchEvent(new Event(VAULT_CHANGED));
    const letters = screen.getByRole("combobox", { name: "Cover letter (optional)" });
    await waitFor(() => expect(within(letters).getByRole("option", { name: `Version 3, made ${formatDate(1795000000000)}` })).toBeInTheDocument());
  });

  it("loads the kit again after a stale write, and the next write names the revision it now shows", async () => {
    const { state, api } = openKit();
    await screen.findByRole("button", { name: "Approve kit" });
    // Answered somewhere else since this page read it.
    Object.assign(state.kits![JOB]!, { revision: 7 });
    state.kits![JOB]!.questions[2]!.typedAnswer = "Answered elsewhere.";
    await userEvent.click(within(item("What is your notice period?")).getByRole("button", { name: "Use this answer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(typeset(KIT_CHANGED));
    await userEvent.click(screen.getByRole("button", { name: "Load the kit again" }));
    await waitFor(() => expect(within(item("Why do you want to work at Litware?")).getByRole("textbox", { name: "Your answer" })).toHaveValue("Answered elsewhere."));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Load the kit again" })).toBeNull();
    await userEvent.click(within(item("What is your notice period?")).getByRole("button", { name: "Use this answer" }));
    await waitFor(() => expect(within(item("What is your notice period?")).getByText("You’ve checked this answer.")).toBeInTheDocument());
    expect(api.callsTo("POST", /\/kit\/questions\/kq-notice$/).map((call) => (call.body as { expectedRevision: number }).expectedRevision)).toEqual([6, 7]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps an answer typed into one question when another question's answer is saved", async () => {
    openKit();
    await screen.findByRole("button", { name: "Approve kit" });
    await userEvent.click(within(item("What is your notice period?")).getByRole("button", { name: "Use this answer" }));
    await waitFor(() => expect(within(item("What is your notice period?")).getByText("You’ve checked this answer.")).toBeInTheDocument());
    const visaAnswer = () => within(item("Will you now or in the future require visa sponsorship?")).getByRole("textbox", { name: "Your answer" });
    await userEvent.type(visaAnswer(), " Not now.");
    const why = item("Why do you want to work at Litware?");
    await userEvent.type(within(why).getByRole("textbox", { name: "Your answer" }), "The team.");
    await userEvent.click(within(why).getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve kit" })).toBeEnabled());
    expect(visaAnswer()).toHaveValue("No. Not now.");
    expect(within(item("Why do you want to work at Litware?")).getByRole("textbox", { name: "Your answer" })).toHaveValue("The team.");
  });

  it("uses no straight apostrophe in anything it says", async () => {
    openKit((state) => {
      state.kits![JOB]!.questions[0]!.text = "What is your notice period?";
    });
    await screen.findByRole("button", { name: "Approve kit" });
    // Everything but the employer's questions and the person's own answers, which are shown as written.
    const own = new Set(["What is your notice period?", "Portfolio link", "Why do you want to work at Litware?", "Will you now or in the future require visa sponsorship?"]);
    const said = [...panel().querySelectorAll("p, label, button, option, h3, h4, span, li")].filter((node) => node.children.length === 0 && !own.has(node.textContent ?? ""));
    for (const node of said) expect(node.textContent, node.outerHTML).not.toContain("'");
  });
});

describe("the saved answers card", () => {
  function openCard(change: (state: Fixtures) => void = () => {}) {
    const state = fullVault();
    change(state);
    const api = installFakeApi(state);
    renderWithSession(<SavedAnswers />, state.me);
    return { state, api };
  }
  const card = () => screen.getByRole("region", { name: "Saved answers" });

  it("says what saved answers are, what is never saved, and why an older one can't be offered", async () => {
    openCard();
    await screen.findByText("Portfolio link", { selector: "strong" });
    expect(
      within(card()).getByText(
        "Short answers you give on many applications, in your own words. An application kit offers one when an employer’s question fits its label. Your answers stay in your vault, and their words are never sent to an AI model.",
      ),
    ).toBeInTheDocument();
    expect(card().querySelector(".rs-msg")!.textContent!.replace(/\s+/g, " ").trim()).toBe(
      "Questions about work authorisation, visas, sponsorship or citizenship, pay, or personal details such as age, health or family are never saved. They’re asked every time you apply.",
    );
    expect(within(card()).getByText("This answer can’t be offered any more: it’s about salary, pay or compensation.")).toBeInTheDocument();
    expect(within(card()).getByText("A short name, such as “Notice period” or “Portfolio link”.")).toBeInTheDocument();
    for (const node of card().querySelectorAll("p, label, button, h2"))
      if (!/Four weeks|https:|salary in line/.test(node.textContent ?? "")) expect(node.textContent).not.toContain("'");
  });

  it("is empty until one is added, then adds, edits and deletes one", async () => {
    const { api } = openCard((state) => {
      state.savedAnswers = [];
    });
    await screen.findByText("No saved answers yet.");
    await userEvent.type(screen.getByRole("textbox", { name: "Label" }), "Notice period");
    await userEvent.type(screen.getByRole("textbox", { name: "Answer" }), "Four weeks.");
    await userEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await screen.findByText("Saved.");
    expect(within(card()).getByText("Four weeks.")).toBeInTheDocument();
    expect(api.callsTo("POST", /\/api\/saved-answers$/)[0]!.body).toEqual({ label: "Notice period", answer: "Four weeks." });
    // A second with the same label and other words is refused in the server's words.
    await userEvent.type(screen.getByRole("textbox", { name: "Label" }), "notice period");
    await userEvent.type(screen.getByRole("textbox", { name: "Answer" }), "Two weeks.");
    await userEvent.click(screen.getByRole("button", { name: "Save answer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(typeset(SAVED_ANSWER_LABEL_TAKEN));
    // Edited at the revision it was read at.
    await userEvent.click(screen.getByRole("button", { name: "Edit Notice period" }));
    const editing = screen.getByRole("form", { name: "Edit Notice period" });
    await userEvent.clear(within(editing).getByRole("textbox", { name: "Answer" }));
    await userEvent.type(within(editing).getByRole("textbox", { name: "Answer" }), "Two weeks.");
    await userEvent.click(within(editing).getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(within(card()).getByText("Two weeks.")).toBeInTheDocument());
    expect(api.callsTo("PUT", /\/api\/saved-answers\//)[0]!.body).toEqual({ label: "Notice period", answer: "Two weeks.", expectedRevision: 1 });
    await userEvent.click(screen.getByRole("button", { name: "Delete Notice period" }));
    await screen.findByText("No saved answers yet.");
  });

  it("loads the saved answers again after a stale edit, so the next save names the revision changed elsewhere", async () => {
    const { state, api } = openCard();
    await screen.findByText("Portfolio link", { selector: "strong" });
    await userEvent.click(screen.getByRole("button", { name: "Edit Notice period" }));
    // Edited somewhere else since this page read it.
    Object.assign(state.savedAnswers![0]!, { revision: 3, answer: "Three weeks." });
    const editing = () => screen.getByRole("form", { name: "Edit Notice period" });
    await userEvent.clear(within(editing()).getByRole("textbox", { name: "Answer" }));
    await userEvent.type(within(editing()).getByRole("textbox", { name: "Answer" }), "Two weeks.");
    await userEvent.click(within(editing()).getByRole("button", { name: "Save answer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(typeset(SAVED_ANSWER_CHANGED));
    await waitFor(() => expect(api.callsTo("GET", /\/api\/saved-answers$/)).toHaveLength(2));
    // What was typed is kept, and saved again at the revision now held.
    expect(within(editing()).getByRole("textbox", { name: "Answer" })).toHaveValue("Two weeks.");
    await userEvent.click(within(editing()).getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(within(card()).getByText("Two weeks.")).toBeInTheDocument());
    expect(api.callsTo("PUT", /\/api\/saved-answers\//).map((call) => (call.body as { expectedRevision: number }).expectedRevision)).toEqual([2, 3]);
  });

  it("refuses an answer about pay in the server's sentence, and keeps what was typed", async () => {
    openCard();
    await screen.findByText("Portfolio link", { selector: "strong" });
    await userEvent.type(within(screen.getByRole("form", { name: "Add a saved answer" })).getByRole("textbox", { name: "Label" }), "Day rate");
    await userEvent.type(within(screen.getByRole("form", { name: "Add a saved answer" })).getByRole("textbox", { name: "Answer" }), "500");
    await userEvent.click(within(screen.getByRole("form", { name: "Add a saved answer" })).getByRole("button", { name: "Save answer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved answers can’t hold salary, pay or compensation.");
    expect(within(screen.getByRole("form", { name: "Add a saved answer" })).getByRole("textbox", { name: "Label" })).toHaveValue("Day rate");
  });
});
