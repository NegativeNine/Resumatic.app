import { useMemo, useSyncExternalStore } from "react";

export type Route =
  | { page: "facts" }
  | { page: "jobs" }
  | { page: "resume"; id: string }
  | { page: "account" }
  | { page: "privacy" }
  | { page: "terms" }
  | { page: "notFound" };

export const href = {
  facts: "#/facts",
  jobs: "#/jobs",
  account: "#/account",
  privacy: "#/privacy",
  terms: "#/terms",
  resume: (id: string) => `#/resumes/${encodeURIComponent(id)}`,
};

const PAGES = ["facts", "jobs", "account", "privacy", "terms"] as const;

/** The v1 addresses, still honoured so old links and bookmarks land on the renamed pages. */
const ALIASES: Readonly<Record<string, (typeof PAGES)[number]>> = { sources: "facts", applications: "jobs" };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts.length === 0) return { page: "facts" };
  const [head, id] = parts;
  if (parts.length === 1) {
    const name = ALIASES[head] ?? head;
    const page = PAGES.find((p) => p === name);
    return page ? { page } : { page: "notFound" };
  }
  if (parts.length === 2 && head === "resumes") {
    try {
      return { page: "resume", id: decodeURIComponent(id) };
    } catch {
      return { page: "notFound" };
    }
  }
  return { page: "notFound" };
}

/** The hash an old address should show instead, such as "#/facts" for "#/sources"; otherwise null. */
export function canonicalHash(hash: string): string | null {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const page = parts.length === 1 ? ALIASES[parts[0]] : undefined;
  return page ? `#/${page}` : null;
}

/** Rewrites an old address in place, so the address bar and copied links use the new names. */
function canonicalize(): void {
  const canonical = canonicalHash(window.location.hash);
  if (canonical) window.history.replaceState(window.history.state, "", canonical);
}

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function currentHash(): string {
  canonicalize();
  return window.location.hash;
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, currentHash);
  return useMemo(() => parseRoute(hash), [hash]);
}

export function navigate(to: string) {
  window.location.hash = to;
}
