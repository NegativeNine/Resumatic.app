import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

test("the role form exposes unknown-end editing only when the v2 capability is available", async () => {
  const vite = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
  try {
    const { RoleForm } = await vite.ssrLoadModule("/src/web/components/RoleForm.tsx");
    const { SessionContext } = await vite.ssrLoadModule("/src/web/session.ts");
    const role = { id: "r1", kind: "job", org: "Acme", title: "Engineer", startDate: null, endDate: null, unknownEndStartDate: "2020", state: "confirmed", quote: null, sourceId: null };
    const render = (enabled) => {
      const me = { userId: "u1", profile: { name: "", email: "", phone: "", location: "", links: [] }, quota: { used: 0, limit: 3, month: "2026-11" }, capabilities: { ocr: false, connectedApps: false, roleDateUnknownEnd: enabled } };
      return renderToStaticMarkup(createElement(SessionContext, { value: { me, updateMe() {}, async refreshMe() {}, endSession() {} } }, createElement(RoleForm, { role, reload: async () => {}, onClose() {} })));
    };
    const disabled = render(false);
    assert.ok(!disabled.includes("End date is unknown"));
    assert.ok(disabled.includes("date editing is temporarily unavailable"));
    assert.match(disabled.match(/<input\b[^>]*value="2020"[^>]*>/)?.[0] ?? "", /disabled/);
    const enabled = render(true);
    assert.ok(enabled.includes("End date is unknown"));
    assert.match(enabled, /type="checkbox"[^>]*checked/);
    assert.ok(enabled.includes('value="2020"'));
  } finally { await vite.close(); }
});
