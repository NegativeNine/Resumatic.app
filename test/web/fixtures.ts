import type { ApplicationView, FactView, Me, ResumeView, RoleView, SourceView } from "../../src/shared/api";
import type { DocumentView } from "../../src/shared/documents";
import type { McpGrant } from "../../src/shared/mcp";
import type { ShareGrant, SharedView } from "../../src/shared/sharing";
import type { BillingView } from "../../src/web/api";
import data from "./fixtures.json";
import full from "./fixtures-full.json";

/** Everything the fake API serves. The JSON is shared with the screenshot script. */
export interface Fixtures {
  me: Me;
  sources: SourceView[];
  roles: RoleView[];
  facts: FactView[];
  applications: ApplicationView[];
  resumes: Record<string, ResumeView>;
  /** The screens that are empty by default: documents, share links, connected apps, plans. */
  documents?: DocumentView[];
  shares?: ShareGrant[];
  mcpGrants?: McpGrant[];
  billing?: BillingView;
}

/** A fresh, deep copy of the fixtures, so a test can change it freely. */
export function fixtures(): Fixtures {
  return structuredClone(data) as unknown as Fixtures;
}

/** Sam's vault before anything has been uploaded. */
export function emptyVault(): Fixtures {
  return { ...fixtures(), sources: [], roles: [], facts: [], applications: [], resumes: {} };
}

/** Sam's vault with every optional screen filled in: documents in each state, share links, apps, plans. */
export function fullVault(): Fixtures {
  const { shared: _shared, ...extras } = structuredClone(full) as unknown as Required<Pick<Fixtures, "documents" | "shares" | "mcpGrants" | "billing">> & { shared: SharedView };
  const state = { ...fixtures(), ...extras };
  state.me.capabilities = { ocr: false, ...state.me.capabilities, connectedApps: true };
  return state;
}

/** The fixed copy a coach sees at /share. */
export function sharedView(): SharedView {
  return structuredClone(full.shared) as unknown as SharedView;
}
