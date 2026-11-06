import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../src/web/api";

afterEach(() => vi.unstubAllGlobals());

it("sends unknown-end role writes to versioned routes without a legacy fallback", async () => {
  const calls: { url: string; method: string; body: { unknownEndStartDate?: string } }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method!, body: JSON.parse(String(init.body)) });
    return url.endsWith("/roles") ? Response.json({ roleId: "r1" }) : new Response(null, { status: 204 });
  }));
  await api.addRoleV2({ kind: "job", org: "Acme", title: null, startDate: null, endDate: null, unknownEndStartDate: "2020" });
  await api.updateRoleV2("r1", { unknownEndStartDate: "2021", startDate: null, endDate: null });
  expect(calls.map(({ url, method }) => [method, url])).toEqual([["POST", "/api/v3/roles"], ["PATCH", "/api/v2/roles/r1"]]);
  expect(calls.map(({ body }) => body.unknownEndStartDate)).toEqual(["2020", "2021"]);
});
