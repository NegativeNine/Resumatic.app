import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  MCP_GRANT_TTL_MS,
  oauthSubject,
  type McpClaims,
  type NewMcpGrant,
} from "../../src/shared/mcp";
import { McpGrantStore, MCP_MIGRATIONS } from "../../src/vault/mcp-grants";

const now = 1_800_000_000_000;
const id = "0653389a-0d6d-4e90-94eb-23cc98b95c19";
const who = { userId: "shard:01:owner", gen: 2, epoch: "epoch-one" };
const input: NewMcpGrant = {
  id,
  clientId: "https://client.test/app",
  clientName: "A client",
  scopes: ["vault:read"],
  expiresAt: now + 60_000,
};
function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(statement: string, ...bindings: (string | number | null)[]) {
      const rows = db.prepare(statement).all(...bindings);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
  for (const statement of MCP_MIGRATIONS) sql.exec(statement);
  const security = { gen: who.gen, epoch: who.epoch, open: true };
  const store = new McpGrantStore(sql, {
    authorizeOwner(caller) {
      if (
        !security.open ||
        caller.userId !== who.userId ||
        caller.gen !== security.gen
      )
        throw new Error("owner required");
    },
    requireOpen() {
      if (!security.open) throw new Error("closed");
    },
    currentEpoch() {
      return security.epoch;
    },
  });
  const grant = store.create(who, input, now);
  const claims: McpClaims = {
    uid: who.userId,
    vid: "a".repeat(64),
    gen: who.gen,
    epoch: who.epoch,
    grantId: grant.id,
    clientId: grant.clientId,
    scopes: grant.scopes,
    expiresAt: grant.expiresAt,
  };
  return { db, store, security, claims };
}

describe("MCP grant gate", () => {
  it("requires activation from the token callback, binds once and enforces narrow scopes", () => {
    const { db, store, claims } = fixture();
    try {
      expect(() => store.authorize(claims, "vault:read", now)).toThrow(
        "permission",
      );
      store.bind(claims, "remote_grant_1", now);
      store.bind(claims, "remote_grant_1", now + 1);
      expect(store.authorize(claims, "vault:read", now)).toMatchObject(who);
      expect(() => store.bind(claims, "another_grant", now)).toThrow("expired");
      expect(() => store.authorize(claims, "vault:generate", now)).toThrow(
        "permission",
      );
      expect(() =>
        store.authorize(
          { ...claims, scopes: ["vault:read", "vault:generate"] },
          "vault:generate",
          now,
        ),
      ).toThrow("not granted");
      expect(() =>
        store.authorize({ ...claims, clientId: "other" }, "vault:read", now),
      ).toThrow("no longer valid");
    } finally {
      db.close();
    }
  });
  it("revokes locally before KV cleanup and returns the same cleanup identifier on retry", () => {
    const { db, store, claims } = fixture();
    try {
      store.bind(claims, "remote_grant_1", now);
      expect(store.revoke(who, id, now)).toEqual({
        oauthGrantId: "remote_grant_1",
      });
      expect(store.revoke(who, id, now + 1)).toEqual({
        oauthGrantId: "remote_grant_1",
      });
      expect(() => store.authorize(claims, "vault:read", now)).toThrow(
        "no longer valid",
      );
      expect(() => store.bind(claims, "remote_grant_1", now)).toThrow(
        "no longer valid",
      );
      expect(store.list(who)[0]?.revokedAt).toBe(now);
    } finally {
      db.close();
    }
  });
  it("honors account epoch, sign-out generation, account closing and exact expiry", () => {
    const { db, store, claims, security } = fixture();
    try {
      store.bind(claims, "remote_grant_1", now);
      security.epoch = "restored-epoch";
      expect(() => store.authorize(claims, "vault:read", now)).toThrow(
        "no longer valid",
      );
      security.epoch = who.epoch;
      security.gen++;
      expect(() => store.authorize(claims, "vault:read", now)).toThrow(
        "owner required",
      );
      security.gen = who.gen;
      security.open = false;
      expect(() => store.authorize(claims, "vault:read", now)).toThrow(
        "closed",
      );
      security.open = true;
      expect(() =>
        store.authorize(claims, "vault:read", claims.expiresAt),
      ).toThrow("no longer valid");
      store.purgeExpired(claims.expiresAt);
      expect(store.list(who)).toEqual([]);
    } finally {
      db.close();
    }
  });
  it("rejects missing read scope, excessive lifetime and unauthorized owner methods", () => {
    const { db, store } = fixture();
    try {
      expect(() =>
        store.create(who, { ...input, scopes: ["vault:generate"] }, now),
      ).toThrow("invalid");
      expect(() =>
        store.create(
          who,
          { ...input, expiresAt: now + MCP_GRANT_TTL_MS + 1 },
          now,
        ),
      ).toThrow("invalid");
      expect(() => store.list({ ...who, userId: "other" })).toThrow(
        "owner required",
      );
      expect(() => store.revoke({ ...who, userId: "other" }, id, now)).toThrow(
        "owner required",
      );
    } finally {
      db.close();
    }
  });
  it("encodes account IDs without OAuth storage separators", () => {
    const encoded = oauthSubject(who.userId);
    expect(encoded).not.toContain(":");
    expect(encoded).not.toEqual(oauthSubject("other"));
    expect(oauthSubject("用户:42")).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
