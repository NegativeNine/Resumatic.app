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
/**
 * A cover letter or interview preparation in a copy: its words only, as they were checked against
 * confirmed facts when it was written. Neither the facts cited nor the posting come with it.
 */
export interface SharedDocument {
  id: string;
  version: number;
  kind: "letter" | "prep";
  /** A letter's paragraphs, in order. Empty for interview preparation. */
  paragraphs: string[];
  /** Interview preparation: each question with the points prepared for it. Empty for a letter. */
  questions: { question: string; points: string[] }[];
}
/** A finished cover letter or interview preparation, as the list to choose from needs it. */
export interface ShareableDocument {
  id: string;
  kind: "letter" | "prep";
  applicationId: string;
  version: number;
  createdAt: number;
  /** False for one written before its evidence was kept: it has to be written again to be shared. */
  shareable: boolean;
}
/** The job a shared resume or document was made for, as the owner had it named when the copy was made. */
export interface SharedJob {
  title: string | null;
  company: string | null;
}
export interface ShareSnapshot {
  /**
   * Version 2 adds the owner's name and each resume's job. A version 1 copy has neither.
   * Version 3 is a version 2 copy that also holds documents, so code that predates them refuses it
   * instead of serving a part it never checked.
   */
  schemaVersion: 1 | 2 | 3;
  createdAt: number;
  facts: SharedFact[];
  resumes: (SharedResume & { job?: SharedJob | null })[];
  /** Cover letters and interview preparation. Present, and not empty, only in a version 3 copy. */
  documents?: (SharedDocument & { job?: SharedJob | null })[];
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
/**
 * How long a coach's client list keeps an entry after its copy's last day. The copy can't be opened
 * by then; the entry stays this long so the coach sees that access ended, and then it goes.
 */
export const COACH_CLIENT_KEPT_MS = 30 * 24 * 60 * 60 * 1000;
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
  /** Cover letters and interview preparation in the copy. Absent from a server that predates them. */
  documentCount?: number;
  /** The coach this link names, or null for a link anyone reads as nobody in particular. */
  coach?: ShareCoach | null;
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
  /**
   * How the person reading stands to the coach this copy names. Absent when it names none, or when
   * the reader is its owner.
   * - sign-in: nobody is signed in;
   * - sign-in-again: signed in, but with a session from before the sign-in address was carried;
   * - other: signed in with a different address;
   * - you: this is the named coach, who hasn't added the copy to their clients;
   * - joined: the named coach, with the copy in their clients.
   */
  reviewer?: "sign-in" | "sign-in-again" | "other" | "you" | "joined";
}

/** The coach a copy names, as its owner sees them. */
export interface ShareCoach {
  /** The address the owner gave. Only the account that signs in with it can act as the coach. */
  email: string;
  /** The coach's name once they have added the copy to their clients, if they have one. */
  name: string | null;
  /** When that account added the copy to its clients, or null if it hasn't. */
  joinedAt: number | null;
}

/** Someone who shared a copy with this account as their coach, as the coach's client list shows it. */
export interface CoachClient {
  grantId: string;
  /** The owner's name, when they chose to put it on the copy. */
  ownerName: string | null;
  addedAt: number;
  expiresAt: number;
  /** False once the link has expired or been revoked, or the owner's account is gone. */
  active: boolean;
  factCount: number;
  resumeCount: number;
  documentCount: number;
}
