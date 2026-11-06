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
  const state = { signedIn: false, source: false, sourceRunning: false, sourceCancel: false, sourceFailed: false, sourceRetryKeys: [], documentRetryKeys: [], roleState: "proposed", factState: "proposed", manualFact: null, manualFactKeys: [], uploadKeys: [], applications: [], documents: [], tailored: false, resumeRunning: false, resumeCancel: false, resumeUncited: false, resumeLegacy: false, resumeNeedsGroundingReview: false, legacyChecked: false, legacyHeadersReady: false, legacyFinalized: false, legacyExtraLine: false, resumeText: "Built 12 payment services", resumeVersion: 1, manualEdits: [], manualDocument: null };
  const role = { id: "role-1", kind: "job", org: "Acme Example", title: "Engineer", startDate: "2021", endDate: null, state: "proposed", quote: "Acme Example — Engineer", sourceId: "source-1", revision: 1 };
  const fact = { id: "fact-1", roleId: "role-1", kind: "accomplishment", text: "Built 12 payment services", level: null, levelNeedsReview: true, previousLevel: "led", origin: "user", state: "proposed", quote: "Built 12 payment services", sourceId: "source-1", revision: 1 };
  const me = { userId: "synthetic-user", profile: { name: "Avery Example", email: "avery@example.test", phone: "", location: "", links: [] }, quota: { used: 0, limit: 3, month: "2026-11" } };
  const send = (res, status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(value === undefined ? "" : JSON.stringify(value)); };
  const read = async (req) => { const chunks = []; let bytes = 0; for await (const chunk of req) { bytes += chunk.length; if (bytes > 20_000) throw new Error("request_too_large"); chunks.push(chunk); } return Buffer.concat(chunks); };
  const standin = async (req, res, next) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/auth/login" && req.method === "GET") { state.signedIn = true; res.writeHead(302, { location: "/" }); res.end(); return; }
    if (!path.startsWith("/api/")) return next();
    if (path === "/api/me") return state.signedIn ? send(res, 200, me) : send(res, 401, { error: "unauthenticated", message: "sign in" });
    if (!state.signedIn) return send(res, 401, { error: "unauthenticated" });
    if (path === "/api/shares" && req.method === "GET") return send(res, 200, { grants: [{ id: "legacy-grant", epoch: "synthetic", createdAt: Date.now(), expiresAt: Date.now() + 60_000, revokedAt: null, factCount: 0, resumeCount: 1, available: false }] });
    if (path === "/api/sources" && req.method === "GET") return send(res, 200, { sources: state.source ? [{ id: "source-1", filename: "synthetic.pdf", state: state.sourceRunning ? "queued" : state.sourceFailed ? "failed" : "ready", retryRunId: state.sourceFailed ? "run-1" : undefined, dispatchUncertain: state.sourceRunning, cancellationPending: state.sourceCancel, error: null, createdAt: 1, proposed: 2 }, { id: "source-ocr", filename: "synthetic.pdf (image transcription)", state: "ready", origin: "ocr", parentSourceId: "source-1", error: null, createdAt: 2, proposed: 0 }] : [] });
    if (path === "/api/sources/source-1/cancel" && req.method === "POST") { state.sourceCancel = true; res.writeHead(202); res.end(); return; }
    if (path === "/api/runs/run-1/retry" && req.method === "POST") { const key = req.headers["idempotency-key"]; if (typeof key !== "string" || !key) return send(res, 400, { error: "invalid" }); state.sourceRetryKeys.push(key); if (state.sourceRetryKeys.length === 1) return send(res, 503, { error: "unavailable" }); state.sourceFailed = false; return send(res, 202, { runId: "run-2", targetId: "source-1" }); }
    if (path === "/api/roles" && req.method === "GET") return send(res, 200, { roles: state.source ? [{ ...role, state: state.roleState }] : [] });
    if (path === "/api/facts" && req.method === "GET") return send(res, 200, { facts: [...(state.source ? [{ ...fact, state: state.factState }] : []), ...(state.manualFact ? [state.manualFact] : [])] });
    if (path === "/api/v2/facts" && req.method === "POST") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || !key || body.text !== "Built an accessible application") return send(res, 400, { error: "invalid" });
      state.manualFactKeys.push(key);
      if (!state.manualFact) {
        state.manualFact = { id: "manual-fact", roleId: null, kind: "accomplishment", text: body.text, level: null, origin: "user", state: "confirmed", quote: null, sourceId: null, revision: 1 };
        // The server committed the fact but the client received an error.
        return send(res, 503, { error: "unavailable" });
      }
      if (key !== state.manualFactKeys[0]) return send(res, 409, { error: "conflict" });
      return send(res, 201, { factId: "manual-fact" });
    }
    if (path === "/api/facts/fact-1" && req.method === "PATCH") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      if (body.expectedRevision !== fact.revision || body.level !== "led") return send(res, 400, { error: "invalid" });
      fact.level = body.level; fact.levelNeedsReview = false; delete fact.previousLevel; fact.revision++;
      return send(res, 204);
    }
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
      state.applications.push({ id: "application-1", company: null, title: null, excerpt: "Synthetic platform engineer job", createdAt: 1, resumes: [], status: "saved", appliedAt: null, notes: "", revision: 1 });
      return send(res, 201, { applicationId: "application-1" });
    }
    if (path === "/api/applications/application-1" && req.method === "PATCH") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      const application = state.applications[0];
      if (!application || body.expectedRevision !== application.revision) return send(res, 409, { error: "conflict" });
      Object.assign(application, { status: body.status, appliedAt: body.appliedAt, notes: body.notes, revision: application.revision + 1 });
      return send(res, 204);
    }
    if (path === "/api/applications/application-1/resumes" && req.method === "POST") {
      if (state.roleState !== "confirmed" || state.factState !== "confirmed" || !req.headers["idempotency-key"]) return send(res, 400, { error: "invalid" });
      state.tailored = true; return send(res, 202, { resumeId: "resume-1" });
    }
    if (path === "/api/resumes/resume-1/cancel" && req.method === "POST") { state.resumeCancel = true; res.writeHead(202); res.end(); return; }
    if (path === "/api/resumes/resume-1" && req.method === "GET" && state.resumeRunning) return send(res, 200, { id: "resume-1", applicationId: "application-1", state: "running", step: null, error: null, version: 0, createdAt: 1, dispatchUncertain: true, cancellationPending: state.resumeCancel, body: null, report: null, facts: {} });
    if (path === "/api/resumes/resume-1" && req.method === "GET") return send(res, 200, { id: "resume-1", applicationId: "application-1", state: "ready", provenance: state.resumeLegacy ? "legacy" : "snapshot", ...(state.resumeNeedsGroundingReview ? { needsGroundingReview: true } : {}), ...(state.resumeLegacy ? { legacyReview: { verifiedLineIds: state.legacyChecked ? ["line-1"] : [], totalLines: state.legacyExtraLine ? 2 : 1, headersReady: state.legacyHeadersReady, skillsReady: true } } : {}), step: null, error: null, version: state.resumeVersion, createdAt: 1, report: null, facts: { "fact-1": { text: fact.text, quote: fact.quote } }, body: { summary: null, sections: [{ roleId: "role-1", kind: "job", org: role.org, title: role.title, startDate: role.startDate, endDate: null, lines: [{ id: "line-1", text: state.resumeText, factIds: state.resumeUncited ? [] : ["fact-1"], status: state.resumeUncited ? "edited" : "kept" }, ...(state.legacyExtraLine ? [{ id: "line-extra", text: "Unsupported historical line", factIds: [], status: "edited" }] : [])] }], skills: [] } });
    if (path === "/api/resumes/resume-1/versions") return send(res, 200, { versions: [] });
    if (path === "/api/resumes/resume-1/grounding-review" && req.method === "POST") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      if (state.resumeLegacy || !state.resumeNeedsGroundingReview || body.expectedVersion !== state.resumeVersion) return send(res, 409, { error: "conflict" });
      state.resumeLegacy = true; state.legacyChecked = false; state.legacyHeadersReady = false; state.legacyExtraLine = true; state.resumeVersion++;
      return send(res, 200, { version: state.resumeVersion });
    }
    if (path === "/api/resumes/resume-1/legacy-remove-line" && req.method === "POST") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      if (!state.resumeLegacy || !state.legacyExtraLine || body.lineId !== "line-extra" || body.expectedVersion !== state.resumeVersion) return send(res, 409, { error: "conflict" });
      state.legacyExtraLine = false; state.resumeVersion++;
      return send(res, 200, { version: state.resumeVersion });
    }
    if (path === "/api/resumes/resume-1/legacy-finalize" && req.method === "POST") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      if (!state.resumeLegacy || !state.legacyChecked || !state.legacyHeadersReady || body.expectedVersion !== state.resumeVersion) return send(res, 409, { error: "conflict" });
      state.resumeLegacy = false; state.resumeNeedsGroundingReview = false; state.legacyFinalized = true; state.resumeVersion++;
      return send(res, 200, { version: state.resumeVersion });
    }
    if (path === "/api/runs/document-2/cancel" && req.method === "POST") { state.documents.find((d) => d.id === "document-2").cancellationPending = true; res.writeHead(202); res.end(); return; }
    if (path === "/api/runs/document-failed/retry" && req.method === "POST") {
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || !key) return send(res, 400, { error: "invalid" });
      state.documentRetryKeys.push(key);
      if (state.documentRetryKeys.length === 1) return send(res, 503, { error: "unavailable" });
      state.documents.push({ id: "document-retry", applicationId: "application-1", kind: "prep", state: "running", createdAt: 4, result: null, facts: {} });
      return send(res, 202, { runId: "document-retry", targetId: "document-retry" });
    }
    if (path === "/api/applications/application-1/documents" && req.method === "GET") return send(res, 200, { documents: state.documents });
    if (path === "/api/documents/manual-edit" && req.method === "GET") return send(res, 200, state.manualDocument);
    if (path === "/api/applications/application-1/documents" && req.method === "POST") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      if (body.kind === "refine" && typeof body.manualText === "string") {
        if (!req.headers["idempotency-key"] || body.resumeId !== "resume-1" || body.expectedVersion !== state.resumeVersion || body.lineIds?.[0] !== "line-1") return send(res, 400, { error: "invalid" });
        if ((state.resumeUncited || state.resumeLegacy) && JSON.stringify(body.manualFactIds) !== '["fact-1"]') return send(res, 400, { error: "invalid" });
        state.manualEdits.push(body);
        const failed = state.manualEdits.length === 1;
        if (!failed) { state.resumeText = body.manualText; state.resumeUncited = false; if (state.resumeLegacy) state.legacyChecked = true; state.resumeVersion++; }
        state.manualDocument = { id: "manual-edit", applicationId: "application-1", kind: "refine", state: failed ? "failed" : "ready", error: failed ? "invalid" : null };
        return send(res, 202, { documentId: "manual-edit", runId: "manual-edit" });
      }
      if (body.kind !== "letter" || !req.headers["idempotency-key"] || state.factState !== "confirmed") return send(res, 400, { error: "invalid" });
      state.documents.push({ id: "document-1", applicationId: "application-1", kind: "letter", state: "ready", version: 1, createdAt: 1, error: null, result: { kind: "letter", units: [{ id: "unit-1", roleId: "role-1", text: "I built 12 payment services.", factIds: ["fact-1"], group: 0 }], questions: [], report: { kept: 1, repaired: 0, replaced: 0, dropped: 0, gaps: [] } }, facts: { "fact-1": { text: fact.text, quote: fact.quote } } });
      return send(res, 202, { documentId: "document-1", runId: "document-1" });
    }
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
    stage = "ocr_download_links"; await wait(`!![...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Download image inputs (JSON)' && x.getAttribute('href') === '/api/sources/source-ocr/file') && !![...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Download original PDF' && x.getAttribute('href') === '/api/sources/source-1/file')`);
    stage = "uncertain_source_cancellation";
    state.sourceRunning = true; await call("Page.reload");
    await wait(`document.body?.innerText.includes("we can't confirm that reading started")`);
    await clickText("button", "Cancel reading");
    await wait(`document.body?.innerText.includes('Cancellation is pending')`);
    if (!state.sourceCancel) throw new Error("SOURCE_CANCEL_NOT_SENT");
    stage = "failed_source_retry";
    state.sourceRunning = false; state.sourceCancel = false; state.sourceFailed = true; await call("Page.reload");
    await wait(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Retry reading')`);
    await clickText("button", "Retry reading");
    await wait(`document.body?.innerText.includes('Try again') || !!document.querySelector('[role="alert"]')`);
    await clickText("button", "Retry reading");
    await wait(`document.body?.innerText.includes('Ready · 2 facts to review')`);
    if (state.sourceRetryKeys.length !== 2 || state.sourceRetryKeys[0] !== state.sourceRetryKeys[1]) throw new Error("SOURCE_RETRY_KEY_MISMATCH");
    await wait(`document.body?.innerText.includes('Ready · 2 facts to review')`);
    stage = "review_role"; await wait(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Confirm role')`); await clickText("button", "Confirm role"); await wait(`!([...document.querySelectorAll('button')].some(x => x.textContent.trim() === 'Confirm role'))`);
    stage = "fact_level_review"; await wait(`document.body?.innerText.includes('needs your confirmation before it is used')`); await clickText('.fact button', 'Edit');
    await wait(`!!document.querySelector('.fact select[id$="-level"]')`);
    await evalPage(`(() => { const e = document.querySelector('.fact select[id$="-level"]'); e.value = 'led'; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await clickText('.fact button', 'Save fact'); await wait(`!document.querySelector('.fact select[id$="-level"]')`);
    if (fact.level !== 'led' || fact.levelNeedsReview) throw new Error('FACT_LEVEL_NOT_REAFFIRMED');
    stage = "review_fact"; await wait(`!![...document.querySelectorAll('.fact button')].find(x => x.textContent.trim() === 'Confirm' && !x.disabled)`); await clickText(".fact button", "Confirm"); await wait(`document.body?.innerText.includes('nothing is waiting for review')`);
    stage = "manual_fact_retry";
    await clickText("button", "Add a fact yourself");
    await wait(`!!document.querySelector('.add-fact-form textarea')`);
    await evalPage(`document.querySelector('.add-fact-form textarea').focus()`);
    await call("Input.insertText", { text: "Built an accessible application" });
    await clickText(".add-fact-form button", "Add fact");
    await wait(`!!document.querySelector('.add-fact-form [role="alert"]')`);
    await clickText(".add-fact-form button", "Add fact");
    await wait(`document.body?.innerText.includes('Fact added.')`);
    if (state.manualFactKeys.length !== 2 || state.manualFactKeys[0] !== state.manualFactKeys[1]) throw new Error("MANUAL_FACT_RETRY_KEY_MISMATCH");
    stage = "application"; await clickText("nav a", "Applications"); await wait(`!!document.querySelector('textarea')`); await evalPage(`document.querySelector('textarea').focus()`); await call("Input.insertText", { text: "Synthetic platform engineer position requiring experience building reliable payment services and APIs." }); await clickText("button", "Save job"); await wait(`document.body?.innerText.includes('Synthetic platform engineer job')`);
    stage = "tracking"; await clickText("button", "Track & prepare"); await wait(`!!document.querySelector('.application-workspace select')`); await evalPage(`(() => { const e = document.querySelector('.application-workspace select'); e.value = 'applied'; e.dispatchEvent(new Event('change', { bubbles: true })); })()`); await evalPage(`document.querySelector('.application-workspace textarea').focus()`); await call("Input.insertText", { text: "Synthetic follow-up note" }); await clickText("button", "Save tracking details"); await wait(`document.querySelector('.application-workspace')?.innerText.includes('Saved.')`); if (state.applications[0]?.status !== "applied" || state.applications[0]?.notes !== "Synthetic follow-up note") throw new Error("TRACKING_NOT_SAVED");
    stage = "cover_letter"; await clickText("button", "Create cover letter"); await wait(`!![...document.querySelectorAll('summary')].find(x => x.textContent.trim() === 'Read cover letter')`); await clickText("summary", "Read cover letter"); await wait(`document.body?.innerText.includes('I built 12 payment services.')`);
    await wait(`(() => { const link = [...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Download Word'); return link?.origin === location.origin && link.getAttribute('href') === '/api/documents/document-1/docx' && link.referrerPolicy === 'no-referrer'; })()`);
    stage = "saved_interview_answer";
    state.documents.push({ id: "question-doc", applicationId: "application-1", kind: "questions", state: "ready", version: 1, createdAt: 1, error: null, answeredQuestionIds: ["question-1"], result: { kind: "questions", units: [], questions: [{ id: "question-1", requirement: "Reliability", question: "How have you improved reliability?" }], report: { kept: 0, repaired: 0, replaced: 0, dropped: 0, gaps: [] } }, facts: {} });
    await call("Page.reload");
    await wait(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Track & prepare')`);
    await clickText("button", "Track & prepare");
    await wait(`!![...document.querySelectorAll('summary')].find(x => x.textContent.trim() === 'Read experience questions')`);
    await clickText("summary", "Read experience questions");
    await wait(`document.body?.innerText.includes('You previously saved an answer to this question.')`);
    stage = "uncertain_document_cancellation";
    state.documents.push({ id: "document-2", applicationId: "application-1", kind: "prep", state: "running", dispatchUncertain: true, createdAt: 2, result: null, facts: {} });
    await clickText("button", "Close workspace"); await clickText("button", "Track & prepare");
    await wait(`document.body?.innerText.includes("we can't confirm that preparation started")`);
    await clickText("button", "Cancel generation");
    await wait(`document.body?.innerText.includes("Cancellation is pending")`);
    if (!state.documents.find((d) => d.id === "document-2")?.cancellationPending) throw new Error("DOCUMENT_CANCEL_NOT_SENT");
    state.documents = state.documents.filter((d) => d.id !== "document-2");
    stage = "document_retry";
    state.documents.push({ id: "document-failed", applicationId: "application-1", kind: "prep", state: "failed", retryRunId: "document-failed", createdAt: 3, error: "unavailable", result: null, facts: {} });
    await clickText("button", "Close workspace"); await clickText("button", "Track & prepare");
    await wait(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Retry interview preparation')`);
    await clickText("button", "Retry interview preparation");
    await wait(`document.body?.innerText.includes('Resumatic is busy right now')`);
    await clickText("button", "Retry interview preparation");
    await wait(`document.body?.innerText.includes('Preparing and checking your document')`);
    if (state.documentRetryKeys.length !== 2 || state.documentRetryKeys[0] !== state.documentRetryKeys[1]) throw new Error("DOCUMENT_RETRY_KEY_MISMATCH");
    state.documents = state.documents.filter((d) => d.id !== "document-retry");
    stage = "resume"; await clickText("button", "Tailor a resume"); await wait(`document.body?.innerText.includes('Resume preview') || !!document.querySelector('[aria-label="Resume preview"]')`); if (!state.tailored) throw new Error("TAILOR_NOT_STARTED");
    await wait(`document.querySelector('[aria-label="Resume preview"]')?.innerText.includes('Built 12 payment services')`);
    stage = "historic_level_guard"; state.resumeNeedsGroundingReview = true; await call("Page.reload");
    await wait(`document.body?.innerText.includes('wording without verified evidence')`);
    if (await evalPage(`!![...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Download PDF')`)) throw new Error('HISTORIC_LEVEL_DOWNLOAD_SHOWN');
    state.resumeNeedsGroundingReview = false; await call("Page.reload");
    await wait(`!![...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Download PDF')`);
    stage = "verified_manual_edit";
    await clickText("button", "Edit line");
    await evalPage(`(() => { const e = document.querySelector('.line textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(e, 'Built 12 reliable payment services'); e.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await clickText("button", "Check and save");
    await wait(`document.body?.innerText.includes("couldn't verify that wording")`);
    if (!await evalPage(`document.querySelector('.line textarea')?.value === 'Built 12 reliable payment services'`)) throw new Error("MANUAL_TEXT_LOST");
    await clickText("button", "Check and save");
    await wait(`document.querySelector('[aria-label="Resume preview"]')?.innerText.includes('Built 12 reliable payment services') && !document.querySelector('.line textarea')`);
    stage = "uncited_remediation";
    state.resumeUncited = true; await call("Page.reload");
    await wait(`document.body?.innerText.includes('wording without verified evidence')`);
    if (await evalPage(`!![...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Download PDF')`)) throw new Error("UNVERIFIED_DOWNLOAD_SHOWN");
    await clickText("button", "Edit line");
    await wait(`!!document.querySelector('.line fieldset input[type="checkbox"]')`);
    await evalPage(`document.querySelector('.line fieldset input[type="checkbox"]').click()`);
    await clickText("button", "Check and save");
    await wait(`!![...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Download PDF')`);
    if (JSON.stringify(state.manualEdits.at(-1)?.manualFactIds) !== '["fact-1"]') throw new Error("REMEDIATION_FACT_MISSING");
    stage = "legacy_resume_review";
    state.resumeNeedsGroundingReview = true; await call("Page.reload");
    await wait(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Start review')`);
    await clickText("button", "Start review");
    await wait(`document.body?.innerText.includes('0 of 2 lines checked') && document.body?.innerText.includes("headings don't match")`);
    await evalPage(`(() => { const line = [...document.querySelectorAll('.line')].find(x => x.innerText.includes('Unsupported historical line')); const button = [...line.querySelectorAll('button')].find(x => x.textContent.trim() === 'Remove line'); button.click(); })()`);
    await wait(`document.body?.innerText.includes('0 of 1 lines checked') && !document.body?.innerText.includes('Unsupported historical line')`);
    if (state.legacyExtraLine) throw new Error("LEGACY_REMOVE_NOT_SENT");
    if (!state.resumeLegacy) throw new Error("SNAPSHOT_REVIEW_NOT_STARTED");
    if (!await evalPage(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Create checked version')?.disabled`)) throw new Error("LEGACY_FINALIZE_NOT_BLOCKED");
    await clickText("button", "Review line");
    await wait(`!!document.querySelector('.line fieldset input[type="checkbox"]')`);
    await evalPage(`document.querySelector('.line fieldset input[type="checkbox"]').click()`);
    await clickText("button", "Check and save");
    await wait(`document.body?.innerText.includes('1 of 1 lines checked')`);
    if (!await evalPage(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Create checked version')?.disabled`)) throw new Error("LEGACY_HEADER_NOT_BLOCKED");
    state.legacyHeadersReady = true; await call("Page.reload");
    await wait(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Create checked version' && !x.disabled)`);
    await clickText("button", "Create checked version");
    await wait(`!![...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Download PDF')`);
    if (!state.legacyFinalized || state.resumeLegacy || JSON.stringify(state.manualEdits.at(-1)?.manualFactIds) !== '["fact-1"]') throw new Error("LEGACY_REVIEW_NOT_COMPLETED");
    stage = "uncertain_resume_cancellation";
    state.resumeRunning = true; await call("Page.reload");
    await wait(`document.body?.innerText.includes("we can't confirm that tailoring started")`);
    await clickText("button", "Cancel tailoring");
    await wait(`document.body?.innerText.includes("Cancellation is pending")`);
    if (!state.resumeCancel) throw new Error("RESUME_CANCEL_NOT_SENT");
    stage = "export_disclosure";
    await clickText("nav a", "Account");
    await wait(`document.body?.innerText.includes('up to 128 source files and 100 MiB')`);
    await wait(`document.body?.innerText.includes('This link is currently unavailable.')`);
    if (!await evalPage(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Revoke link')`)) throw new Error("SHARE_REVOKE_MISSING");
    if (!await evalPage(`!!document.querySelector('a[href="/api/export/archive"]')`)) throw new Error("ARCHIVE_LINK_MISSING");
    if (!await evalPage(`!!document.querySelector('a[href="/api/export"]') && [...document.querySelectorAll('a[href="#/sources"]')].some(x => x.textContent.includes('Sources & facts'))`)) throw new Error("EXPORT_DOWNLOAD_LINKS_MISSING");
    console.log(JSON.stringify({ status: "passed", promotionEligible: false, mode: "synthetic-api-standin", checks: { signInNavigation: true, uploadRetryKey: true, ocrDownloadLinks: true, uncertainSourceCancellation: true, sourceReadingRetry: true, roleAndFactReview: true, factLevelReview: true, manualFactRetryKey: true, applicationCreation: true, applicationTracking: true, coverLetterDisplay: true, documentWordDownloadLink: true, savedInterviewAnswer: true, tailoredResumeDisplay: true, historicLevelGuard: true, verifiedManualEdit: true, uncitedRemediation: true, legacyResumeReview: true, uncertainDocumentCancellation: true, documentRetry: true, uncertainResumeCancellation: true, exportDisclosure: true, unavailableShareNotice: true } }));
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
