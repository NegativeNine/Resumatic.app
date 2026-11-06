import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

// Local ordering diagnostic, not a test of provider quiescence. These operations
// simulate already-dispatched requests arriving at R2 at the indicated points.
// Conditions are evaluated atomically at commit:
// https://developers.cloudflare.com/r2/reference/consistency/
// Conditional put and httpEtag: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/

it("models deletion fencing a later data put that matches an acknowledged placeholder", async () => {
  const key = `vaults/diagnostic-${crypto.randomUUID()}/exports/attempt`;
  try {
    const placeholder = await env.FILES.put(key, crypto.randomUUID());
    expect(placeholder).not.toBeNull();
    const match = new Headers({ "if-match": placeholder!.httpEtag });

    // This order models a previously dispatched data request arriving after
    // deletion, with no other writer able to recreate this placeholder.
    await env.FILES.delete(key);
    expect(await env.FILES.put(key, "synthetic career text", { onlyIf: match })).toBeNull();
    expect(await env.FILES.head(key)).toBeNull();
  } finally {
    await env.FILES.delete(key);
  }
});

it("models an uncertain placeholder arriving after a prefix sweep", async () => {
  const prefix = `vaults/diagnostic-${crypto.randomUUID()}/`;
  const key = `${prefix}exports/attempt`;
  try {
    // A negative observation or sweep cannot cancel an earlier dispatched
    // placeholder creation that has yet to reach R2.
    expect((await env.FILES.list({ prefix })).objects).toHaveLength(0);
    await env.FILES.put(key, crypto.randomUUID(), { onlyIf: new Headers({ "if-none-match": "*" }) });
    expect((await env.FILES.list({ prefix })).objects).toHaveLength(1);
  } finally {
    await env.FILES.delete(key);
  }
});

it("models a delayed create-only write succeeding after its sentinel is removed", async () => {
  const key = `vaults/diagnostic-${crypto.randomUUID()}/exports/attempt`;
  const createOnly = new Headers({ "if-none-match": "*" });
  try {
    await env.FILES.put(key, "sentinel", { onlyIf: createOnly });
    expect(await env.FILES.put(key, "synthetic career text", { onlyIf: createOnly })).toBeNull();
    await env.FILES.delete(key);
    // Removing the sentinel permits an earlier dispatched create-only request
    // to commit if it arrives only after the sweep.
    expect(await env.FILES.put(key, "synthetic career text", { onlyIf: createOnly })).not.toBeNull();
  } finally {
    await env.FILES.delete(key);
  }
});
