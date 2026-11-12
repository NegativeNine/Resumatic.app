import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { McpGrant } from "../../src/shared/mcp";
import type { TodayWaiting } from "../../src/shared/today";
import { Shell } from "../../src/web/components/Shell";
import { formatDate, formatDateTime } from "../../src/web/format";
import { SharingApps } from "../../src/web/pages/sharing/SharingApps";
import { SharingCoaches } from "../../src/web/pages/sharing/SharingCoaches";
import { SharingOverview } from "../../src/web/pages/sharing/SharingOverview";
import { SharingRecruiters } from "../../src/web/pages/sharing/SharingRecruiters";
import { parseRoute } from "../../src/web/router";
import { SCREENS, shownRoute } from "../../src/web/screens";
import { installFakeApi, type FakeApi } from "./api-fake";
import { fixtures, fullVault, type Fixtures } from "./fixtures";
import { renderWithSession } from "./render";

// Sharing's pages. Overview summarises the three ways anything could leave the record from the
// owner's own copies, apps and Today, and never reads a comment thread or marks one seen. Coaches
// holds the copies and the form for a new one, Recruiters what isn't open yet beside what the person
// is looking for, and Connected apps the apps as before.

/** The fixed sentence for a server fault, never the server's words. */
const FAULT = "Something went wrong in Resumatic. Try again in a moment.";
const LATER = 2740124520000;

const suggestions = (count: number): TodayWaiting => ({
  kind: "suggestions", grantId: "sh-1", coachName: "Dana Okafor", coachEmail: "dana.okafor@example.com", count, latest: 1794051720000,
});

const grant = (extra: Partial<McpGrant> & Pick<McpGrant, "id" | "clientName">): McpGrant => ({
  clientId: `client-${extra.id}`, scopes: ["vault:read"], expiresAt: LATER, epoch: "e", gen: 1, createdAt: 1793958120000,
  revokedAt: null, oauthGrantId: `oauth-${extra.id}`, state: "active", ...extra,
});

/**
 * The overview in its shell, over a full vault whose Today holds two new comments and one line of
 * suggested wording. `change` adjusts the vault first.
 */
function overview(change: (state: Fixtures) => void = () => {}, prepare: (api: FakeApi) => void = () => {}) {
  const state = fullVault();
  state.today!.waiting.push(suggestions(1));
  state.today!.counts.sharing = 3;
  change(state);
  const api = installFakeApi(state);
  prepare(api);
  const page = renderWithSession(
    <Shell route={parseRoute("#/sharing")} title="Sharing">
      <SharingOverview />
    </Shell>,
    state.me,
  );
  return { state, api, page };
}

const way = (name: string) => screen.getByRole("region", { name });
const text = (element: Element) => element.textContent!.replace(/\s+/g, " ").trim();
/** Each term of a way's list with what it says now. */
const entries = (section: HTMLElement) =>
  [...section.querySelectorAll("dl dt")].map((term) => [term.textContent, [...term.nextElementSibling!.querySelectorAll(".app-kv__line")].map((line) => line.textContent)]);
/** Waits until the copies, the apps and Today have all been read. */
async function loaded(api: FakeApi) {
  await waitFor(() => expect(document.querySelectorAll(".rs-loading")).toHaveLength(0));
  await waitFor(() => expect(api.callsTo("GET", /^\/api\/v2\/today$/).length).toBeGreaterThan(0));
}

describe("Sharing › Overview", () => {
  it("names the three ways with what each holds now, from the copies, Today and the apps", async () => {
    const { api } = overview();
    await screen.findByText("Claude: Can read your facts and create documents. Access ends " + formatDate(LATER) + ".");
    await screen.findByText("2 new comments and 1 line of suggested wording.");
    await loaded(api);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sharing");
    expect(document.querySelector(".rs-lede")).toHaveTextContent(
      "The three ways anything could leave your record, and what each holds now. Nothing leaves without your choice.",
    );
    expect([...document.querySelectorAll(".app-sharing-ways > section > .app-row > h2, .app-sharing-ways > section > h2")].map((h) => h.textContent)).toEqual([
      "Coaches",
      "Recruiters",
      "Connected apps",
    ]);

    const coaches = way("Coaches");
    expect(within(coaches).getByText("3 waiting for you")).toHaveClass("rs-mark--needs-you");
    expect(coaches).toHaveTextContent("A coach reads a fixed copy you chose. They can comment and suggest wording. Only you can change anything.");
    // Only the copy that is open now: not the expired one, nor the revoked one.
    expect(entries(coaches)).toEqual([
      ["Open now", [`Dana Okafor: 6 facts, 1 resume version and 1 document, until ${formatDate(LATER)}.`]],
      ["Waiting for you", []],
    ]);
    expect(coaches.querySelectorAll("dd")[1]).toHaveTextContent("2 new comments and 1 line of suggested wording.");
    expect(within(coaches).getByRole("link", { name: "Open Coaches" })).toHaveAttribute("href", "#/sharing/coaches");

    const recruiters = way("Recruiters");
    expect(recruiters).toHaveTextContent("No recruiter can find you today. What you’re looking for stays in your record, and nobody is shown it.");
    expect(recruiters.querySelector("dd")).toHaveTextContent(/^Nothing\.$/);
    expect(recruiters.querySelector(".rs-mark")).toBeNull();
    expect(within(recruiters).getByRole("link", { name: "Open Recruiters" })).toHaveAttribute("href", "#/sharing/recruiters");

    const apps = way("Connected apps");
    expect(within(apps).getByText("1 connected")).toHaveClass("rs-mark--backed");
    expect(apps).toHaveTextContent("An app you connect can do only what you allowed, and only until its access runs out.");
    expect(entries(apps)).toEqual([
      ["Open now", [`Claude: Can read your facts and create documents. Access ends ${formatDate(LATER)}.`]],
      ["Waiting", ["Career Notebook hasn’t finished connecting."]],
    ]);
    expect(within(apps).getByRole("link", { name: "Open Connected apps" })).toHaveAttribute("href", "#/sharing/apps");

    // What never leaves, each row with its tick, and the privacy notice under them.
    const never = way("What never leaves your record");
    const rows = [...never.querySelectorAll(".app-q")];
    expect(rows.map((row) => row.querySelector(".app-q__t")!.textContent)).toEqual([
      "Facts you keep private",
      "Your files",
      "The words a fact came from",
      "Your pay floor",
    ]);
    for (const row of rows) expect(row.querySelector(".rs-tick")).toHaveClass("rs-tick--left-out");
    expect(text(rows[0]!)).toContain("They’re left out of every new resume and letter, never put in a shared copy and never shown to a connected app.");
    expect(within(rows[0] as HTMLElement).getByRole("link", { name: "See your facts" })).toHaveAttribute("href", "#/facts/all");
    expect(text(rows[1]!)).toContain("A coach or an app can be given facts and resumes. Neither is given a file you added.");
    expect(within(rows[1] as HTMLElement).getByRole("link", { name: "Your files" })).toHaveAttribute("href", "#/facts/files");
    expect(text(rows[2]!)).toContain("The words in your files can name a person or a client. No coach or app is shown them.");
    expect(text(rows[3]!)).toContain("It stays in your record. Nobody is shown it, and nothing uses it yet.");
    for (const row of rows.slice(2)) expect(within(row as HTMLElement).queryByRole("link")).toBeNull();
    expect(within(never).getByText(/says what sharing and connected apps do with your data\.$/)).toHaveTextContent(
      "The privacy notice says what sharing and connected apps do with your data.",
    );
    expect(within(never).getByRole("link", { name: "privacy notice" })).toHaveAttribute("href", "#/privacy");
  });

  it("counts lines of suggested wording in the plural", async () => {
    overview((state) => {
      state.today!.waiting = state.today!.waiting.filter((item) => item.kind !== "suggestions");
      state.today!.waiting.push(suggestions(2));
    });
    expect(await screen.findByText("2 new comments and 2 lines of suggested wording.")).toBeInTheDocument();
  });

  it("counts suggested wording alone, without comments", async () => {
    overview((state) => {
      state.today!.waiting = state.today!.waiting.filter((item) => item.kind !== "comments");
      state.today!.waiting.push(suggestions(1));
    });
    expect(await screen.findByText("2 lines of suggested wording.")).toBeInTheDocument();
  });

  it("counts what waits exactly as the Coaches tab does, and from the session before Today loads", async () => {
    const { page } = overview((state) => (state.me.newFromCoach = 4));
    // Before Today has answered, both count the session's new comments.
    expect(screen.getByRole("link", { name: "Coaches, 4 waiting for you" })).toBeInTheDocument();
    expect(within(way("Coaches")).getByText("4 waiting for you")).toBeInTheDocument();
    expect(way("Coaches").querySelectorAll("dd")[1]).toHaveTextContent(/^4 new comments\.$/);
    // Once it has, both count Today's.
    await screen.findByRole("link", { name: "Coaches, 3 waiting for you" });
    expect(within(way("Coaches")).getByText("3 waiting for you")).toBeInTheDocument();
    expect(way("Coaches").querySelectorAll("dd")[1]).toHaveTextContent(/^2 new comments and 1 line of suggested wording\.$/);
    page.unmount();

    // Where Today can't be read, both go on counting from the session.
    const state = fullVault();
    state.me.newFromCoach = 1;
    const api = installFakeApi(state);
    api.fail("GET", /^\/api\/v2\/today$/, 503, "unavailable", "busy", false);
    renderWithSession(
      <Shell route={parseRoute("#/sharing")} title="Sharing">
        <SharingOverview />
      </Shell>,
      state.me,
    );
    await waitFor(() => expect(api.callsTo("GET", /^\/api\/v2\/today$/).length).toBeGreaterThan(0));
    await screen.findByText(/^Dana Okafor: /);
    expect(screen.getByRole("link", { name: "Coaches, 1 waiting for you" })).toBeInTheDocument();
    expect(within(way("Coaches")).getByText("1 waiting for you")).toBeInTheDocument();
    expect(way("Coaches").querySelectorAll("dd")[1]).toHaveTextContent(/^1 new comment\.$/);
  });

  it("says nothing is open and nothing waits in an empty record", async () => {
    const state = fixtures();
    state.me.capabilities = { ocr: false, connectedApps: true };
    const api = installFakeApi(state);
    renderWithSession(
      <Shell route={parseRoute("#/sharing")} title="Sharing">
        <SharingOverview />
      </Shell>,
      state.me,
    );
    await screen.findByText("No copy is open.");
    await screen.findByText("No app is connected.");
    await loaded(api);
    expect(entries(way("Coaches"))[0]).toEqual(["Open now", ["No copy is open."]]);
    expect(way("Coaches").querySelectorAll("dd")[1]).toHaveTextContent(/^Nothing\.$/);
    expect(entries(way("Connected apps"))).toEqual([["Open now", ["No app is connected."]]]);
    // No mark counts anything, so no mark says "waiting for you" or "connected".
    expect([...document.querySelectorAll("main .rs-mark")].map((mark) => mark.textContent)).toEqual([]);
    expect(screen.queryByText(/waiting for you/)).toBeNull();
    expect(screen.queryByText(/connected$/)).toBeNull();
  });

  it("names three copies at most, then how many more are open and how many are closed for now", async () => {
    overview((state) => {
      const base = state.shares![0]!;
      state.shares = [
        { ...base, id: "a", label: "For Dana", coach: null },
        { ...base, id: "b", label: null, coach: { email: "lee@example.test", name: "Lee Chen", joinedAt: 1793958120000 } },
        { ...base, id: "c", label: null, coach: { email: "kim@example.test", name: null, joinedAt: null } },
        { ...base, id: "d", label: null, coach: null, factCount: 2, resumeCount: 0, documentCount: 0 },
        { ...base, id: "e", label: "Fifth" },
        { ...base, id: "f", label: "Closed one", available: false },
        { ...base, id: "g", label: "Closed two", available: false },
        { ...base, id: "h", label: "Revoked", revokedAt: 1793698920000 },
      ];
    });
    await screen.findByText(/^For Dana: /);
    const until = formatDate(LATER);
    expect(entries(way("Coaches"))[0]).toEqual([
      "Open now",
      [
        `For Dana: 6 facts, 1 resume version and 1 document, until ${until}.`,
        `Lee Chen: 6 facts, 1 resume version and 1 document, until ${until}.`,
        `kim@example.test: 6 facts, 1 resume version and 1 document, until ${until}.`,
        "and 2 more.",
        "2 copies closed for now.",
      ],
    ]);
    expect(way("Coaches")).not.toHaveTextContent(/Revoked|Closed one|Fifth/);
  });

  it("says a copy that names nobody is a link, and that one closed copy is closed", async () => {
    overview((state) => {
      const base = state.shares![0]!;
      state.shares = [
        { ...base, id: "a", label: null, coach: null, factCount: 2, resumeCount: 0, documentCount: 0 },
        { ...base, id: "b", label: "Closed", available: false },
      ];
    });
    expect(await screen.findByText(`A link: 2 facts, until ${formatDate(LATER)}.`)).toBeInTheDocument();
    expect(screen.getByText("1 copy closed for now.")).toBeInTheDocument();
  });

  it("lists only active apps as connected, and a pending one as not finished", async () => {
    const { state } = overview((state) => {
      state.mcpGrants = [
        grant({ id: "g-active", clientName: "Active Tool", scopes: ["vault:read", "vault:jobs"] }),
        grant({ id: "g-pending", clientName: "Half Tool", state: "pending", oauthGrantId: null }),
        grant({ id: "g-expired", clientName: "Expired Tool", expiresAt: 1793958120000 }),
        grant({ id: "g-revoked", clientName: "Revoked Tool", revokedAt: 1793958120000, state: "revoked" }),
        // Revoked and expired, and still marked pending: its access has ended all the same.
        grant({ id: "g-ended", clientName: "Ended Tool", state: "pending", revokedAt: 1793958120000 }),
      ];
    });
    const apps = way("Connected apps");
    await within(apps).findByText("1 connected");
    expect(within(apps).getAllByText(/hasn’t finished connecting\.$/)).toHaveLength(1);
    expect(entries(apps)).toEqual([
      ["Open now", [`Active Tool: Can read your facts and saved jobs, and add jobs. Access ends ${formatDate(LATER)}.`]],
      ["Waiting", ["Half Tool hasn’t finished connecting."]],
    ]);
    for (const name of ["Expired Tool", "Revoked Tool", "Ended Tool"]) expect(apps).not.toHaveTextContent(name);
    expect(state.mcpGrants).toHaveLength(5);
  });

  it("never asks for the apps where connected apps are off, and says no app can reach the record", async () => {
    const { api } = overview((state) => (state.me.capabilities!.connectedApps = false));
    await screen.findByText(/^Dana Okafor: /);
    await loaded(api);
    const apps = way("Connected apps");
    expect(apps).toHaveTextContent("Connected apps aren’t turned on here, so no app can reach your record.");
    expect(within(apps).queryByRole("link")).toBeNull();
    expect(apps.querySelector(".rs-mark")).toBeNull();
    expect(api.callsTo("GET", /mcp\/grants/)).toEqual([]);
    // Nowhere on the page, the tabs included, leads to it.
    expect(document.querySelector('a[href="#/sharing/apps"]')).toBeNull();
  });

  it("says no recruiter can find you, and reads neither the preferences nor the preview", async () => {
    const { api } = overview();
    await screen.findByText(/^Dana Okafor: /);
    await loaded(api);
    expect(way("Recruiters")).toHaveTextContent("No recruiter can find you today.");
    expect(api.callsTo("GET", /^\/api\/preferences/)).toEqual([]);
    expect(api.callsTo("GET", /^\/api\/v2\/card-preview/)).toEqual([]);
  });

  it("marks no comment seen and reads no thread", async () => {
    const { api } = overview((state) => {
      state.me.newFromCoach = 2;
      state.shareComments = [
        {
          target: { kind: "fact", factId: "fact-migration" },
          quote: "Led the migration of 40 services from Heroku to Kubernetes.",
          grantId: "sh-1",
          coachEmail: "dana@example.test",
          open: true,
          comments: [{ id: "c1", author: "coach", body: "Lead with what it saved.", createdAt: 1794051720000, name: "Dana Okafor", seen: false }],
        },
      ];
    });
    await screen.findByText("2 new comments and 1 line of suggested wording.");
    await loaded(api);
    expect(api.callsTo("GET", /^\/api\/shares\/comments/)).toEqual([]);
    expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
    expect(screen.queryByText("Lead with what it saved.")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Comments from your coach" })).toBeNull();
  });

  it("shows a fixed sentence and a retry when the copies can't be loaded, never the server's words", async () => {
    overview(undefined, (api) => api.fail("GET", /^\/api\/shares$/, 500, "internal", "SQLITE_BUSY in shares at 0x7f"));
    const coaches = way("Coaches");
    const alert = await within(coaches).findByRole("alert");
    expect(alert).toHaveTextContent(FAULT);
    expect(document.body.textContent).not.toMatch(/SQLITE|0x7f/);
    // The other ways are there all the same, and Today's count still reads.
    await within(way("Connected apps")).findByText("1 connected");
    expect(way("Recruiters")).toHaveTextContent("Nothing.");
    await within(coaches).findByText("2 new comments and 1 line of suggested wording.");
    // Trying again reads the copies again.
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await within(coaches).findByText(/^Dana Okafor: /)).toBeInTheDocument();
    expect(within(coaches).queryByRole("alert")).toBeNull();
  });

  it("shows a fixed sentence and a retry when the apps can't be loaded, never the server's words", async () => {
    overview(undefined, (api) => api.fail("GET", /^\/api\/mcp\/grants$/, 500, "internal", "oauth KV exploded: token=abc"));
    const apps = way("Connected apps");
    const alert = await within(apps).findByRole("alert");
    expect(alert).toHaveTextContent(FAULT);
    expect(document.body.textContent).not.toMatch(/exploded|token=/);
    expect(apps.querySelector(".rs-mark")).toBeNull();
    await within(way("Coaches")).findByText(/^Dana Okafor: /);
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await within(apps).findByText("1 connected")).toBeInTheDocument();
  });

  it("shows an app's and a coach's chosen name as text", async () => {
    const MARKUP_APP = `<img src=x onerror="alert(1)">Evil <b>App</b>`;
    const MARKUP_COACH = `<script>alert(2)</script>You`;
    overview((state) => {
      state.mcpGrants = [grant({ id: "g-x", clientName: MARKUP_APP }), grant({ id: "g-y", clientName: `${MARKUP_APP} 2`, state: "pending" })];
      state.shares = [{ ...state.shares![0]!, label: null, coach: { email: "coach@example.test", name: MARKUP_COACH, joinedAt: 1793958120000 } }];
    });
    const apps = way("Connected apps");
    expect(await within(apps).findByText(`${MARKUP_APP}: Can read your facts. Access ends ${formatDate(LATER)}.`)).toBeInTheDocument();
    expect(within(apps).getByText(`${MARKUP_APP} 2 hasn’t finished connecting.`)).toBeInTheDocument();
    const coaches = way("Coaches");
    expect(await within(coaches).findByText(`${MARKUP_COACH}: 6 facts, 1 resume version and 1 document, until ${formatDate(LATER)}.`)).toBeInTheDocument();
    // Nothing they wrote became an element, and a coach who calls themselves "You" is named as they wrote it.
    expect(document.querySelectorAll("main img, main script, main b")).toHaveLength(0);
    expect(within(coaches).queryByText(/^You:/)).toBeNull();
  });
});

describe("Sharing › Coaches", () => {
  it("counts what a copy holds in plain words, and marks its state", async () => {
    const state = fullVault();
    installFakeApi(state);
    renderWithSession(<SharingCoaches />, state.me);
    // A link with a label goes by it, and says what it holds underneath.
    const active = (await screen.findByText("Dana Okafor")).closest("li")!;
    expect(within(active).getByText("Active")).toBeInTheDocument();
    expect(within(active).getByRole("button", { name: "Revoke link" })).toBeEnabled();
    const shares = state.shares!;
    const opened = shares[0]!.lastReadAt!;
    expect(active.querySelector(".rs-setting__text > span")!.textContent).toMatch(
      new RegExp(`^6 facts, 1 resume version and 1 document\\. Created .+\\. Expires .+\\. Last opened ${formatDateTime(opened)}\\.$`),
    );
    // A copy with no resumes doesn't mention them.
    const expired = screen.getByText("3 facts").closest("li")!;
    expect(within(expired).getByText("Expired")).toBeInTheDocument();
    expect(within(expired).queryByRole("button")).toBeNull();
    expect(expired.querySelector(".rs-setting__text > span")!.textContent).toMatch(/^Created .+\. Expired .+\. Never opened\.$/);
    const revoked = screen.getByText("12 facts and 2 resume versions").closest("li")!;
    expect(within(revoked).getByText("Revoked")).toBeInTheDocument();
    expect(revoked.textContent).toContain(`Last opened ${formatDateTime(shares[2]!.lastReadAt!)}.`);
  });

  it("says a link hasn’t been opened only when the server keeps that reading", async () => {
    const state = fullVault();
    const [first, second, third] = state.shares!;
    first!.lastReadAt = null;
    delete second!.lastReadAt;
    delete third!.lastReadAt;
    installFakeApi(state);
    renderWithSession(<SharingCoaches />, state.me);
    const active = (await screen.findByText("Dana Okafor")).closest("li")!;
    expect(active.textContent).toContain("Not opened yet.");
    for (const text of ["3 facts", "12 facts and 2 resume versions"]) {
      const row = screen.getByText(text).closest("li")!;
      expect(row.textContent).not.toMatch(/opened/i);
    }
  });

  it("asks who a link is for and what the copy should say, and sends exactly that", async () => {
    const state = fullVault();
    const api = installFakeApi(state);
    renderWithSession(<SharingCoaches />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Choose what to share" }));
    const facts = await screen.findByRole("group", { name: /Confirmed facts/ });
    const name = screen.getByRole("checkbox", { name: "Put my name at the top of the copy" });
    const jobs = screen.getByRole("checkbox", { name: "Say which job each resume and document is for" });
    // The name is offered; where someone is applying is theirs to add, and only a resume has a job.
    expect(name).toBeChecked();
    expect(jobs).not.toBeChecked();
    expect(jobs).toBeDisabled();
    expect(jobs).toHaveAccessibleDescription(/Choose a resume or a document first/);
    const fact = within(facts).getAllByRole("checkbox")[0]!;
    await userEvent.click(fact);
    const label = screen.getByRole("textbox", { name: /^Who it’s for/ });
    expect(label).toHaveAttribute("maxlength", "80");
    expect(label).toHaveAccessibleDescription(/The reader doesn’t see it/);
    await userEvent.type(label, "  Dana Okafor ");
    await userEvent.click(name);
    await userEvent.click(screen.getByRole("button", { name: "Create share link" }));
    expect(await screen.findByLabelText("Your share link")).toHaveValue("https://resumatic.test/share#synthetic-share-new-1");
    const sent = api.callsTo("POST", /^\/api\/shares$/)[0]!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ resumes: [], label: "Dana Okafor", showName: false, showJobs: false });
    expect(sent.factIds).toHaveLength(1);
    // The new link heads the list under its label, not opened yet.
    const row = (await screen.findAllByText("Dana Okafor"))[0]!.closest("li")!;
    expect(row.textContent).toContain("1 fact. Created");
    expect(row.textContent).toContain("Not opened yet.");
  });

  it("offers finished cover letters and interview preparation, and sends the ones chosen", async () => {
    const state = fullVault();
    const api = installFakeApi(state);
    renderWithSession(<SharingCoaches />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Choose what to share" }));
    const group = await screen.findByRole("group", { name: /^Cover letters and interview preparation \(0 selected, up to 20\)/ });
    // Finished letters and preparation only: not gap questions, nor one that failed or is still running.
    expect(within(group).getAllByRole("checkbox")).toHaveLength(2);
    const letter = within(group).getByRole("checkbox", { name: /^Cover letter for Platform Engineer at Litware, / });
    expect(within(group).getByRole("checkbox", { name: /^Interview preparation for Platform Engineer at Litware, / })).toBeEnabled();
    const jobs = screen.getByRole("checkbox", { name: "Say which job each resume and document is for" });
    expect(jobs).toBeDisabled();
    expect(jobs).toHaveAccessibleDescription(/Choose a resume or a document first/);
    const create = screen.getByRole("button", { name: "Create share link" });
    expect(create).toBeDisabled();
    await userEvent.click(letter);
    expect(screen.getByRole("group", { name: /\(1 selected, up to 20\)/ })).toBe(group);
    // A document was written for a job too, so it can say which.
    expect(jobs).toBeEnabled();
    await userEvent.click(jobs);
    await userEvent.click(create);
    await screen.findByLabelText("Your share link");
    expect(api.callsTo("POST", /^\/api\/shares$/)[0]!.body).toMatchObject({
      factIds: [], resumes: [], documents: [{ id: "doc-letter", version: 1 }], showName: true, showJobs: true,
    });
    expect((await screen.findByText("1 document")).closest("li")!.textContent).toContain("Not opened yet.");
  });

  it("won’t offer a document whose sentences can’t be checked again, and says what to do", async () => {
    const state = fullVault();
    const api = installFakeApi(state);
    api.unshareable.add("doc-prep");
    renderWithSession(<SharingCoaches />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Choose what to share" }));
    const group = await screen.findByRole("group", { name: /^Cover letters and interview preparation/ });
    const preparation = within(group).getByRole("checkbox", { name: /^Interview preparation for Platform Engineer at Litware, / });
    expect(preparation).toBeDisabled();
    expect(preparation.closest("li")!.textContent).toContain("Written before documents could be shared. Write a new one to share it.");
    expect(within(group).getByRole("checkbox", { name: /^Cover letter for/ })).toBeEnabled();
  });

  it("doesn’t offer a fact you keep private for sharing, and says that some aren’t listed", async () => {
    const state = fullVault();
    const marked = state.facts.find((fact) => fact.id === "fact-pipeline")!;
    marked.sensitive = true;
    const api = installFakeApi(state);
    renderWithSession(<SharingCoaches />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Choose what to share" }));
    const facts = await screen.findByRole("group", { name: /^Confirmed facts/ });
    expect(within(facts).getByText("Facts you keep private aren’t listed.")).toBeInTheDocument();
    expect(within(facts).queryByRole("checkbox", { name: marked.text })).toBeNull();
    // The other confirmed facts are all there to choose, and only they can be sent.
    const offered = within(facts).getAllByRole("checkbox");
    expect(offered).toHaveLength(state.facts.filter((fact) => fact.state === "confirmed" && !fact.sensitive).length);
    for (const box of offered) await userEvent.click(box);
    await userEvent.click(screen.getByRole("button", { name: "Create share link" }));
    await screen.findByLabelText("Your share link");
    const sent = api.callsTo("POST", /^\/api\/shares$/)[0]!.body as { factIds: string[] };
    expect(sent.factIds).toHaveLength(offered.length);
    expect(sent.factIds).not.toContain(marked.id);
  });

  it("says nothing about private facts in the form when none is kept private", async () => {
    const state = fullVault();
    installFakeApi(state);
    renderWithSession(<SharingCoaches />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Choose what to share" }));
    const facts = await screen.findByRole("group", { name: /^Confirmed facts/ });
    // Nothing in the form for a new copy says a private fact was left out.
    expect(within(facts.closest("section")!).queryByText(/private/)).toBeNull();
  });

  it("won’t offer a document that uses a fact you keep private, and says to create a new one", async () => {
    const state = fullVault();
    const api = installFakeApi(state);
    api.usesSensitive.add("doc-letter");
    api.unshareable.add("doc-prep");
    renderWithSession(<SharingCoaches />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Choose what to share" }));
    const group = await screen.findByRole("group", { name: /^Cover letters and interview preparation/ });
    const letter = within(group).getByRole("checkbox", { name: /^Cover letter for Platform Engineer at Litware, / });
    expect(letter).toBeDisabled();
    expect(letter.closest("li")!.textContent).toMatch(/\. Uses a fact you keep private\. Create a new one to share it\.$/);
    // Each document gives its own reason: the other was written before documents could be shared.
    const preparation = within(group).getByRole("checkbox", { name: /^Interview preparation for/ });
    expect(preparation.closest("li")!.textContent).toMatch(/\. Written before documents could be shared\. Write a new one to share it\.$/);
    expect(preparation.closest("li")!.textContent).not.toContain("private");
  });

  it("says a closed link stays closed while a fact it holds is kept private", async () => {
    const state = fullVault();
    state.shares![0]!.available = false;
    installFakeApi(state);
    renderWithSession(<SharingCoaches />, state.me);
    const closed = (await screen.findByText("Dana Okafor")).closest("li")!;
    expect(within(closed).getByRole("status")).toHaveTextContent(
      "This link is currently unavailable. If it includes a resume, review that version before creating a new link. If it holds a fact you keep private, it stays closed while you keep it private. You can still revoke this one.",
    );
    expect(within(closed).queryByText("Active")).toBeNull();
    expect(within(closed).getByRole("button", { name: "Revoke link" })).toBeEnabled();
  });

  it("has no documents to offer against a server without the list, and says so when the list fails", async () => {
    const state = fullVault();
    const api = installFakeApi(state);
    api.fail("GET", /^\/api\/documents$/, 404, "not_found", "no such route");
    renderWithSession(<SharingCoaches />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Choose what to share" }));
    const group = await screen.findByRole("group", { name: /^Cover letters and interview preparation/ });
    expect(within(group).getByText("You have no finished cover letters or interview preparation yet.")).toBeInTheDocument();
    // The rest of the form is there to use.
    expect(within(screen.getByRole("group", { name: /^Confirmed facts/ })).getAllByRole("checkbox").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Close selection" }));
    api.fail("GET", /^\/api\/documents$/, 503, "unavailable", "busy");
    await userEvent.click(screen.getByRole("button", { name: "Choose what to share" }));
    expect(await screen.findByText("Resumatic is busy right now. Try again in a minute.")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /^Cover letters/ })).toBeNull();
  });

  it("offers the job names once a resume is chosen, and leaves the label out when it’s empty", async () => {
    const state = fullVault();
    const api = installFakeApi(state);
    renderWithSession(<SharingCoaches />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Choose what to share" }));
    const resumes = await screen.findByRole("group", { name: /Saved resume versions/ });
    await userEvent.click(within(resumes).getAllByRole("checkbox")[0]!);
    const jobs = screen.getByRole("checkbox", { name: "Say which job each resume and document is for" });
    await waitFor(() => expect(jobs).toBeEnabled());
    expect(jobs).not.toBeChecked();
    expect(jobs).toHaveAccessibleDescription(/Leave it off to keep where you’re applying to yourself/);
    await userEvent.click(jobs);
    await userEvent.type(screen.getByRole("textbox", { name: /^Who it’s for/ }), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Create share link" }));
    await screen.findByLabelText("Your share link");
    const sent = api.callsTo("POST", /^\/api\/shares$/)[0]!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ factIds: [], showName: true, showJobs: true });
    expect(sent.resumes).toHaveLength(1);
    expect(sent).not.toHaveProperty("label");
  });

  it("lays out the list, the comments and live access, then the form", async () => {
    const state = fullVault();
    state.shareComments = [
      {
        target: { kind: "fact", factId: "fact-migration" },
        quote: "Led the migration of 40 services from Heroku to Kubernetes.",
        grantId: "sh-1",
        coachEmail: "dana@example.test",
        open: true,
        comments: [{ id: "c1", author: "coach", body: "How long did it take?", createdAt: 1794051720000, name: "Dana Okafor", seen: true }],
      },
    ];
    installFakeApi(state);
    renderWithSession(<SharingCoaches />, state.me);
    await screen.findByRole("region", { name: "Comments from your coach" });
    expect(document.querySelector(".rs-lede")).toHaveTextContent(
      "Share a fixed copy with someone who’s helping you. They can read it and comment on it. Only you can change your resume.",
    );
    const columns = [...document.querySelector(".app-sharing-cols")!.children];
    expect(columns.map((column) => [...column.querySelectorAll("h2")].map((heading) => heading.textContent))).toEqual([
      ["Copies you’ve shared", "Comments from your coach", "Live access"],
      ["Share a new copy"],
    ]);
    const form = screen.getByRole("region", { name: "Share a new copy" });
    expect(within(form).getByText("The copy is made now and doesn’t change afterwards.")).toBeInTheDocument();
    // The form opens on request, so the page doesn't read every fact, job and document on each visit.
    expect(within(form).getByRole("button", { name: "Choose what to share" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: /^Confirmed facts/ })).toBeNull();
  });

  it("clears the one-time link when its copy is revoked from the list", async () => {
    const state = fullVault();
    const api = installFakeApi(state);
    renderWithSession(<SharingCoaches />, state.me);
    await userEvent.click(await screen.findByRole("button", { name: "Choose what to share" }));
    await userEvent.click(within(await screen.findByRole("group", { name: /^Confirmed facts/ })).getAllByRole("checkbox")[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Create share link" }));
    const link = await screen.findByLabelText("Your share link");
    // The hint names where the copy is listed, which is no longer below it.
    expect(link).toHaveAccessibleDescription(
      "Copy this link now. It’s shown only once. You can revoke it under Copies you’ve shared at any time.",
    );
    const list = screen.getByRole("region", { name: "Copies you’ve shared" });
    const fresh = (await within(list).findByText("1 fact")).closest("li")!;
    // Revoking another copy leaves the link on show.
    await userEvent.click(within(within(list).getByText("Dana Okafor").closest("li")!).getByRole("button", { name: "Revoke link" }));
    await waitFor(() => expect(within(within(list).getByText("Dana Okafor").closest("li")!).getByText("Revoked")).toBeInTheDocument());
    expect(screen.getByLabelText("Your share link")).toBe(link);
    // Revoking its own copy takes it away.
    await userEvent.click(within(fresh).getByRole("button", { name: "Revoke link" }));
    await waitFor(() => expect(screen.queryByLabelText("Your share link")).toBeNull());
    expect(api.callsTo("DELETE", /^\/api\/shares\//).map((call) => call.path)).toEqual(["/api/shares/sh-1", "/api/shares/share-new-1"]);
    expect(within(within(list).getByText("1 fact").closest("li")!).getByText("Revoked")).toBeInTheDocument();
  });
});

describe("Sharing › Recruiters", () => {
  const headings = (column: Element) => [...column.querySelectorAll("h2")].map((heading) => heading.textContent);

  it("shows the placeholders, the preview where it’s on and what you’re looking for, in the board’s order", async () => {
    const state = fullVault();
    const api = installFakeApi(state);
    renderWithSession(<SharingRecruiters />, state.me);
    await screen.findByText("Web platform development software");
    await screen.findByRole("button", { name: "Save preferences" });
    expect(document.querySelector(".rs-lede")).toHaveTextContent("What you’re looking for, kept in your record. No recruiter can find you today.");
    expect(headings(document.querySelector(".app-main")!)).toEqual(["Can recruiters find you?", "What a recruiter would see"]);
    expect(headings(document.querySelector(".app-side")!)).toEqual(["Requests to meet you", "What you’re looking for"]);
    // Being found and requests are in view, not behind More choices.
    expect(document.querySelector("details")).toBeNull();
    expect(api.callsTo("GET", /^\/api\/v2\/card-preview$/)).toHaveLength(1);
    expect(api.callsTo("GET", /^\/api\/preferences$/)).toHaveLength(1);
  });

  it("without the preview, still shows the preferences and the placeholders, and asks for no preview", async () => {
    const state = fullVault();
    state.me.capabilities!.cardPreview = false;
    const api = installFakeApi(state);
    renderWithSession(<SharingRecruiters />, state.me);
    await screen.findByRole("button", { name: "Save preferences" });
    expect(headings(document.querySelector(".app-main")!)).toEqual(["Can recruiters find you?"]);
    expect(headings(document.querySelector(".app-side")!)).toEqual(["Requests to meet you", "What you’re looking for"]);
    expect(api.callsTo("GET", /card-preview/)).toEqual([]);
  });
});

describe("Sharing › Connected apps", () => {
  it("lists and revokes apps as before", async () => {
    const state = fullVault();
    const api = installFakeApi(state);
    renderWithSession(<SharingApps />, state.me);
    expect(document.querySelector(".rs-lede")).toHaveTextContent(
      "Let an assistant or a tool you use work with your record. It can do only what you allow, and only for 30 days at a time.",
    );
    const list = await screen.findByRole("region", { name: "Your apps" });
    const claude = (await within(list).findByText("Claude")).closest("li")!;
    expect(within(claude).getByText("Connected")).toBeInTheDocument();
    expect(within(claude).getByText(/Can read your facts and create documents\./)).toBeInTheDocument();
    expect(within(within(list).getByText("Career Notebook").closest("li")!).getByText("Waiting to connect")).toBeInTheDocument();
    expect(within(within(list).getByText("Old Tool").closest("li")!).getByRole("button", { name: "Remove credentials" })).toBeEnabled();
    await userEvent.click(within(claude).getByRole("button", { name: "Revoke access" }));
    await waitFor(() => expect(within(within(list).getByText("Claude").closest("li")!).getByText("Access ended")).toBeInTheDocument());
    expect(api.callsTo("DELETE", /^\/api\/mcp\/grants\//).map((call) => call.path)).toEqual(["/api/mcp/grants/g-1"]);
  });

  it("is not found, and has no tab, where apps are off", async () => {
    const state = fullVault();
    state.me.capabilities!.connectedApps = false;
    const api = installFakeApi(state);
    const shown = shownRoute(parseRoute("#/sharing/apps"), state.me);
    expect(shown.name).toBe("notFound");
    expect(SCREENS[shown.name].title).toBe("Page not found");
    renderWithSession(
      <Shell route={shown} title={SCREENS[shown.name].title}>
        {SCREENS[shown.name].render(shown)}
      </Shell>,
      state.me,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Page not found");
    await act(async () => {});
    expect(api.callsTo("GET", /mcp\/grants/)).toEqual([]);
    // The Sharing tabs, where they show, leave it out.
    const tabs = renderWithSession(
      <Shell route={parseRoute("#/sharing/coaches")} title="Coaches">
        <p>Coaches</p>
      </Shell>,
      state.me,
    );
    const row = within(tabs.container).getByRole("navigation", { name: "Sharing" });
    expect(within(row).getAllByRole("link").map((link) => link.textContent)).toEqual(["Overview", "Coaches", "Recruiters"]);
  });
});
