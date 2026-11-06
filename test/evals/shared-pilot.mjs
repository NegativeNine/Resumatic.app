// A configured HTTPS origin and shared secret do not prove this HTTP endpoint
// reaches the same Cloudflare account and Durable Object namespace as Worker
// model calls. Keep real dispatch closed until that binding is verified.
export const SHARED_PILOT_IDENTITY_VERIFIED = false;

/** Authenticated, fixed-name staging coordinator. Never sends model inputs or outputs. */
export class SharedPilotBudget {
  #identityProbes = new Map();
  constructor(origin, key, fetcher = fetch) {
    let url;
    try { url = new URL(origin); } catch { throw new Error("shared_pilot_configuration_required"); }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        typeof key !== "string" || new TextEncoder().encode(key).length < 32)
      throw new Error("shared_pilot_configuration_required");
    this.origin = url.origin;
    this.key = key;
    this.fetcher = fetcher;
  }
  async #call(action, body) {
    let response;
    try {
      response = await this.fetcher(`${this.origin}/auth/test/pilot-budget/${action}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-pilot-budget-key": this.key, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error", signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new Error("shared_pilot_unavailable"); }
    if (!response.ok) throw new Error("shared_pilot_unavailable");
    return response;
  }
  async reserve(id, micros, calls) {
    if (!SHARED_PILOT_IDENTITY_VERIFIED) throw new Error("shared_pilot_identity_unverified");
    const response = await this.#call("reserve", { id, micros, calls });
    if (response.status !== 204) throw new Error("shared_pilot_unavailable");
  }
  async settle(id, actualMicros) {
    if (!SHARED_PILOT_IDENTITY_VERIFIED) throw new Error("shared_pilot_identity_unverified");
    const response = await this.#call("settle", { id, actualMicros });
    let value;
    try { value = await response.json(); } catch { throw new Error("shared_pilot_unavailable"); }
    if (!value || typeof value.frozen !== "boolean") throw new Error("shared_pilot_unavailable");
    if (value.frozen) throw new Error("shared_pilot_frozen");
  }
  async freeze() {
    if (!SHARED_PILOT_IDENTITY_VERIFIED) throw new Error("shared_pilot_identity_unverified");
    await this.#call("freeze", {});
  }
  async status() {
    const response = await this.#call("status");
    try { return await response.json(); } catch { throw new Error("shared_pilot_unavailable"); }
  }

  /** Read-only accounting metadata for reconciling ambiguous attempts; never authorizes spending. */
  async auditAttempts() {
    const response = await this.#call("attempts");
    if (response.status !== 200) throw new Error("shared_pilot_unavailable");
    let value;
    try {
      if (!response.body) throw new Error();
      const reader = response.body.getReader();
      const chunks = []; let total = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          if (!(next.value instanceof Uint8Array) || next.value.length > 32_768 - total) throw new Error();
          total += next.value.length; chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch { throw new Error("shared_pilot_unavailable"); }
    const t = value?.totals;
    const nonnegative = (n) => Number.isSafeInteger(n) && n >= 0;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "attempts,totals" ||
        !t || typeof t !== "object" || Array.isArray(t) ||
        Object.keys(t).sort().join() !== "count,frozen,maxCalls,maxMicros,overrun,pending,reservedCalls,reservedMicros,unknown" ||
        !Number.isSafeInteger(t.maxMicros) || t.maxMicros < 1 || t.maxMicros > 10_000_000 ||
        !Number.isSafeInteger(t.maxCalls) || t.maxCalls < 1 || t.maxCalls > 50 ||
        !nonnegative(t.reservedMicros) || t.reservedMicros > t.maxMicros ||
        !nonnegative(t.reservedCalls) || t.reservedCalls > t.maxCalls || typeof t.frozen !== "boolean" ||
        ![t.count, t.pending, t.unknown, t.overrun].every(nonnegative) ||
        !Array.isArray(value.attempts) || value.attempts.length > 50 || t.count !== value.attempts.length ||
        value.attempts.some((a) => !a || typeof a !== "object" || Array.isArray(a) || Object.keys(a).sort().join() !== "actualMicros,idMac,reservedCalls,reservedMicros,state" ||
          typeof a.idMac !== "string" || !/^[0-9a-f]{64}$/.test(a.idMac) || !Number.isSafeInteger(a.reservedMicros) || a.reservedMicros < 1 ||
          !Number.isSafeInteger(a.reservedCalls) || a.reservedCalls < 1 || a.reservedCalls > 50 ||
          !["pending", "settled", "unknown", "overrun"].includes(a.state) ||
          (a.actualMicros !== null && (!Number.isSafeInteger(a.actualMicros) || a.actualMicros < 0)) ||
          ((a.state === "pending" || a.state === "unknown") && a.actualMicros !== null) ||
          (a.state === "settled" && (a.actualMicros === null || a.actualMicros > a.reservedMicros)) ||
          (a.state === "overrun" && (a.actualMicros === null || a.actualMicros <= a.reservedMicros))) ||
        new Set(value.attempts.map((a) => a.idMac)).size !== value.attempts.length ||
        value.attempts.reduce((sum, a) => sum + a.reservedMicros, 0) !== t.reservedMicros ||
        value.attempts.reduce((sum, a) => sum + a.reservedCalls, 0) !== t.reservedCalls ||
        value.attempts.filter((a) => a.state === "pending").length !== t.pending ||
        value.attempts.filter((a) => a.state === "unknown").length !== t.unknown ||
        value.attempts.filter((a) => a.state === "overrun").length !== t.overrun ||
        ((t.unknown > 0 || t.overrun > 0) && !t.frozen))
      throw new Error("shared_pilot_unavailable");
    return value;
  }

  /** Diagnostic only. A result proves one observed invocation, not account ownership or future versions. */
  async beginIdentity(path, vaultId) {
    if (!new Set(["distill", "tailor", "document", "reembed", "vault"]).has(path) || !/^[0-9a-f]{64}$/i.test(vaultId))
      throw new Error("shared_pilot_identity_invalid");
    const response = await this.#call("identity/begin", { path, vaultId });
    let value;
    try { value = await response.json(); } catch { throw new Error("shared_pilot_unavailable"); }
    if (response.status !== 201 || !value || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.nonce) ||
        !Number.isSafeInteger(value.expiresAt)) throw new Error("shared_pilot_unavailable");
    this.#identityProbes.set(value.nonce, { path, vaultId });
    return value;
  }
  async identityStatus(nonce) {
    if (!this.#identityProbes.has(nonce)) throw new Error("shared_pilot_identity_invalid");
    const response = await this.#call("identity/status", { nonce });
    let value;
    try { value = await response.json(); } catch { throw new Error("shared_pilot_unavailable"); }
    if (!value || !["waiting", "observed"].includes(value.state)) throw new Error("shared_pilot_unavailable");
    return value;
  }
  async consumeIdentity(nonce, runId) {
    const expected = this.#identityProbes.get(nonce);
    if (!expected || !/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new Error("shared_pilot_identity_invalid");
    // Never retry a consumed challenge on an ambiguous response.
    this.#identityProbes.delete(nonce);
    const response = await this.#call("identity/consume", { nonce, runId });
    let value;
    try { value = await response.json(); } catch { throw new Error("shared_pilot_unavailable"); }
    if (!value || value.path !== expected.path || value.vaultId !== expected.vaultId || value.runId !== runId ||
        !/^[A-Za-z0-9 _:-]{1,100}$/.test(value.step) ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(value.workerVersion) || !/^[A-Za-z0-9_-]{1,100}$/.test(value.runtimeVersion))
      throw new Error("shared_pilot_identity_mismatch");
    return value;
  }
}
export function sharedPilotFromEnv(env = process.env) {
  return new SharedPilotBudget(env.STAGING_URL, env.PILOT_BUDGET_KEY);
}
