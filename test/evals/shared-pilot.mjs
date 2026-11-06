// A configured HTTPS origin and shared secret do not prove this HTTP endpoint
// reaches the same Cloudflare account and Durable Object namespace as Worker
// model calls. Keep real dispatch closed until that binding is verified.
export const SHARED_PILOT_IDENTITY_VERIFIED = false;

/** Authenticated, fixed-name staging coordinator. Never sends model inputs or outputs. */
export class SharedPilotBudget {
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
}
export function sharedPilotFromEnv(env = process.env) {
  return new SharedPilotBudget(env.STAGING_URL, env.PILOT_BUDGET_KEY);
}
