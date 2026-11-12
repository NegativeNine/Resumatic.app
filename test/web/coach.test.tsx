import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachClient } from "../../src/shared/sharing";
import { ShareSnapshotContent } from "../../src/web/components/ShareSnapshotContent";
import { SharingCoaches } from "../../src/web/pages/sharing/SharingCoaches";
import { ClientsPage } from "../../src/web/pages/ClientsPage";
import { installFakeApi } from "./api-fake";
import { fixtures, fullVault, sharedView } from "./fixtures";
import { renderWithSession } from "./render";

const GRANT = "0653389a-0d6d-4e90-94eb-23cc98b95c19";
const client = (extra: Partial<CoachClient> = {}): CoachClient => ({
  grantId: GRANT, ownerName: "Sam Rivera", addedAt: Date.UTC(2026, 10, 8, 15), expiresAt: Date.UTC(2026, 10, 13, 15),
  active: true, factCount: 6, resumeCount: 1, documentCount: 0, ...extra,
});
const violations = async () => (await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).violations;

afterEach(() => vi.unstubAllGlobals());

describe("a coach's clients", () => {
  it("lists whose copy each is, what it holds and until when, and opens one without its link", async () => {
    const state = fixtures();
    state.clients = [client(), client({ grantId: "9b2f6c1e-7a40-4d55-8c3b-5e1f0a9d2c77", ownerName: null, factCount: 0, resumeCount: 2, documentCount: 1 })];
    const api = installFakeApi(state);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    renderWithSession(<ClientsPage />, state.me);
    const sam = (await screen.findByRole("heading", { level: 2, name: "Sam Rivera" })).closest("li")!;
    expect(within(sam).getByText(/^6 facts and 1 resume version, until \d+ Nov 2026\.$/)).toBeInTheDocument();
    expect(within(sam).getByText("Fixed copy")).toBeInTheDocument();
    // A client who left their name off the copy is still a client.
    const unnamed = screen.getByRole("heading", { level: 2, name: "A client who didn’t give their name" }).closest("li")!;
    expect(within(unnamed).getByText(/^2 resume versions and 1 document, until /)).toBeInTheDocument();
    await userEvent.click(within(sam).getByRole("button", { name: "Open Sam Rivera’s copy" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/share?g=${GRANT}`));
    expect(api.callsTo("POST", /^\/api\/coach\/clients\/[^/]+\/open$/)).toHaveLength(1);
    expect(await violations()).toEqual([]);
  });

  it("says a copy has ended, offers nothing to open, and lets the coach take it off the list", async () => {
    const state = fixtures();
    state.clients = [client({ active: false, factCount: 0, resumeCount: 0 })];
    const api = installFakeApi(state);
    renderWithSession(<ClientsPage />, state.me);
    const row = (await screen.findByRole("heading", { name: "Sam Rivera" })).closest("li")!;
    expect(within(row).getByText("Access ended")).toBeInTheDocument();
    expect(within(row).getByText("Their link has expired or been revoked. They can share again at any time.")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /^Open/ })).toBeNull();
    // Removing asks first, and Keep changes nothing.
    await userEvent.click(within(row).getByRole("button", { name: "Remove Sam Rivera from my list" }));
    await userEvent.click(within(row).getByRole("button", { name: "Keep" }));
    expect(api.callsTo("DELETE", /^\/api\/coach\/clients\//)).toEqual([]);
    await userEvent.click(within(row).getByRole("button", { name: "Remove Sam Rivera from my list" }));
    await userEvent.click(within(row).getByRole("button", { name: "Remove from my list" }));
    expect(await screen.findByText("No clients yet")).toBeInTheDocument();
    expect(api.callsTo("DELETE", /^\/api\/coach\/clients\//)).toHaveLength(1);
  });

  it("explains an empty list, and says nothing is known about a copy until a session from before is renewed", async () => {
    const state = fixtures();
    const api = installFakeApi(state);
    const first = renderWithSession(<ClientsPage />, state.me);
    expect(await screen.findByText(/open their link while signed in and add it\s+here/)).toBeInTheDocument();
    expect(screen.getByText(/A client can end your access at any moment\./)).toBeInTheDocument();
    first.unmount();
    // The server can't say whose coach this session is, so it reports every copy as not open.
    state.clients = [client({ active: false, factCount: 0, resumeCount: 0 })];
    api.coachNeedsSignIn = true;
    renderWithSession(<ClientsPage />, state.me);
    expect(await screen.findByText(/^Sign out and in again to open your clients\u2019 copies\./)).toBeInTheDocument();
    const row = screen.getByRole("heading", { name: "Sam Rivera" }).closest("li")!;
    // That isn't the copy having ended, and the row doesn't say it has.
    expect(within(row).getByText(/^Added \d+ Nov 2026\.$/)).toBeInTheDocument();
    expect(within(row).queryByText("Access ended")).toBeNull();
    expect(within(row).queryByText(/expired or been revoked/)).toBeNull();
    expect(within(row).queryByRole("button", { name: /^Open/ })).toBeNull();
    expect(within(row).getByRole("button", { name: "Remove Sam Rivera from my list" })).toBeInTheDocument();
  });

  it("says so when a copy ends between the list loading and the coach opening it, and keeps them signed in", async () => {
    const state = fixtures();
    state.clients = [client()];
    const api = installFakeApi(state);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const { ended } = renderWithSession(<ClientsPage />, state.me);
    api.fail("POST", /^\/api\/coach\/clients\/[^/]+\/open$/, 409, "conflict", "this copy has ended; the person who shared it can share again");
    await userEvent.click(await screen.findByRole("button", { name: "Open Sam Rivera\u2019s copy" }));
    // The server's own words, set as sentences.
    expect(await screen.findByText("This copy has ended. The person who shared it can share again.")).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    expect(ended).toEqual([]);
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
    expect(notice.compareDocumentPosition(screen.getByRole("heading", { name: "Shared career snapshot" }))).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    expect(notice.compareDocumentPosition(document.querySelector(".app-share__facts, .app-share__resume")!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(await violations()).toEqual([]);
  });
});
