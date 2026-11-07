import test from "node:test";
import assert from "node:assert/strict";
import { gatewayPrivacyObserved } from "./lib/gateway-privacy.mjs";

const accountId = "a".repeat(32);
const gatewayId = "resumatic-staging";
const token = "private-management-token";
const response = (result) => Response.json({ success: true, result });
const inspect = (result) => gatewayPrivacyObserved({ accountId, gatewayId, token, fetcher: async () => response(result) });

test("observes the exact named gateway with both exports explicitly disabled", async () => {
  let request;
  const ok = await gatewayPrivacyObserved({ accountId, gatewayId, token, fetcher: async (url, init) => {
    request = { url, init };
    return response({ id: gatewayId, logpush: false, otel: [] });
  } });
  assert.equal(ok, true);
  assert.equal(request.url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways/${gatewayId}`);
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.headers.authorization, `Bearer ${token}`);
  assert.equal(await inspect({ id: gatewayId, logpush: false, otel: null }), true);
});

test("missing, enabled, malformed or mismatched settings do not satisfy the prerequisite", async () => {
  for (const settings of [
    {}, { id: gatewayId, logpush: false }, { id: gatewayId, otel: [] },
    { id: gatewayId, logpush: true, otel: [] }, { id: gatewayId, logpush: false, otel: [{}] },
    { id: gatewayId, logpush: "false", otel: [] }, { id: gatewayId, logpush: false, otel: {} },
    { id: "different", logpush: false, otel: [] },
  ]) assert.equal(await inspect(settings), false);
});

test("rejects redirects, unbounded replies, invalid configuration and provider errors", async () => {
  for (const fetcher of [
    async () => new Response(null, { status: 302, headers: { location: "https://other.example/" } }),
    async () => new Response("x".repeat(256 * 1024 + 1)),
    async () => new Response("invalid-json"),
    async () => { throw new Error(`private ${token}`); },
    async () => Response.json({ success: false, result: { id: gatewayId, logpush: false, otel: [] } }),
  ]) assert.equal(await gatewayPrivacyObserved({ accountId, gatewayId, token, fetcher }), false);
  let called = false;
  assert.equal(await gatewayPrivacyObserved({ accountId: "bad", gatewayId, token, fetcher: async () => { called = true; } }), false);
  assert.equal(called, false);
});
