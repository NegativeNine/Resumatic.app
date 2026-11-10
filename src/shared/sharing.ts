import type { FactKind, Level, Profile, RoleKind } from "./api";

export interface SharedRole {
  id: string;
  kind: RoleKind;
  org: string;
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  /** A supported start whose end is unknown; legacy startDate stays null. */
  unknownEndStartDate?: string | null;
}
export interface SharedFact {
  id: string;
  kind: FactKind;
  text: string;
  level: Level | null;
  origin: "extracted" | "user";
  role: SharedRole | null;
}
export interface SharedLine {
  id: string;
  text: string;
  verification: "verified" | "user-authored" | "unverified";
}
export interface SharedResume {
  id: string;
  version: number;
  profile: Profile;
  summary: SharedLine | null;
  sections: (SharedRole & { lines: SharedLine[] })[];
  skills: string[];
  verification: "verified" | "user-authored" | "mixed" | "unverified";
}
/** The job a shared resume was tailored for, as the owner had it named when the copy was made. */
export interface SharedJob {
  title: string | null;
  company: string | null;
}
export interface ShareSnapshot {
  /** Version 2 adds the owner's name and each resume's job. A version 1 copy has neither. */
  schemaVersion: 1 | 2;
  createdAt: number;
  facts: SharedFact[];
  resumes: (SharedResume & { job?: SharedJob | null })[];
  /** Whose copy this is, when they chose to put their name on it. */
  owner?: { name: string } | null;
}
// The privacy notice states these three in words, and a test holds the two together.
/** The longest a share link can last. */
export const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a reader's browser keeps one copy open before the link is needed again. */
export const SHARE_SESSION_TTL_MS = 60 * 60 * 1000;
/** How often, at most, a copy's last-opened time is written. */
export const SHARE_READ_INTERVAL_MS = 60_000;
/** The longest label an owner can give a link, such as "For Dana". */
export const MAX_SHARE_LABEL_CHARS = 80;
export interface ShareGrant {
  id: string;
  epoch: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  factCount: number;
  resumeCount: number;
  /** Whether an unexpired, unrevoked snapshot can currently be delivered. */
  available?: boolean;
  /** The owner's own note of who the link is for. Never shown to the reader. */
  label?: string | null;
  /** When the copy was last opened, or null if it never has been. */
  lastReadAt?: number | null;
}
export interface SharedView {
  grantId: string;
  expiresAt: number;
  snapshot: ShareSnapshot;
}
