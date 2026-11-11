import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import type { CommentThread, OwnerCommentThread, ShareComment, ShareSuggestion, SharedView, ShareTarget } from "../../src/shared/sharing";
import { VAULT_CHANGED } from "../../src/web/live";
import { AccountPage } from "../../src/web/pages/AccountPage";
import { SharePage } from "../../src/web/pages/SharePage";
import { quotaMessage } from "../../src/web/tailor";
import { FakeApi, installFakeApi } from "./api-fake";
import { fixtures, fullVault, sharedView, type Fixtures } from "./fixtures";
import { renderWithSession } from "./render";

const GRANT = "0653389a-0d6d-4e90-94eb-23cc98b95c19";
// The share page reads which copy it shows from the address as its module loads.
vi.hoisted(() => window.history.replaceState(null, "", "/share?g=0653389a-0d6d-4e90-94eb-23cc98b95c19"));

const violations = async () => (await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).violations;
const SATURDAY = Date.UTC(2026, 10, 8, 15);
const LED_LINE = "Led the migration of 40 services from Heroku to Kubernetes";
const SUMMARY = "Backend engineer who builds and runs Python services on Kubernetes.";
const onLine: ShareTarget = { kind: "line", resumeId: "res-ready", version: 2, lineId: "l1" };
const WORDING = "Moved 40 services from Heroku to Kubernetes, and led the work";
const suggestion = (id: string, state: ShareSuggestion, body = WORDING, extra: Partial<ShareComment> = {}): ShareComment => ({
  id, author: "coach", body, createdAt: SATURDAY, suggestion: state, ...extra,
});

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

/** Opens the share page on a copy, with the copy answered here and everything else by the fake API. */
function open(view: SharedView, state: Fixtures = fixtures()) {
  const api = new FakeApi(state);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/share/snapshot") return new Response(JSON.stringify(view), { status: 200, headers: { "content-type": "application/json" } });
      return api.fetch(input, init);
    }),
  );
  const page = render(<SharePage />);
  return { api, page };
}
const aside = () => within(screen.getByRole("complementary", { name: "Comments" }));
const card = (quote: string) => within(screen.getByRole("article", { name: `On “${quote}”` }));

describe("a coach suggesting wording", () => {
  it("opens the chosen line to edit, and sends only wording that differs, fits and shows on one line", async () => {
    const { api } = open(joined());
    await screen.findByText("No comments yet.");
    // Nothing chosen, or a fact: there is no line to suggest wording for.
    expect(aside().getByRole("button", { name: "Suggest wording" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Python" }));
    expect(aside().getByRole("button", { name: "Suggest wording" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: LED_LINE }));
    await userEvent.click(aside().getByRole("button", { name: "Suggest wording" }));

    const box = aside().getByRole("textbox", { name: "Suggested wording for this line" });
    expect(box).toHaveValue(LED_LINE);
    expect(box).toHaveFocus();
    expect(box).toHaveAccessibleDescription(
      `Sam Rivera decides whether to use it. If they accept, it’s checked against their confirmed facts first. ${LED_LINE.length} of 300 characters`,
    );
    const send = () => aside().getByRole("button", { name: "Send suggestion" });
    // The line's own words are no suggestion.
    expect(send()).toBeDisabled();
    await userEvent.type(box, " ");
    expect(send()).toBeDisabled();
    // Nor are they with a list marker added: the copy prints a line under a role without one.
    await userEvent.clear(box);
    await userEvent.type(box, `• ${LED_LINE}`);
    expect(send()).toBeDisabled();
    await userEvent.clear(box);
    expect(send()).toBeDisabled();
    await userEvent.type(box, "x".repeat(301));
    expect(aside().getByText("1 characters over the 300 limit")).toBeInTheDocument();
    expect(send()).toBeDisabled();
    await userEvent.clear(box);
    await userEvent.type(box, "One line{enter}and a second");
    expect(send()).toBeDisabled();
    await userEvent.clear(box);
    await userEvent.type(box, "Zero​width");
    expect(send()).toBeDisabled();
    // Cancel goes back to the comment form, and nothing was sent.
    await userEvent.click(aside().getByRole("button", { name: "Cancel" }));
    expect(aside().getByRole("textbox", { name: "Comment on the selected line" })).toBeInTheDocument();
    expect(api.callsTo("POST", /\/suggestions$/)).toEqual([]);

    await userEvent.click(aside().getByRole("button", { name: "Suggest wording" }));
    const again = aside().getByRole("textbox", { name: "Suggested wording for this line" });
    expect(again).toHaveValue(LED_LINE);
    await userEvent.clear(again);
    await userEvent.type(again, `  ${WORDING}  `);
    await userEvent.click(send());
    expect(await aside().findByText("Suggestion sent.")).toBeInTheDocument();
    expect(api.callsTo("POST", /\/suggestions$/).map((call) => [call.path, call.body])).toEqual([
      [`/api/coach/clients/${GRANT}/suggestions`, { target: onLine, text: WORDING }],
    ]);
    const thread = card(LED_LINE);
    expect(thread.getByText("Your suggested wording")).toBeInTheDocument();
    expect(thread.getByText("Waiting for Sam Rivera")).toBeInTheDocument();
    expect(thread.getByRole("deletion")).toHaveTextContent(`Line in the copy: ${LED_LINE}`);
    expect(thread.getByRole("insertion")).toHaveTextContent(`Suggested: ${WORDING}`);

    // One waits on the line, so another can't be sent until it is deleted.
    await userEvent.click(aside().getByRole("button", { name: "Suggest wording" }));
    await userEvent.type(aside().getByRole("textbox", { name: "Suggested wording for this line" }), " too");
    expect(aside().getByText("You already have a suggestion waiting on this line. Delete it to suggest another.")).toBeInTheDocument();
    expect(send()).toBeDisabled();
    // Choosing something else on the copy closes the suggestion.
    await userEvent.click(screen.getByRole("button", { name: SUMMARY }));
    expect(aside().queryByRole("textbox", { name: "Suggested wording for this line" })).toBeNull();
    expect(await violations()).toEqual([]);
  });

  it("shows the server's sentence for a refusal, and keeps the words", async () => {
    const { api } = open(joined());
    await screen.findByText("No comments yet.");
    api.fail("POST", /\/suggestions$/, 422, "invalid", "That line isn't in this copy.");
    await userEvent.click(screen.getByRole("button", { name: LED_LINE }));
    await userEvent.click(aside().getByRole("button", { name: "Suggest wording" }));
    const box = aside().getByRole("textbox", { name: "Suggested wording for this line" });
    await userEvent.clear(box);
    await userEvent.type(box, WORDING);
    await userEvent.click(aside().getByRole("button", { name: "Send suggestion" }));
    expect(await aside().findByRole("alert")).toHaveTextContent("That line isn’t in this copy.");
    expect(box).toHaveValue(WORDING);
    // One already waiting, said by the vault: shown here too, not taken for the copy ending.
    api.fail("POST", /\/suggestions$/, 409, "conflict", "You already have a suggestion waiting on this line. Delete it to suggest another.");
    await userEvent.click(aside().getByRole("button", { name: "Send suggestion" }));
    await waitFor(() => expect(aside().getByRole("alert")).toHaveTextContent("You already have a suggestion waiting on this line. Delete it to suggest another."));
    // The copy ending leaves only that sentence.
    api.fail("POST", /\/suggestions$/, 409, "conflict", "this copy has ended; the person who shared it can share again");
    await userEvent.click(aside().getByRole("button", { name: "Send suggestion" }));
    const ended = within(await screen.findByRole("complementary", { name: "Comments" }));
    expect(await ended.findByRole("alert")).toHaveTextContent("This copy has ended. The person who shared it can share again.");
    expect(ended.queryByRole("textbox")).toBeNull();
    expect(ended.queryByRole("button")).toBeNull();
  });

  it("says where each suggestion stands, in one of three ways, and names nobody on a copy without a name", async () => {
    const threads: CommentThread[] = [
      { target: onLine, quote: LED_LINE, comments: [suggestion("s1", { state: "waiting" }), suggestion("s2", { state: "used" }, "Led the move of 40 services"), suggestion("s3", { state: "not_used" }, "Moved services")] },
    ];
    const first = open(joined(), { ...fixtures(), coachComments: structuredClone(threads) });
    const thread = await screen.findByRole("article", { name: `On “${LED_LINE}”` });
    const items = within(thread).getAllByRole("listitem");
    const read = (index: number) => [...items[index]!.querySelectorAll(".rs-mark, .app-suggestion__note")].map((node) => node.textContent);
    expect(read(0)).toEqual(["Waiting for Sam Rivera", "If Sam Rivera accepts, the wording is checked against their confirmed facts before the resume changes."]);
    expect(read(1)).toEqual(["Used", "Sam Rivera used this wording. This copy is fixed, so it still shows the earlier line."]);
    expect(read(2)).toEqual(["Not used", "Sam Rivera didn’t use this suggestion."]);
    // Each can be deleted, whatever its owner did with it.
    expect(within(thread).getAllByRole("button", { name: "Delete" })).toHaveLength(3);
    first.page.unmount();

    open(joined((view) => { view.snapshot.owner = null; }), { ...fixtures(), coachComments: structuredClone(threads) });
    const unnamed = await screen.findByRole("article", { name: `On “${LED_LINE}”` });
    expect(within(unnamed).getByText("Waiting for the owner")).toBeInTheDocument();
    expect(within(unnamed).getByText("If the owner accepts, the wording is checked against their confirmed facts before the resume changes.")).toBeInTheDocument();
    expect(within(unnamed).getByText("The owner used this wording. This copy is fixed, so it still shows the earlier line.")).toBeInTheDocument();
    expect(within(unnamed).getByText("The owner didn’t use this suggestion.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: SUMMARY }));
    await userEvent.click(aside().getByRole("button", { name: "Suggest wording" }));
    expect(aside().getByRole("textbox", { name: "Suggested wording for this line" })).toHaveAccessibleDescription(/^The owner decides whether to use it\./);
  });
});

describe("an owner answering suggested wording", () => {
  const thread = (comments: ShareComment[], extra: Partial<OwnerCommentThread> = {}): OwnerCommentThread => ({
    target: onLine,
    quote: LED_LINE,
    grantId: "sh-1",
    coachEmail: "dana@example.test",
    open: true,
    job: { title: "Platform Engineer", company: "Initrode" },
    comments,
    ...extra,
  });
  const named = (id: string, state: ShareSuggestion, body = WORDING) => suggestion(id, state, body, { name: "Dana Okafor", seen: true });
  /** The thread's item holding the suggestion with this wording. */
  const itemNode = (body: string): HTMLElement => {
    const region = screen.getByRole("region", { name: "Comments from your coach" });
    const found = [...region.querySelectorAll("ins")].find((node) => node.textContent === `Suggested: ${body}`);
    if (!found) throw new Error(`no suggestion reading ${body}`);
    return found.closest("li")!;
  };
  const itemOf = (body: string) => within(itemNode(body));
  const told = (body: string) => [...itemNode(body).querySelectorAll(".rs-mark, .app-suggestion__note")].map((node) => node.textContent);

  it("says where each stands, in its own words, with what can be done", async () => {
    const state = fullVault();
    state.shareComments = [
      thread([
        named("w", { state: "waiting" }, "Waiting wording"),
        named("c", { state: "checking" }, "Checking wording"),
        named("a", { state: "applied", appliedVersion: 4 }, "Applied wording"),
        named("m", { state: "applied" }, "Moved wording"),
        named("n", { state: "not_applied" }, "Refused wording"),
        named("d", { state: "declined" }, "Declined wording"),
        named("o", { state: "stale" }, "Stale wording"),
      ]),
    ];
    installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    await screen.findByRole("region", { name: "Comments from your coach" });
    expect(told("Waiting wording")).toEqual([
      "Waiting for you",
      "If you accept, this wording is checked against the facts this line cites before it replaces the line. A completed check uses one output.",
    ]);
    expect(told("Checking wording")).toEqual(["Checking", "Checking this wording against the cited facts…"]);
    expect(told("Applied wording")).toEqual(["Accepted", "This wording passed the check. It’s in version 4 of your resume."]);
    expect(told("Moved wording")).toEqual(["Accepted", "This wording passed the check and is in your resume."]);
    expect(told("Refused wording")).toEqual(["Not applied", "This wording didn’t pass the check against your confirmed facts, so your resume wasn’t changed."]);
    expect(told("Declined wording")).toEqual(["Declined", "You declined this suggestion."]);
    expect(told("Stale wording")).toEqual(["Out of date", "This line has changed or been removed since the copy was made, so this can’t be applied."]);
    // Who it is from, and the two lines.
    expect(itemOf("Waiting wording").getByText("Suggested wording")).toBeInTheDocument();
    expect(itemOf("Waiting wording").getByText("From Dana Okafor")).toBeInTheDocument();
    expect(itemOf("Waiting wording").getByRole("deletion")).toHaveTextContent(`Line in the copy: ${LED_LINE}`);
    // Waiting: accept or decline, and Accept is off while another check runs. Out of date: decline only.
    expect(itemOf("Waiting wording").getByRole("button", { name: "Accept and check" })).toBeDisabled();
    expect(itemOf("Waiting wording").getByRole("button", { name: "Decline" })).toBeEnabled();
    expect(itemOf("Stale wording").queryByRole("button", { name: "Accept and check" })).toBeNull();
    expect(itemOf("Stale wording").getByRole("button", { name: "Decline" })).toBeEnabled();
    for (const done of ["Checking wording", "Applied wording", "Refused wording", "Declined wording"]) {
      expect(itemOf(done).queryByRole("button", { name: "Accept and check" }), done).toBeNull();
      expect(itemOf(done).queryByRole("button", { name: "Decline" }), done).toBeNull();
    }
    // A card being checked can't be deleted; every other can.
    expect(itemOf("Checking wording").queryByRole("button", { name: "Delete" })).toBeNull();
    for (const other of ["Waiting wording", "Applied wording", "Refused wording", "Declined wording", "Stale wording"])
      expect(itemOf(other).getByRole("button", { name: "Delete" }), other).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  });

  it("accepts once, shows the check, then the version it went into", async () => {
    const state = fullVault();
    state.shareComments = [thread([named("w", { state: "waiting" }, "Waiting wording"), named("x", { state: "waiting" }, "Another wording")])];
    const api = installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    await screen.findByRole("region", { name: "Comments from your coach" });
    await userEvent.click(itemOf("Waiting wording").getByRole("button", { name: "Accept and check" }));
    expect(await itemOf("Waiting wording").findByText("Checking this wording against the cited facts…")).toBeInTheDocument();
    expect(api.callsTo("POST", /\/accept$/).map((call) => call.path)).toEqual(["/api/shares/suggestions/w/accept"]);
    // Every Accept is off while the check runs, and the card being checked has no Delete.
    expect(itemOf("Another wording").getByRole("button", { name: "Accept and check" })).toBeDisabled();
    expect(itemOf("Waiting wording").queryByRole("button", { name: "Delete" })).toBeNull();
    // The check finishes.
    state.shareComments[0]!.comments[0]!.suggestion = { state: "applied", appliedVersion: 3 };
    window.dispatchEvent(new Event(VAULT_CHANGED));
    expect(await itemOf("Waiting wording").findByText("This wording passed the check. It’s in version 3 of your resume.")).toBeInTheDocument();
    expect(itemOf("Another wording").getByRole("button", { name: "Accept and check" })).toBeEnabled();
    expect(api.callsTo("POST", /\/accept$/)).toHaveLength(1);
  });

  it("says why a check ended without a verdict, and that it can be accepted again", async () => {
    const state = fullVault();
    state.shareComments = [
      thread([
        named("c", { state: "waiting", lastCheck: "changed" }, "Changed wording"),
        named("u", { state: "waiting", lastCheck: "unfinished" }, "Unfinished wording"),
        named("s", { state: "checking", startUnconfirmed: true }, "Unconfirmed wording"),
      ]),
    ];
    installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    await screen.findByRole("region", { name: "Comments from your coach" });
    expect(told("Changed wording")).toEqual([
      "Waiting for you",
      "The resume or its facts changed, so this wording wasn’t applied. You can accept again.",
      "If you accept, this wording is checked against the facts this line cites before it replaces the line. A completed check uses one output.",
    ]);
    expect(told("Unfinished wording")[1]).toBe("The check couldn’t be finished, so nothing changed. You can accept again.");
    expect(told("Unconfirmed wording")).toEqual(["Checking", "Your check was requested, but Resumatic can’t confirm yet that it started. Keep this page open."]);
  });

  it("says when no outputs are left, and declines", async () => {
    const state = fullVault();
    state.me.quota = { ...state.me.quota, used: state.me.quota.limit };
    state.shareComments = [thread([named("w", { state: "waiting" }, "Waiting wording")], { coachEmail: "coach@example.test" })];
    state.shareComments[0]!.comments[0]!.name = null;
    const api = installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    await screen.findByRole("region", { name: "Comments from your coach" });
    // A coach without a name is “your coach”.
    expect(itemOf("Waiting wording").getByText("From your coach")).toBeInTheDocument();
    await userEvent.click(itemOf("Waiting wording").getByRole("button", { name: "Accept and check" }));
    expect(await itemOf("Waiting wording").findByRole("alert")).toHaveTextContent(quotaMessage(state.me.quota));
    expect(told("Waiting wording")[0]).toBe("Waiting for you");
    await userEvent.click(itemOf("Waiting wording").getByRole("button", { name: "Decline" }));
    expect(await itemOf("Waiting wording").findByText("You declined this suggestion.")).toBeInTheDocument();
    expect(api.callsTo("POST", /\/decline$/).map((call) => call.path)).toEqual(["/api/shares/suggestions/w/decline"]);
  });
});
