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
export interface ShareSnapshot {
  schemaVersion: 1;
  createdAt: number;
  facts: SharedFact[];
  resumes: SharedResume[];
}
export interface ShareGrant {
  id: string;
  epoch: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  factCount: number;
  resumeCount: number;
}
export interface SharedView {
  grantId: string;
  expiresAt: number;
  snapshot: ShareSnapshot;
}
