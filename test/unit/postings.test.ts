import { afterEach, describe, expect, it } from "vitest";
import { MAX_JD_CHARS } from "../../src/shared/api";
import { MAX_POSTING_PAGE_BYTES, MAX_POSTING_REDIRECTS, postingAddress, readPosting, setPostingFetcher } from "../../src/worker/postings";

const OWN = "app.resumatic.app";
const LINK = "https://jobs.example.com/litware/platform-engineer";
const DESCRIPTION = "Run our Kubernetes fleet and build the tools product teams ship with. Own the release pipeline.";
const posting = (extra: Record<string, unknown> = {}) =>
  `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org", "@type": "JobPosting", title: "Platform Engineer",
    hiringOrganization: { name: "Litware" }, description: `<p>${DESCRIPTION}</p>`, ...extra,
  })}</script></head><body></body></html>`;
const html = (body: string, type = "text/html; charset=utf-8", status = 200) =>
  new Response(body, { status, headers: { "content-type": type } });
const redirect = (location: string | null, status = 302) =>
  new Response(null, { status, headers: location === null ? {} : { location } });

type Seen = { url: string; init: RequestInit };
/** Answers each address from the table, and remembers what was asked for. */
function site(pages: Record<string, () => Response | Promise<Response>>): Seen[] {
  const seen: Seen[] = [];
  setPostingFetcher(async (url, init) => {
    seen.push({ url, init });
    const page = pages[url];
    if (!page) throw new TypeError("no route to host");
    return page();
  });
  return seen;
}

afterEach(() => setPostingFetcher(null));

describe("the address a posting is read from", () => {
  it("is a public https page on a named host", () => {
    expect(postingAddress(`${LINK}?gh_jid=41#apply`, OWN).href).toBe(`${LINK}?gh_jid=41`);
    // A page worth reading is on https, so that is where an http address is asked for.
    expect(postingAddress("http://jobs.example.com/a", OWN).href).toBe("https://jobs.example.com/a");
    expect(postingAddress("https://JOBS.Example.COM:443/a", OWN).href).toBe("https://jobs.example.com/a");
    for (const allowed of ["https://careers.litware.co.uk/", "https://b\u00fccher.example.org/stellen", "https://example.xn--p1ai/", "https://resumatic.app/careers"])
      expect(() => postingAddress(allowed, OWN), allowed).not.toThrow();
  });

  it("is never an address inside a network, a number, a port of its own, or this app", () => {
    for (const refused of [
      "ftp://jobs.example.com/a", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,<p>x</p>", "//jobs.example.com/a", "jobs.example.com/a",
      "https://user:secret@jobs.example.com/a", "https://jobs.example.com:8443/a", "http://jobs.example.com:8080/a", "http://jobs.example.com:443/a",
      "https://localhost/a", "https://127.0.0.1/a", "https://127.1/a", "https://0x7f.0.0.1/a", "https://0177.0.0.1/a", "https://2130706433/a",
      "https://[::1]/a", "https://[::ffff:127.0.0.1]/a", "https://[fd00::1]/a", "https://10.0.0.8/a", "https://192.168.1.1/a",
      "https://169.254.169.254/latest/meta-data/", "https://metadata.google.internal/computeMetadata/v1/",
      "https://printer.local/", "https://api.localhost/", "https://host.localdomain/", "https://wiki.corp/", "https://nas.lan/", "https://router.home/",
      "https://service.intranet/", "https://db.private/", "https://hidden.onion/", "https://1.0.0.127.in-addr.arpa/", "https://site.test/", "https://jobs.example/",
      "https://jobs.example.com./a", `https://${OWN}/api/export`, `https://${OWN.toUpperCase()}/api/me`, `https://x.${OWN}/`, `http://${OWN}/share`,
      "https://jobs.example.com/a b", ` ${LINK}`, `${LINK}?${"x".repeat(2_000)}`, "",
    ])
      expect(() => postingAddress(refused, OWN), refused).toThrow("use the posting's public web address");
  });

  it("leaves a public name that points inward to the network's own rules", () => {
    // A name can be made to resolve anywhere, and a name is all that is known here. What stops this
    // one is that the platform's outbound requests cannot reach private addresses, which is checked
    // against the deployed Worker, not in this test.
    expect(() => postingAddress("https://10.0.0.8.nip.io/a", OWN)).not.toThrow();
  });
});

describe("reading a posting from its page", () => {
  it("returns what the page says about the job, asking as itself and sending nothing of the person's", async () => {
    const seen = site({ [LINK]: () => html(posting()) });
    expect(await readPosting(`${LINK}#apply`, OWN)).toEqual({
      posting: { text: `Platform Engineer at Litware\n\n${DESCRIPTION}`, title: "Platform Engineer", company: "Litware", truncated: false, host: "jobs.example.com" },
    });
    expect(seen).toHaveLength(1);
    const { url, init } = seen[0]!;
    expect(url).toBe(LINK);
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeUndefined();
    const headers = new Headers(init.headers);
    expect(headers.get("user-agent")).toMatch(/^Resumatic\//);
    expect([...headers.keys()].sort()).toEqual(["accept", "accept-language", "user-agent"]);
  });

  it("follows a few redirects, holding each to the same rule as the first address", async () => {
    const seen = site({
      [LINK]: () => redirect("/a", 301),
      "https://jobs.example.com/a": () => redirect("http://boards.example.org/b", 307),
      "https://boards.example.org/b": () => redirect("https://boards.example.org/c#top", 308),
      "https://boards.example.org/c": () => html(posting()),
    });
    const read = await readPosting(LINK, OWN);
    expect(read.posting).toMatchObject({ title: "Platform Engineer", host: "boards.example.org" });
    expect(seen.map((request) => request.url)).toEqual([LINK, "https://jobs.example.com/a", "https://boards.example.org/b", "https://boards.example.org/c"]);
    expect(MAX_POSTING_REDIRECTS).toBe(3);
  });

  it("stops at a redirect too many, one with nowhere to go, and one that points inward", async () => {
    const loop = site({ [LINK]: () => redirect(LINK) });
    expect(await readPosting(LINK, OWN)).toEqual({ posting: null, reason: "unreachable" });
    expect(loop).toHaveLength(MAX_POSTING_REDIRECTS + 1);
    site({ [LINK]: () => redirect(null) });
    expect(await readPosting(LINK, OWN)).toEqual({ posting: null, reason: "unreachable" });
    for (const inward of ["http://169.254.169.254/latest/meta-data/", "https://localhost/admin", "https://[::1]/", "https://wiki.corp/", `https://${OWN}/api/export`, "https://jobs.example.com:8443/x", "file:///etc/passwd", "https://user:secret@jobs.example.com/x"]) {
      const seen = site({ [LINK]: () => redirect(inward), [inward]: () => html(posting()) });
      expect(await readPosting(LINK, OWN), inward).toEqual({ posting: null, reason: "unreachable" });
      // The address it was sent to is never asked for.
      expect(seen.map((request) => request.url), inward).toEqual([LINK]);
    }
  });

  it("says a page couldn't be reached when the site refuses, fails or isn't there", async () => {
    for (const status of [204, 206, 304, 400, 401, 403, 404, 429, 500, 503]) {
      site({ [LINK]: () => new Response(status === 204 || status === 304 ? null : posting(), { status, headers: { "content-type": "text/html" } }) });
      expect(await readPosting(LINK, OWN), String(status)).toEqual({ posting: null, reason: "unreachable" });
    }
    site({});
    expect(await readPosting(LINK, OWN)).toEqual({ posting: null, reason: "unreachable" });
  });

  it("reads only web pages", async () => {
    for (const type of ["application/pdf", "application/json", "application/ld+json", "text/plain", "text/htmlx", "image/png", "application/octet-stream", ""]) {
      site({ [LINK]: () => new Response(posting(), { headers: type ? { "content-type": type } : {} }) });
      expect(await readPosting(LINK, OWN), type).toEqual({ posting: null, reason: "not_a_page" });
    }
    for (const type of ["text/html", "TEXT/HTML; Charset=UTF-8", "application/xhtml+xml", " text/html ;charset=utf-8"]) {
      site({ [LINK]: () => html(posting(), type) });
      expect((await readPosting(LINK, OWN)).posting?.company, type).toBe("Litware");
    }
  });

  it("says so when the page holds no posting, or too little to be one", async () => {
    site({ [LINK]: () => html("<html><body><h1>Platform Engineer</h1><p>Apply in the app.</p></body></html>") });
    expect(await readPosting(LINK, OWN)).toEqual({ posting: null, reason: "no_posting" });
    site({ [LINK]: () => html(posting({ description: "Apply now." })) });
    expect(await readPosting(LINK, OWN)).toEqual({ posting: null, reason: "no_posting" });
    site({ [LINK]: () => html("") });
    expect(await readPosting(LINK, OWN)).toEqual({ posting: null, reason: "no_posting" });
  });

  it("reads the start of a page and never the rest", async () => {
    const chunk = new TextEncoder().encode(" ".repeat(64 * 1024));
    const endless = (first: string) => {
      let pulled = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(pulled === 1 ? new TextEncoder().encode(first) : chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      return { response: new Response(body, { headers: { "content-type": "text/html" } }), state: () => ({ pulled, cancelled }) };
    };
    const early = endless(posting());
    site({ [LINK]: () => early.response });
    expect((await readPosting(LINK, OWN)).posting?.title).toBe("Platform Engineer");
    expect(early.state().cancelled).toBe(true);
    // A little past the cap at most: the stream's own buffer, never the page without end.
    expect(early.state().pulled).toBeLessThanOrEqual(MAX_POSTING_PAGE_BYTES / chunk.byteLength + 4);

    // A posting that begins after the cap is not found, because that part is never read.
    site({ [LINK]: () => html(" ".repeat(MAX_POSTING_PAGE_BYTES) + posting()) });
    expect(await readPosting(LINK, OWN)).toEqual({ posting: null, reason: "no_posting" });
    site({ [LINK]: () => html(posting() + " ".repeat(MAX_POSTING_PAGE_BYTES)) });
    expect((await readPosting(LINK, OWN)).posting?.company).toBe("Litware");
  });

  it("cuts a posting that is longer than one can be, and says so", async () => {
    site({ [LINK]: () => html(posting({ description: `<p>${"Requirement written out in full. ".repeat(2_000)}</p>` })) });
    const read = await readPosting(LINK, OWN);
    expect(read.posting?.truncated).toBe(true);
    expect(read.posting!.text.length).toBeLessThanOrEqual(MAX_JD_CHARS);
  });

  it("reads a page in the character set it declares, and as UTF-8 when the name means nothing", async () => {
    const latin = Uint8Array.from(Buffer.from(posting({ title: "Ing\u00e9nieur plateforme" }), "latin1"));
    site({ [LINK]: () => new Response(latin, { headers: { "content-type": "text/html; charset=ISO-8859-1" } }) });
    expect((await readPosting(LINK, OWN)).posting?.title).toBe("Ing\u00e9nieur plateforme");
    site({ [LINK]: () => html(posting({ title: "Ing\u00e9nieur plateforme" }), 'text/html; charset="not-a-charset"') });
    expect((await readPosting(LINK, OWN)).posting?.title).toBe("Ing\u00e9nieur plateforme");
  });

  it("gives up on a site that doesn't answer, or stops partway", async () => {
    const started = Date.now();
    // Never answers: only the deadline ends the wait.
    setPostingFetcher((_url, init) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))));
    expect(await readPosting(LINK, OWN, 40)).toEqual({ posting: null, reason: "unreachable" });
    // Never answers, and takes no notice of being told to stop.
    setPostingFetcher(() => new Promise(() => {}));
    expect(await readPosting(LINK, OWN, 40)).toEqual({ posting: null, reason: "unreachable" });
    // Sends its headers, then nothing.
    let cancelled = false;
    setPostingFetcher(async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel() { cancelled = true; } }), { headers: { "content-type": "text/html" } }));
    expect(await readPosting(LINK, OWN, 40)).toEqual({ posting: null, reason: "unreachable" });
    expect(cancelled).toBe(true);
    // Breaks off in the middle of the page.
    setPostingFetcher(async () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error("connection reset")); } }), { headers: { "content-type": "text/html" } }));
    expect(await readPosting(LINK, OWN, 40)).toEqual({ posting: null, reason: "unreachable" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("asks no site at all for an address it won't read", async () => {
    const seen = site({});
    for (const refused of ["https://169.254.169.254/latest/meta-data/", "https://localhost/", `https://${OWN}/api/export`, "https://jobs.example.com:8443/a"])
      await expect(readPosting(refused, OWN), refused).rejects.toThrow("use the posting's public web address");
    expect(seen).toEqual([]);
  });
});
