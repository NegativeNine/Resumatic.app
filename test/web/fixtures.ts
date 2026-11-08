import type { ApplicationView, FactView, Me, ResumeView, RoleView, SourceView } from "../../src/shared/api";
import data from "./fixtures.json";

/** Everything the fake API serves. The JSON is shared with the screenshot script. */
export interface Fixtures {
  me: Me;
  sources: SourceView[];
  roles: RoleView[];
  facts: FactView[];
  applications: ApplicationView[];
  resumes: Record<string, ResumeView>;
}

/** A fresh, deep copy of the fixtures, so a test can change it freely. */
export function fixtures(): Fixtures {
  return structuredClone(data) as unknown as Fixtures;
}

/** Sam's vault before anything has been uploaded. */
export function emptyVault(): Fixtures {
  return { ...fixtures(), sources: [], roles: [], facts: [], applications: [], resumes: {} };
}
