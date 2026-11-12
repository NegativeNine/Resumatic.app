import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useCallback, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Me } from "../../src/shared/api";
import type { CommentThread, OwnerCommentThread, ShareComment, SharedView, ShareTarget } from "../../src/shared/sharing";
import { OwnerComments } from "../../src/web/components/ShareComments";
import { ShareSnapshotContent } from "../../src/web/components/ShareSnapshotContent";
import { SharingCoaches } from "../../src/web/pages/sharing/SharingCoaches";
import { SharePage } from "../../src/web/pages/SharePage";
import { SessionContext } from "../../src/web/session";
import { FakeApi, installFakeApi } from "./api-fake";
import { fixtures, fullVault, sharedView, type Fixtures } from "./fixtures";
import { renderWithSession } from "./render";

const GRANT = "0653389a-0d6d-4e90-94eb-23cc98b95c19";
// The share page reads which copy it shows from the address as its module loads, so the address
// is set before anything is imported.
vi.hoisted(() => window.history.replaceState(null, "", "/share?g=0653389a-0d6d-4e90-94eb-23cc98b95c19"));

const violations = async () => (await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).violations;
const SATURDAY = Date.UTC(2026, 10, 8, 15);
const comment = (id: string, author: ShareComment["author"], body: string, extra: Partial<ShareComment> = {}): ShareComment => ({ id, author, body, createdAt: SATURDAY, ...extra });

// The copy sharedView() gives: three facts, and one resume version with a summary and four lines.
const LED = "Led the migration of 40 services from Heroku to Kubernetes.";
const LED_LINE = "Led the migration of 40 services from Heroku to Kubernetes";
const SUMMARY = "Backend engineer who builds and runs Python services on Kubernetes.";
const onFact: ShareTarget = { kind: "fact", factId: "f1" };
const onLine: ShareTarget = { kind: "line", resumeId: "res-ready", version: 2, lineId: "l1" };

/** The copy as its named coach reads it once it is in their list. */
function joined(change: (view: SharedView) => void = () => {}): SharedView {
  const view = sharedView();
  view.grantId = GRANT;
  view.snapshot.schemaVersion = 2;
  view.snapshot.owner = { name: "Sam Rivera" };
  view.reviewer = "joined";
  change(view);
  return view;
}

/**
 * Opens the share page on a copy. The copy itself is answered here, as is adding it to the
 * reader's client list; everything under /api/coach/clients/…/comments is the fake API's.
 */
function open(view: SharedView, state: Fixtures = fixtures()) {
  const api = new FakeApi(state);
  const copy = { view };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.pathname === "/share/snapshot") return new Response(JSON.stringify(copy.view), { status: 200, headers: { "content-type": "application/json" } });
      if (url.pathname === "/api/coach/clients" && method === "POST") {
        api.calls.push({ method, path: url.pathname, body: JSON.parse(String(init?.body)) });
        copy.view = { ...copy.view, reviewer: "joined" };
        return new Response(null, { status: 204 });
      }
      return api.fetch(input, init);
    }),
  );
  const page = render(<SharePage />);
  return { api, state, copy, page };
}

const commentCalls = (api: FakeApi) => api.calls.filter((call) => call.path.includes("/comments"));
const form = () => within(screen.getByRole("complementary", { name: "Comments" }));
const box = () => form().getByRole("textbox");
const thread = (quote: string) => screen.getByRole("article", { name: `On “${quote}”` });

describe("a coach commenting on a client's copy", () => {
  it("names the chosen line or fact in the form, and nothing chosen leaves it disabled", async () => {
    const { api } = open(joined());
    expect(await screen.findByText(/^Shared with you until \d+ Nov 2026\. You can comment\. Only Sam Rivera can change it\.$/)).toBeInTheDocument();
    // The mark comes first, then what the reader can do, then the way back to their list.
    // A fixed copy is neither backed nor go, so its mark is a neutral note.
    expect(screen.getByText("Fixed copy")).toHaveClass("rs-mark--note");
    expect(screen.getByText("Fixed copy").parentElement!.textContent).toMatch(/^Fixed copy Shared with you until \d+ Nov 2026\. You can comment\. Only Sam Rivera can change it\. Open your clients$/);
    expect(screen.getByRole("link", { name: "Open your clients" })).toHaveAttribute("href", "/#/coaching/clients");
    expect(await screen.findByText("No comments yet.")).toBeInTheDocument();
    expect(api.callsTo("GET", /^\/api\/coach\/clients\/[^/]+\/comments$/).map((call) => call.path)).toEqual([`/api/coach/clients/${GRANT}/comments`]);

    // Nothing chosen: the form says what to do first, and takes nothing.
    const nothing = form().getByRole("textbox", { name: "Comment on a line or a fact" });
    expect(nothing).toBeDisabled();
    expect(nothing).toHaveAccessibleDescription(/^Choose a line or a fact on the copy to comment on it\./);
    expect(form().getByRole("button", { name: "Comment" })).toBeDisabled();
    expect(form().getByText("0 of 1,000 characters")).toBeInTheDocument();

    // Every fact, the summary and each line under a role can be chosen, and nothing else.
    const choices = screen.getAllByRole("button", { pressed: false });
    expect(choices.map((choice) => choice.textContent)).toEqual([
      LED,
      "Reduced p95 API latency from 900 ms to 210 ms by moving hot paths to Redis.",
      "Python",
      SUMMARY,
      LED_LINE,
      "Reduced p95 API latency from 900 ms to 210 ms with Redis",
      "Mentored two junior engineers through their first on-call rotations (written by the owner)",
      "Built internal admin pages in Django",
    ]);
    // Skills, a role's heading and what a fact is filed under are read, not chosen.
    for (const text of ["Python · Kubernetes · Redis · PostgreSQL", "Senior Backend Engineer, Northwind Logistics", "Sam Rivera, version 2", "General experience. Added by the owner in their own words."])
      for (const shown of screen.getAllByText(text)) expect(shown.closest("button"), text).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: LED_LINE }));
    expect(screen.getByRole("button", { name: LED_LINE })).toHaveAttribute("aria-pressed", "true");
    const onTheLine = form().getByRole("textbox", { name: "Comment on the selected line" });
    expect(onTheLine).toBeEnabled();
    expect(onTheLine).toHaveAttribute("placeholder", "Say what would make this line stronger.");
    expect(onTheLine).toHaveAccessibleDescription(
      /^Sam Rivera will see this the next time they open Resumatic\. Resumatic doesn’t send email\. They keep your comments, with your name and sign-in address, until they delete them\. 0 of 1,000 characters$/,
    );
    // An empty box sends nothing.
    expect(form().getByRole("button", { name: "Comment" })).toBeDisabled();

    // One at a time: choosing a fact lets go of the line.
    await userEvent.click(screen.getByRole("button", { name: "Python" }));
    expect(screen.getAllByRole("button", { pressed: true }).map((choice) => choice.textContent)).toEqual(["Python"]);
    const onTheFact = form().getByRole("textbox", { name: "Comment on the selected fact" });
    expect(onTheFact).toHaveAttribute("placeholder", "Say what would make this fact stronger.");
    // And choosing the chosen one again lets go of it.
    await userEvent.click(screen.getByRole("button", { name: "Python" }));
    expect(screen.queryAllByRole("button", { pressed: true })).toEqual([]);
    expect(form().getByRole("textbox", { name: "Comment on a line or a fact" })).toBeDisabled();
    expect(commentCalls(api).filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("puts a sent comment in its thread under “You”", async () => {
    const { api } = open(joined());
    await screen.findByText("No comments yet.");
    await userEvent.click(screen.getByRole("button", { name: LED_LINE }));
    await userEvent.type(box(), "  Lead with what it saved.{enter}{enter}Then the scale.  ");
    // Counted as it will be kept: without the space at either end.
    expect(form().getByText("41 of 1,000 characters")).toBeInTheDocument();
    await userEvent.click(form().getByRole("button", { name: "Comment" }));

    expect(await form().findByText("Comment added.")).toBeInTheDocument();
    const sent = api.callsTo("POST", /\/comments$/);
    expect(sent.map((call) => [call.path, call.body])).toEqual([[`/api/coach/clients/${GRANT}/comments`, { target: onLine, body: "Lead with what it saved.\n\nThen the scale." }]]);
    // The thread is headed by the line's words, and the comment keeps its line breaks.
    const card = thread(LED_LINE);
    expect(within(card).getByText(/^You, \d+ Nov 2026$/)).toBeInTheDocument();
    expect(within(card).getByText(/^Lead with what it saved\.\s+Then the scale\.$/).textContent).toBe("Lead with what it saved.\n\nThen the scale.");
    expect(screen.queryByText("No comments yet.")).toBeNull();
    // The box is empty for the next one, and the line stays chosen.
    expect(box()).toHaveValue("");
    expect(screen.getByRole("button", { name: LED_LINE })).toHaveAttribute("aria-pressed", "true");

    // A second comment on the same line joins the same thread, and one on a fact starts another.
    await userEvent.type(box(), "And name the team.");
    expect(form().queryByText("Comment added.")).toBeNull();
    await userEvent.click(form().getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(within(thread(LED_LINE)).getAllByText(/^You, /)).toHaveLength(2));
    await userEvent.click(screen.getByRole("button", { name: LED }));
    await userEvent.type(box(), "How long did it take?");
    await userEvent.click(form().getByRole("button", { name: "Comment" }));
    expect(within(await screen.findByRole("article", { name: `On “${LED}”` })).getByText("How long did it take?")).toBeInTheDocument();
    expect(form().getAllByRole("article").map((card) => card.getAttribute("aria-labelledby")).length).toBe(2);
    expect(api.callsTo("POST", /\/comments$/).map((call) => (call.body as { target: ShareTarget }).target)).toEqual([onLine, onLine, onFact]);
  });

  it("shows a reply under the owner's name, or as the owner's when the copy carries none", async () => {
    const threads: CommentThread[] = [
      { target: onLine, quote: LED_LINE, comments: [comment("c1", "coach", "Lead with what it saved."), comment("c2", "owner", "It saved two days a release.")] },
    ];
    const first = open(joined(), { ...fixtures(), coachComments: structuredClone(threads) });
    const card = await screen.findByRole("article", { name: `On “${LED_LINE}”` });
    expect(within(card).getAllByRole("listitem").map((item) => item.querySelector(".app-thread__byline")!.textContent)).toEqual([
      expect.stringMatching(/^You, \d+ Nov 2026$/),
      expect.stringMatching(/^Sam Rivera, \d+ Nov 2026$/),
    ]);
    // Only the coach's own comment can be deleted from here.
    expect(within(card).getAllByRole("button", { name: "Delete" })).toHaveLength(1);
    expect(within(within(card).getAllByRole("listitem")[1]!).queryByRole("button")).toBeNull();
    // Nothing tells a coach whether the owner has looked.
    expect(within(card).queryByText("New")).toBeNull();
    first.page.unmount();

    open(joined((view) => { view.snapshot.owner = null; }), { ...fixtures(), coachComments: structuredClone(threads) });
    expect(await screen.findByText(/^Shared with you until \d+ Nov 2026\. You can comment\. Only its owner can change it\.$/)).toBeInTheDocument();
    expect(within(await screen.findByRole("article", { name: `On “${LED_LINE}”` })).getByText(/^The owner, \d+ Nov 2026$/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: SUMMARY }));
    expect(box()).toHaveAccessibleDescription(/^The owner of this copy will see this the next time they open Resumatic\./);
  });

  it("says the owner may get an email only where Resumatic sends them, and that it never holds the coach's words", async () => {
    const KEEP = "They keep your comments, with your name and sign-in address, until they delete them\\. 0 of 1,000 characters$";
    const withEmail = fixtures();
    withEmail.me.capabilities = { ocr: false, connectedApps: false, emailNotices: true };
    const sending = open(joined(), withEmail);
    await screen.findByText("No comments yet.");
    await userEvent.click(screen.getByRole("button", { name: LED_LINE }));
    expect(box()).toHaveAccessibleDescription(
      new RegExp(`^Sam Rivera will see this the next time they open Resumatic\\. They may also get an email saying there’s something new\\. It never holds your words\\. ${KEEP}`),
    );
    sending.page.unmount();

    // Email off, or no answer on whether it is on: no email is promised.
    const withoutEmail = fixtures();
    withoutEmail.me.capabilities = { ocr: false, connectedApps: false, emailNotices: false };
    for (const [state, broken] of [[withoutEmail, false], [fixtures(), true]] as const) {
      const quiet = open(joined(), state);
      if (broken) quiet.api.fail("GET", /^\/api\/me$/, 503, "unavailable", "busy");
      await screen.findByText("No comments yet.");
      await userEvent.click(screen.getByRole("button", { name: LED_LINE }));
      expect(box()).toHaveAccessibleDescription(new RegExp(`^Sam Rivera will see this the next time they open Resumatic\\. Resumatic doesn’t send email\\. ${KEEP}`));
      quiet.page.unmount();
    }
  });

  it("never shows the owner's reply under “You”, whatever name the owner chose", async () => {
    const threads: CommentThread[] = [
      { target: onLine, quote: LED_LINE, comments: [comment("c1", "coach", "Lead with what it saved."), comment("c2", "owner", "It saved two days a release.")] },
    ];
    open(joined((view) => { view.snapshot.owner = { name: "You" }; }), { ...fixtures(), coachComments: threads });
    const card = await screen.findByRole("article", { name: `On “${LED_LINE}”` });
    expect(within(card).getAllByRole("listitem").map((item) => item.querySelector(".app-thread__byline")!.textContent)).toEqual([
      expect.stringMatching(/^You, \d+ Nov 2026$/),
      expect.stringMatching(/^The owner, \d+ Nov 2026$/),
    ]);
  });

  it("gives other readers, and a copy of documents alone, nothing to choose", async () => {
    for (const reviewer of [undefined, "sign-in", "sign-in-again", "other", "you"] as const) {
      const { api, page } = open(joined((view) => { view.reviewer = reviewer; }));
      await screen.findByText("Sam Rivera", { selector: "h1.app-share__title" });
      expect(screen.getByText(LED_LINE)).toBeInTheDocument();
      expect(screen.queryAllByRole("button", { pressed: false }), String(reviewer)).toEqual([]);
      expect(screen.queryByRole("complementary")).toBeNull();
      expect(screen.queryByRole("heading", { name: "Comments" })).toBeNull();
      expect(document.querySelector(".app-share__main--comments, .app-share__columns, .app-share__pick")).toBeNull();
      // And the page asks for no thread on their behalf.
      expect(api.calls).toEqual([]);
      page.unmount();
    }
    // The copy without the comments is the page as it always was: text to read, in one column.
    const plain = render(<ShareSnapshotContent view={joined()} />);
    expect(plain.container.querySelector("main")!.className).toBe("app-share__main");
    expect(plain.container.querySelectorAll("button, aside, .app-share__columns, .app-share__copy")).toHaveLength(0);
    // A fact is a paragraph of its own words, and a line is its list item's own text.
    expect(plain.container.querySelector(".app-share__facts li > p")!.innerHTML).toBe(LED);
    expect(plain.container.querySelector(".rs-sheet li")!.innerHTML).toBe(LED_LINE);
    plain.unmount();

    // Letters and preparation have no line or fact to name, so there is nothing to comment on.
    const { api } = open(
      joined((view) => {
        view.snapshot.schemaVersion = 3;
        view.snapshot.facts = [];
        view.snapshot.resumes = [];
        view.snapshot.documents = [{ id: "doc-letter", version: 1, kind: "letter", paragraphs: [LED], questions: [], job: null }];
      }),
    );
    expect(await screen.findByText(/^Shared with you until \d+ Nov 2026\. Only Sam Rivera can change it\.$/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open your clients" })).toBeInTheDocument();
    expect(screen.getByText(LED)).toBeInTheDocument();
    expect(screen.queryByText(/You can comment/)).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(api.calls).toEqual([]);
  });

  it("offers to add a copy that has left the list, and comments again once it is back", async () => {
    const { api, state } = open(joined());
    state.coachComments = [{ target: onFact, quote: LED, comments: [comment("c1", "coach", "From before")] }];
    api.fail("GET", /\/comments$/, 404, "not_found", "no such client");
    // The notice the copy shows a coach who hasn't added it, in place of the threads and the form.
    expect(await screen.findByText(/^Sam Rivera named you as their coach\. Add this copy to your client list to comment on it and to open it later without the link\. They’ll see that you added it, and the name on your account\.$/)).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryAllByRole("button", { pressed: false })).toEqual([]);
    expect(screen.queryByText(/Shared with you until/)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Add to my clients" }));
    expect(await screen.findByText(/^Shared with you until /)).toBeInTheDocument();
    expect(await screen.findByText("From before")).toBeInTheDocument();
    expect(api.calls.filter((call) => call.method === "POST")).toEqual([{ method: "POST", path: "/api/coach/clients", body: { grantId: GRANT } }]);

    // The same when the list loses the copy while a comment is being sent or deleted.
    await userEvent.click(screen.getByRole("button", { name: LED_LINE }));
    await userEvent.type(box(), "Written just as the copy left the list");
    api.fail("POST", /\/comments$/, 404, "not_found", "no such client");
    await userEvent.click(form().getByRole("button", { name: "Comment" }));
    expect(await screen.findByRole("button", { name: "Add to my clients" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(state.coachComments.flatMap((held) => held.comments.map((item) => item.body))).toEqual(["From before"]);
  });

  it("reads a 404 from a server without the comment routes as a failure, not as a copy that left the list", async () => {
    const { api, state } = open(joined());
    state.coachComments = [{ target: onFact, quote: LED, comments: [comment("c1", "coach", "Loaded once the routes are back")] }];
    // A Worker from before comments answers every one of these paths so.
    api.fail("GET", /\/comments$/, 404, "not_found", "no such route");
    const aside = within(await screen.findByRole("complementary", { name: "Comments" }));
    expect(await aside.findByRole("alert")).toHaveTextContent("Comments couldn’t be loaded. Check your connection, then try again.");
    // The copy is still in the list, so the page offers no add.
    expect(screen.queryByRole("button", { name: "Add to my clients" })).toBeNull();
    expect(screen.queryByText(/named you as their coach/)).toBeNull();
    expect(screen.getByText(/^Shared with you until /)).toBeInTheDocument();
    await userEvent.click(aside.getByRole("button", { name: "Try again" }));
    expect(await aside.findByText("Loaded once the routes are back")).toBeInTheDocument();

    // The same for a comment sent or deleted: the words stay, and so does the copy's place in the list.
    await userEvent.click(screen.getByRole("button", { name: LED_LINE }));
    await userEvent.type(box(), "Kept through a rollback");
    api.fail("POST", /\/comments$/, 404, "not_found", "no such route");
    await userEvent.click(form().getByRole("button", { name: "Comment" }));
    expect(await form().findByRole("alert")).toHaveTextContent("That didn’t go through. Check your connection, then try again.");
    expect(box()).toHaveValue("Kept through a rollback");
    api.fail("DELETE", /\/comments\//, 404, "not_found", "no such route");
    await userEvent.click(within(thread(LED)).getByRole("button", { name: "Delete" }));
    await userEvent.click(within(thread(LED)).getByRole("button", { name: "Delete comment" }));
    await waitFor(() => expect(api.callsTo("DELETE", /\/comments\//)).toHaveLength(1));
    expect(screen.getByText("Loaded once the routes are back")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add to my clients" })).toBeNull();
    expect(api.calls.filter((call) => call.path === "/api/coach/clients")).toEqual([]);
  });

  it("says a copy of documents alone can be opened later, not commented on, before it is added", async () => {
    open(
      joined((view) => {
        view.reviewer = "you";
        view.snapshot.schemaVersion = 3;
        view.snapshot.facts = [];
        view.snapshot.resumes = [];
        view.snapshot.documents = [{ id: "doc-letter", version: 1, kind: "letter", paragraphs: [LED], questions: [], job: null }];
      }),
    );
    expect(await screen.findByText(/^Sam Rivera named you as their coach\. Add this copy to your client list to open it later without the link\./)).toBeInTheDocument();
  });

  it("drops the threads and the form when the copy has ended, or the session has", async () => {
    const held: CommentThread[] = [{ target: onFact, quote: LED, comments: [comment("c1", "coach", "Before the end")] }];
    const cases: [number, string, string, string][] = [
      [409, "conflict", "this copy has ended; the person who shared it can share again", "This copy has ended. The person who shared it can share again."],
      [409, "conflict", "sign out and in again to use this account as a coach", "Sign out and in again to use this account as a coach."],
      [401, "unauthenticated", "this session was signed out", "Sign in to Resumatic again, then reload this page."],
      [410, "gone", "this vault no longer exists", "This account has been deleted."],
    ];
    for (const [status, code, message, sentence] of cases) {
      // Refused as the threads load.
      const loading = open(joined(), { ...fixtures(), coachComments: structuredClone(held) });
      loading.api.fail("GET", /\/comments$/, status, code, message);
      const aside = within(await screen.findByRole("complementary", { name: "Comments" }));
      expect(await aside.findByRole("alert")).toHaveTextContent(sentence);
      expect(aside.queryByText("Before the end")).toBeNull();
      expect(aside.queryByRole("textbox")).toBeNull();
      expect(aside.queryByRole("button")).toBeNull();
      // The copy is still there to read, as text: nothing on it can be chosen, and the notice no
      // longer says the reader can comment.
      expect(screen.getByText(LED_LINE)).toBeInTheDocument();
      expect(screen.getByText(LED_LINE).closest("button")).toBeNull();
      expect(screen.queryAllByRole("button", { pressed: false })).toEqual([]);
      expect(document.querySelector(".app-share__pick")).toBeNull();
      expect(screen.queryByText(/You can comment/)).toBeNull();
      expect(screen.getByText(/^Shared with you until \d+ Nov 2026\. Only Sam Rivera can change it\.$/)).toBeInTheDocument();
      loading.page.unmount();

      // Refused as a comment is sent: what was on the page goes too.
      const sending = open(joined(), { ...fixtures(), coachComments: structuredClone(held) });
      await screen.findByText("Before the end");
      await userEvent.click(screen.getByRole("button", { name: LED_LINE }));
      await userEvent.type(box(), "One more");
      sending.api.fail("POST", /\/comments$/, status, code, message);
      await userEvent.click(form().getByRole("button", { name: "Comment" }));
      expect(await form().findByRole("alert")).toHaveTextContent(sentence);
      expect(form().queryByText("Before the end")).toBeNull();
      expect(form().queryByRole("textbox")).toBeNull();
      // The line that was chosen is text again, and so is every other.
      expect(screen.queryAllByRole("button", { pressed: true })).toEqual([]);
      expect(screen.queryAllByRole("button", { pressed: false })).toEqual([]);
      expect(screen.getByText(LED_LINE).closest("button")).toBeNull();
      expect(screen.queryByText(/You can comment/)).toBeNull();
      // Nothing more is asked of the server on the reader's behalf.
      const asked = commentCalls(sending.api).length;
      await userEvent.click(screen.getByText(LED_LINE));
      expect(commentCalls(sending.api)).toHaveLength(asked);
      sending.page.unmount();
    }
  });

  it("keeps the words in the box when a comment doesn't go through, and says why when the server does", async () => {
    const { api, state } = open(joined());
    await screen.findByText("No comments yet.");
    await userEvent.click(screen.getByRole("button", { name: LED_LINE }));
    await userEvent.type(box(), "Lead with what it saved.");
    const send = form().getByRole("button", { name: "Comment" });

    // The connection, or the server falling over: the page's own sentence.
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await userEvent.click(send);
    expect(await form().findByRole("alert")).toHaveTextContent("That didn’t go through. Check your connection, then try again.");
    expect(box()).toHaveValue("Lead with what it saved.");
    api.fail("POST", /\/comments$/, 503, "unavailable", "this account is temporarily unavailable during maintenance");
    await userEvent.click(send);
    await waitFor(() => expect(api.callsTo("POST", /\/comments$/)).toHaveLength(1));
    expect(await form().findByRole("alert")).toHaveTextContent("That didn’t go through. Check your connection, then try again.");
    expect(box()).toHaveValue("Lead with what it saved.");

    // A refusal the reader can act on is said in the server's words, set as sentences.
    const refusals: [number, string, string, string][] = [
      [422, "invalid", "write a comment of up to 1,000 characters", "Write a comment of up to 1,000 characters."],
      [422, "invalid", "choose a line or a fact from this copy", "Choose a line or a fact from this copy."],
      [429, "quota", "this copy has as many comments as it can hold", "This copy has as many comments as it can hold."],
      [429, "quota", "you've written a lot of comments on this copy in the last hour; carry on later", "You’ve written a lot of comments on this copy in the last hour. Carry on later."],
      [429, "quota", "this person's account can't hold more comments until they delete some", "This person’s account can’t hold more comments until they delete some."],
    ];
    for (const [status, code, message, sentence] of refusals) {
      api.fail("POST", /\/comments$/, status, code, message);
      await userEvent.click(send);
      await waitFor(() => expect(form().getByRole("alert")).toHaveTextContent(sentence));
      expect(box()).toHaveValue("Lead with what it saved.");
      expect(form().getByRole("textbox", { name: "Comment on the selected line" })).toBeEnabled();
    }
    expect(state.coachComments ?? []).toEqual([]);

    // Sent again, it goes, and the refusal is gone with it.
    await userEvent.click(send);
    expect(await form().findByText("Comment added.")).toBeInTheDocument();
    expect(form().queryByRole("alert")).toBeNull();
    expect(box()).toHaveValue("");
    // Every try carried the same words for the same line.
    expect(new Set(api.callsTo("POST", /\/comments$/).map((call) => JSON.stringify(call.body)))).toEqual(new Set([JSON.stringify({ target: onLine, body: "Lead with what it saved." })]));

    // A comment over the limit isn't sent at all: the counter says by how much.
    await userEvent.click(box());
    await userEvent.paste("x".repeat(1003));
    expect(form().getByText("3 characters over the 1,000 limit")).toBeInTheDocument();
    expect(form().getByRole("button", { name: "Comment" })).toBeDisabled();
  });

  it("says so when the threads can't be loaded, and loads them on another try", async () => {
    const { api, state } = open(joined());
    state.coachComments = [{ target: onFact, quote: LED, comments: [comment("c1", "coach", "Loaded on the second try")] }];
    api.fail("GET", /\/comments$/, 503, "unavailable", "busy");
    const aside = within(await screen.findByRole("complementary", { name: "Comments" }));
    expect(await aside.findByRole("alert")).toHaveTextContent("Comments couldn’t be loaded. Check your connection, then try again.");
    expect(aside.queryByRole("textbox")).toBeNull();
    await userEvent.click(aside.getByRole("button", { name: "Try again" }));
    expect(await aside.findByText("Loaded on the second try")).toBeInTheDocument();
    expect(aside.queryByRole("alert")).toBeNull();
  });

  it("asks before deleting a comment", async () => {
    const { api, state } = open(joined(), {
      ...fixtures(),
      coachComments: [
        { target: onLine, quote: LED_LINE, comments: [comment("c1", "coach", "Lead with what it saved."), comment("c2", "owner", "It saved two days."), comment("c3", "coach", "Then say so.")] },
        { target: onFact, quote: LED, comments: [comment("c4", "coach", "How long did it take?")] },
      ],
    });
    const first = within(await screen.findByRole("article", { name: `On “${LED_LINE}”` })).getAllByRole("listitem")[0]!;
    const start = within(first).getByRole("button", { name: "Delete" });
    // Each Delete says whose comment it is and of when, so several in a thread can be told apart.
    expect(start).toHaveAccessibleDescription(/^You, \d+ Nov 2026$/);
    await userEvent.click(start);
    // Keep changes nothing, and is where the keyboard already is.
    const keep = within(first).getByRole("button", { name: "Keep" });
    expect(keep).toHaveFocus();
    expect(within(first).getByRole("button", { name: "Delete comment" })).toBeInTheDocument();
    await userEvent.click(keep);
    expect(within(first).queryByRole("button", { name: "Delete comment" })).toBeNull();
    expect(within(first).getByRole("button", { name: "Delete" })).toHaveFocus();
    expect(api.callsTo("DELETE", /\/comments\//)).toEqual([]);

    await userEvent.click(within(first).getByRole("button", { name: "Delete" }));
    await userEvent.click(within(first).getByRole("button", { name: "Delete comment" }));
    await waitFor(() => expect(screen.queryByText("Lead with what it saved.")).toBeNull());
    expect(api.callsTo("DELETE", /\/comments\//).map((call) => call.path)).toEqual([`/api/coach/clients/${GRANT}/comments/c1`]);
    // The owner's reply and the coach's other comment stay in the thread.
    expect(within(thread(LED_LINE)).getAllByRole("listitem").map((item) => item.querySelector(".app-thread__body")!.textContent)).toEqual(["It saved two days.", "Then say so."]);
    // A thread whose last comment goes, goes with it.
    const other = within(thread(LED));
    await userEvent.click(other.getByRole("button", { name: "Delete" }));
    await userEvent.click(other.getByRole("button", { name: "Delete comment" }));
    await waitFor(() => expect(screen.queryByRole("article", { name: `On “${LED}”` })).toBeNull());
    expect(state.coachComments!.map((held) => held.comments.map((item) => item.id))).toEqual([["c2", "c3"]]);

    // A delete that doesn't go through leaves the comment where it was, and says so.
    api.fail("DELETE", /\/comments\//, 503, "unavailable", "busy");
    const last = within(thread(LED_LINE)).getAllByRole("listitem")[1]!;
    await userEvent.click(within(last).getByRole("button", { name: "Delete" }));
    await userEvent.click(within(last).getByRole("button", { name: "Delete comment" }));
    expect(await form().findByRole("alert")).toHaveTextContent("That didn’t go through. Check your connection, then try again.");
    expect(screen.getByText("Then say so.")).toBeInTheDocument();
  });

  it("shows markup as the text it is", async () => {
    const hostile = '<img src=x onerror="window.pwned = true"> <b>bold</b> [a link](javascript:alert(1)) <script>window.pwned = true</script>';
    const { state } = open(joined((view) => { view.snapshot.owner = { name: "<i>Sam</i>" }; }), {
      ...fixtures(),
      coachComments: [{ target: onFact, quote: '<u>Led</u> "it"', comments: [comment("c1", "coach", hostile), comment("c2", "owner", "<a href='https://example.test'>click</a>\nline two")] }],
    });
    const card = await screen.findByRole("article", { name: 'On “<u>Led</u> "it"”' });
    expect(within(card).getByText(hostile)).toBeInTheDocument();
    expect(within(card).getByText(/^<i>Sam<\/i>, \d+ Nov 2026$/)).toBeInTheDocument();
    // No element was made from any of it: no image, no link, no script, no emphasis.
    for (const tag of ["img", "a", "script", "b", "i", "u"]) expect(card.querySelector(tag), tag).toBeNull();
    expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
    expect(state.coachComments).toHaveLength(1);
  });

  it("has no axe violations, with a line chosen and a thread open for deleting", async () => {
    open(joined(), {
      ...fixtures(),
      coachComments: [{ target: onLine, quote: LED_LINE, comments: [comment("c1", "coach", "Lead with what it saved."), comment("c2", "owner", "It saved two days.")] }],
    });
    await screen.findByRole("article", { name: `On “${LED_LINE}”` });
    expect(await violations()).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: LED_LINE }));
    await userEvent.type(box(), "And who asked for it.");
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await violations()).toEqual([]);
    // The threads follow the copy in the page, under a heading of their own.
    const aside = screen.getByRole("complementary", { name: "Comments" });
    expect(within(aside).getByRole("heading", { level: 2, name: "Comments" })).toBeInTheDocument();
    expect(aside.compareDocumentPosition(document.querySelector(".app-share__copy")!)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    expect(aside.closest("main")).not.toBeNull();
  });
});

describe("an owner reading what their coach wrote", () => {
  const fromDana = (extra: Partial<OwnerCommentThread> = {}): OwnerCommentThread => ({
    target: { kind: "line", resumeId: "res-ready", version: 2, lineId: "l1" },
    quote: LED_LINE,
    grantId: "sh-1",
    coachEmail: "dana@example.test",
    open: true,
    job: { title: "Platform Engineer", company: "Initrode" },
    comments: [comment("c1", "coach", "Lead with what it saved.", { name: "Dana Okafor", seen: false })],
    ...extra,
  });
  const onAFact = (extra: Partial<OwnerCommentThread> = {}): OwnerCommentThread => ({
    target: { kind: "fact", factId: "fact-migration" },
    quote: LED,
    grantId: "sh-1",
    coachEmail: "dana@example.test",
    open: true,
    comments: [comment("c5", "coach", "How long did it take?", { name: "Dana Okafor", seen: true })],
    ...extra,
  });
  const card = () => screen.getByRole("region", { name: "Comments from your coach" });

  it("shows no card without threads, or against a server without the route", async () => {
    const state = fullVault();
    const api = installFakeApi(state);
    const first = renderWithSession(<SharingCoaches />, state.me);
    await screen.findByRole("heading", { name: "Copies you’ve shared" });
    await waitFor(() => expect(api.callsTo("GET", /^\/api\/shares\/comments$/)).toHaveLength(1));
    expect(screen.queryByRole("heading", { name: "Comments from your coach" })).toBeNull();
    expect(api.callsTo("POST", /\/seen$/)).toEqual([]);
    first.unmount();

    // A server from before comments answers "no such route". That is nothing to show, and no error.
    api.fail("GET", /^\/api\/shares\/comments$/, 404, "not_found", "no such route", false);
    const { ended } = renderWithSession(<SharingCoaches />, state.me);
    await screen.findByRole("heading", { name: "Copies you’ve shared" });
    await waitFor(() => expect(api.callsTo("GET", /^\/api\/shares\/comments$/)).toHaveLength(2));
    await screen.findByText("Dana Okafor");
    expect(screen.queryByRole("heading", { name: "Comments from your coach" })).toBeNull();
    expect(screen.queryByText(/couldn’t be found/)).toBeNull();
    expect(ended).toEqual([]);
  });

  it("says who wrote a thread, what it is about and where to open it", async () => {
    const state = fullVault();
    state.shareComments = [
      fromDana(),
      fromDana({ quote: SUMMARY, target: { kind: "line", resumeId: "res-old", version: 3, lineId: "s" }, job: null, comments: [comment("c4", "coach", "Shorter.", { name: null, seen: true })] }),
      onAFact(),
    ];
    installFakeApi(state);
    renderWithSession(<SharingCoaches />, state.me);
    const section = await screen.findByRole("region", { name: "Comments from your coach" });
    // Directly after the copies shared, and before whatever follows them.
    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings.indexOf("Comments from your coach")).toBe(headings.indexOf("Copies you’ve shared") + 1);
    expect(within(section).getByText("What your coach wrote on copies you shared. These are their words, not your facts: Resumatic never uses a comment to write or check a resume. They stay here after a copy ends, until you delete them.")).toBeInTheDocument();
    expect(within(section).getAllByRole("article").map((thread) => within(thread).getByRole("heading", { level: 3 }).textContent)).toEqual([
      `On “${LED_LINE}”`,
      `On “${SUMMARY}”`,
      `On “${LED}”`,
    ]);

    const line = within(thread(LED_LINE));
    expect(line.getByText(/^Dana Okafor \(dana@example\.test\), \d+ Nov 2026/)).toBeInTheDocument();
    expect(line.getByText("From dana@example.test, on version 2 of your resume for Platform Engineer at Initrode.")).toBeInTheDocument();
    expect(line.getByRole("link", { name: "Open this resume" })).toHaveAttribute("href", "#/resumes/res-ready");
    // A job with no name is a resume, and an account with no name is its address.
    const unnamed = within(thread(SUMMARY));
    expect(unnamed.getByText("From dana@example.test, on version 3 of a resume.")).toBeInTheDocument();
    expect(unnamed.getByRole("link", { name: "Open this resume" })).toHaveAttribute("href", "#/resumes/res-old");
    expect(unnamed.getByText(/^dana@example\.test, \d+ Nov 2026$/)).toBeInTheDocument();
    expect(unnamed.getByRole("textbox", { name: "Reply to dana@example.test" })).toBeInTheDocument();
    const fact = within(thread(LED));
    expect(fact.getByText("From dana@example.test, on a fact you shared.")).toBeInTheDocument();
    expect(fact.getByRole("link", { name: "Open All facts" })).toHaveAttribute("href", "#/facts/all");
    expect(await violations()).toEqual([]);
  });

  it("never bylines a coach's comment as the owner's own, or as the product's, whatever name the coach chose", async () => {
    const state = fixtures();
    state.shareComments = [
      fromDana({
        comments: [
          comment("c1", "coach", "Agreed, I’ll say I led the migration.", { name: "You", seen: true }),
          comment("c2", "owner", "It saved two days."),
          comment("c3", "coach", "From the product, honest.", { name: " resumatic ", seen: true }),
        ],
      }),
    ];
    installFakeApi(state);
    renderWithSession(<OwnerComments />, state.me);
    await screen.findByRole("region", { name: "Comments from your coach" });
    const bylines = within(thread(LED_LINE)).getAllByRole("listitem").map((item) => item.querySelector(".app-thread__byline")!.textContent);
    // Only the owner's own reply is "You". A name that would read as the owner or the product is no name: the address stands.
    expect(bylines).toEqual([
      expect.stringMatching(/^dana@example\.test, \d+ Nov 2026$/),
      expect.stringMatching(/^You, \d+ Nov 2026$/),
      expect.stringMatching(/^dana@example\.test, \d+ Nov 2026$/),
    ]);
    // Nor does the name stand in the page's own sentences.
    expect(screen.getByRole("textbox", { name: "Reply to dana@example.test" })).toHaveAccessibleDescription(/^dana@example\.test sees your reply/);
  });

  it("says on the share form that the coach it names can comment, and nobody else", async () => {
    const state = fullVault();
    installFakeApi(state);
    renderWithSession(<SharingCoaches />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Choose what to share" }));
    expect(await screen.findByRole("textbox", { name: /^Your coach’s sign-in address/ })).toHaveAccessibleDescription(
      "If your coach has a Resumatic account, this lets them keep the copy in their client list, open it without the link and comment on it. Anyone with the link can still read it. Only your coach can comment.",
    );
  });

  it("marks new comments, and tells the server once they have been shown", async () => {
    const state = fixtures();
    state.me.newFromCoach = 2;
    state.shareComments = [
      fromDana({ comments: [comment("c1", "coach", "Lead with what it saved.", { name: "Dana Okafor", seen: false }), comment("c2", "owner", "It saved two days."), comment("c3", "coach", "Then say so.", { name: "Dana Okafor", seen: false })] }),
      onAFact(),
    ];
    const api = installFakeApi(state);
    const refreshed = vi.fn(async () => {});
    function Session({ children }: { children: ReactNode }) {
      const [me, setMe] = useState<Me>(state.me);
      const updateMe = useCallback((change: (current: Me) => Me) => setMe(change), []);
      return <SessionContext value={{ me, updateMe, refreshMe: refreshed, endSession: () => {} }}>{children}</SessionContext>;
    }
    const first = render(<Session><OwnerComments /></Session>);
    await screen.findByRole("region", { name: "Comments from your coach" });
    // New ones are marked on this showing. The owner's own reply and one already seen are not.
    const items = within(thread(LED_LINE)).getAllByRole("listitem");
    expect(items.map((item) => within(item).queryByText("New") !== null)).toEqual([true, false, true]);
    // Something new waits for the person, so it is amber.
    for (const mark of within(thread(LED_LINE)).getAllByText("New")) expect(mark).toHaveClass("rs-mark", "rs-mark--needs-you");
    expect(within(thread(LED)).queryByText("New")).toBeNull();
    // Told once, naming what was shown as new, and the count on the Coaches tab is read again afterwards.
    await waitFor(() => expect(refreshed).toHaveBeenCalledTimes(1));
    expect(api.callsTo("POST", /^\/api\/v2\/shares\/comments\/seen$/).map((call) => call.body)).toEqual([{ ids: ["c1", "c3"] }]);
    expect(state.me.newFromCoach).toBe(0);
    expect(within(thread(LED_LINE)).getAllByText("New")).toHaveLength(2);
    first.unmount();

    // The next showing has nothing new, and tells the server nothing.
    render(<Session><OwnerComments /></Session>);
    await screen.findByRole("region", { name: "Comments from your coach" });
    expect(screen.queryByText("New")).toBeNull();
    expect(api.callsTo("POST", /^\/api\/v2\/shares\/comments\/seen$/)).toHaveLength(1);
    expect(refreshed).toHaveBeenCalledTimes(1);
  });

  it("marks nothing and says nothing when a server from before the named list refuses it", async () => {
    const state = fixtures();
    state.me.newFromCoach = 1;
    state.shareComments = [fromDana()];
    const api = installFakeApi(state);
    // A Worker from before the v2 path answers it so. Nothing falls back to marking everything.
    api.fail("POST", /\/seen$/, 404, "not_found", "no such route");
    const first = renderWithSession(<OwnerComments />, state.me);
    const section = await screen.findByRole("region", { name: "Comments from your coach" });
    await waitFor(() => expect(api.calls.filter((call) => call.path.endsWith("/seen"))).toHaveLength(1));
    expect(api.calls.filter((call) => call.path.endsWith("/seen")).map((call) => call.path)).toEqual(["/api/v2/shares/comments/seen"]);
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(within(section).getByText("New")).toBeInTheDocument();
    expect(state.me.newFromCoach).toBe(1);
    expect(state.shareComments[0]!.comments[0]!.seen).toBe(false);
    first.unmount();
    // The next showing tries again.
    renderWithSession(<OwnerComments />, state.me);
    await screen.findByRole("region", { name: "Comments from your coach" });
    await waitFor(() => expect(state.me.newFromCoach).toBe(0));
    expect(api.callsTo("POST", /^\/api\/v2\/shares\/comments\/seen$/).map((call) => call.body)).toEqual([{ ids: ["c1"] }, { ids: ["c1"] }]);
  });

  it("leaves new a comment written after the list was read", async () => {
    const state = fixtures();
    state.me.newFromCoach = 1;
    state.shareComments = [fromDana()];
    const api = installFakeApi(state);
    // The coach writes again in the moment between the page reading the list and saying what it showed.
    const reading = api.fetch.bind(api);
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const answered = await reading(input, init);
      if (String(input).endsWith("/api/shares/comments") && (init?.method ?? "GET") === "GET")
        state.shareComments![0]!.comments.push(comment("c7", "coach", "Written while the page was open.", { name: "Dana Okafor", seen: false }));
      return answered;
    });
    renderWithSession(<OwnerComments />, state.me);
    await screen.findByRole("region", { name: "Comments from your coach" });
    await waitFor(() => expect(api.callsTo("POST", /^\/api\/v2\/shares\/comments\/seen$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/v2\/shares\/comments\/seen$/)[0]!.body).toEqual({ ids: ["c1"] });
    // It was never on the page, so it is still counted, and still new when the list is next read.
    expect(state.me.newFromCoach).toBe(1);
    expect(state.shareComments[0]!.comments.map((item) => [item.id, item.seen])).toEqual([["c1", true], ["c7", false]]);
  });

  it("sends a reply to the latest coach comment, and shows it under “You”", async () => {
    const state = fixtures();
    state.shareComments = [
      fromDana({ comments: [comment("c1", "coach", "Lead with what it saved.", { name: "Dana Okafor", seen: true }), comment("c2", "owner", "It saved two days."), comment("c3", "coach", "Then say so.", { name: "Dana O.", seen: true })] }),
    ];
    const api = installFakeApi(state);
    renderWithSession(<OwnerComments />, state.me);
    const reply = await screen.findByRole("textbox", { name: "Reply to Dana O." });
    expect(reply).toHaveAccessibleDescription(/^Dana O\. sees your reply when they next open this copy\. Resumatic doesn’t email coaches\. 0 of 1,000 characters$/);
    expect(within(card()).getByRole("button", { name: "Reply" })).toBeDisabled();
    await userEvent.type(reply, "  I will, in the first line.  ");
    await userEvent.click(within(card()).getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(within(thread(LED_LINE)).getAllByRole("listitem")).toHaveLength(4));
    expect(api.callsTo("POST", /\/replies$/).map((call) => [call.path, call.body])).toEqual([["/api/shares/comments/c3/replies", { body: "I will, in the first line." }]]);
    const last = within(thread(LED_LINE)).getAllByRole("listitem")[3]!;
    expect(within(last).getByText(/^You, \d+ Nov 2026$/)).toBeInTheDocument();
    expect(within(last).getByText("I will, in the first line.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Reply to Dana O." })).toHaveValue("");

    // Refusals are said in the server's words, and the reply stays in the box.
    const refusals: [number, string, string, string][] = [
      [404, "not_found", "that comment has been deleted; reload to see the thread as it stands", "That comment has been deleted. Reload to see the thread as it stands."],
      [422, "invalid", "write a comment of up to 1,000 characters", "Write a comment of up to 1,000 characters."],
      [429, "quota", "delete some comments to make room for more", "Delete some comments to make room for more."],
      // The copy closed since the page loaded: the page's own sentence, with the coach's name in it.
      [409, "conflict", "this copy isn't open to your coach any more, so they can't read a reply; share a new copy to carry on", "This copy isn’t open to Dana O. any more, so they can’t read a reply. Share a new copy to carry on."],
    ];
    await userEvent.type(screen.getByRole("textbox", { name: "Reply to Dana O." }), "One more thing");
    for (const [status, code, message, sentence] of refusals) {
      api.fail("POST", /\/replies$/, status, code, message);
      await userEvent.click(within(card()).getByRole("button", { name: "Reply" }));
      await waitFor(() => expect(within(card()).getByRole("alert")).toHaveTextContent(sentence));
      expect(screen.getByRole("textbox", { name: "Reply to Dana O." })).toHaveValue("One more thing");
    }
    expect(state.shareComments[0]!.comments).toHaveLength(4);
  });

  it("puts a sentence in place of the form on a closed thread, and has no form with no coach comment left", async () => {
    const state = fixtures();
    state.shareComments = [
      fromDana({ open: false }),
      onAFact({ open: false, comments: [comment("c5", "coach", "How long did it take?", { name: null, seen: true })] }),
      // Open, but the coach's own comments have been deleted: there is nothing to answer.
      fromDana({ quote: SUMMARY, target: { kind: "line", resumeId: "res-ready", version: 2, lineId: "s" }, comments: [comment("c9", "owner", "Thanks, done.")] }),
    ];
    const api = installFakeApi(state);
    renderWithSession(<OwnerComments />, state.me);
    await screen.findByRole("region", { name: "Comments from your coach" });
    expect(within(thread(LED_LINE)).getByText("This copy isn’t open to Dana Okafor any more, so they can’t read a reply. Share a new copy to carry on.")).toBeInTheDocument();
    expect(within(thread(LED)).getByText("This copy isn’t open to dana@example.test any more, so they can’t read a reply. Share a new copy to carry on.")).toBeInTheDocument();
    expect(within(card()).queryByRole("textbox")).toBeNull();
    expect(within(card()).queryByRole("button", { name: "Reply" })).toBeNull();
    expect(within(thread(SUMMARY)).queryByText(/isn’t open to/)).toBeNull();
    // A closed thread can still be read and deleted from.
    expect(within(thread(LED_LINE)).getByText("Lead with what it saved.")).toBeInTheDocument();
    expect(within(thread(LED_LINE)).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(api.callsTo("POST", /\/replies$/)).toEqual([]);
  });

  it("asks before deleting a comment, the coach's or the owner's own", async () => {
    const state = fixtures();
    state.shareComments = [fromDana({ open: false, comments: [comment("c1", "coach", "Lead with what it saved.", { name: "Dana Okafor", seen: true }), comment("c2", "owner", "It saved two days.")] })];
    const api = installFakeApi(state);
    renderWithSession(<OwnerComments />, state.me);
    await screen.findByRole("region", { name: "Comments from your coach" });
    const [theirs, mine] = within(thread(LED_LINE)).getAllByRole("listitem");
    await userEvent.click(within(theirs!).getByRole("button", { name: "Delete" }));
    await userEvent.click(within(theirs!).getByRole("button", { name: "Keep" }));
    expect(api.callsTo("DELETE", /^\/api\/shares\/comments\//)).toEqual([]);
    expect(within(theirs!).queryByRole("button", { name: "Delete comment" })).toBeNull();

    // A delete that fails says so, and the comment stays.
    api.fail("DELETE", /^\/api\/shares\/comments\//, 503, "unavailable", "busy");
    await userEvent.click(within(mine!).getByRole("button", { name: "Delete" }));
    await userEvent.click(within(mine!).getByRole("button", { name: "Delete comment" }));
    expect(await within(card()).findByRole("alert")).toHaveTextContent("Resumatic is busy right now. Try again in a minute.");
    expect(screen.getByText("It saved two days.")).toBeInTheDocument();

    await userEvent.click(within(mine!).getByRole("button", { name: "Delete" }));
    await userEvent.click(within(mine!).getByRole("button", { name: "Delete comment" }));
    await waitFor(() => expect(screen.queryByText("It saved two days.")).toBeNull());
    await userEvent.click(within(thread(LED_LINE)).getByRole("button", { name: "Delete" }));
    await userEvent.click(within(thread(LED_LINE)).getByRole("button", { name: "Delete comment" }));
    // With its last thread gone the card goes too.
    await waitFor(() => expect(screen.queryByRole("region", { name: "Comments from your coach" })).toBeNull());
    expect(api.callsTo("DELETE", /^\/api\/shares\/comments\//).map((call) => call.path)).toEqual(["/api/shares/comments/c2", "/api/shares/comments/c2", "/api/shares/comments/c1"]);
  });

  it("says so when the threads can't be loaded, and shows a coach's words as text", async () => {
    const state = fixtures();
    const hostile = '<img src=x onerror="window.pwned = true"> **bold** <a href="https://example.test">link</a>';
    state.shareComments = [fromDana({ quote: "<b>Led</b>", comments: [comment("c1", "coach", hostile, { name: "<script>Dana</script>", seen: true })] })];
    const api = installFakeApi(state);
    api.fail("GET", /^\/api\/shares\/comments$/, 503, "unavailable", "busy");
    renderWithSession(<OwnerComments />, state.me);
    const section = await screen.findByRole("region", { name: "Comments from your coach" });
    expect(within(section).getByRole("alert")).toHaveTextContent("Resumatic is busy right now. Try again in a minute.");
    await userEvent.click(within(section).getByRole("button", { name: "Try again" }));
    const shown = await screen.findByRole("article", { name: "On “<b>Led</b>”" });
    expect(within(shown).getByText(hostile)).toBeInTheDocument();
    expect(within(shown).getByText(/^<script>Dana<\/script> \(dana@example\.test\), \d+ Nov 2026$/)).toBeInTheDocument();
    expect(within(shown).getByRole("textbox", { name: "Reply to <script>Dana</script>" })).toBeInTheDocument();
    for (const tag of ["img", "script", "b"]) expect(shown.querySelector(tag), tag).toBeNull();
    // The one link in the thread is the app's own, to the resume.
    expect(within(shown).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["#/resumes/res-ready"]);
    expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
  });
});
