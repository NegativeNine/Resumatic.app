import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { directory } from "../../src/shared/stubs";
import { nowSeconds, rsaSigner } from "../support/keys";
import { call } from "./support";

const global = directory(env);
const ids = [1, 2, 3].map((n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const email = "private-inventory-email@example.test";
const subject = "private-inventory-subject";
const token = "11111111-1111-4111-8111-111111111111";
let headers: Record<string, string>;

beforeAll(async () => {
  const signer = await rsaSigner();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (String(input instanceof Request ? input.url : input) === `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`)
      return Response.json(signer.jwks);
    return new Response("unexpected fetch", { status: 599 });
  });
  headers = { "cf-access-jwt-assertion": await signer.sign({ iss: env.ACCESS_TEAM_DOMAIN, aud: [env.ACCESS_AUD], email: "admin@example.com", exp: nowSeconds() + 600 }) };
  await runInDurableObject(global, (_instance, ctx) => {
    const sql = ctx.storage.sql;
    for (const operation of ids.slice(0, 2)) {
      sql.exec(`INSERT INTO invite_revocation_barrier(slot,operation_id,email,email_fingerprint,generation,created_at) VALUES (1,?,?,?,NULL,?)`, operation, `${operation}@example.test`, "a".repeat(64), Date.now());
      sql.exec(`INSERT INTO invite_quarantine_marker(slot,operation_id) VALUES (1,?)`, operation);
      sql.exec(`INSERT INTO invite_revocation_quarantines(operation_id,email,email_fingerprint,generation,created_at)
        SELECT operation_id,email,email_fingerprint,generation,created_at FROM invite_revocation_barrier WHERE operation_id=?`, operation);
      sql.exec(`DELETE FROM invite_revocation_barrier WHERE operation_id=?`, operation);
      sql.exec(`DELETE FROM invite_quarantine_marker WHERE slot=1`);
    }
    sql.exec(`INSERT INTO invite_revocation_claims(operation_id,token,provider,subject,shard,email,generation,state,user_id,vault_id)
      VALUES (?,?,'google',?,0,?,NULL,'created',?,?)`, ids[1], crypto.randomUUID(), `${subject}-created`, email, `s0:${crypto.randomUUID()}`, "c".repeat(64));
    sql.exec(`INSERT INTO invite_revocation_barrier(slot,operation_id,email,email_fingerprint,generation,created_at) VALUES (1,?,?,?,NULL,?)`, ids[2], email, "b".repeat(64), Date.now());
    sql.exec(`INSERT INTO invite_revocation_claims(operation_id,token,provider,subject,shard,email,generation,state)
      VALUES (?,?,'google',?,0,?,NULL,'pending')`, ids[2], token, subject, email);
  });
});

afterAll(async () => {
  try {
    await runInDurableObject(global, (_instance, ctx) => {
      const sql = ctx.storage.sql;
      sql.exec(`DELETE FROM invite_revocation_claims WHERE operation_id IN (?,?)`, ids[1], ids[2]);
      sql.exec(`DELETE FROM invite_revocation_barrier WHERE operation_id=?`, ids[2]);
      for (const operation of ids.slice(0, 2)) {
        sql.exec(`INSERT INTO invite_quarantine_marker(slot,operation_id) VALUES (1,?)`, operation);
        sql.exec(`DELETE FROM invite_revocation_quarantines WHERE operation_id=?`, operation);
        sql.exec(`DELETE FROM invite_quarantine_marker WHERE slot=1`);
      }
    });
  } finally { vi.unstubAllGlobals(); }
});

it("requires Cloudflare Access for the inventory", async () => {
  expect((await call("/admin/invites/revocations")).status).toBe(403);
  expect((await call("/admin/invites/revocations", { headers: { "cf-access-jwt-assertion": "invalid" } })).status).toBe(403);
});

it("paginates pending and quarantined operations without exposing claim content or mutating state", async () => {
  const before = await global.inviteRevocationStatus(ids[2]!);
  const first = await call("/admin/invites/revocations?limit=1", { headers });
  expect(first.status).toBe(200);
  const a = await first.json() as { operations: unknown[]; nextCursor: string | null };
  expect(a).toEqual({ operations: [{ operationId: ids[0], phase: "quarantined", remaining: 0, orphans: 0 }], nextCursor: ids[0] });
  const second = await (await call(`/admin/invites/revocations?limit=1&after=${a.nextCursor}`, { headers })).json() as { operations: unknown[]; nextCursor: string | null };
  expect(second).toEqual({ operations: [{ operationId: ids[1], phase: "quarantined", remaining: 1, orphans: 1 }], nextCursor: ids[1] });
  const third = await (await call(`/admin/invites/revocations?limit=1&after=${second.nextCursor}`, { headers })).json() as { operations: unknown[]; nextCursor: string | null };
  expect(third).toEqual({ operations: [{ operationId: ids[2], phase: "active", remaining: 1, orphans: 0 }], nextCursor: null });
  const output = JSON.stringify([a, second, third]);
  for (const secret of [email, subject, token, "a".repeat(64), "b".repeat(64)]) expect(output).not.toContain(secret);
  expect(await global.inviteRevocationStatus(ids[2]!)).toEqual(before);
});

it("rejects malformed or duplicate pagination parameters", async () => {
  for (const query of ["?limit=0", "?limit=101", "?limit=01", "?after=bad", "?after=", "?limit=1&limit=2", `?after=${ids[0]}&after=${ids[1]}`])
    expect((await call(`/admin/invites/revocations${query}`, { headers })).status, query).toBe(422);
});

it("shows inherited inventory without inventing an outcome", async () => {
  const operation = "00000000-0000-4000-8000-000000000004";
  await runInDurableObject(global, (_instance, ctx) => ctx.storage.sql.exec(`INSERT INTO invite_revocation_legacy_operations(operation_id) VALUES (?)`, operation));
  try {
    const response = await call(`/admin/invites/revocations?after=${ids[2]}`, { headers });
    expect(await response.json()).toEqual({ operations: [{ operationId: operation, phase: "inventory", remaining: 1, orphans: 0, inventoryPending: true }], nextCursor: null });
  } finally {
    await runInDurableObject(global, (_instance, ctx) => {
      const sql = ctx.storage.sql;
      sql.exec(`INSERT INTO invite_revocation_legacy_marker(slot,operation_id) VALUES (1,?)`, operation);
      sql.exec(`INSERT INTO invite_revocation_legacy_proofs(operation_id,local_orphans,scanned_at) VALUES (?,0,?)`, operation, Date.now());
      sql.exec(`DELETE FROM invite_revocation_legacy_operations WHERE operation_id=?`, operation);
      sql.exec(`DELETE FROM invite_revocation_legacy_marker WHERE slot=1`);
    });
  }
});

it("fails closed on malformed stored operation IDs including an empty ID", async () => {
  for (const operation of ["", "invalid"]) {
    await runInDurableObject(global, (_instance, ctx) => ctx.storage.sql.exec(`INSERT INTO invite_revocation_legacy_operations(operation_id) VALUES (?)`, operation));
    try { expect((await call("/admin/invites/revocations", { headers })).status).toBe(503); }
    finally {
      await runInDurableObject(global, (_instance, ctx) => {
        const sql = ctx.storage.sql;
        sql.exec(`INSERT INTO invite_revocation_legacy_marker(slot,operation_id) VALUES (1,?)`, operation);
        sql.exec(`INSERT INTO invite_revocation_legacy_proofs(operation_id,local_orphans,scanned_at) VALUES (?,0,?)`, operation, Date.now());
        sql.exec(`DELETE FROM invite_revocation_legacy_operations WHERE operation_id=?`, operation);
        sql.exec(`DELETE FROM invite_revocation_legacy_marker WHERE slot=1`);
      });
    }
  }
});

it("rejects a duplicate active/quarantine operation even across a page boundary", async () => {
  const operation = ids[2]!;
  await runInDurableObject(global, (_instance, ctx) => {
    const sql = ctx.storage.sql;
    sql.exec(`INSERT INTO invite_quarantine_marker(slot,operation_id) VALUES (1,?)`, operation);
    sql.exec(`INSERT INTO invite_revocation_quarantines(operation_id,email,email_fingerprint,generation,created_at)
      SELECT operation_id,email,email_fingerprint,generation,created_at FROM invite_revocation_barrier WHERE operation_id=?`, operation);
    sql.exec(`DELETE FROM invite_quarantine_marker WHERE slot=1`);
  });
  try { expect((await call(`/admin/invites/revocations?limit=1&after=${ids[1]}`, { headers })).status).toBe(503); }
  finally {
    await runInDurableObject(global, (_instance, ctx) => {
      const sql = ctx.storage.sql;
      sql.exec(`INSERT INTO invite_quarantine_marker(slot,operation_id) VALUES (1,?)`, operation);
      sql.exec(`DELETE FROM invite_revocation_quarantines WHERE operation_id=?`, operation);
      sql.exec(`DELETE FROM invite_quarantine_marker WHERE slot=1`);
    });
  }
});
