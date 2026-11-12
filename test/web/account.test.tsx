import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Shell } from "../../src/web/components/Shell";
import { AccountPage } from "../../src/web/pages/AccountPage";
import { ACCOUNT_ANCHORS, ACCOUNT_SECTIONS, parseRoute, type AccountSection } from "../../src/web/router";
import { THEME_KEY } from "../../src/web/theme";
import { installFakeApi } from "./api-fake";
import { fixtures, fullVault, type Fixtures } from "./fixtures";
import { renderWithSession } from "./render";

// Account: who the person is on a resume, their plan, notices, theme and data, signing in, and
// deleting the account, last. What leaves the record is under Sharing, and saved answers are under
// Jobs, so Account neither shows nor loads them.

const DELETE_TEXT =
  "This permanently deletes your account and everything in your record: your files, roles, facts, jobs and documents. Copies you’ve shared stop working and connected apps lose access. It can’t be undone, so download your record first if you want to keep it.";
const PLAN_WORDS =
  "A tailored resume, cover letter or interview preparation counts as one document when it finishes. A line check, or suggested wording you accept, counts toward your documents too. Checking your fit never does.";
const HINT = "A resume or document is ready, or a link or an app’s access is about to end";

const text = (element: Element) => element.textContent!.replace(/\s+/g, " ").trim();
const nav = () => screen.getByRole("navigation", { name: "Account sections" });

/** Account in a full vault, once its plan and notices have loaded. */
async function open(change: (state: Fixtures) => void = () => {}, section?: AccountSection) {
  const state = fullVault();
  change(state);
  const api = installFakeApi(state);
  const page = renderWithSession(<AccountPage section={section} />, state.me);
  await screen.findByRole("combobox", { name: "Choose a plan" });
  if (state.me.capabilities?.emailNotices) await screen.findByRole("checkbox", { name: "A coach comments on a copy you shared" });
  return { state, api, page };
}

describe("Account", () => {
  it("switches the theme at once and keeps the choice in this browser", async () => {
    const state = fixtures();
    installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    await userEvent.click(await screen.findByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
    await userEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("follows the device when the choice is Match system", async () => {
    const dark = vi.fn((query: string) => ({ matches: query.includes("dark"), media: query, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal("matchMedia", dark);
    const state = fixtures();
    installFakeApi(state);
    window.localStorage.setItem(THEME_KEY, "light");
    renderWithSession(<AccountPage />, state.me);
    await userEvent.click(await screen.findByRole("radio", { name: "Match system" }));
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
  });

  it("keeps Delete my account disabled until the phrase is typed, and says what goes", async () => {
    const state = fixtures();
    installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    const remove = await screen.findByRole("button", { name: "Delete my account" });
    expect(remove).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/to confirm/), "delete my account");
    expect(remove).toBeEnabled();
    const zone = screen.getByRole("region", { name: "Delete account" });
    expect(zone.querySelector("p")).toHaveTextContent(DELETE_TEXT);
    // The way to keep a copy first leads to the downloads on this page.
    expect(within(zone).getByRole("link", { name: "download your record" })).toHaveAttribute("href", "#/account/data");
  });

  it("signs out with the fixed note once the account is being deleted", async () => {
    const state = fixtures();
    installFakeApi(state);
    const { ended } = renderWithSession(<AccountPage />, state.me);
    await userEvent.type(await screen.findByLabelText(/to confirm/), "Delete my account ");
    await userEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    await waitFor(() =>
      expect(ended).toEqual([
        "Your account is being deleted. You’ve been signed out, and your files, facts, jobs and documents are being removed.",
      ]),
    );
  });

  it("offers your record and your files for download, in the plain words", async () => {
    const state = fixtures();
    installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    const data = (await screen.findByRole("heading", { name: "Your data" })).closest("section")!;
    expect(data).toHaveTextContent("Your record is kept in a database of its own, separate from everyone else’s.");
    const rows = [...data.querySelectorAll(".rs-setting")];
    expect(rows.map((row) => row.querySelector("strong")!.textContent)).toEqual(["Everything", "Your record only"]);
    expect(rows[0]).toHaveTextContent(
      "Your record and your files together, as a ZIP archive. It holds up to 128 files and 100 MiB of data.",
    );
    expect(within(rows[0] as HTMLElement).getByRole("link", { name: "Download your record and files (ZIP)" })).toHaveAttribute("download");
    expect(rows[1]).toHaveTextContent(
      "One JSON file. For a larger record, download this and the individual files from Facts while your account is active.",
    );
    expect(within(rows[1] as HTMLElement).getByRole("link", { name: "Download your record (JSON)" })).toHaveAttribute("download");
    // Where the record is kept can't be chosen yet, and says so in the privacy notice's words.
    const region = screen.getByRole("region", { name: "Where your record is kept" });
    expect(region).toHaveTextContent("it is created in a Cloudflare region near where you first sign in.");
    expect(region.querySelectorAll("select, input, button")).toHaveLength(0);
  });

  it("has the board’s sections in order, with Delete account last", async () => {
    const { page } = await open();
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Profile",
      "Plan",
      "Notifications",
      "More email notices",
      "Appearance",
      "Your data",
      "Where your record is kept",
      "Signing in",
      "Delete account",
    ]);
    expect(screen.getByText("Your contact details, for the top of your resumes. Nothing here is a fact about your work.")).toBeInTheDocument();
    // Delete account is the last thing on the page.
    const sections = document.querySelector(".app-account > .app-stack")!;
    expect(sections.lastElementChild).toBe(screen.getByRole("region", { name: "Delete account" }));
    // Without email notices there is no Notifications section, and the rest keep their order.
    page.unmount();
    await open((state) => (state.me.capabilities!.emailNotices = false));
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Profile",
      "Plan",
      "Appearance",
      "Your data",
      "Where your record is kept",
      "Signing in",
      "Delete account",
    ]);
  });

  it("no longer shows or loads sharing, preferences, the preview, saved answers or apps", async () => {
    const { api } = await open();
    await screen.findByText("Plus, 60 documents each billing period");
    for (const route of [/^\/api\/shares/, /^\/api\/preferences/, /^\/api\/v2\/card-preview/, /^\/api\/saved-answers/, /^\/api\/mcp\/grants/])
      expect(api.callsTo("GET", route), String(route)).toEqual([]);
    for (const heading of ["Share with a coach", "Copies you’ve shared", "Share a new copy", "Comments from your coach", "Job preferences", "What you’re looking for", "Card preview", "What a recruiter would see", "Saved answers", "Connected apps", "Your apps"])
      expect(screen.queryByRole("heading", { name: heading }), heading).toBeNull();
    // Saved answers moved to Jobs, and Account says where in one line.
    expect(screen.getByText(/^Saved answers are under/)).toHaveTextContent("Saved answers are under Jobs › Rules and answers.");
    expect(screen.getByRole("link", { name: "Jobs › Rules and answers" })).toHaveAttribute("href", "#/jobs/rules");
  });

  it("focuses each section its address names, and the page for Notifications where email is off", async () => {
    for (const section of ACCOUNT_SECTIONS) {
      const state = fullVault();
      installFakeApi(state);
      const page = renderWithSession(
        <Shell route={parseRoute(`#/account/${section}`)} title="Account">
          <AccountPage section={section} />
        </Shell>,
        state.me,
      );
      await waitFor(() => expect(document.activeElement, section).toBe(document.getElementById(ACCOUNT_ANCHORS[section])));
      page.unmount();
    }
    const state = fullVault();
    state.me.capabilities!.emailNotices = false;
    installFakeApi(state);
    renderWithSession(
      <Shell route={parseRoute("#/account/notifications")} title="Account">
        <AccountPage section="notifications" />
      </Shell>,
      state.me,
    );
    expect(document.getElementById(ACCOUNT_ANCHORS.notifications)).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("main")));
  });

  it("lists its sections beside them, marking the one its address names, without Notifications where email is off", async () => {
    const marked = () => within(nav()).getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "location").map((link) => link.textContent);
    const { page } = await open(undefined, "plan");
    expect(within(nav()).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Profile", "#/account/profile"],
      ["Plan", "#/account/plan"],
      ["Notifications", "#/account/notifications"],
      ["Appearance", "#/account/appearance"],
      ["Your data", "#/account/data"],
      ["Signing in", "#/account/signing-in"],
    ]);
    expect(marked()).toEqual(["Plan"]);
    page.unmount();

    const plain = await open();
    expect(marked()).toEqual([]);
    plain.page.unmount();

    await open((state) => (state.me.capabilities!.emailNotices = false), "notifications");
    expect(within(nav()).getAllByRole("link").map((link) => link.textContent)).toEqual(["Profile", "Plan", "Appearance", "Your data", "Signing in"]);
    expect(marked()).toEqual([]);
  });

  it("says who is signed in only where the session carries an address", async () => {
    const { page } = await open((state) => (state.me.signInEmail = "sam.rivera@example.com"));
    const signing = screen.getByRole("region", { name: "Signing in" });
    expect(within(signing).getByText("Signed in with Google as sam.rivera@example.com.")).toBeInTheDocument();
    expect(within(signing).getByRole("button", { name: "Sign out" })).toBeEnabled();
    expect(within(signing).getByRole("button", { name: "Sign out everywhere" })).toBeEnabled();
    page.unmount();
    await open((state) => delete state.me.signInEmail);
    expect(text(screen.getByRole("region", { name: "Signing in" }))).not.toMatch(/Signed in with/);
  });

  it("shows the plan words, and checkout or the portal only where billing is on", async () => {
    // On, with no plan yet: plans named as words, and checkout.
    const first = await open();
    const plan = screen.getByRole("region", { name: "Plan" });
    expect(text(plan)).toContain(PLAN_WORDS);
    const plans = within(plan).getByRole("combobox", { name: "Choose a plan" });
    expect(within(plans).getByRole("option", { name: "Plus, 60 documents each billing period" })).toBeInTheDocument();
    expect(within(plan).getByRole("button", { name: "Continue to checkout" })).toBeEnabled();
    expect(within(plan).queryByRole("button", { name: "Manage billing or cancel" })).toBeNull();
    first.page.unmount();

    // On, with a plan: the portal, and no checkout.
    const state = fullVault();
    state.billing!.current = { planId: "plus", status: "active", cancelAtPeriodEnd: false, validUntil: Date.UTC(2026, 11, 1) };
    installFakeApi(state);
    const second = renderWithSession(<AccountPage />, state.me);
    const paid = screen.getByRole("region", { name: "Plan" });
    await within(paid).findByRole("button", { name: "Manage billing or cancel" });
    expect(text(paid)).toContain(PLAN_WORDS);
    expect(within(paid).queryByRole("button", { name: "Continue to checkout" })).toBeNull();
    expect(within(paid).queryByRole("combobox")).toBeNull();
    second.unmount();

    // Off: the words, and neither.
    const closed = fullVault();
    closed.billing = { enabled: false, plans: [], current: null };
    installFakeApi(closed);
    renderWithSession(<AccountPage />, closed.me);
    const off = screen.getByRole("region", { name: "Plan" });
    await within(off).findByText("Plans can’t be bought at the moment. The documents you already have stay available.");
    expect(text(off)).toContain(PLAN_WORDS);
    expect(within(off).queryAllByRole("button", { name: /checkout|Manage billing/ })).toEqual([]);
  });

  it("keeps the More choices row closed and naming what is inside", async () => {
    await open();
    const notices = screen.getByRole("region", { name: "Notifications" });
    const more = notices.querySelector("details.rs-more")!;
    expect(more).not.toBeNull();
    expect((more as HTMLDetailsElement).open).toBe(false);
    expect(text(more.querySelector("summary")!)).toBe(`More choices ${HINT}`);
    expect(more.querySelector(".rs-more__hint")).toHaveTextContent(HINT);
    // It is last in Notifications, after the notices that work, and holds nothing to choose.
    expect(notices.lastElementChild).toBe(more);
    const inside = more.querySelector(".rs-more__body")!;
    expect(inside.querySelector("h2")).toHaveTextContent("More email notices");
    expect(inside.querySelectorAll("input, select, textarea, button")).toHaveLength(0);
  });

  it("uses rs-btn--danger only in Delete account", async () => {
    await open((state) => (state.me.signInEmail = "sam.rivera@example.com"));
    const danger = [...document.querySelectorAll(".rs-btn--danger")];
    expect(danger).toHaveLength(1);
    expect(danger[0]).toHaveTextContent("Delete my account");
    const zone = screen.getByRole("region", { name: "Delete account" });
    expect(zone).toHaveClass("rs-panel", "rs-danger-zone");
    expect(zone).toContainElement(danger[0] as HTMLElement);
  });
});
