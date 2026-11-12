import type { ApplicationView, FactView, Me, ResumeView, RoleView, SourceView } from "../../src/shared/api";
import type { DocumentView } from "../../src/shared/documents";
import type { EmailNotices } from "../../src/shared/email-notices";
import type { Preferences } from "../../src/shared/preferences";
import type { CardPreview } from "../../src/shared/card";
import type { McpGrant } from "../../src/shared/mcp";
import type { CoachClient, CommentThread, OwnerCommentThread, ShareGrant, SharedView } from "../../src/shared/sharing";
import type { BillingView } from "../../src/web/api";
import data from "./fixtures.json";
import full from "./fixtures-full.json";

/** Everything the fake API serves. The JSON is shared with the screenshot script. */
export interface Fixtures {
  me: Me;
  /** The person's job preferences as saved. Absent until they first save: nothing said, at revision 0. */
  preferences?: Preferences;
  /** The owner's card preview. Absent: a ready card with nothing on it, as every vault has today. */
  cardPreview?: CardPreview;
  /** Which email notices are on, and the address they go to. Absent: every kind off, to the session's address. */
  emailNotices?: EmailNotices;
  sources: SourceView[];
  /** What each source was read as, by its ID, for "See this quote in its source". */
  sourceTexts?: Record<string, string>;
  roles: RoleView[];
  facts: FactView[];
  applications: ApplicationView[];
  resumes: Record<string, ResumeView>;
  /** The screens that are empty by default: documents, share links, connected apps, plans. */
  documents?: DocumentView[];
  shares?: ShareGrant[];
  /** The copies other people have shared with this account as their coach. */
  clients?: CoachClient[];
  /** What this account has written as a coach on the copy it is reading, with the owner's replies. */
  coachComments?: CommentThread[];
  /** What coaches have written on the copies this account shared, with its own replies. */
  shareComments?: OwnerCommentThread[];
  mcpGrants?: McpGrant[];
  billing?: BillingView;
}

/** A fresh, deep copy of the fixtures, so a test can change it freely. */
export function fixtures(): Fixtures {
  return structuredClone(data) as unknown as Fixtures;
}

/** Sam’s vault before anything has been uploaded. */
export function emptyVault(): Fixtures {
  return { ...fixtures(), sources: [], roles: [], facts: [], applications: [], resumes: {} };
}

/** Sam’s vault with every optional screen filled in: documents in each state, share links, apps, plans, a card. */
export function fullVault(): Fixtures {
  const { shared: _shared, ...extras } = structuredClone(full) as unknown as Required<Pick<Fixtures, "documents" | "shares" | "mcpGrants" | "billing" | "cardPreview" | "emailNotices">> & { shared: SharedView };
  const state = { ...fixtures(), ...extras };
  state.me.capabilities = { ocr: false, ...state.me.capabilities, connectedApps: true, cardPreview: true, emailNotices: true };
  return state;
}

/** The fixed copy a coach sees at /share. */
export function sharedView(): SharedView {
  return structuredClone(full.shared) as unknown as SharedView;
}
