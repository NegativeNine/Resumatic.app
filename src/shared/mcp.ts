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
