const MAX_BODY_BYTES = 256 * 1024;

/**
 * A point-in-time check of the named gateway's configured export destinations.
 * This never writes gateway settings or sends inference requests, and does not
 * prove that configuration cannot change or that every destination is known.
 */
export async function gatewayPrivacyObserved({ accountId, gatewayId, token, fetcher = fetch }) {
  if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/i.test(accountId) ||
      typeof gatewayId !== "string" || !/^[a-z0-9-]{1,64}$/.test(gatewayId) ||
      typeof token !== "string" || !token) return false;
  try {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${accountId.toLowerCase()}/ai-gateway/gateways/${gatewayId}`,
      { method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${token}`, accept: "application/json" } },
    );
    if (response.status !== 200 || !response.body) return false;
    const reader = response.body.getReader();
    const parts = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || part.value.byteLength > MAX_BODY_BYTES - size) throw new Error();
        size += part.value.byteLength;
        parts.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const gateway = body?.result;
    return body?.success === true && !!gateway && typeof gateway === "object" && !Array.isArray(gateway) &&
      gateway.id === gatewayId && gateway.logpush === false && Object.hasOwn(gateway, "otel") &&
      (gateway.otel === null || (Array.isArray(gateway.otel) && gateway.otel.length === 0));
  } catch {
    // Errors, response bodies and request headers can contain credentials.
    return false;
  }
}
