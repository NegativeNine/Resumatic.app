import { DurableObject } from "cloudflare:workers";
import { PILOT_SCHEMA, PilotLedger } from "./ledger";

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
}
