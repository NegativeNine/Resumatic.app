import { z } from "zod";

export const MCP_SCOPES = [
  "vault:read",
  "vault:generate",
  // See saved jobs and add new ones. Separate from reading facts, because a list of jobs shows
  // where someone is applying.
  "vault:jobs",
  "offline_access",
] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
/**
 * A fit preview takes the one generation slot and spends from the daily model budget, answers
 * about a saved posting, and returns what facts say: all three permissions, together.
 */
export const MCP_FIT_SCOPES = ["vault:read", "vault:jobs", "vault:generate"] as const satisfies readonly McpScope[];
/** Fit previews connected apps together may start on one account in a UTC day. The owner's own are not counted. */
export const MAX_APP_FIT_STARTS_PER_DAY = 20;
/** One requirement read from a job's posting, with the id and present wording of each confirmed fact matched to it. */
export interface McpFitRequirement {
  text: string;
  facts: { id: string; text: string }[];
}
/** What `preview_fit` answers. Each state is an ordinary answer: refusals are the tool's one denial sentence. */
export type McpFit =
  | { state: "ready"; applicationId: string; checkedAt: number; requirements: McpFitRequirement[]; note: string }
  | { state: "preparing" | "busy" | "changed" | "failed" | "limit"; applicationId: string; message: string };
/** The fixed sentences of `preview_fit`'s answers, read by the app's model. */
export const MCP_FIT_TEXT = {
  note: "A requirement with no facts beside it means none of the person's confirmed facts was matched to it. It doesn't mean they lack that experience, and it isn't a score.",
  noRequirements: "No requirements could be read from this job's posting.",
  preparing: "This fit preview is being prepared. Ask again in a few seconds with the same requestKey.",
  busy: "Another resume or document is still being made, and Resumatic works on one at a time. Wait for it to finish, then try again.",
  changed: "The job's posting or the person's confirmed facts changed after this preview was made. Ask again with a new requestKey.",
  failed: "This fit preview couldn't be finished. Ask again with a new requestKey.",
  stopped: "This fit preview stopped at a usage limit. Ask again later with a new requestKey.",
  limit: "Connected apps have started as many fit previews as this account allows in one day. Ask again tomorrow.",
} as const;
export const MCP_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const McpClaimsSchema = z
  .object({
    uid: z.string().min(1).max(200),
    vid: z.string().regex(/^[a-f0-9]{64}$/i),
    gen: z.number().int().nonnegative(),
    epoch: z.string().min(1).max(128),
    grantId: z.uuid(),
    clientId: z.string().min(1).max(2048),
    scopes: z.array(z.enum(MCP_SCOPES)).min(1).max(MCP_SCOPES.length),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type McpClaims = z.infer<typeof McpClaimsSchema>;
export interface NewMcpGrant {
  id: string;
  clientId: string;
  clientName: string;
  scopes: McpScope[];
  expiresAt: number;
}
export interface McpGrant extends NewMcpGrant {
  epoch: string;
  gen: number;
  createdAt: number;
  revokedAt: number | null;
  oauthGrantId: string | null;
  state: "pending" | "active" | "revoked";
}

/** OAuth's storage format disallows colons in subjects; account IDs remain unchanged elsewhere. */
export function oauthSubject(userId: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(userId)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
