import { afterEach, describe, expect, it, vi } from "vitest";
import type { SharedView } from "../../src/shared/sharing";
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
    expect(await page.screen.findByRole("heading", { name: "Shared career snapshot" })).toBeInTheDocument();
    expect(page.calls).toEqual([
      { method: "POST", path: "/share/session", body: { token: "synthetic-token" } },
      { method: "GET", path: `/share/snapshot?g=${GRANT}`, body: null },
    ]);
    // Reloading this address opens this copy, whichever others the reader has open.
    expect(address()).toBe(`/share?g=${GRANT}`);
    expect(document.title).toBe("Sam Rivera, shared copy – Resumatic");
  });

  it("opens the copy its address names when there is no link to exchange", async () => {
    const page = await visit(`/share?g=${GRANT}`, () => ({ status: 200, body: named() }));
    expect(await page.screen.findByRole("heading", { name: "Shared career snapshot" })).toBeInTheDocument();
    expect(page.calls).toEqual([{ method: "GET", path: `/share/snapshot?g=${GRANT}`, body: null }]);
    expect(address()).toBe(`/share?g=${GRANT}`);
  });

  it("opens the copy a new link is for, not the one the address named", async () => {
    const other = "9b2f6c1e-7a40-4d55-8c3b-5e1f0a9d2c77";
    const page = await visit(`/share?g=${other}#synthetic-token`, (seen) =>
      seen.method === "POST" ? { status: 200, body: { grantId: GRANT } } : { status: 200, body: named() },
    );
    await page.screen.findByRole("heading", { name: "Shared career snapshot" });
    expect(page.calls[1]!.path).toBe(`/share/snapshot?g=${GRANT}`);
    expect(address()).toBe(`/share?g=${GRANT}`);
  });

  it("opens as it always did when the reply doesn’t name the copy", async () => {
    // A server that keeps one copy for each browser answers the exchange with nothing.
    const page = await visit("/share#synthetic-token", (seen) =>
      seen.method === "POST" ? { status: 204 } : { status: 200, body: sharedView() },
    );
    expect(await page.screen.findByRole("heading", { name: "Shared career snapshot" })).toBeInTheDocument();
    expect(page.calls.map((call) => call.path)).toEqual(["/share/session", "/share/snapshot"]);
    expect(address()).toBe("/share");
    expect(document.title).toBe("Shared copy – Resumatic");
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
    expect(await page.screen.findByRole("heading", { name: "Shared career snapshot" })).toBeInTheDocument();
    // The link was exchanged once. The second try reads the copy it already opened.
    expect(page.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /share/session",
      `GET /share/snapshot?g=${GRANT}`,
      `GET /share/snapshot?g=${GRANT}`,
    ]);
  });

  it("says a copy is unavailable once its hour is up, with nothing to retry", async () => {
    const page = await visit(`/share?g=${GRANT}`, () => ({ status: 410, body: { error: "gone" } }));
    expect(await page.screen.findByRole("heading", { name: "Share unavailable" })).toBeInTheDocument();
    expect(page.screen.getByText(/open the link from your message again/)).toBeInTheDocument();
    expect(page.screen.queryByRole("button")).toBeNull();
    expect(document.title).toBe("");
  });
});
