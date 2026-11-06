import type {
  FactKind,
  Level,
  LineStatus,
  ResumeBody,
  ResumeReport,
  RoleKind,
} from "./api";
import type { LocationHint } from "./location";

/** The caller, taken from a verified session cookie. Every user call to a vault carries it. */
export interface Who {
  epoch?: string;
  userId: string;
  gen: number;
}

export interface SignInInput {
  provider: "google" | "test";
  subject: string;
  email: string;
  hint: LocationHint;
  /** Internal placement metadata supplied only by the Directory routing helper. */
  homeShard?: number;
  /** The global Directory has already authorized this new account's invite. */
  inviteAuthorized?: boolean;
}

export interface VaultRow {
  vaultId: string;
  userId: string;
  email: string;
  hint: string;
  state: "creating" | "active" | "deleting" | "swept";
  updatedAt: number;
}

// ---- Distill ----

export interface ExtractedRole {
  span?: [number, number];
  confidence?: number | null;
  /** A label the model gives the role so facts can point at it. */
  key: string;
  kind: RoleKind;
  org: string;
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  unknownEndStartDate?: string | null;
  quote: string;
}

export interface ExtractedFact {
  reviewReasons?: string[];
  span?: [number, number];
  confidence?: number | null;
  roleKey: string | null;
  kind: FactKind;
  text: string;
  level: Level | null;
  quote: string;
}

export interface Extraction {
  roles: ExtractedRole[];
  facts: ExtractedFact[];
}

// ---- Tailor ----

export interface FactRecord {
  revision?: number;
  origin?: "extracted" | "user";
  id: string;
  roleId: string | null;
  kind: FactKind;
  text: string;
  level: Level | null;
  quote: string | null;
}

export interface RoleRecord {
  revision?: number;
  id: string;
  kind: RoleKind;
  org: string;
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  unknownEndStartDate?: string | null;
}

export interface Analysis {
  company: string | null;
  title: string | null;
  requirements: string[];
}

/** One confirmed fact close to one requirement, by cosine similarity. */
export interface Candidate {
  factId: string;
  query: number;
  score: number;
}

export interface Selection {
  /** Accomplishment and credential facts the writer may use, best first. */
  factIds: string[];
  /** Confirmed skill facts that match the job, printed verbatim. */
  skillIds: string[];
  /** Requirements with no supporting fact. */
  gaps: string[];
}

export interface DraftLine {
  id: string;
  /** null for the summary line. */
  roleId: string | null;
  text: string;
  factIds: string[];
  status?: LineStatus;
}

export interface Draft {
  lines: DraftLine[];
}

export interface VerifiedDraft {
  lines: DraftLine[];
  report: ResumeReport;
}

export interface TailorInput {
  applicationId: string;
  jdText: string;
  analysis: Analysis | null;
  selection: Selection | null;
  draft: Draft | null;
  verified: VerifiedDraft | null;
  facts: FactRecord[];
  roles: RoleRecord[];
}

export interface RenderData {
  profile: import("./api").Profile;
  body: ResumeBody;
  version: number;
  company: string | null;
  title: string | null;
}
