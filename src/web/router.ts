import { useMemo, useSyncExternalStore } from "react";

export type Route =
  | { page: "sources" }
  | { page: "applications" }
  | { page: "resume"; id: string }
  | { page: "account" }
  | { page: "notFound" };

export const href = {
  sources: "#/sources",
  applications: "#/applications",
  account: "#/account",
  resume: (id: string) => `#/resumes/${encodeURIComponent(id)}`,
};

const PAGES = ["sources", "applications", "account"] as const;

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts.length === 0) return { page: "sources" };
  const [head, id] = parts;
  if (parts.length === 1) {
    const page = PAGES.find((p) => p === head);
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

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return useMemo(() => parseRoute(hash), [hash]);
}

export function navigate(to: string) {
  window.location.hash = to;
}
