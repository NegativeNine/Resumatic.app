import { DurableObject } from "cloudflare:workers";
import { PILOT_SCHEMA, PilotLedger, type PilotIdentityPath } from "./ledger";

/** Staging's one shared pilot ledger; it never receives model inputs or outputs. */
export class PilotBudget extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => {
        for (const statement of PILOT_SCHEMA) ctx.storage.sql.exec(statement);
      });
    });
  }

  private ledger(): PilotLedger {
    return new PilotLedger(this.ctx.storage.sql, (fn) => this.ctx.storage.transactionSync(fn));
  }

  initialize(maxMicros: number, maxCalls: number): void { this.ledger().initialize(maxMicros, maxCalls); }
  reserve(id: string, micros: number, calls: number): void { this.ledger().reserve(id, micros, calls); }
  settle(id: string, actualMicros: number | null): { frozen: boolean } { return this.ledger().settle(id, actualMicros); }
  freeze(): void { this.ledger().freeze(); }
  status() { return this.ledger().status(); }
  async auditAttempts() {
    // Capture synchronously before hashing: entries from one response describe
    // one local snapshot even if another request settles while Web Crypto runs.
    const { attempts, totals } = this.ledger().auditAttempts();
    const secret = this.env.PILOT_BUDGET_KEY;
    if (!secret || new TextEncoder().encode(secret).length < 32) throw new Error("pilot key unavailable");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const hashed = await Promise.all(attempts.map(async ({ id, ...rest }) => {
      const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`resumatic-pilot-attempt-v1:${id}`));
      return { idMac: [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join(""), ...rest };
    }));
    return { totals, attempts: hashed.sort((a, b) => a.idMac.localeCompare(b.idMac)) };
  }
  beginIdentity(nonce: string, path: PilotIdentityPath, vaultId: string, workerVersion: string) { return this.ledger().beginIdentity(nonce, path, vaultId, workerVersion); }
  observeIdentity(path: PilotIdentityPath | null, vaultId: string, runId: string, step: string, runtimeVersion: string) { return this.ledger().observeIdentity(path, vaultId, runId, step, runtimeVersion); }
  identityStatus(nonce: string) { return this.ledger().identityStatus(nonce); }
  consumeIdentity(nonce: string, runId: string) { return this.ledger().consumeIdentity(nonce, runId); }
}
