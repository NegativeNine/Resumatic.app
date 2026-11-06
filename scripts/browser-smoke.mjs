#!/usr/bin/env node
// Real browser + real React app; every API response is a synthetic local stand-in.
import { createServer as httpServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const browser = process.env.LOCAL_CHROME_BIN;
if (!browser?.startsWith("/")) {
  console.log(JSON.stringify({ status: "pending", reason: "LOCAL_CHROME_REQUIRED", promotionEligible: false }));
  process.exitCode = 2;
} else {
  const temp = await mkdtemp(join(tmpdir(), "resumatic-browser-smoke-"));
  let vite, server, chrome, ws;
  let stage = "setup";
  const state = { signedIn: false, source: false, roleState: "proposed", factState: "proposed", uploadKeys: [], applications: [], tailored: false };
  const role = { id: "role-1", kind: "job", org: "Acme Example", title: "Engineer", startDate: "2021", endDate: null, state: "proposed", quote: "Acme Example — Engineer", sourceId: "source-1", revision: 1 };
  const fact = { id: "fact-1", roleId: "role-1", kind: "accomplishment", text: "Built 12 payment services", level: "implemented", origin: "extracted", state: "proposed", quote: "Built 12 payment services", sourceId: "source-1", revision: 1 };
  const me = { userId: "synthetic-user", profile: { name: "Avery Example", email: "avery@example.test", phone: "", location: "", links: [] }, quota: { used: 0, limit: 3, month: "2026-11" } };
  const send = (res, status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(value === undefined ? "" : JSON.stringify(value)); };
  const read = async (req) => { const chunks = []; let bytes = 0; for await (const chunk of req) { bytes += chunk.length; if (bytes > 20_000) throw new Error("request_too_large"); chunks.push(chunk); } return Buffer.concat(chunks); };
  const standin = async (req, res, next) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/auth/login" && req.method === "GET") { state.signedIn = true; res.writeHead(302, { location: "/" }); res.end(); return; }
    if (!path.startsWith("/api/")) return next();
    if (path === "/api/me") return state.signedIn ? send(res, 200, me) : send(res, 401, { error: "unauthenticated", message: "sign in" });
    if (!state.signedIn) return send(res, 401, { error: "unauthenticated" });
    if (path === "/api/sources" && req.method === "GET") return send(res, 200, { sources: state.source ? [{ id: "source-1", filename: "synthetic.pdf", state: "ready", error: null, createdAt: 1, proposed: 2 }] : [] });
    if (path === "/api/roles" && req.method === "GET") return send(res, 200, { roles: state.source ? [{ ...role, state: state.roleState }] : [] });
    if (path === "/api/facts" && req.method === "GET") return send(res, 200, { facts: state.source ? [{ ...fact, state: state.factState }] : [] });
    if (path === "/api/sources" && req.method === "POST") {
      await read(req); const key = req.headers["idempotency-key"]; if (typeof key !== "string" || !key) return send(res, 400, { error: "invalid" });
      state.uploadKeys.push(key);
      if (!state.source) { state.source = true; return send(res, 503, { error: "unavailable" }); }
      if (key !== state.uploadKeys[0]) return send(res, 409, { error: "conflict" });
      return send(res, 201, { sourceId: "source-1" });
    }
    if (path === "/api/review" && req.method === "POST") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      if (body.confirm?.includes("role-1")) state.roleState = "confirmed";
      if (body.confirm?.includes("fact-1")) state.factState = "confirmed";
      return send(res, 204);
    }
    if (path === "/api/applications" && req.method === "GET") return send(res, 200, { applications: state.applications });
    if (path === "/api/applications" && req.method === "POST") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      if (typeof body.jdText !== "string" || body.jdText.length < 40) return send(res, 400, { error: "invalid" });
      state.applications.push({ id: "application-1", company: null, title: null, excerpt: "Synthetic platform engineer job", createdAt: 1, resumes: [] });
      return send(res, 201, { applicationId: "application-1" });
    }
    if (path === "/api/applications/application-1/resumes" && req.method === "POST") {
      if (state.roleState !== "confirmed" || state.factState !== "confirmed" || !req.headers["idempotency-key"]) return send(res, 400, { error: "invalid" });
      state.tailored = true; return send(res, 202, { resumeId: "resume-1" });
    }
    if (path === "/api/resumes/resume-1" && req.method === "GET") return send(res, 200, { id: "resume-1", applicationId: "application-1", state: "ready", step: null, error: null, version: 1, createdAt: 1, report: null, facts: { "fact-1": { text: fact.text, quote: fact.quote } }, body: { summary: null, sections: [{ roleId: "role-1", kind: "job", org: role.org, title: role.title, startDate: role.startDate, endDate: null, lines: [{ id: "line-1", text: fact.text, factIds: ["fact-1"], status: "kept" }] }], skills: [] } });
    if (path === "/api/resumes/resume-1/versions") return send(res, 200, { versions: [] });
    if (path === "/api/applications/application-1/documents") return send(res, 200, { documents: [] });
    return send(res, 404, { error: "not_found" });
  };
  try {
    await access(browser, constants.X_OK);
    vite = await createServer({ configFile: false, plugins: [react(), { name: "synthetic-api", configureServer(s) { s.middlewares.use((req, res, next) => void standin(req, res, next).catch(() => send(res, 500, { error: "unavailable" }))); } }], server: { middlewareMode: true, hmr: false }, appType: "spa", logLevel: "silent" });
    server = httpServer(vite.middlewares);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const file = join(temp, "synthetic.pdf"); await writeFile(file, "%PDF-1.4 synthetic browser fixture\n");
    chrome = spawn(browser, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking", "--disable-component-update", "--proxy-server=http://127.0.0.1:1", "--proxy-bypass-list=127.0.0.1", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", `--user-data-dir=${join(temp, "profile")}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });
    let spawnError = false; chrome.on("error", () => { spawnError = true; });
    let port;
    for (let i = 0; i < 100; i++) { try { port = Number((await readFile(join(temp, "profile", "DevToolsActivePort"), "utf8")).split("\n")[0]); break; } catch { if (spawnError || chrome.exitCode !== null || chrome.signalCode !== null) throw new Error("BROWSER_EXITED"); await delay(100); } }
    if (!port) throw new Error("BROWSER_START_TIMEOUT");
    const targetResponse = await fetch(`http://127.0.0.1:${port}/json/list`, { redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!targetResponse.ok) throw new Error("BROWSER_PAGE_MISSING");
    const targets = await targetResponse.json();
    const target = Array.isArray(targets) && targets.find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
    if (!target) throw new Error("BROWSER_PAGE_MISSING");
    const debuggerUrl = new URL(target.webSocketDebuggerUrl);
    if (debuggerUrl.protocol !== "ws:" || debuggerUrl.hostname !== "127.0.0.1" || Number(debuggerUrl.port) !== port || debuggerUrl.username || debuggerUrl.password)
      throw new Error("BROWSER_DEBUGGER_NOT_LOOPBACK");
    ws = new WebSocket(debuggerUrl.href);
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("CDP_TIMEOUT")), 5000); ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true }); ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP_CLOSED")); }, { once: true }); });
    let next = 0; const pending = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === "Fetch.requestPaused") {
        const url = new URL(msg.params.request.url);
        const allowed = url.origin === origin || url.protocol === "data:" || url.href === "about:blank";
        void call(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed ? { requestId: msg.params.requestId } : { requestId: msg.params.requestId, errorReason: "BlockedByClient" }).catch(() => {});
        return;
      }
      if (!msg.id) return; const p = pending.get(msg.id); if (!p) return; pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(new Error("CDP_ERROR")) : p.resolve(msg.result);
    });
    ws.addEventListener("close", () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("CDP_CLOSED")); } pending.clear(); });
    const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP_TIMEOUT")); }, 5000); pending.set(id, { resolve, reject, timer }); try { ws.send(JSON.stringify({ id, method, params })); } catch { clearTimeout(timer); pending.delete(id); reject(new Error("CDP_CLOSED")); } });
    const evalPage = async (expression) => { const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error("BROWSER_SCRIPT_FAILED"); return r.result.value; };
    const wait = async (expression) => { for (let i = 0; i < 100; i++) { if (await evalPage(expression)) return; await delay(100); } throw new Error("BROWSER_WAIT_TIMEOUT"); };
    const clickText = (selector, text) => evalPage(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(x => x.textContent.trim() === ${JSON.stringify(text)}); if (!e) return false; e.click(); return true; })()`);
    await call("Page.enable"); await call("Runtime.enable"); await call("Fetch.enable", { patterns: [{ urlPattern: "*" }] }); await call("Page.navigate", { url: origin });
    stage = "sign_in"; await wait(`!![...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Sign in with Google')`); await clickText("a", "Sign in with Google"); await wait(`document.body?.innerText.includes('Sources & facts') && !!document.querySelector('input[type=file]')`);
    stage = "upload_retry"; const root = await call("DOM.getDocument"); const input = await call("DOM.querySelector", { nodeId: root.root.nodeId, selector: "input[type=file]" }); await call("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [file] }); await wait(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Retry upload')`); await clickText("button", "Retry upload"); await wait(`document.body?.innerText.includes('Built 12 payment services')`); if (state.uploadKeys.length !== 2 || state.uploadKeys[0] !== state.uploadKeys[1]) throw new Error("UPLOAD_RETRY_KEY_MISMATCH");
    stage = "review"; await clickText("button", "Confirm role"); await wait(`!([...document.querySelectorAll('button')].some(x => x.textContent.trim() === 'Confirm role'))`); await clickText(".fact button", "Confirm"); await wait(`document.body?.innerText.includes('nothing is waiting for review')`);
    stage = "application"; await clickText("nav a", "Applications"); await wait(`!!document.querySelector('textarea')`); await evalPage(`document.querySelector('textarea').focus()`); await call("Input.insertText", { text: "Synthetic platform engineer position requiring experience building reliable payment services and APIs." }); await clickText("button", "Save job"); await wait(`document.body?.innerText.includes('Synthetic platform engineer job')`); await clickText("button", "Tailor a resume"); await wait(`document.body?.innerText.includes('Resume preview') || !!document.querySelector('[aria-label="Resume preview"]')`); if (!state.tailored) throw new Error("TAILOR_NOT_STARTED");
    await wait(`document.querySelector('[aria-label="Resume preview"]')?.innerText.includes('Built 12 payment services')`);
    console.log(JSON.stringify({ status: "passed", promotionEligible: false, mode: "synthetic-api-standin", checks: { signInNavigation: true, uploadRetryKey: true, roleAndFactReview: true, applicationCreation: true, tailoredResumeDisplay: true } }));
  } catch {
    console.log(JSON.stringify({ status: "failed", reason: "BROWSER_SMOKE_FAILED", stage, promotionEligible: false })); process.exitCode = 1;
  } finally {
    if (ws) ws.close();
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const stopped = once(chrome, "exit").catch(() => {}); chrome.kill("SIGTERM");
      await Promise.race([stopped, delay(2000)]);
      if (chrome.exitCode === null && chrome.signalCode === null) { chrome.kill("SIGKILL"); await Promise.race([stopped, delay(2000)]); }
    }
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } if (vite) await vite.close();
    await rm(temp, { recursive: true, force: true });
  }
}
