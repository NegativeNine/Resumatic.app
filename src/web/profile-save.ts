import type { Profile } from "../shared/api";

export function isProfileSnapshot(value: unknown): value is Profile & { revision: number } {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<Profile>;
  return Number.isSafeInteger(p.revision) && p.revision! > 0 &&
    typeof p.name === "string" && typeof p.email === "string" &&
    typeof p.phone === "string" && typeof p.location === "string" &&
    Array.isArray(p.links) && p.links.every((link) => typeof link === "string");
}

/** A fresh read can resolve a lost reply only at the next revision with every submitted field intact. */
export function profileWriteObserved(current: unknown, previousRevision: number | undefined, submitted: Profile): current is Profile {
  return Number.isSafeInteger(previousRevision) && previousRevision! > 0 &&
    previousRevision! < Number.MAX_SAFE_INTEGER && isProfileSnapshot(current) && current.revision === previousRevision! + 1 &&
    current.name === submitted.name && current.email === submitted.email &&
    current.phone === submitted.phone && current.location === submitted.location &&
    current.links.length === submitted.links.length &&
    current.links.every((link, index) => link === submitted.links[index]);
}
