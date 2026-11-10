import { isWebUrl, MIN_JD_CHARS } from "../shared/api";
import { AppError } from "../shared/errors";
import type { PostingRead } from "../shared/postings";
import { composePosting, extractJobPosting } from "./posting-page";

// Reads a job posting from the page a signed-in person names, so they can check it before saving.
// This is the one place the Worker fetches an address a person typed. It asks only for public
// https pages on named hosts, follows a few redirects under the same rule, sends no credentials,
// reads a bounded amount for a bounded time, and returns only what a JobPosting on the page says.

export const MAX_POSTING_PAGE_BYTES = 1_500_000;
export const POSTING_FETCH_TIMEOUT_MS = 8_000;
export const MAX_POSTING_REDIRECTS = 3;

export type PostingFetcher = (url: string, init: RequestInit) => Promise<Response>;
let override: PostingFetcher | null = null;
/** Test seam, like setModels: no test reaches a real site. */
export function setPostingFetcher(fetcher: PostingFetcher | null): void {
  override = fetcher;
}

/** Names that only resolve inside a network, or are reserved for no network at all. */
const PRIVATE_SUFFIXES = [
  ".local", ".localhost", ".localdomain", ".internal", ".intranet", ".lan", ".home", ".corp", ".private",
  ".test", ".invalid", ".example", ".onion", ".arpa",
];

/**
 * The address to fetch: https, the default port, and a host with a name. A host given as numbers
 * (in any of the forms an address can be written) has no alphabetic last label, so it is refused,
 * as are names that only mean something inside a private network and this app's own host.
 */
export function postingAddress(value: string, ownHost: string): URL {
  const refuse = () => new AppError("invalid", "use the posting's public web address, starting with https://");
  if (!isWebUrl(value)) throw refuse();
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const lastLabel = host.slice(host.lastIndexOf(".") + 1);
  const own = ownHost.toLowerCase();
  if (
    // An address with a port of its own. The scheme's usual port never shows here.
    url.port !== "" ||
    !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(lastLabel) ||
    PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    host === own ||
    host.endsWith(`.${own}`)
  )
    throw refuse();
  // A page worth reading is served over https. An http address is asked for at its https one.
  url.protocol = "https:";
  url.hash = "";
  return url;
}

const unread = (reason: Exclude<PostingRead, { posting: object }>["reason"]): PostingRead => ({ posting: null, reason });

export async function readPosting(
  address: string,
  ownHost: string,
  timeoutMs = POSTING_FETCH_TIMEOUT_MS,
): Promise<PostingRead> {
  let url = postingAddress(address, ownHost);
  const send = override ?? ((target: string, init: RequestInit) => fetch(target, init));
  let response: Response;
  let html: string;
  try {
    // One deadline for the whole read, redirects and body included.
    const signal = AbortSignal.timeout(timeoutMs);
    const expired = new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true }),
    );
    expired.catch(() => {});
    for (let hop = 0; ; hop++) {
      const request = send(url.href, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en",
          // Says who is asking and why. No cookie or other credential is ever sent.
          "user-agent": "Resumatic/1.0 (+https://resumatic.app; reads one job posting when a person asks)",
        },
      });
      // The signal ends a request that honours it. The race ends the wait for one that doesn't.
      response = await Promise.race([request, expired]);
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location || hop >= MAX_POSTING_REDIRECTS) return unread("unreachable");
      // Each hop is held to the same rule as the address the person gave.
      try {
        url = postingAddress(new URL(location, url).href, ownHost);
      } catch {
        return unread("unreachable");
      }
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return unread("unreachable");
    }
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!/^\s*(?:text\/html|application\/xhtml\+xml)\s*(?:;|$)/.test(type)) {
      await response.body?.cancel().catch(() => {});
      return unread("not_a_page");
    }
    html = await readCapped(response, type, expired);
  } catch {
    return unread("unreachable");
  }
  const found = extractJobPosting(html);
  if (!found || found.description.length < MIN_JD_CHARS) return unread("no_posting");
  const { text, truncated } = composePosting(found);
  return { posting: { text, title: found.title, company: found.company, truncated, host: url.hostname } };
}

/** The start of the page, up to the cap, as text. The rest is never read. */
async function readCapped(response: Response, contentType: string, expired: Promise<never>): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_POSTING_PAGE_BYTES) {
      const { done, value } = await Promise.race([reader.read(), expired]);
      if (done) break;
      const kept = value.subarray(0, MAX_POSTING_PAGE_BYTES - size);
      chunks.push(kept);
      size += kept.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  const charset = /charset\s*=\s*"?([a-z0-9._-]{1,40})/i.exec(contentType)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}
