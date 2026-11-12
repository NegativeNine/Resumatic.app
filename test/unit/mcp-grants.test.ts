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
  it("counts only active grants, not pending, revoked or expired ones", () => {
    const { db, store, claims } = fixture();
    try {
      // The fixture's grant is pending until its token callback binds it.
      expect(store.activeCount(now)).toBe(0);
      store.bind(claims, "remote_grant_1", now);
      expect(store.activeCount(now)).toBe(1);
      // At the moment it expires it is no longer counted, before any cleanup.
      expect(store.activeCount(claims.expiresAt - 1)).toBe(1);
      expect(store.activeCount(claims.expiresAt)).toBe(0);
      const second = { ...input, id: "1653389a-0d6d-4e90-94eb-23cc98b95c19" };
      store.create(who, second, now);
      store.bind({ ...claims, grantId: second.id }, "remote_grant_2", now);
      expect(store.activeCount(now)).toBe(2);
      store.revoke(who, id, now);
      expect(store.activeCount(now)).toBe(1);
      // A grant marked active but revoked is not counted either.
      db.prepare(`UPDATE mcp_grants SET state = 'active' WHERE id = ?`).run(id);
      expect(store.activeCount(now)).toBe(1);
    } finally {
      db.close();
    }
  });
  it("says when its next grant is due to be erased, which is the moment erasing takes it", () => {
    const { db, store, claims } = fixture();
    try {
      expect(store.nextAlarm()).toBe(input.expiresAt);
      store.bind(claims, "remote_grant_1", now);
      // A bound grant is erased when it ends, revoked or not.
      const later = store.create(who, { ...input, id: "1653389a-0d6d-4e90-94eb-23cc98b95c19", expiresAt: now + MCP_GRANT_TTL_MS }, now);
      expect(store.nextAlarm()).toBe(input.expiresAt);
      store.revoke(who, id, now);
      expect(store.nextAlarm()).toBe(input.expiresAt);
      store.purgeExpired(input.expiresAt - 1);
      expect(store.list(who)).toHaveLength(2);
      store.purgeExpired(input.expiresAt);
      expect(store.list(who).map((grant) => grant.id)).toEqual([later.id]);
      // A grant still waiting for its token is erased ten minutes after it was made.
      expect(store.nextAlarm()).toBe(now + 600_000);
      store.purgeExpired(now + 600_000 - 1);
      expect(store.list(who)).toHaveLength(1);
      store.purgeExpired(now + 600_000);
      expect(store.list(who)).toEqual([]);
      expect(store.nextAlarm()).toBeNull();
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
