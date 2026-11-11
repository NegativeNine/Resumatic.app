import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { EmailNotices as Settings } from "../../src/shared/email-notices";
import { EmailNotices } from "../../src/web/components/EmailNotices";
import { AccountPage } from "../../src/web/pages/AccountPage";
import { installFakeApi } from "./api-fake";
import { fixtures, fullVault, type Fixtures } from "./fixtures";
import { renderWithSession } from "./render";

const ROUTE = /^\/api\/email-notices/;
const ADDRESS = "sam.rivera@example.com";
const LABELS = ["A coach comments on a copy you shared", "A coach suggests wording for a line", "Facts have waited 3 days for review"];
const CONTENT =
  "A notice says only that there’s something new to see, with a link to Resumatic. It never holds a comment, suggested wording, a fact, a job or anyone’s name.";
const REFUSED = "This notice couldn’t be changed. Try again.";

const settings = (extra: Partial<Settings> = {}): Settings => ({ comment: false, suggestion: false, reminder: false, status: "ok", address: ADDRESS, ...extra });

/** Account with the deployment sending notices, or the card by itself. */
function open(change: (state: Fixtures) => void = () => {}, page = false) {
  const state = fixtures();
  state.me.capabilities = { ocr: false, connectedApps: false, emailNotices: true };
  state.me.signInEmail = ADDRESS;
  change(state);
  const api = installFakeApi(state);
  const session = renderWithSession(page ? <AccountPage /> : <EmailNotices />, state.me);
  return { state, api, session };
}

const card = async () => (await screen.findByRole("heading", { name: "Email notices", level: 2 })).closest("section")!;
const box = (name: string) => screen.getByRole("checkbox", { name });

describe("email notices on Account", () => {
  it("hidden when email is off for the deployment", async () => {
    const state = fixtures();
    state.me.capabilities = { ocr: false, connectedApps: false, emailNotices: false };
    const api = installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    await screen.findByRole("heading", { name: "Account", level: 1 });
    await screen.findByRole("button", { name: "Save preferences" });
    expect(screen.queryByRole("heading", { name: "Email notices" })).toBeNull();
    expect(api.callsTo("GET", ROUTE)).toEqual([]);
  });

  it("shows the sign-in address and the fixed sentence", async () => {
    open(undefined, true);
    const section = await card();
    await within(section).findByText(`Notices go to the address you sign in with, ${ADDRESS}. You get at most one of each kind a day.`);
    expect(within(section).getByText(CONTENT)).toBeInTheDocument();
    expect(within(section).getAllByRole("checkbox").map((item) => (item as HTMLInputElement).labels![0]!.textContent)).toEqual(LABELS);
    expect(box(LABELS[2]!)).toHaveAccessibleDescription("Once a week at most, while they wait.");
    for (const name of LABELS) {
      expect(box(name)).not.toBeChecked();
      expect(box(name)).toBeEnabled();
    }
  });

  it("turns one kind on and off", async () => {
    const { api, state } = open();
    await screen.findByText(CONTENT);
    await userEvent.click(box(LABELS[0]!));
    await waitFor(() => expect(box(LABELS[0]!)).toBeChecked());
    expect(api.callsTo("PUT", ROUTE)).toEqual([{ method: "PUT", path: "/api/email-notices/comment", body: { on: true } }]);
    expect(state.emailNotices).toEqual(settings({ comment: true }));
    expect(box(LABELS[1]!)).not.toBeChecked();
    await userEvent.click(box(LABELS[0]!));
    await waitFor(() => expect(box(LABELS[0]!)).not.toBeChecked());
    expect(api.callsTo("PUT", ROUTE).at(-1)).toEqual({ method: "PUT", path: "/api/email-notices/comment", body: { on: false } });
    await userEvent.click(box(LABELS[2]!));
    await waitFor(() => expect(box(LABELS[2]!)).toBeChecked());
    expect(state.emailNotices).toEqual(settings({ reminder: true }));
  });

  it("a session without an address can't turn one on", async () => {
    const { api } = open((state) => {
      delete state.me.signInEmail;
    });
    await screen.findByText(CONTENT);
    expect(screen.getByText("Sign out, then sign in again to turn on email notices.")).toBeInTheDocument();
    expect(screen.queryByText(/Notices go to the address you sign in with/)).toBeNull();
    for (const name of LABELS) expect(box(name)).toBeDisabled();
    await userEvent.click(box(LABELS[0]!));
    expect(api.callsTo("PUT", ROUTE)).toEqual([]);
  });

  it("shows the failing and paused sentences", async () => {
    const FAILING = "The last email notice couldn’t be sent. Your notices stay on, and anything new still shows here when you sign in.";
    const PAUSED = "Email notices are paused because the address you sign in with has changed. Anything new still shows here when you sign in.";
    const failing = open((state) => {
      state.emailNotices = settings({ comment: true, status: "failing" });
    });
    expect(await screen.findByText(FAILING)).toBeInTheDocument();
    expect(screen.queryByText(PAUSED)).toBeNull();
    expect(box(LABELS[0]!)).toBeChecked();
    failing.session.unmount();
    open((state) => {
      state.emailNotices = settings({ comment: true, reminder: true, status: "paused" });
    });
    expect(await screen.findByText(PAUSED)).toBeInTheDocument();
    expect(screen.queryByText(FAILING)).toBeNull();
  });

  it("a refused save shows the form's sentence, never the server's", async () => {
    const { api } = open();
    await screen.findByText(CONTENT);
    for (const [status, code] of [
      [409, "conflict"],
      [422, "invalid"],
      [503, "unavailable"],
      [500, "internal"],
    ] as const) {
      api.fail("PUT", ROUTE, status, code, "SERVER-DETAIL-8121 something the server said");
      await userEvent.click(box(LABELS[1]!));
      expect(await screen.findByText(REFUSED)).toBeInTheDocument();
      expect(screen.queryByText(/SERVER-DETAIL/)).toBeNull();
      // It reads what is saved again, so the box shows what is true.
      await waitFor(() => expect(box(LABELS[1]!)).not.toBeChecked());
    }
    // A save that goes through clears the sentence.
    await userEvent.click(box(LABELS[1]!));
    await waitFor(() => expect(box(LABELS[1]!)).toBeChecked());
    expect(screen.queryByText(REFUSED)).toBeNull();
  });

  it("a session that has ended ends here too, and isn't read again", async () => {
    const { api, session } = open();
    await screen.findByText(CONTENT);
    api.fail("PUT", ROUTE, 401, "unauthenticated", "this session was signed out");
    const reads = api.callsTo("GET", ROUTE).length;
    await userEvent.click(box(LABELS[0]!));
    await waitFor(() => expect(session.ended).toEqual(["Your session has ended. Sign in again to carry on."]));
    expect(screen.queryByText(REFUSED)).toBeNull();
    expect(api.callsTo("GET", ROUTE)).toHaveLength(reads);
  });

  it("a load that fails can be tried again", async () => {
    const state = fixtures();
    state.me.capabilities = { ocr: false, connectedApps: false, emailNotices: true };
    const api = installFakeApi(state);
    api.fail("GET", ROUTE, 500, "internal", "SERVER-DETAIL-4410");
    renderWithSession(<EmailNotices />, state.me);
    await screen.findByRole("button", { name: "Try again" });
    expect(screen.queryByText(/SERVER-DETAIL/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(CONTENT);
  });

  it("is on Account in the full vault", async () => {
    const state = fullVault();
    installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    const section = await card();
    await within(section).findByText(CONTENT);
    expect(box(LABELS[0]!)).toBeChecked();
    expect(box(LABELS[1]!)).not.toBeChecked();
    expect(box(LABELS[2]!)).toBeChecked();
  });
});
