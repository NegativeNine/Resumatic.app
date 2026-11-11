import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { COACH_CLIENT_KEPT_MS } from "../../src/shared/sharing";
import { COACH_CLIENT_MIGRATIONS, CoachClientStore, MAX_COACH_CLIENTS } from "../../src/vault/coach-clients";

const now = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const vaultId = (letter: string) => letter.repeat(64);
const grantId = (n: number) => `0653389a-0d6d-4e90-94eb-${String(n).padStart(12, "0")}`;

function store() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(statement: string, ...bindings: (string | number | null)[]) {
      const values = db.prepare(statement).all(...bindings);
      return {
        toArray: () => values,
        one: () => {
          if (values.length !== 1) throw new Error("expected exactly one row");
          return values[0];
        },
      };
    },
  } as unknown as SqlStorage;
  for (const migration of COACH_CLIENT_MIGRATIONS) sql.exec(migration);
  const rows = () => (db.prepare(`SELECT COUNT(*) AS n FROM coach_clients`).get() as { n: number }).n;
  return { clients: new CoachClientStore(sql), db, rows };
}

describe("a coach's client list", () => {
  it("keeps where each copy lives, newest first, and exports everything but that", () => {
    const { clients, db } = store();
    try {
      clients.add({ grantId: grantId(1), ownerVault: vaultId("a"), ownerName: "Sam Rivera", expiresAt: now + 7 * DAY }, now);
      clients.add({ grantId: grantId(2), ownerVault: vaultId("b"), ownerName: null, expiresAt: now + 3 * DAY }, now + 5);
      expect(clients.list(now + 10)).toEqual([
        { grantId: grantId(2), ownerVault: vaultId("b"), ownerName: null, addedAt: now + 5, expiresAt: now + 3 * DAY },
        { grantId: grantId(1), ownerVault: vaultId("a"), ownerName: "Sam Rivera", addedAt: now, expiresAt: now + 7 * DAY },
      ]);
      expect(clients.count(now + 10)).toBe(2);
      expect(clients.get(grantId(1), now + 10)).toMatchObject({ ownerVault: vaultId("a"), ownerName: "Sam Rivera" });
      expect(clients.get(grantId(3), now + 10)).toBeNull();
      // The export says whose copy and until when. Where it is kept never leaves the server.
      expect(clients.export(now + 10)).toEqual([
        { grantId: grantId(2), ownerName: null, addedAt: now + 5, expiresAt: now + 3 * DAY },
        { grantId: grantId(1), ownerName: "Sam Rivera", addedAt: now, expiresAt: now + 7 * DAY },
      ]);
      expect(JSON.stringify(clients.export(now + 10))).not.toContain(vaultId("a"));

      // Adding one already there refreshes what the list says and keeps when it was first added.
      clients.add({ grantId: grantId(1), ownerVault: vaultId("a"), ownerName: `  ${"S".repeat(300)}`, expiresAt: now + 6 * DAY }, now + 99);
      expect(clients.get(grantId(1), now + 100)).toEqual({
        grantId: grantId(1), ownerVault: vaultId("a"), ownerName: `  ${"S".repeat(198)}`, addedAt: now, expiresAt: now + 6 * DAY,
      });
      expect(clients.count(now + 100)).toBe(2);

      clients.remove(grantId(1));
      clients.remove(grantId(1));
      expect(clients.list(now + 100).map((client) => client.grantId)).toEqual([grantId(2)]);
    } finally { db.close(); }
  });

  it("takes only a copy's ID, a vault's ID and a whole-number expiry", () => {
    const { clients, db, rows } = store();
    try {
      const good = { grantId: grantId(1), ownerVault: vaultId("a"), ownerName: "Sam Rivera", expiresAt: now + DAY };
      for (const bad of [
        { ...good, grantId: "not-a-grant" },
        { ...good, grantId: `${grantId(1)}'` },
        { ...good, ownerVault: "a".repeat(63) },
        { ...good, ownerVault: "A".repeat(64) },
        { ...good, ownerVault: `${"a".repeat(63)}/` },
        { ...good, expiresAt: Number.NaN },
        { ...good, expiresAt: 1.5 },
      ])
        expect(() => clients.add(bad, now), JSON.stringify(bad)).toThrow("this copy can't be added");
      expect(rows()).toBe(0);
    } finally { db.close(); }
  });

  it("holds a bounded number, and a full list still refreshes one already on it", () => {
    const { clients, db } = store();
    try {
      for (let n = 0; n < MAX_COACH_CLIENTS; n++)
        clients.add({ grantId: grantId(n), ownerVault: vaultId("a"), ownerName: null, expiresAt: now + DAY }, now + n);
      expect(clients.count(now + DAY)).toBe(MAX_COACH_CLIENTS);
      expect(() => clients.add({ grantId: grantId(MAX_COACH_CLIENTS), ownerVault: vaultId("a"), ownerName: null, expiresAt: now + DAY }, now + DAY)).toThrow("your client list is full");
      clients.add({ grantId: grantId(0), ownerVault: vaultId("a"), ownerName: "Sam Rivera", expiresAt: now + 2 * DAY }, now + DAY);
      expect(clients.get(grantId(0), now + DAY)).toMatchObject({ ownerName: "Sam Rivera", addedAt: now });
      clients.remove(grantId(1));
      clients.add({ grantId: grantId(MAX_COACH_CLIENTS), ownerVault: vaultId("a"), ownerName: null, expiresAt: now + DAY }, now + DAY);
      expect(clients.count(now + DAY)).toBe(MAX_COACH_CLIENTS);
    } finally { db.close(); }
  });

  it("says whether a copy fits before anything is added, by the rule adding goes by", () => {
    const { clients, db, rows } = store();
    try {
      clients.requireRoom(grantId(0), now);
      for (let n = 0; n < MAX_COACH_CLIENTS; n++)
        clients.add({ grantId: grantId(n), ownerVault: vaultId("a"), ownerName: null, expiresAt: now + DAY }, now);
      // Full: a new copy is refused, one already on the list is not, and asking changes nothing.
      expect(() => clients.requireRoom(grantId(MAX_COACH_CLIENTS), now)).toThrow("your client list is full; remove a copy that has ended, then add this one");
      clients.requireRoom(grantId(0), now);
      expect(rows()).toBe(MAX_COACH_CLIENTS);
      // Entries past their time leave room, cleared away or not.
      clients.requireRoom(grantId(MAX_COACH_CLIENTS), now + DAY + COACH_CLIENT_KEPT_MS);
      expect(rows()).toBe(MAX_COACH_CLIENTS);
    } finally { db.close(); }
  });

  it("drops an entry a fixed time after its copy's last day, whether or not it has been cleared away", () => {
    const { clients, db, rows } = store();
    try {
      const expiresAt = now + DAY;
      clients.add({ grantId: grantId(1), ownerVault: vaultId("a"), ownerName: "Sam Rivera", expiresAt }, now);
      // Past the copy's last day the entry stays, so the coach sees that access ended.
      const lastMoment = expiresAt + COACH_CLIENT_KEPT_MS - 1;
      expect(clients.list(lastMoment)).toHaveLength(1);
      expect(clients.count(lastMoment)).toBe(1);
      expect(clients.get(grantId(1), lastMoment)).not.toBeNull();
      // Then it is gone from every read at once, before anything deletes it.
      const lapsed = expiresAt + COACH_CLIENT_KEPT_MS;
      expect(clients.list(lapsed)).toEqual([]);
      expect(clients.count(lapsed)).toBe(0);
      expect(clients.get(grantId(1), lapsed)).toBeNull();
      expect(clients.export(lapsed)).toEqual([]);
      expect(rows()).toBe(1);
      clients.purge(lastMoment);
      expect(rows()).toBe(1);
      clients.purge(lapsed);
      expect(rows()).toBe(0);
    } finally { db.close(); }
  });

  it("says when its next entry is due to be cleared, which is the moment clearing takes it", () => {
    const { clients, db, rows } = store();
    try {
      expect(clients.nextAlarm()).toBeNull();
      clients.add({ grantId: grantId(1), ownerVault: vaultId("a"), ownerName: null, expiresAt: now + 3 * DAY }, now);
      clients.add({ grantId: grantId(2), ownerVault: vaultId("b"), ownerName: null, expiresAt: now + DAY }, now);
      const first = now + DAY + COACH_CLIENT_KEPT_MS;
      expect(clients.nextAlarm()).toBe(first);
      // An alarm at that moment finds the entry due, so it never has to come back for it.
      clients.purge(first - 1);
      expect(rows()).toBe(2);
      clients.purge(first);
      expect(rows()).toBe(1);
      expect(clients.nextAlarm()).toBe(now + 3 * DAY + COACH_CLIENT_KEPT_MS);
      clients.remove(grantId(1));
      expect(clients.nextAlarm()).toBeNull();
    } finally { db.close(); }
  });

  it("doesn't count lapsed entries against the limit, and clears them when a copy is added", () => {
    const { clients, db, rows } = store();
    try {
      for (let n = 0; n < MAX_COACH_CLIENTS; n++)
        clients.add({ grantId: grantId(n), ownerVault: vaultId("a"), ownerName: null, expiresAt: now + DAY }, now);
      const later = now + DAY + COACH_CLIENT_KEPT_MS;
      clients.add({ grantId: grantId(MAX_COACH_CLIENTS), ownerVault: vaultId("b"), ownerName: "Sam Rivera", expiresAt: later + DAY }, later);
      expect(clients.list(later).map((client) => client.grantId)).toEqual([grantId(MAX_COACH_CLIENTS)]);
      expect(rows()).toBe(1);
    } finally { db.close(); }
  });
});
