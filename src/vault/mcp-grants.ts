import { AppError } from "../shared/errors";
import {
  MCP_GRANT_TTL_MS,
  MCP_SCOPES,
  McpClaimsSchema,
  type McpClaims,
  type McpGrant,
  type McpScope,
  type NewMcpGrant,
} from "../shared/mcp";
import type { Who } from "../shared/types";

export const MCP_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS mcp_grants (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL, client_name TEXT NOT NULL, scopes TEXT NOT NULL,
    epoch TEXT NOT NULL, gen INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    revoked_at INTEGER, oauth_grant_id TEXT, state TEXT NOT NULL CHECK(state IN ('pending','active','revoked'))
  )`,
  `CREATE INDEX IF NOT EXISTS mcp_grant_expiry ON mcp_grants(expires_at)`,
];
interface GrantRow extends Record<string, SqlStorageValue> {
  id: string;
  client_id: string;
  client_name: string;
  scopes: string;
  epoch: string;
  gen: number;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  oauth_grant_id: string | null;
  state: "pending" | "active" | "revoked";
}
function view(row: GrantRow): McpGrant {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    scopes: JSON.parse(row.scopes),
    epoch: row.epoch,
    gen: row.gen,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    oauthGrantId: row.oauth_grant_id,
    state: row.state,
  };
}

/** Strongly consistent permission gate. OAuth KV is an additional credential store, never this gate. */
export class McpGrantStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly auth: {
      authorizeOwner(who: Who): void;
      requireOpen(): void;
      currentEpoch(): string;
    },
  ) {}

  create(who: Who, input: NewMcpGrant, now = Date.now()): McpGrant {
    this.auth.authorizeOwner(who);
    if (
      !/^[0-9a-f-]{36}$/i.test(input.id) ||
      !input.clientId ||
      input.clientId.length > 2048 ||
      !input.clientName ||
      input.clientName.length > 200 ||
      !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= now ||
      input.expiresAt > now + MCP_GRANT_TTL_MS ||
      !input.scopes.includes("vault:read") ||
      new Set(input.scopes).size !== input.scopes.length ||
      input.scopes.some((s) => !MCP_SCOPES.includes(s))
    )
      throw new AppError("invalid", "invalid connected app grant");
    const count =
      this.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM mcp_grants WHERE revoked_at IS NULL AND expires_at > ?`,
          now,
        )
        .toArray()[0]?.count ?? 0;
    if (count >= 100)
      throw new AppError("quota", "revoke an existing connected app first");
    const grant: McpGrant = {
      ...input,
      scopes: [...input.scopes],
      epoch: this.auth.currentEpoch(),
      gen: who.gen,
      createdAt: now,
      revokedAt: null,
      oauthGrantId: null,
      state: "pending",
    };
    this.sql.exec(
      `INSERT INTO mcp_grants (id, client_id, client_name, scopes, epoch, gen, created_at, expires_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      grant.id,
      grant.clientId,
      grant.clientName,
      JSON.stringify(grant.scopes),
      grant.epoch,
      grant.gen,
      now,
      grant.expiresAt,
    );
    return grant;
  }

  private checked(claims: McpClaims, now: number): GrantRow {
    this.auth.requireOpen();
    if (!McpClaimsSchema.safeParse(claims).success)
      throw new AppError("forbidden", "invalid connected app grant");
    const who = { userId: claims.uid, gen: claims.gen, epoch: claims.epoch };
    this.auth.authorizeOwner(who);
    const row = this.sql
      .exec<GrantRow>(`SELECT * FROM mcp_grants WHERE id = ?`, claims.grantId)
      .toArray()[0];
    if (
      !row ||
      row.revoked_at !== null ||
      row.state === "revoked" ||
      row.expires_at <= now ||
      claims.expiresAt <= now ||
      claims.expiresAt !== row.expires_at ||
      row.epoch !== this.auth.currentEpoch() ||
      row.epoch !== claims.epoch ||
      row.gen !== claims.gen ||
      row.client_id !== claims.clientId
    )
      throw new AppError(
        "forbidden",
        "connected app access is no longer valid",
      );
    const scopes = JSON.parse(row.scopes) as McpScope[];
    if (claims.scopes.some((s) => !scopes.includes(s)))
      throw new AppError("forbidden", "connected app scope was not granted");
    return row;
  }

  /** Only the provider's authenticated token callback calls this; a grant ID cannot be rebound. */
  bind(claims: McpClaims, oauthGrantId: string, now = Date.now()): void {
    const row = this.checked(claims, now);
    if (
      !/^[A-Za-z0-9_-]{1,200}$/.test(oauthGrantId) ||
      (row.oauth_grant_id !== null && row.oauth_grant_id !== oauthGrantId) ||
      (row.state === "pending" && now >= row.created_at + 600_000)
    )
      throw new AppError("forbidden", "connected app authorization expired");
    this.sql.exec(
      `UPDATE mcp_grants SET oauth_grant_id = ?, state = 'active' WHERE id = ?`,
      oauthGrantId,
      claims.grantId,
    );
  }

  authorize(claims: McpClaims, requiredScope: McpScope, now = Date.now()): Who {
    const row = this.checked(claims, now);
    if (
      row.state !== "active" ||
      !row.oauth_grant_id ||
      !claims.scopes.includes(requiredScope) ||
      !(JSON.parse(row.scopes) as McpScope[]).includes(requiredScope)
    )
      throw new AppError("forbidden", "connected app permission is required");
    return { userId: claims.uid, gen: claims.gen, epoch: claims.epoch } as Who;
  }

  list(who: Who): McpGrant[] {
    this.auth.authorizeOwner(who);
    return this.sql
      .exec<GrantRow>(
        `SELECT * FROM mcp_grants ORDER BY created_at DESC LIMIT 200`,
      )
      .toArray()
      .map(view);
  }

  revoke(
    who: Who,
    id: string,
    now = Date.now(),
  ): { oauthGrantId: string | null } {
    this.auth.authorizeOwner(who);
    const row = this.sql
      .exec<GrantRow>(`SELECT * FROM mcp_grants WHERE id = ?`, id)
      .toArray()[0];
    this.sql.exec(
      `UPDATE mcp_grants SET state = 'revoked', revoked_at = COALESCE(revoked_at, ?) WHERE id = ?`,
      now,
      id,
    );
    return { oauthGrantId: row?.oauth_grant_id ?? null };
  }

  purgeExpired(now = Date.now()): void {
    this.sql.exec(
      `DELETE FROM mcp_grants WHERE expires_at <= ? OR (state = 'pending' AND created_at <= ?)`,
      now,
      now - 600_000,
    );
  }

  /**
   * When `purgeExpired` next has a row to delete, or null when none is held. The Vault sets its
   * alarm by this: an account that only connected an app has nothing else that would wake it.
   */
  nextAlarm(): number | null {
    const row = this.sql
      .exec<{ at: number | null }>(
        `SELECT MIN(CASE WHEN state = 'pending' THEN MIN(expires_at, created_at + ?) ELSE expires_at END) AS at FROM mcp_grants`,
        600_000,
      )
      .toArray()[0];
    return row?.at ?? null;
  }
}
