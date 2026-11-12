import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachClient } from "../../src/shared/sharing";
import { copyHeading, ShareSnapshotContent } from "../../src/web/components/ShareSnapshotContent";
import { SharingCoaches } from "../../src/web/pages/sharing/SharingCoaches";
import { CoachClients } from "../../src/web/pages/outside/CoachClients";
import { CoachCopy } from "../../src/web/pages/outside/CoachCopy";
import { VAULT_CHANGED } from "../../src/web/live";
import { ACCOUNT_DELETED_NOTE } from "../../src/web/session";
import { FakeApi, installFakeApi } from "./api-fake";
import { fixtures, fullVault, sharedView } from "./fixtures";
import { renderWithSession } from "./render";

const GRANT = "0653389a-0d6d-4e90-94eb-23cc98b95c19";
const OTHER = "9b2f6c1e-7a40-4d55-8c3b-5e1f0a9d2c77";
const client = (extra: Partial<CoachClient> = {}): CoachClient => ({
  grantId: GRANT, ownerName: "Sam Rivera", addedAt: Date.UTC(2026, 10, 8, 15), expiresAt: Date.UTC(2026, 10, 13, 15),
  active: true, factCount: 6, resumeCount: 1, documentCount: 0, ...extra,
});
const violations = async () => (await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).violations;

afterEach(() => vi.unstubAllGlobals());

describe("a coach's clients", () => {
  it("lists whose copy each is, what it holds and until when, and links each live copy to its page in the app", async () => {
    const state = fixtures();
    state.clients = [client(), client({ grantId: OTHER, ownerName: null, factCount: 0, resumeCount: 2, documentCount: 1 })];
    const api = installFakeApi(state);
    renderWithSession(<CoachClients />, state.me);
    expect(screen.getByRole("heading", { level: 1, name: "Clients" })).toBeInTheDocument();
    expect(screen.getByText("People who shared a copy with you. Each copy is fixed, and each one has an end.")).toBeInTheDocument();
    const list = await screen.findByRole("region", { name: "Your clients" });
    const sam = within(list).getByRole("heading", { level: 3, name: "Sam Rivera" }).closest("li")!;
    expect(within(sam).getByText("6 facts and 1 resume version.")).toBeInTheDocument();
    expect(within(sam).getByText(/^Added \d+ Nov 2026\. The copy ends \d+ Nov 2026\.$/)).toBeInTheDocument();
    // The copy opens on its own page in the app: a link, with nothing asked of the server first.
    expect(within(sam).getByRole("link", { name: "Open Sam Rivera’s copy" })).toHaveAttribute("href", `#/coaching/clients/${GRANT}`);
    expect(within(sam).queryByText("Ended")).toBeNull();
    // A client who left their name off the copy is still a client, told apart by the heading.
    const unnamed = within(list).getByRole("heading", { level: 3, name: "A client who didn’t give their name" }).closest("li")!;
    expect(within(unnamed).getByText("2 resume versions and 1 document.")).toBeInTheDocument();
    const open = within(unnamed).getByRole("link", { name: "Open their copy" });
    expect(open).toHaveAttribute("href", `#/coaching/clients/${OTHER}`);
    expect(open).toHaveAccessibleDescription("A client who didn’t give their name");
    expect(api.callsTo("POST", /^\/api\/coach\/clients\/[^/]+\/open$/)).toEqual([]);
    // Nothing on the page is about an organisation, replies or a job: the list doesn't know them.
    expect(document.body.textContent).not.toMatch(/organisation|repl(y|ies)|For .+ at /i);
    expect(await violations()).toEqual([]);
  });

  it("says a copy has ended, offers nothing to open, and lets the coach take it off the list", async () => {
    const state = fixtures();
    state.clients = [client({ active: false, factCount: 0, resumeCount: 0 })];
    const api = installFakeApi(state);
    renderWithSession(<CoachClients />, state.me);
    const row = (await screen.findByRole("heading", { name: "Sam Rivera" })).closest("li")!;
    expect(within(row).getByText("Ended")).toHaveClass("rs-mark--note");
    expect(within(row).getByText("Their link has expired or been turned off. They can share again at any time.")).toBeInTheDocument();
    expect(within(row).queryByRole("link")).toBeNull();
    expect(within(row).queryByText(/The copy ends/)).toBeNull();
    // Removing asks first, and Keep changes nothing.
    await userEvent.click(within(row).getByRole("button", { name: "Remove Sam Rivera from my list" }));
    await userEvent.click(within(row).getByRole("button", { name: "Keep" }));
    expect(api.callsTo("DELETE", /^\/api\/coach\/clients\//)).toEqual([]);
    await userEvent.click(within(row).getByRole("button", { name: "Remove Sam Rivera from my list" }));
    await userEvent.click(within(row).getByRole("button", { name: "Remove from my list" }));
    expect(await screen.findByText("No clients yet")).toBeInTheDocument();
    expect(api.callsTo("DELETE", /^\/api\/coach\/clients\//)).toHaveLength(1);
    expect(await violations()).toEqual([]);
  });

  it("a session from before coaches had an address says nothing about whether a copy has ended", async () => {
    const state = fixtures();
    // The server can't say whose coach this session is, so it reports every copy as not open.
    state.clients = [client({ active: false, factCount: 0, resumeCount: 0 })];
    const api = installFakeApi(state);
    api.coachNeedsSignIn = true;
    renderWithSession(<CoachClients />, state.me);
    expect(await screen.findByText(/^Sign out and in again to open your clients\u2019 copies\./)).toBeInTheDocument();
    const row = screen.getByRole("heading", { name: "Sam Rivera" }).closest("li")!;
    // That isn't the copy having ended, and the row doesn't say it has, or anything else it can't know.
    expect(within(row).getByText(/^Added \d+ Nov 2026\.$/)).toBeInTheDocument();
    expect(within(row).queryByText("Ended")).toBeNull();
    expect(within(row).queryByText(/expired|turned off|ends/)).toBeNull();
    expect(within(row).queryByText(/fact|resume|fixed copy/i)).toBeNull();
    expect(within(row).queryByRole("link")).toBeNull();
    expect(within(row).queryByText(/./, { selector: ".rs-mark" })).toBeNull();
    expect(within(row).getByRole("button", { name: "Remove Sam Rivera from my list" })).toBeInTheDocument();
  });

  it("explains an empty list with the coach's own sign-in address", async () => {
    const state = fixtures();
    state.me.signInEmail = "dana@example.test";
    installFakeApi(state);
    const first = renderWithSession(<CoachClients />, state.me);
    expect(await screen.findByText("No clients yet")).toBeInTheDocument();
    expect(
      screen.getByText(/When someone names your sign-in address, dana@example\.test, on a copy they share, open their link while signed in and choose Add to\s+my clients\.$/),
    ).toBeInTheDocument();
    // How a client is added, and what a coach can and can't do, beside the list.
    const added = screen.getByRole("region", { name: "How a client is added" });
    expect(within(added).getByText("A client adds you. Nobody can be added from this side.")).toBeInTheDocument();
    expect(within(added).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "They share a copy and name your sign-in address, dana@example.test. It appears here.",
      "Or they send you a link. Open it while signed in and choose Add to my clients.",
    ]);
    const can = screen.getByRole("region", { name: "What you can do with a copy" });
    expect(within(can).getAllByRole("listitem")).toHaveLength(3);
    expect(within(can).getByText("You can’t change a client’s resume, see anything they didn’t choose, or keep a copy after it ends.")).toBeInTheDocument();
    expect(await violations()).toEqual([]);
    first.unmount();
    // A session that doesn't know its address says only that there is one.
    delete state.me.signInEmail;
    renderWithSession(<CoachClients />, state.me);
    expect(await screen.findByText(/When someone names your sign-in address on a copy they share,/)).toBeInTheDocument();
  });
});

describe("naming a coach on a link", () => {
  it("sends the address with the link, and the list says who it names and whether they took it up", async () => {
    const state = fullVault();
    state.shares![1]!.coach = { email: "dana@example.test", name: "Dana Okafor", joinedAt: Date.UTC(2026, 10, 8, 15) };
    state.shares![1]!.revokedAt = null;
    const api = installFakeApi(state);
    renderWithSession(<SharingCoaches />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Choose what to share" }));
    const address = screen.getByRole("textbox", { name: /^Your coach’s sign-in address/ });
    expect(address).toHaveAccessibleDescription(/Anyone with the link can still read it\./);
    await userEvent.click(within(await screen.findByRole("group", { name: /^Confirmed facts/ })).getAllByRole("checkbox")[0]!);
    const create = screen.getByRole("button", { name: "Create share link" });
    // Half an address is told so before anything is sent.
    await userEvent.type(address, "dana@");
    expect(create).toBeDisabled();
    expect(address).toBeInvalid();
    expect(address).toHaveAccessibleDescription("Enter a full email address, or leave this empty.");
    await userEvent.type(address, "example.test ");
    expect(create).toBeEnabled();
    await userEvent.click(create);
    await screen.findByLabelText("Your share link");
    expect(api.callsTo("POST", /^\/api\/shares$/)[0]!.body).toMatchObject({ coachEmail: "dana@example.test" });
    expect((await screen.findByText(/Names dana@example\.test as coach\. Not in their client list yet\./)).closest("li")).not.toBeNull();
    expect(screen.getByText(/Dana Okafor added it to their client list on \d+ Nov 2026, /)).toBeInTheDocument();
  });

  it("leaves the address out when it’s empty", async () => {
    const state = fullVault();
    const api = installFakeApi(state);
    renderWithSession(<SharingCoaches />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Choose what to share" }));
    await userEvent.click(within(await screen.findByRole("group", { name: /^Confirmed facts/ })).getAllByRole("checkbox")[0]!);
    await userEvent.type(screen.getByRole("textbox", { name: /^Your coach’s sign-in address/ }), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Create share link" }));
    await screen.findByLabelText("Your share link");
    expect(api.callsTo("POST", /^\/api\/shares$/)[0]!.body).not.toHaveProperty("coachEmail");
  });
});

describe("the copy's word to its coach", () => {
  it("is said under the heading, and a copy that names nobody says nothing", async () => {
    const view = sharedView();
    const plain = render(<ShareSnapshotContent view={view} />);
    expect(document.querySelector(".app-share__notice")).toBeNull();
    plain.unmount();
    render(<ShareSnapshotContent view={view} notice={<p>For the coach</p>} />);
    const notice = screen.getByText("For the coach");
    // After the heading and what the owner can see, before anything the copy holds.
    expect(notice.compareDocumentPosition(screen.getByRole("heading", { name: copyHeading(view.snapshot) }))).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    expect(notice.compareDocumentPosition(document.querySelector(".app-share__facts, .app-share__resume")!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(await violations()).toEqual([]);
  });
});

describe("a client's copy in the app", () => {
  const LED = "Led the migration of 40 services from Heroku to Kubernetes.";
  const SIGNED_OUT = "Your session has ended. Sign in again to carry on.";
  const ENDED = "this copy has ended; the person who shared it can share again";
  const COPY = /^\/api\/coach\/clients\/[^/]+\/copy$/;
  const COMMENTS = /^\/api\/coach\/clients\/[^/]+\/comments$/;

  /** The copy in a coach's list, read in the app. `hold` keeps each read of the copy after the first waiting until it is let go. */
  function openCopy(state = fixtures(), { hold = false } = {}) {
    state.clients ??= [client()];
    const api = new FakeApi(state);
    const held: (() => void)[] = [];
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (hold && COPY.test(path) && (init?.method ?? "GET") === "GET" && ++reads > 1) await new Promise<void>((resolve) => held.push(resolve));
        return api.fetch(input, init);
      }),
    );
    const page = renderWithSession(<CoachCopy grantId={GRANT} />, state.me);
    return { api, state, held, ...page };
  }

  async function comment(text: string) {
    await userEvent.click(await screen.findByRole("button", { name: LED }));
    await userEvent.type(screen.getByRole("textbox", { name: "Comment on the selected fact" }), text);
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
  }

  it("opens a client's copy in the app with its comments and the form beside it", async () => {
    const { api } = openCopy();
    expect(screen.getByText("Opening your client’s copy…")).toBeInTheDocument();
    const heading = await screen.findByRole("heading", { level: 1, name: copyHeading(sharedView().snapshot) });
    expect(heading).toHaveTextContent("A shared copy");
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Clients" })).toHaveAttribute("href", "#/coaching/clients");
    expect(within(crumbs).getByText("A client who didn’t give their name")).toHaveAttribute("aria-current", "page");
    expect(screen.getByText(/^A copy made \d+ Nov 2026\. It ends \d+ Nov 2026\. Its owner’s own record may have changed since\.$/)).toBeInTheDocument();
    expect(screen.getByText("Shared copy, read only")).toHaveClass("rs-mark--note");
    // The copy and its comments, exactly as at /share, inside the app's page.
    expect(document.querySelector(".app-share.app-share--in-app .app-share__columns")).not.toBeNull();
    const aside = screen.getByRole("complementary", { name: "Comments" });
    expect(await within(aside).findByText("No comments yet.")).toBeInTheDocument();
    await comment("Say what it saved.");
    expect(await within(aside).findByText("Say what it saved.")).toBeInTheDocument();
    expect(api.callsTo("POST", COMMENTS)).toHaveLength(1);
    // Read from the coach's own list and session: no link, no copy's session and no cookie are asked for.
    expect(api.calls.filter((call) => call.path.startsWith("/share") || call.path.endsWith("/open"))).toEqual([]);
    expect(api.callsTo("GET", COPY).map((call) => call.path)).toEqual([`/api/coach/clients/${GRANT}/copy`]);
    expect(await violations()).toEqual([]);
  });

  it("says a copy ended before it opened, and keeps the coach signed in", async () => {
    const state = fixtures();
    state.clients = [client({ active: false })];
    const { ended } = openCopy(state);
    const card = await screen.findByRole("region", { name: "This copy can’t be opened" });
    // The server's own sentence, set as sentences.
    expect(within(card).getByText("This copy has ended. The person who shared it can share again.")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Back to your clients" })).toHaveAttribute("href", "#/coaching/clients");
    expect(within(card).queryByRole("button")).toBeNull();
    expect(ended).toEqual([]);
    expect(await violations()).toEqual([]);
  });

  it("says a copy is no longer in the list, with a way back to Clients", async () => {
    const state = fixtures();
    state.clients = [];
    const { ended } = openCopy(state);
    const card = await screen.findByRole("region", { name: "This copy isn’t in your clients" });
    expect(within(card).getByText("Open the link from your client’s message, then choose Add to my clients.")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Back to your clients" })).toHaveAttribute("href", "#/coaching/clients");
    expect(ended).toEqual([]);
  });

  it("treats a 404 from a server without the route as a failure to retry, not as an unlisted copy", async () => {
    const state = fixtures();
    state.clients = [client()];
    const api = new FakeApi(state);
    api.fail("GET", COPY, 404, "not_found", "no such route");
    vi.stubGlobal("fetch", vi.fn(api.fetch));
    renderWithSession(<CoachCopy grantId={GRANT} />, state.me);
    const failed = await screen.findByRole("alert");
    expect(screen.queryByText(/isn’t in your clients/)).toBeNull();
    await userEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1, name: "A shared copy" })).toBeInTheDocument();
  });

  it("signs the coach out when the copy's read answers 401, and says the account was deleted on 410", async () => {
    for (const [status, code, note] of [[401, "unauthenticated", SIGNED_OUT], [410, "gone", ACCOUNT_DELETED_NOTE]] as const) {
      const state = fixtures();
      state.clients = [client()];
      const api = new FakeApi(state);
      api.fail("GET", COPY, status, code, "this session was signed out");
      vi.stubGlobal("fetch", vi.fn(api.fetch));
      const page = renderWithSession(<CoachCopy grantId={GRANT} />, state.me);
      await waitFor(() => expect(page.ended, String(status)).toEqual([note]));
      expect(screen.queryByText(/this session was signed out/)).toBeNull();
      page.unmount();
    }
  });

  it("signs the coach out when a comment is refused for a session that has ended", async () => {
    const { api, ended } = openCopy();
    await screen.findByRole("heading", { level: 1, name: "A shared copy" });
    api.fail("POST", COMMENTS, 401, "unauthenticated", "this session was signed out");
    api.fail("GET", COPY, 401, "unauthenticated", "this session was signed out");
    await comment("Lead with what it saved.");
    // Reading the copy again is what decides: the session has ended, so the shell is told, never left asking for a reload.
    await waitFor(() => expect(ended).toEqual([SIGNED_OUT]));
    expect(api.callsTo("GET", COPY)).toHaveLength(2);
  });

  it("says the account was deleted when a comment is refused with 410", async () => {
    const { api, ended } = openCopy();
    await screen.findByRole("heading", { level: 1, name: "A shared copy" });
    api.fail("POST", COMMENTS, 410, "gone", "this account has been deleted");
    api.fail("GET", COPY, 410, "gone", "this account has been deleted");
    await comment("Lead with what it saved.");
    await waitFor(() => expect(ended).toEqual([ACCOUNT_DELETED_NOTE]));
  });

  it("puts a refused comment's sentence in place of the threads, then shows the ended card", async () => {
    const { api, state, held, ended } = openCopy(fixtures(), { hold: true });
    await screen.findByRole("heading", { level: 1, name: "A shared copy" });
    // The copy ends while the coach is writing.
    api.fail("POST", COMMENTS, 409, "conflict", ENDED);
    state.clients![0]!.active = false;
    await comment("Lead with what it saved.");
    // While the copy is read again, the refusal stands where the threads were, and nothing can be chosen.
    const aside = screen.getByRole("complementary", { name: "Comments" });
    expect(await within(aside).findByText("This copy has ended. The person who shared it can share again.")).toBeInTheDocument();
    expect(within(aside).queryByRole("textbox")).toBeNull();
    expect(screen.queryAllByRole("button", { pressed: false })).toEqual([]);
    await waitFor(() => expect(held).toHaveLength(1));
    held.shift()!();
    expect(await screen.findByRole("region", { name: "This copy can’t be opened" })).toBeInTheDocument();
    expect(ended).toEqual([]);
  });

  it("keeps the copy, and the refusal in place of the threads, when reading it again still opens it", async () => {
    const { api, ended } = openCopy();
    await screen.findByRole("heading", { level: 1, name: "A shared copy" });
    api.fail("POST", COMMENTS, 409, "conflict", ENDED);
    await comment("Lead with what it saved.");
    await waitFor(() => expect(api.callsTo("GET", COPY)).toHaveLength(2));
    const aside = screen.getByRole("complementary", { name: "Comments" });
    expect(await within(aside).findByText("This copy has ended. The person who shared it can share again.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "A shared copy" })).toBeInTheDocument();
    expect(within(aside).queryByRole("textbox")).toBeNull();
    expect(ended).toEqual([]);
  });

  it("keeps the chosen line and the wording being written when the coach's own vault changes, and reads the copy only when asked", async () => {
    const LINE = "Led the migration of 40 services from Heroku to Kubernetes";
    const { api } = openCopy();
    await screen.findByRole("heading", { level: 1, name: "A shared copy" });
    const aside = within(screen.getByRole("complementary", { name: "Comments" }));
    await aside.findByText("No comments yet.");
    await userEvent.click(screen.getByRole("button", { name: LINE }));
    await userEvent.click(aside.getByRole("button", { name: "Suggest wording" }));
    const box = aside.getByRole("textbox", { name: "Suggested wording for this line" });
    await userEvent.clear(box);
    await userEvent.type(box, "Moved 40 services to Kubernetes");
    // The coach's own upload or run reports a change. It says nothing about a client's copy, which
    // is kept in the client's vault: the copy isn't read again, and its owner isn't told of another read.
    api.fail("GET", COPY, 503, "unavailable", "the service is busy");
    window.dispatchEvent(new Event(VAULT_CHANGED));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.callsTo("GET", COPY)).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "A shared copy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: LINE })).toHaveAttribute("aria-pressed", "true");
    expect(aside.getByRole("textbox", { name: "Suggested wording for this line" })).toHaveValue("Moved 40 services to Kubernetes");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("shows the unlisted card when a comment finds the copy taken off the list", async () => {
    const { api, ended } = openCopy();
    await screen.findByRole("heading", { level: 1, name: "A shared copy" });
    // Another tab took it off the list.
    api.fail("POST", COMMENTS, 404, "not_found", "no such client");
    await comment("Lead with what it saved.");
    expect(await screen.findByRole("region", { name: "This copy isn’t in your clients" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(ended).toEqual([]);
  });
});
