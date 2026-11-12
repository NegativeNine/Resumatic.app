import { afterEach, describe, expect, it, vi } from "vitest";
import type { SharedView } from "../../src/shared/sharing";
import { copyHeading } from "../../src/web/components/ShareSnapshotContent";
import { sharedView } from "./fixtures";

const GRANT = "0653389a-0d6d-4e90-94eb-23cc98b95c19";
type Reply = { status: number; body?: unknown };
type Seen = { method: string; path: string; body: unknown };

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  document.title = "";
});

/**
 * Loads the page as a browser arriving at `address` would. The page reads the link from the address
 * as its module loads, before anything else can see it, so each visit needs the module afresh.
 */
async function visit(address: string, answer: (seen: Seen) => Reply) {
  vi.resetModules();
  window.history.replaceState(null, "", address);
  const calls: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const seen = { method: (init?.method ?? "GET").toUpperCase(), path: url.pathname + url.search, body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
      calls.push(seen);
      const reply = answer(seen);
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
        headers: reply.body === undefined ? {} : { "content-type": "application/json" },
      });
    }),
  );
  const rtl = await import("@testing-library/react");
  const { SharePage } = await import("../../src/web/pages/SharePage");
  // The link is out of the address before the page renders or asks for anything.
  const addressAtLoad = window.location.pathname + window.location.search + window.location.hash;
  const view = rtl.render(<SharePage />);
  unmount = view.unmount;
  return { calls, addressAtLoad, screen: rtl.screen, fireEvent: rtl.fireEvent };
}

const address = () => window.location.pathname + window.location.search + window.location.hash;

function named(): SharedView {
  const view = sharedView();
  view.grantId = GRANT;
  view.snapshot.schemaVersion = 2;
  view.snapshot.owner = { name: "Sam Rivera" };
  return view;
}

describe("opening a shared copy", () => {
  it("takes the link out of the address and keeps which copy it is", async () => {
    const page = await visit("/share?utm=1#synthetic-token", (seen) =>
      seen.method === "POST" ? { status: 200, body: { grantId: GRANT } } : { status: 200, body: named() },
    );
    expect(page.addressAtLoad).toBe("/share");
    expect(await page.screen.findByText(copyHeading(named().snapshot), { selector: "h1.app-share__title" })).toBeInTheDocument();
    expect(page.calls).toEqual([
      { method: "POST", path: "/share/session", body: { token: "synthetic-token" } },
      { method: "GET", path: `/share/snapshot?g=${GRANT}`, body: null },
    ]);
    // Reloading this address opens this copy, whichever others the reader has open.
    expect(address()).toBe(`/share?g=${GRANT}`);
    // The title is set once the copy is on the page, a moment after the heading is.
    await vi.waitFor(() => expect(document.title).toBe("Sam Rivera, shared copy – Resumatic"));
  });

  it("opens the copy its address names when there is no link to exchange", async () => {
    const page = await visit(`/share?g=${GRANT}`, () => ({ status: 200, body: named() }));
    expect(await page.screen.findByText(copyHeading(named().snapshot), { selector: "h1.app-share__title" })).toBeInTheDocument();
    expect(page.calls).toEqual([{ method: "GET", path: `/share/snapshot?g=${GRANT}`, body: null }]);
    expect(address()).toBe(`/share?g=${GRANT}`);
  });

  it("opens the copy a new link is for, not the one the address named", async () => {
    const other = "9b2f6c1e-7a40-4d55-8c3b-5e1f0a9d2c77";
    const page = await visit(`/share?g=${other}#synthetic-token`, (seen) =>
      seen.method === "POST" ? { status: 200, body: { grantId: GRANT } } : { status: 200, body: named() },
    );
    await page.screen.findByText(copyHeading(named().snapshot), { selector: "h1.app-share__title" });
    expect(page.calls[1]!.path).toBe(`/share/snapshot?g=${GRANT}`);
    expect(address()).toBe(`/share?g=${GRANT}`);
  });

  it("opens as it always did when the reply doesn’t name the copy", async () => {
    // A server that keeps one copy for each browser answers the exchange with nothing.
    const page = await visit("/share#synthetic-token", (seen) =>
      seen.method === "POST" ? { status: 204 } : { status: 200, body: sharedView() },
    );
    expect(await page.screen.findByRole("heading", { level: 1, name: copyHeading(sharedView().snapshot) })).toBeInTheDocument();
    expect(page.calls.map((call) => call.path)).toEqual(["/share/session", "/share/snapshot"]);
    expect(address()).toBe("/share");
    await vi.waitFor(() => expect(document.title).toBe("Shared copy – Resumatic"));
  });

  it("asks again for the same copy after a failure that may pass, without the link", async () => {
    let reads = 0;
    const page = await visit("/share#synthetic-token", (seen) => {
      if (seen.method === "POST") return { status: 200, body: { grantId: GRANT } };
      reads += 1;
      return reads === 1 ? { status: 503, body: { error: "unavailable" } } : { status: 200, body: named() };
    });
    expect(await page.screen.findByRole("heading", { name: "This copy couldn’t be opened" })).toBeInTheDocument();
    expect(address()).toBe(`/share?g=${GRANT}`);
    page.fireEvent.click(page.screen.getByRole("button", { name: "Try again" }));
    expect(await page.screen.findByText(copyHeading(named().snapshot), { selector: "h1.app-share__title" })).toBeInTheDocument();
    // The link was exchanged once. The second try reads the copy it already opened.
    expect(page.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /share/session",
      `GET /share/snapshot?g=${GRANT}`,
      `GET /share/snapshot?g=${GRANT}`,
    ]);
  });

  it("says in the server’s words why a copy can’t be added, and adds it once it can be", async () => {
    let standing: SharedView["reviewer"] = "you";
    const refusals: Reply[] = [
      { status: 409, body: { error: "conflict", message: "your client list is full; remove a copy that has ended, then add this one" } },
      // A refusal that doesn't say why keeps the page's own sentence.
      { status: 409 },
    ];
    const page = await visit(`/share?g=${GRANT}`, (seen) => {
      // Once the copy is in the list, the page asks for what its coach has written on it.
      if (seen.path.startsWith("/api/coach/clients/")) return { status: 200, body: { threads: [] } };
      if (seen.method === "GET") return { status: 200, body: { ...named(), reviewer: standing } };
      const refusal = refusals.shift();
      if (refusal) return refusal;
      standing = "joined";
      return { status: 204 };
    });
    const add = await page.screen.findByRole("button", { name: "Add to my clients" });
    expect(page.screen.getByText(/^Sam Rivera named you as their coach\./)).toBeInTheDocument();
    page.fireEvent.click(add);
    expect(await page.screen.findByRole("alert")).toHaveTextContent("Your client list is full. Remove a copy that has ended, then add this one.");
    // Still offered, because making room is something the reader can do.
    expect(add).toBeEnabled();
    page.fireEvent.click(add);
    await vi.waitFor(() => expect(page.screen.getByRole("alert")).toHaveTextContent("This copy couldn’t be added. Reload the page and try again."));
    page.fireEvent.click(add);
    expect(await page.screen.findByText(/^Shared with you until \d+ Nov 2026\. You can comment\. Only Sam Rivera can change it\.$/)).toBeInTheDocument();
    expect(page.screen.getByRole("link", { name: "Open your clients" })).toHaveAttribute("href", "/#/coaching/clients");
    expect(await page.screen.findByText("No comments yet.")).toBeInTheDocument();
    expect(page.screen.queryByRole("alert")).toBeNull();
    expect(page.screen.queryByRole("button", { name: "Add to my clients" })).toBeNull();
    expect(page.calls.filter((call) => call.method === "POST")).toEqual(
      Array.from({ length: 3 }, () => ({ method: "POST", path: "/api/coach/clients", body: { grantId: GRANT } })),
    );
  });

  it("tells a coach signed out elsewhere to sign in again, not to reload", async () => {
    const page = await visit(`/share?g=${GRANT}`, (seen) =>
      seen.method === "GET"
        ? { status: 200, body: { ...named(), reviewer: "you" } }
        : { status: 401, body: { error: "unauthenticated", message: "this session was signed out" } },
    );
    page.fireEvent.click(await page.screen.findByRole("button", { name: "Add to my clients" }));
    expect(await page.screen.findByRole("alert")).toHaveTextContent("Sign in to Resumatic again, then reload this page.");
    expect(page.screen.queryByText(/this session was signed out/)).toBeNull();
    expect(page.screen.queryByText(/Reload the page and try again/)).toBeNull();
  });

  it("offers the add again when the copy still isn’t in the list after it was added", async () => {
    // The add went through, and the copy read again can't yet say it is in the list.
    const page = await visit(`/share?g=${GRANT}`, (seen) =>
      seen.method === "GET" ? { status: 200, body: { ...named(), reviewer: "you" } } : { status: 204 },
    );
    page.fireEvent.click(await page.screen.findByRole("button", { name: "Add to my clients" }));
    await vi.waitFor(() => expect(page.calls.filter((call) => call.method === "GET")).toHaveLength(2));
    const again = await page.screen.findByRole("button", { name: "Add to my clients" });
    await vi.waitFor(() => expect(again).toBeEnabled());
    expect(page.screen.queryByRole("alert")).toBeNull();
  });

  it("says a copy whose hour is up isn't open any more, with nothing to retry", async () => {
    const page = await visit(`/share?g=${GRANT}`, () => ({ status: 410, body: { error: "gone", message: "This link has expired or been turned off. Ask the person who sent it for a new one." } }));
    const card = await page.screen.findByRole("region", { name: "This copy isn’t open any more" });
    expect(page.screen.getByRole("heading", { level: 1, name: "This copy isn’t open any more" })).toBeInTheDocument();
    expect(card).toHaveTextContent(
      "A copy stays open for an hour at a time. Open the link from your message again. If the link doesn’t work either, it has expired or been turned off, and the person who shared it can share a new copy.",
    );
    expect(page.screen.queryByRole("button")).toBeNull();
    // Chosen by the step that failed, never by the server's words.
    expect(page.screen.queryByText(/Ask the person who sent it/)).toBeNull();
    expect(page.screen.getByText("Shared copy, read only")).toHaveClass("rs-mark--note");
    expect(document.title).toBe("");
  });

  it("names whose copy it is and its job when the copy says them, and says only ‘A shared copy’ when it doesn't", () => {
    const job = { title: "Platform Engineer", company: "Litware" };
    const copy = named().snapshot;
    // Its name alone, when no resume or document names a job.
    expect(copyHeading(copy)).toBe("Sam Rivera");
    copy.resumes[0]!.job = job;
    expect(copyHeading(copy)).toBe("Sam Rivera, for Platform Engineer at Litware");
    // Every resume and document has to be for the same job, or none is named.
    copy.schemaVersion = 3;
    copy.documents = [{ id: "doc-letter", version: 1, kind: "letter", paragraphs: ["A line."], questions: [], job }];
    expect(copyHeading(copy)).toBe("Sam Rivera, for Platform Engineer at Litware");
    copy.documents[0]!.job = { title: "Staff Engineer", company: "Litware" };
    expect(copyHeading(copy)).toBe("Sam Rivera");
    copy.documents[0]!.job = null;
    expect(copyHeading(copy)).toBe("Sam Rivera");
    // A job without its owner's name, and neither.
    copy.documents = undefined;
    copy.owner = null;
    expect(copyHeading(copy)).toBe("A shared copy, for Platform Engineer at Litware");
    copy.resumes[0]!.job = { title: null, company: null };
    expect(copyHeading(copy)).toBe("A shared copy");
    // A copy of facts alone names no job, and a copy from before names were added names nobody.
    expect(copyHeading({ ...copy, resumes: [] })).toBe("A shared copy");
    expect(copyHeading(sharedView().snapshot)).toBe("A shared copy");
  });

  it("shows the copy's heading, when it was made and ends, and that its owner's record may have moved on", async () => {
    const view = named();
    view.snapshot.resumes[0]!.job = { title: "Platform Engineer", company: "Litware" };
    const page = await visit(`/share?g=${GRANT}`, () => ({ status: 200, body: view }));
    expect(await page.screen.findByRole("heading", { level: 1, name: "Sam Rivera, for Platform Engineer at Litware" })).toBeInTheDocument();
    expect(page.screen.getByText(/^A copy made \d+ Nov 2026\. It ends \d+ Nov 2026\. Sam Rivera’s own record may have changed since\.$/)).toBeInTheDocument();
    expect(page.screen.getByText(/^Sam Rivera can see when this copy was last opened, but not who opened it\./)).toBeInTheDocument();
  });

  it("says a link that can't be exchanged isn't available, with nothing to retry", async () => {
    for (const status of [400, 403, 404, 410, 422]) {
      const page = await visit("/share#synthetic-token", (seen) =>
        seen.method === "POST" ? { status, body: { error: "gone", message: "This link has expired. Ask the person who sent it for a new one." } } : { status: 200, body: named() },
      );
      const card = await page.screen.findByRole("region", { name: "This link isn’t available" });
      expect(card, String(status)).toHaveTextContent("It has expired, or the person who shared it turned it off. Ask them for a new one.");
      expect(page.screen.queryByRole("button"), String(status)).toBeNull();
      // The copy itself is never asked for, and the link is out of the address.
      expect(page.calls.map((call) => call.path), String(status)).toEqual(["/share/session"]);
      expect(address(), String(status)).toBe("/share");
      unmount?.();
      unmount = null;
    }
  });

  it("says a failure that may pass couldn't open the copy, with a way to try again", async () => {
    for (const status of [408, 429, 503]) {
      const page = await visit("/share#synthetic-token", () => ({ status, body: { error: "unavailable" } }));
      const card = await page.screen.findByRole("region", { name: "This copy couldn’t be opened" });
      expect(card, String(status)).toHaveTextContent("Check your connection, then try again.");
      expect(page.screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
      unmount?.();
      unmount = null;
    }
  });

  it("sends a coach who isn't signed in to sign-in, not the landing page", async () => {
    const page = await visit(`/share?g=${GRANT}`, () => ({ status: 200, body: { ...named(), reviewer: "sign-in" } }));
    const link = await page.screen.findByRole("link", { name: "sign in to Resumatic" });
    expect(link).toHaveAttribute("href", "/#/sign-in");
    expect(link).toHaveAttribute("target", "_blank");
  });
});
