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
  let vite, server, chrome, ws, releaseManualFact, releaseManualRole, releaseAnswer, releaseJob, releaseProfile, releaseDocumentRead;
  let stage = "setup";
  const state = { signedIn: false, source: false, sourceRunning: false, sourceCancel: false, sourceFailed: false, sourceRetryKeys: [], documentRetryKeys: [], roleState: "proposed", factState: "proposed", manualFact: null, manualFactKeys: [], manualRoles: [], manualRoleKeys: [], uploadKeys: [], applications: [], documents: [], tailored: false, resumeRunning: false, resumeCancel: false, resumeUncited: false, resumeLegacy: false, resumeNeedsGroundingReview: false, legacyChecked: false, legacyHeadersReady: false, legacyFinalized: false, legacyExtraLine: false, legacySkill: false, resumeText: "Built 12 payment services", resumeVersion: 1, manualEdits: [], manualDocument: null };
  const role = { id: "role-1", kind: "job", org: "Acme Example", title: "Engineer", startDate: "2021", endDate: null, state: "proposed", quote: "Acme Example — Engineer", sourceId: "source-1", revision: 1 };
  const fact = { id: "fact-1", roleId: "role-1", kind: "accomplishment", text: "Built 12 payment services", level: null, levelNeedsReview: true, previousLevel: "led", origin: "user", state: "proposed", quote: "Built 12 payment services", sourceId: "source-1", revision: 1 };
  const me = { userId: "synthetic-user", profile: { revision: 1, name: "Avery Example", email: "avery@example.test", phone: "", location: "", links: [] }, quota: { used: 0, limit: 3, month: "2026-11" } };
  const shareGrant = "0653389a-0d6d-4e90-94eb-23cc98b95c19";
  const send = (res, status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(value === undefined ? "" : JSON.stringify(value)); };
  const read = async (req) => { const chunks = []; let bytes = 0; for await (const chunk of req) { bytes += chunk.length; if (bytes > 20_000) throw new Error("request_too_large"); chunks.push(chunk); } return Buffer.concat(chunks); };
  const standin = async (req, res, next) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/auth/login" && req.method === "GET") { state.signedIn = true; res.writeHead(302, { location: "/" }); res.end(); return; }
    if (path === "/share/session" && req.method === "POST") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      if (body.token === "synthetic-invalid") return send(res, 410, { error: "gone" });
      if (body.token !== "synthetic-share") return send(res, 400, { error: "invalid" });
      state.shareSessions = (state.shareSessions ?? 0) + 1;
      return state.shareSessions === 1 ? send(res, 503, { error: "unavailable" }) : send(res, 200, { grantId: shareGrant });
    }
    if (path === "/share/snapshot" && req.method === "GET") {
      // The page has to say which copy it wants, as a reader with two open would need it to.
      if (new URL(req.url, "http://localhost").searchParams.get("g") !== shareGrant) return send(res, 410, { error: "gone" });
      state.shareReads = (state.shareReads ?? 0) + 1;
      return state.shareReads === 1 ? send(res, 503, { error: "unavailable" }) : send(res, 200, {
        grantId: shareGrant, expiresAt: Date.now() + 60_000,
        snapshot: { schemaVersion: 2, createdAt: Date.now(), owner: { name: "Avery Example" }, facts: [], resumes: [] },
      });
    }
    if (!path.startsWith("/api/")) return next();
    if (path === "/api/me") return state.signedIn ? send(res, 200, me) : send(res, 401, { error: "unauthenticated", message: "sign in" });
    if (!state.signedIn) return send(res, 401, { error: "unauthenticated" });
    if (path === "/api/profile" && req.method === "GET") return send(res, 200, me.profile);
    // The header's counts: nothing waits in this stand-in.
    if (path === "/api/v2/today" && req.method === "GET") return send(res, 200, { waiting: [], working: [], recent: [], counts: { today: 0, facts: 0, jobs: 0, sharing: 0 }, since: 0, standing: { files: 0, confirmed: 0, leftOut: 0, jobs: { saved: 0, applied: 0, interview: 0, offer: 0, closed: 0 }, copies: 0, coachCopies: 0, apps: 0 } });
    if (path === "/api/v2/profile" && req.method === "PUT") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      state.profileRequests ??= [];
      state.profileRequests.push(body);
      await new Promise((resolve) => { releaseProfile = resolve; });
      if (state.profileRequests.length === 1) return send(res, 503, { error: "unavailable" });
      if (body.expectedRevision !== me.profile.revision) return send(res, 409, { error: "conflict", message: "your profile changed; review the saved details before trying again" });
      const { expectedRevision, ...profile } = body;
      me.profile = { ...profile, revision: expectedRevision + 1 };
      if (state.profileRequests.length === 4) return send(res, 503, { error: "unavailable" });
      return send(res, 200, me.profile);
    }
    if (path === "/api/shares" && req.method === "GET") return send(res, 200, { grants: [{ id: "legacy-grant", epoch: "synthetic", createdAt: Date.now(), expiresAt: Date.now() + 60_000, revokedAt: null, factCount: 0, resumeCount: 1, available: false }] });
    if ((path === "/api/sources" || path === "/api/v2/vault") && req.method === "GET") {
      state.sourceReads = (state.sourceReads ?? 0) + 1;
      if (state.sourcePollFailures > 0) { state.sourcePollFailures--; state.sourcePollFailureCount = (state.sourcePollFailureCount ?? 0) + 1; return send(res, 503, { error: "unavailable" }); }
      if (state.sourceForbiddenFailures > 0) { state.sourceForbiddenFailures--; state.sourceForbiddenSeen = true; return send(res, 403, { error: "forbidden", message: "Access unavailable" }); }
      const sources = state.source ? [{ id: "source-1", filename: "synthetic.pdf", state: state.sourceRunning ? "queued" : state.sourceFailed ? "failed" : "ready", retryRunId: state.sourceFailed ? "run-1" : undefined, dispatchUncertain: state.sourceRunning, cancellationPending: state.sourceCancel, error: null, createdAt: 1, proposed: !state.hideSourceFact && state.factState === "proposed" ? 1 : 0 }, { id: "source-ocr", filename: "synthetic.pdf (image transcription)", state: "ready", origin: "ocr", parentSourceId: "source-1", error: null, createdAt: 2, proposed: 0 }] : [];
      if (path === "/api/v2/vault") return send(res, 200, { sources, roles: [...(state.source && !state.hideSourceRole ? [{ ...role, state: state.roleState }] : []), ...state.manualRoles], facts: [...(state.source && !state.hideSourceFact ? [{ ...fact, state: state.factState }] : []), ...(state.manualFact ? [state.manualFact] : [])] });
      return send(res, 200, { sources });
    }
    // The text read from synthetic.pdf, shown beside To check's question.
    if (path === "/api/sources/source-1/text" && req.method === "GET") return send(res, 200, { markdown: "Acme Example — Engineer\nBuilt 12 payment services\n", revisionId: "source-1:1", origin: "upload" });
    if (path === "/api/sources/source-1/cancel" && req.method === "POST") { state.sourceCancel = true; res.writeHead(202); res.end(); return; }
    if (path === "/api/runs/run-1/retry" && req.method === "POST") { const key = req.headers["idempotency-key"]; if (typeof key !== "string" || !key) return send(res, 400, { error: "invalid" }); state.sourceRetryKeys.push(key); if (state.sourceRetryKeys.length === 1) return send(res, 503, { error: "unavailable" }); state.sourceFailed = false; return send(res, 202, { runId: "run-2", targetId: "source-1" }); }
    if (path === "/api/roles" && req.method === "GET") return send(res, 200, { roles: [...(state.source && !state.hideSourceRole ? [{ ...role, state: state.roleState }] : []), ...state.manualRoles] });
    if (path === "/api/roles/role-1" && req.method === "PATCH") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      state.roleEditAttempts = (state.roleEditAttempts ?? 0) + 1;
      if (body.expectedRevision !== role.revision) return send(res, 409, { error: "conflict" });
      const { expectedRevision: _revision, ...fields } = body;
      Object.assign(role, fields);
      role.revision++;
      // Simulate a committed update whose response and first fresh read are lost.
      state.sourcePollFailures = 1;
      return send(res, 503, { error: "unavailable" });
    }
    if ((path === "/api/roles" || path === "/api/v3/roles") && req.method === "POST") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      if (body.org !== "Synthetic Volunteer Group") return send(res, 400, { error: "invalid" });
      const key = req.headers["idempotency-key"];
      if (path !== "/api/v3/roles" || typeof key !== "string" || !key) return send(res, 400, { error: "invalid" });
      state.manualRoleKeys.push(key);
      if (state.manualRoles.length === 0) {
        state.manualRoles.push({ id: "manual-role", ...body, state: "confirmed", quote: null, sourceId: null, revision: 1 });
        await new Promise((resolve) => { releaseManualRole = resolve; });
        return send(res, 503, { error: "unavailable" });
      }
      if (key !== state.manualRoleKeys[0]) return send(res, 409, { error: "conflict" });
      return send(res, 201, { roleId: "manual-role" });
    }
    if (path === "/api/facts" && req.method === "GET") return send(res, 200, { facts: [...(state.source && !state.hideSourceFact ? [{ ...fact, state: state.factState }] : []), ...(state.manualFact ? [state.manualFact] : [])] });
    if (path === "/api/v2/facts" && req.method === "POST") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || !key || body.text !== "Built an accessible application") return send(res, 400, { error: "invalid" });
      state.manualFactKeys.push(key);
      if (!state.manualFact) {
        state.manualFact = { id: "manual-fact", roleId: null, kind: "accomplishment", text: body.text, level: null, origin: "user", state: "confirmed", quote: null, sourceId: null, revision: 1 };
        // The server committed the fact but the client received an error.
        await new Promise((resolve) => { releaseManualFact = resolve; });
        return send(res, 503, { error: "unavailable" });
      }
      if (key !== state.manualFactKeys[0]) return send(res, 409, { error: "conflict" });
      return send(res, 201, { factId: "manual-fact" });
    }
    if (path === "/api/facts/fact-1" && req.method === "PATCH") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      state.factEditAttempts = (state.factEditAttempts ?? 0) + 1;
      if (body.expectedRevision !== fact.revision) return send(res, 409, { error: "conflict" });
      if (body.level !== "led") return send(res, 400, { error: "invalid" });
      fact.level = body.level; fact.levelNeedsReview = false; delete fact.previousLevel; fact.revision++;
      // Simulate a committed write whose response and first reconciliation read are lost.
      state.sourcePollFailures = 1;
      return send(res, 503, { error: "unavailable" });
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
    if (path === "/api/applications" && req.method === "GET") {
      if (state.trackingReadFailures > 0) { state.trackingReadFailures--; return send(res, 503, { error: "unavailable" }); }
      return send(res, 200, { applications: state.applications });
    }
    if (path === "/api/applications/duplicates" && req.method === "POST") return send(res, 200, { duplicate: null });
    if (path === "/api/v2/applications" && req.method === "POST") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      if (typeof body.jdText !== "string" || body.jdText.length < 40) return send(res, 400, { error: "invalid" });
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || !key) return send(res, 400, { error: "invalid" });
      state.jobRequests ??= [];
      state.jobRequests.push(body);
      state.jobKeys ??= [];
      state.jobKeys.push(key);
      if (state.jobRequests.length === 1)
        state.applications.push({ id: "application-1", company: null, title: null, excerpt: "Synthetic platform engineer job", createdAt: 1, resumes: [], status: "saved", appliedAt: null, notes: "", revision: 1 });
      await new Promise((resolve) => { releaseJob = resolve; });
      // The application was committed, but the response is lost.
      if (state.jobRequests.length === 1) return send(res, 503, { error: "unavailable" });
      if (key !== state.jobKeys[0] || body.jdText !== state.jobRequests[0].jdText) return send(res, 409, { error: "conflict" });
      return send(res, 201, { applicationId: "application-1" });
    }
    // A job's own page reads the job with its whole description.
    if (path === "/api/applications/application-1" && req.method === "GET") {
      const application = state.applications[0];
      return application ? send(res, 200, { ...application, jdText: "Synthetic platform engineer position requiring experience building reliable payment services and APIs.", canDelete: application.resumes.length === 0 }) : send(res, 404, { error: "not_found", message: "This job can't be found. It may have been deleted." });
    }
    if (path === "/api/applications/application-1" && req.method === "PATCH") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      state.trackingRequests ??= [];
      state.trackingRequests.push(body);
      const application = state.applications[0];
      if (!application || body.expectedRevision !== application.revision) return send(res, 409, { error: "conflict" });
      Object.assign(application, { status: body.status, appliedAt: body.appliedAt, notes: body.notes, revision: application.revision + 1 });
      if (state.trackingRequests.length === 1) {
        // The write committed, but both its response and the first reconciliation read fail.
        state.trackingReadFailures = 1;
        return send(res, 503, { error: "unavailable" });
      }
      return send(res, 204);
    }
    if (path === "/api/applications/application-1/resumes" && req.method === "POST") {
      if (state.roleState !== "confirmed" || state.factState !== "confirmed" || !req.headers["idempotency-key"]) return send(res, 400, { error: "invalid" });
      state.tailored = true;
      if (!state.applications[0].resumes.length) state.applications[0].resumes.push({ id: "resume-1", state: "ready", createdAt: 2 });
      return send(res, 202, { resumeId: "resume-1" });
    }
    if (path === "/api/resumes/resume-1/cancel" && req.method === "POST") { state.resumeCancel = true; res.writeHead(202); res.end(); return; }
    if (path === "/api/resumes/resume-1" && req.method === "GET" && state.resumeRunning) return send(res, 200, { id: "resume-1", applicationId: "application-1", state: "running", step: null, error: null, version: 0, createdAt: 1, dispatchUncertain: true, cancellationPending: state.resumeCancel, body: null, report: null, facts: {} });
    if (path === "/api/resumes/resume-1" && req.method === "GET") return send(res, 200, { id: "resume-1", applicationId: "application-1", state: "ready", provenance: state.resumeLegacy ? "legacy" : "snapshot", ...(state.resumeNeedsGroundingReview ? { needsGroundingReview: true } : {}), ...(state.resumeLegacy ? { legacyReview: { verifiedLineIds: state.legacyChecked ? ["line-1"] : [], totalLines: state.legacyExtraLine ? 2 : 1, headersReady: state.legacyHeadersReady, skillsReady: !state.legacySkill } } : {}), step: null, error: null, version: state.resumeVersion, createdAt: 1, report: null, facts: { "fact-1": { text: fact.text, quote: fact.quote }, ...(state.checkedSkill ? { "skill-1": { text: "Go", quote: "Go" } } : {}) }, body: { summary: null, sections: state.resumeLineRemoved ? [] : [{ roleId: "role-1", kind: "job", org: role.org, title: role.title, startDate: role.startDate, endDate: null, lines: [...(state.resumeLineRemoved ? [] : [{ id: "line-1", text: state.resumeText, factIds: state.resumeUncited ? [] : ["fact-1"], status: state.resumeUncited ? "edited" : "kept" }]), ...(state.legacyExtraLine ? [{ id: "line-extra", text: "Unsupported historical line", factIds: [], status: "edited" }] : [])] }], skills: state.legacySkill ? ["Unconfirmed skill"] : state.checkedSkill ? ["Go"] : [] } });
    if (path === "/api/resumes/resume-1/versions") return send(res, 200, { versions: [] });
    if (path === "/api/resumes/resume-1/grounding-review" && req.method === "POST") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      if (state.resumeLegacy || !state.resumeNeedsGroundingReview || body.expectedVersion !== state.resumeVersion) return send(res, 409, { error: "conflict" });
      state.resumeLegacy = true; state.legacyChecked = false; state.legacyHeadersReady = false; state.legacyExtraLine = true; state.legacySkill = true; state.resumeVersion++;
      return send(res, 200, { version: state.resumeVersion });
    }
    if (path === "/api/resumes/resume-1/legacy-remove-line" && req.method === "POST") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      if (!state.resumeLegacy || !state.legacyExtraLine || body.lineId !== "line-extra" || body.expectedVersion !== state.resumeVersion) return send(res, 409, { error: "conflict" });
      state.legacyExtraLine = false; state.resumeVersion++;
      return send(res, 200, { version: state.resumeVersion });
    }
    if (path === "/api/resumes/resume-1/legacy-remove-skill" && req.method === "POST") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      if (!state.resumeLegacy || !state.legacySkill || body.skillIndex !== 0 || body.expectedVersion !== state.resumeVersion) return send(res, 409, { error: "conflict" });
      state.legacySkill = false; state.resumeVersion++;
      return send(res, 200, { version: state.resumeVersion });
    }
    if (path === "/api/resumes/resume-1/remove-skill" && req.method === "POST") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      state.checkedSkillRequests ??= [];
      state.checkedSkillRequests.push(body);
      if (state.resumeLegacy || body.skillIndex !== 0) return send(res, 409, { error: "conflict" });
      if (!state.checkedSkill && state.resumeVersion === body.expectedVersion + 1) return send(res, 200, { version: state.resumeVersion });
      if (!state.checkedSkill || body.expectedVersion !== state.resumeVersion) return send(res, 409, { error: "conflict" });
      // The change commits but the response is lost; retry must use the same version and index.
      state.checkedSkill = false; state.resumeVersion++;
      return send(res, 503, { error: "unavailable" });
    }
    if (path === "/api/resumes/resume-1/remove-line" && req.method === "POST") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      if (state.resumeLegacy || state.resumeLineRemoved || body.lineId !== "line-1" || body.expectedVersion !== state.resumeVersion) return send(res, 409, { error: "conflict" });
      state.resumeLineRemoved = true; state.resumeVersion++;
      return send(res, 200, { version: state.resumeVersion });
    }
    if (path === "/api/resumes/resume-1/legacy-finalize" && req.method === "POST") {
      const body = JSON.parse((await read(req)).toString("utf8"));
      if (!state.resumeLegacy || !state.legacyChecked || !state.legacyHeadersReady || state.legacySkill || body.expectedVersion !== state.resumeVersion) return send(res, 409, { error: "conflict" });
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
    if (path === "/api/applications/application-1/documents" && req.method === "GET") {
      if (state.deferDocumentRead) {
        state.deferDocumentRead = false;
        await new Promise((resolve) => { releaseDocumentRead = resolve; });
      }
      if (state.failDocumentRead) { state.failDocumentRead = false; return send(res, 503, { error: "unavailable" }); }
      if (state.alwaysHideDocuments) return send(res, 200, { documents: [] });
      if (state.hideDocumentRead) { state.hideDocumentRead = false; return send(res, 200, { documents: [] }); }
      return send(res, 200, { documents: state.documents });
    }
    if (path === "/api/documents/question-doc/questions/question-1/answer" && req.method === "POST") {
      state.answer = JSON.parse((await read(req)).toString("utf8"));
      await new Promise((resolve) => { releaseAnswer = resolve; });
      return send(res, 201, { factId: "answer-fact" });
    }
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
      state.letterStarts = (state.letterStarts ?? 0) + 1;
      state.documents.push({ id: "document-1", applicationId: "application-1", kind: "letter", state: "ready", version: 1, createdAt: 1, error: null, result: { kind: "letter", units: [{ id: "unit-1", roleId: "role-1", text: "I built 12 payment services.", factIds: ["fact-1"], group: 0 }], questions: [], report: { kept: 1, repaired: 0, replaced: 0, dropped: 0, gaps: [] } }, facts: { "fact-1": { text: fact.text, quote: fact.quote } } });
      state.failDocumentRead = true;
      state.hideDocumentRead = true;
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
    const waitForRelease = async (get) => { for (let i = 0; i < 100; i++) { const release = get(); if (release) return release; await delay(100); } throw new Error("API_GATE_TIMEOUT"); };
    const clickText = (selector, text) => evalPage(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(x => x.textContent.trim() === ${JSON.stringify(text)}); if (!e) return false; e.click(); return true; })()`);
    // The synthetic.pdf row, and its status read as "Ready · 1 role to check": the mark, then the words beside it.
    const sourceRow = `[...document.querySelectorAll('.rs-sources .rs-source')].find(e => e.querySelector('.rs-source__name')?.textContent.trim() === 'synthetic.pdf')`;
    const sourceStatus = `[...(${sourceRow}?.querySelector('.rs-source__meta')?.children ?? [])].map(e => e.textContent.trim()).join(' · ')`;
    // On To check, the status of the file beside the question: "2 to check", "1 to check" or "All checked".
    const fileStatus = `document.querySelector('.facts-file .rs-mark')?.textContent.trim()`;
    const go = (hash) => evalPage(`location.hash = ${JSON.stringify(hash)}`);
    await call("Page.enable"); await call("Runtime.enable"); await call("Fetch.enable", { patterns: [{ urlPattern: "*" }] }); await call("Page.navigate", { url: origin });
    stage = "sign_in"; await wait(`!![...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Sign in with Google')`); await clickText("a", "Sign in with Google"); await wait(`document.querySelector('h1')?.textContent.trim() === 'Today' && !![...document.querySelectorAll('h3')].find(x => x.textContent.trim() === '1. Add the resume you have')`); await evalPage(`location.hash = '#/facts/check'`); await wait(`document.querySelector('nav a[aria-current="page"]')?.textContent.trim() === 'Facts' && document.querySelector('.app-tabs a[aria-current="page"]')?.textContent.trim() === 'To check' && !!document.querySelector('input[type=file]')`);
    stage = "upload_retry"; const root = await call("DOM.getDocument"); const input = await call("DOM.querySelector", { nodeId: root.root.nodeId, selector: "input[type=file]" }); await call("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [file] }); await wait(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Retry upload')`); await clickText("button", "Retry upload"); await wait(`document.body?.innerText.includes('Built 12 payment services')`); if (state.uploadKeys.length !== 2 || state.uploadKeys[0] !== state.uploadKeys[1]) throw new Error("UPLOAD_RETRY_KEY_MISMATCH");
    stage = "ocr_download_links"; await go("#/facts/files"); await wait(`!![...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Download image inputs (JSON)' && x.getAttribute('href') === '/api/sources/source-ocr/file') && !![...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Download original PDF' && x.getAttribute('href') === '/api/sources/source-1/file')`);
    stage = "source_role_only";
    state.hideSourceFact = true; await call("Page.reload");
    await wait(`${sourceStatus} === 'Ready · 1 role to check'`);
    stage = "source_empty";
    state.hideSourceRole = true; await call("Page.reload");
    await wait(`${sourceStatus} === 'Ready · No items shown' && !!${sourceRow}?.textContent.includes('No roles or facts from this file are shown')`);
    state.hideSourceFact = false; state.hideSourceRole = false; await call("Page.reload");
    await wait(`${sourceStatus} === 'Ready · 1 role and 1 fact to check'`);
    stage = "poll_recovery";
    state.sourceRunning = true; await call("Page.reload");
    await wait(`document.body?.innerText.includes("Resumatic can’t confirm that reading started")`);
    await evalPage(`window.__syntheticVaultPushes = 0; window.addEventListener('resumatic:vault-change', () => window.__syntheticVaultPushes++)`);
    state.sourcePollFailures = 2;
    for (let i = 0; i < 100 && !state.sourcePollFailureCount; i++) await delay(100);
    if (!state.sourcePollFailureCount) throw new Error("POLL_FAILURE_NOT_OBSERVED");
    state.sourceRunning = false;
    // No push or manual retry: the running-state poll must recover itself.
    await wait(`${sourceStatus} === 'Ready · 1 role and 1 fact to check'`);
    if (state.sourcePollFailureCount !== 2) throw new Error("POLL_RETRY_NOT_OBSERVED");
    if (await evalPage(`window.__syntheticVaultPushes !== 0`)) throw new Error("POLL_RECOVERY_USED_PUSH");
    const readsAfterReady = state.sourceReads;
    await delay(2500);
    if (state.sourceReads !== readsAfterReady) throw new Error("POLL_DID_NOT_STOP_AT_READY");
    stage = "poll_forbidden";
    state.sourceRunning = true; await call("Page.reload");
    await wait(`document.body?.innerText.includes("Resumatic can’t confirm that reading started")`);
    await evalPage(`window.__syntheticVaultPushes = 0; window.addEventListener('resumatic:vault-change', () => window.__syntheticVaultPushes++)`);
    state.sourceForbiddenFailures = 1;
    for (let i = 0; i < 100 && !state.sourceForbiddenSeen; i++) await delay(100);
    if (!state.sourceForbiddenSeen) throw new Error("POLL_FORBIDDEN_NOT_OBSERVED");
    await wait(`document.body?.innerText.includes('Access unavailable')`);
    state.sourceRunning = false;
    const readsAfterForbidden = state.sourceReads;
    await delay(2500);
    if (state.sourceReads !== readsAfterForbidden || await evalPage(`window.__syntheticVaultPushes !== 0`)) throw new Error("POLL_CONTINUED_AFTER_FORBIDDEN");
    await clickText('[role="alert"] button', "Try again");
    await wait(`${sourceStatus} === 'Ready · 1 role and 1 fact to check'`);
    stage = "uncertain_source_cancellation";
    state.sourceRunning = true; await call("Page.reload");
    await wait(`document.body?.innerText.includes("Resumatic can’t confirm that reading started")`);
    await clickText("button", "Cancel reading");
    await wait(`document.body?.innerText.includes('Cancellation is pending')`);
    if (!state.sourceCancel) throw new Error("SOURCE_CANCEL_NOT_SENT");
    stage = "failed_source_retry";
    state.sourceRunning = false; state.sourceCancel = false; state.sourceFailed = true; await call("Page.reload");
    await wait(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Retry reading')`);
    await clickText("button", "Retry reading");
    await wait(`!!${sourceRow}?.querySelector('[role="alert"]')`);
    await clickText("button", "Retry reading");
    await wait(`${sourceStatus} === 'Ready · 1 role and 1 fact to check'`);
    if (state.sourceRetryKeys.length !== 2 || state.sourceRetryKeys[0] !== state.sourceRetryKeys[1]) throw new Error("SOURCE_RETRY_KEY_MISMATCH");
    await wait(`${sourceStatus} === 'Ready · 1 role and 1 fact to check'`);
    stage = "role_draft_during_refresh";
    await go("#/facts/check");
    await wait(`${fileStatus} === '2 to check'`);
    await clickText(".facts-ask button", "Fix it");
    await wait(`!!document.querySelector('.facts-ask form input[id$="-title"]')`);
    await evalPage(`(() => { const e = document.querySelector('.facts-ask form input[id$="-title"]'); e.focus(); e.setSelectionRange(e.value.length, e.value.length); })()`);
    await call("Input.insertText", { text: " draft" });
    await clickText('.facts-file button', 'Confirm all 2 from this file');
    await clickText('.facts-file button', 'Yes, confirm 2');
    await wait(`${fileStatus} === 'All checked'`);
    if (!await evalPage(`document.querySelector('.facts-ask form input[id$="-title"]')?.value === 'Engineer draft' && document.querySelector('fieldset.rs-filter')?.disabled && document.body.innerText.includes('Checking is paused')`)) throw new Error("ROLE_DRAFT_LOST_DURING_REFRESH");
    await clickText('.facts-ask form button', 'Cancel');
    await wait(`!document.querySelector('fieldset.rs-filter')?.disabled`);
    state.roleState = "proposed"; state.factState = "proposed";
    await evalPage(`window.dispatchEvent(new Event('resumatic:vault-change'))`);
    await wait(`${fileStatus} === '2 to check'`);
    stage = "review_lock_released_on_navigation";
    await clickText(".facts-ask button", "Fix it");
    await wait(`!!document.querySelector('.facts-ask form input[id$="-title"]')`);
    await go("#/jobs");
    await wait(`!!document.getElementById('job-heading')`);
    await go("#/facts/check");
    await wait(`${fileStatus} === '2 to check'`);
    if (await evalPage(`document.querySelector('fieldset.rs-filter')?.disabled || !!document.querySelector('.facts-ask form input[id$="-title"]')`)) throw new Error("REVIEW_LOCK_SURVIVED_NAVIGATION");
    stage = "fact_draft_during_refresh";
    await clickText('.facts-ask button', 'Skip for now');
    await wait(`document.querySelector('.facts-ask__text')?.textContent.trim() === 'Built 12 payment services'`);
    await clickText('.facts-ask button', 'Fix it');
    await wait(`!!document.querySelector('.facts-ask textarea')`);
    await evalPage(`(() => { const e = document.querySelector('.facts-ask textarea'); e.focus(); e.setSelectionRange(e.value.length, e.value.length); })()`);
    await call("Input.insertText", { text: " draft" });
    state.factState = "confirmed"; fact.roleId = null;
    await evalPage(`window.dispatchEvent(new Event('resumatic:vault-change'))`);
    await wait(`${fileStatus} === '1 to check'`);
    if (!await evalPage(`document.querySelector('.facts-ask textarea')?.value === 'Built 12 payment services draft' && document.querySelector('fieldset.rs-filter')?.disabled`)) throw new Error("FACT_DRAFT_LOST_DURING_REFRESH");
    await clickText('.facts-ask form button', 'Cancel');
    await wait(`!document.querySelector('.facts-ask textarea') && !document.querySelector('fieldset.rs-filter')?.disabled`);
    state.factState = "proposed"; fact.roleId = "role-1";
    await evalPage(`window.dispatchEvent(new Event('resumatic:vault-change'))`);
    await wait(`${fileStatus} === '2 to check'`);
    stage = "role_edit_lost_response";
    // The fact left the queue while its editor was closed, so the role is the question again.
    await wait(`document.querySelector('.facts-ask__text')?.textContent.trim() === 'Engineer at Acme Example'`);
    await clickText(".facts-ask button", "Fix it");
    await wait(`!!document.querySelector('.facts-ask form input[id$="-title"]')`);
    await evalPage(`(() => { const e = document.querySelector('.facts-ask form input[id$="-title"]'); e.focus(); e.setSelectionRange(e.value.length, e.value.length); })()`);
    await call("Input.insertText", { text: " Senior" });
    await clickText(".facts-ask button", "Save role");
    await wait(`!!document.querySelector('.facts-ask [role="alert"]')`);
    if (!await evalPage(`document.querySelector('.facts-ask form input[id$="-title"]')?.value === 'Engineer Senior'`)) throw new Error('ROLE_EDIT_DRAFT_LOST');
    await clickText(".facts-ask button", "Save role");
    await wait(`!document.querySelector('.facts-ask form input[id$="-title"]')`);
    if (role.title !== "Engineer Senior" || state.roleEditAttempts !== 2 || await evalPage(`document.querySelector('fieldset.rs-filter')?.disabled || !document.body.innerText.includes('Engineer Senior')`)) throw new Error('ROLE_EDIT_NOT_RECONCILED');
    stage = "review_role"; await wait(`!![...document.querySelectorAll('.facts-ask button')].find(x => x.textContent.trim() === 'That’s right')`); await clickText(".facts-ask button", "That’s right"); await wait(`document.querySelector('.facts-ask__text')?.textContent.trim() === 'Built 12 payment services'`);
    await wait(`${fileStatus} === '1 to check'`);
    stage = "fact_level_review"; await wait(`document.body?.innerText.includes('needs your confirmation before it is used')`); await clickText('.facts-ask button', 'Fix it');
    await wait(`!!document.querySelector('.facts-ask select[id$="-level"]')`);
    await evalPage(`(() => { const e = document.querySelector('.facts-ask select[id$="-level"]'); e.value = 'led'; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await clickText('.facts-ask button', 'Save fact');
    await wait(`!!document.querySelector('.facts-ask [role="alert"]')`);
    if (!await evalPage(`document.querySelector('.facts-ask select[id$="-level"]')?.value === 'led'`)) throw new Error('FACT_EDIT_DRAFT_LOST');
    await clickText('.facts-ask button', 'Save fact'); await wait(`!document.querySelector('.facts-ask select[id$="-level"]')`);
    if (fact.level !== 'led' || fact.levelNeedsReview || state.factEditAttempts !== 2 || await evalPage(`document.querySelector('fieldset.rs-filter')?.disabled`)) throw new Error('FACT_LEVEL_NOT_REAFFIRMED');
    stage = "review_fact"; await wait(`!![...document.querySelectorAll('.facts-ask button')].find(x => x.textContent.trim() === 'That’s right' && !x.disabled)`); await clickText(".facts-ask button", "That’s right"); await wait(`document.body?.innerText.includes('Nothing is waiting for you to check')`);
    await go("#/facts/files");
    await wait(`${sourceStatus} === 'Ready · All checked'`);
    stage = "manual_fact_retry";
    await go("#/facts/all");
    await wait(`!![...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add a fact yourself')`);
    await clickText("button", "Add a fact yourself");
    await wait(`!!document.querySelector('.add-fact-form textarea')`);
    await evalPage(`document.querySelector('.add-fact-form textarea').focus()`);
    await call("Input.insertText", { text: "Built an accessible application" });
    await clickText(".add-fact-form button", "Add fact");
    const finishManualFact = await waitForRelease(() => releaseManualFact);
    await wait(`!![...document.querySelectorAll('.add-fact-form button')].find(x => x.textContent.trim() === 'Adding…')`);
    if (!await evalPage(`(() => { const f = document.querySelector('form.add-fact-form'); return !!f && [...f.querySelectorAll('textarea, select')].every(e => e.disabled) && [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add a fact yourself')?.disabled; })()`)) throw new Error("MANUAL_FACT_FIELDS_NOT_LOCKED");
    finishManualFact();
    await wait(`!!document.querySelector('.add-fact-form [role="alert"]')`);
    if (!await evalPage(`(() => { const f = document.querySelector('form.add-fact-form'); return f?.querySelector('textarea')?.value === 'Built an accessible application' && [...f.querySelectorAll('textarea, select')].every(e => !e.disabled); })()`)) throw new Error("MANUAL_FACT_RETRY_INPUT_LOST");
    // A saved fact starts confirmed even if its subsequent snapshot read fails.
    state.sourcePollFailures = 1;
    await clickText(".add-fact-form button", "Add fact");
    await wait(`document.body?.innerText.includes('Fact added.')`);
    if (!await evalPage(`document.querySelector('input[name="review-filter"]:checked')?.parentElement?.innerText.includes('Confirmed')`)) throw new Error("MANUAL_FACT_FILTER_NOT_SELECTED_AFTER_READ_FAILURE");
    await clickText('[role="alert"] button', "Try again");
    await wait(`document.body?.innerText.includes('Built an accessible application')`);
    if (state.manualFactKeys.length !== 2 || state.manualFactKeys[0] !== state.manualFactKeys[1]) throw new Error("MANUAL_FACT_RETRY_KEY_MISMATCH");
    await clickText(".add-fact-form button", "Close");
    await wait(`document.activeElement?.textContent.trim() === 'Add a fact yourself'`);
    stage = "manual_role_submission_lock";
    await clickText("button", "Add a role");
    await wait(`!!document.querySelector('form[aria-label="Add a role"] input[type="text"]')`);
    await evalPage(`document.querySelector('form[aria-label="Add a role"] input[type="text"]').focus()`);
    await call("Input.insertText", { text: "Synthetic Volunteer Group" });
    await clickText('form[aria-label="Add a role"] button', "Add role");
    const finishManualRole = await waitForRelease(() => releaseManualRole);
    await wait(`!![...document.querySelectorAll('form[aria-label="Add a role"] button')].find(x => x.textContent.trim() === 'Saving…')`);
    if (!await evalPage(`(() => { const f = document.querySelector('form[aria-label="Add a role"]'); return !!f && [...f.querySelectorAll('input, select')].every(e => e.disabled) && [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add a role')?.disabled; })()`)) throw new Error("MANUAL_ROLE_FIELDS_NOT_LOCKED");
    finishManualRole();
    await wait(`!!document.querySelector('form[aria-label="Add a role"] [role="alert"]')`);
    if (!await evalPage(`(() => { const f = document.querySelector('form[aria-label="Add a role"]'); return f?.querySelector('input[type="text"]')?.value === 'Synthetic Volunteer Group' && [...f.querySelectorAll('input, select')].every(e => !e.disabled); })()`)) throw new Error("MANUAL_ROLE_RETRY_INPUT_LOST");
    await clickText('form[aria-label="Add a role"] button', "Add role");
    await wait(`!document.querySelector('form[aria-label="Add a role"]') && document.activeElement?.textContent.trim() === 'Add a role'`);
    if (state.manualRoles.length !== 1 || state.manualRoleKeys.length !== 2 || state.manualRoleKeys[0] !== state.manualRoleKeys[1]) throw new Error("MANUAL_ROLE_RETRY_KEY_MISMATCH");
    stage = "application";
    const jobText = "Synthetic platform engineer position requiring experience building reliable payment services and APIs.";
    await clickText("nav a", "Jobs"); await wait(`!!document.querySelector('textarea')`); await evalPage(`document.querySelector('textarea').focus()`); await call("Input.insertText", { text: jobText });
    await clickText("button", "Save job");
    let finishJob = await waitForRelease(() => releaseJob); releaseJob = undefined;
    await wait(`document.querySelector('form.card textarea')?.readOnly`);
    if (!await evalPage(`document.querySelector('form.card')?.getAttribute('aria-busy') === 'true' && document.activeElement === document.querySelector('form.card textarea')`)) throw new Error("JOB_SAVING_FOCUS_LOST");
    await call("Input.insertText", { text: " should not be inserted" });
    if (!await evalPage(`document.querySelector('form.card textarea')?.value === ${JSON.stringify(jobText)}`)) throw new Error("JOB_EDITABLE_DURING_SAVE");
    finishJob();
    await wait(`!!document.querySelector('form.card [role="alert"]') && !document.querySelector('form.card textarea')?.readOnly`);
    if (!await evalPage(`document.querySelector('form.card textarea')?.value === ${JSON.stringify(jobText)} && document.activeElement === document.querySelector('form.card textarea')`)) throw new Error("JOB_FAILURE_DRAFT_OR_FOCUS_LOST");
    stage = "job_retry_after_reload";
    await evalPage(`window.__beforeJobRetryReload = true`);
    await call("Page.reload");
    await wait(`window.__beforeJobRetryReload !== true && !!document.querySelector('form.card textarea')`);
    await evalPage(`document.querySelector('form.card textarea').focus()`);
    await call("Input.insertText", { text: jobText });
    await clickText("button", "Save job");
    finishJob = await waitForRelease(() => releaseJob); releaseJob = undefined;
    await wait(`document.querySelector('form.card textarea')?.readOnly`);
    finishJob();
    await wait(`document.querySelector('form.card textarea')?.value === '' && !document.querySelector('form.card textarea')?.readOnly && document.body?.innerText.includes('Synthetic platform engineer job')`);
    if (state.jobRequests.length !== 2 || state.jobKeys.length !== 2 || state.jobKeys[0] !== state.jobKeys[1] || state.applications.length !== 1 || state.jobRequests.some((body) => body.jdText !== jobText) || !await evalPage(`document.querySelector('form.card textarea')?.value === '' && !document.querySelector('form.card textarea')?.readOnly && document.activeElement === document.querySelector('form.card textarea')`)) throw new Error("JOB_SAVE_RESULT_WRONG");
    stage = "job_opened_from_row";
    // A job is a row on Your jobs whose name opens its own page.
    await clickText(".app-job-row h3 a", "Synthetic platform engineer job");
    await wait(`location.hash === '#/jobs/application-1/fit' && !!document.querySelector('[aria-label="This job"] a[aria-current="page"]') && document.querySelector('[aria-label="This job"] a[aria-current="page"]').textContent.trim() === 'Fit'`);
    stage = "document_initial_read";
    state.deferDocumentRead = true;
    await clickText('[aria-label="This job"] a', "Cover letter");
    const finishDocumentRead = await waitForRelease(() => releaseDocumentRead);
    await wait(`document.body?.innerText.includes('Loading your documents')`);
    if (!await evalPage(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Write a cover letter')?.disabled`)) throw new Error("DOCUMENT_START_ENABLED_BEFORE_READ");
    finishDocumentRead();
    stage = "tracking";
    await clickText('[aria-label="This job"] a', "Application");
    await wait(`!!document.querySelector('.app-job-tracking select')`); await evalPage(`(() => { const e = document.querySelector('.app-job-tracking select'); e.value = 'applied'; e.dispatchEvent(new Event('change', { bubbles: true })); })()`); await evalPage(`document.querySelector('.app-job-tracking textarea').focus()`); await call("Input.insertText", { text: "Synthetic follow-up note" }); await clickText("button", "Save tracking details");
    await wait(`!!document.querySelector('.app-job-tracking [role="alert"]')`);
    if (!await evalPage(`document.querySelector('.app-job-tracking textarea')?.value === 'Synthetic follow-up note'`)) throw new Error("TRACKING_DRAFT_LOST");
    await clickText("button", "Save tracking details");
    await wait(`document.querySelector('.app-job-tracking')?.innerText.includes('Saved.')`);
    if (state.trackingRequests.length !== 2 || state.trackingRequests.some((item) => item.expectedRevision !== 1) || state.applications[0]?.revision !== 2 || state.applications[0]?.status !== "applied" || state.applications[0]?.notes !== "Synthetic follow-up note") throw new Error("TRACKING_NOT_RECONCILED");
    // A concurrent edit with different content must remain a conflict and keep the local draft.
    state.applications[0].notes = "Remote note"; state.applications[0].revision++;
    await evalPage(`(() => { const e = document.querySelector('.app-job-tracking textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(e, 'Local draft'); e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await clickText("button", "Save tracking details");
    await wait(`!!document.querySelector('.app-job-tracking [role="alert"]')`);
    if (!await evalPage(`document.querySelector('.app-job-tracking textarea')?.value === 'Local draft'`) || state.applications[0].notes !== "Remote note") throw new Error("TRACKING_CONFLICT_DRAFT_LOST");
    stage = "tracking_draft_on_refresh";
    // The job is read again when the vault changes: the open form, its draft and its focus stay.
    await evalPage(`(() => { const e = document.querySelector('.app-job-tracking textarea'); e.focus(); window.__trackerDraft = e; })()`);
    state.applications[0].status = "interview"; state.applications[0].revision++;
    await evalPage(`window.dispatchEvent(new Event('resumatic:vault-change'))`);
    await wait(`document.querySelector('.app-job-page-head .rs-mark')?.textContent.includes('Interview')`);
    if (!await evalPage(`(() => { const e = document.querySelector('.app-job-tracking textarea'); return e === window.__trackerDraft && document.activeElement === e && e.value === 'Local draft'; })()`)) throw new Error("TRACKING_DRAFT_LOST_ON_REFRESH");
    await clickText("button", "Reload saved details");
    await wait(`document.querySelector('.app-job-tracking textarea')?.value === 'Remote note'`);
    stage = "board_keyboard_scroll";
    await evalPage(`location.hash = '#/jobs'`);
    await wait(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Board')`);
    await clickText("button", "Board");
    await wait(`!!document.querySelector('.application-board-scroller')`);
    if (!await evalPage(`(() => { const region = document.querySelector('[aria-label="Jobs by status"]'); region.focus(); region.scrollLeft = 100; return document.activeElement === region && region.tabIndex === 0 && region.scrollWidth > region.clientWidth && region.scrollLeft > 0; })()`)) throw new Error("BOARD_NOT_KEYBOARD_SCROLLABLE");
    await clickText("button", "List");
    stage = "document_refresh_after_start";
    state.alwaysHideDocuments = true;
    await evalPage(`location.hash = '#/jobs/application-1/letter'`);
    await wait(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Write a cover letter' && !x.disabled)`);
    await clickText("button", "Write a cover letter");
    await wait(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Write a cover letter'); return b?.disabled && !!b.closest('section')?.querySelector('[role="alert"] button'); })()`);
    if (state.letterStarts !== 1) throw new Error("DOCUMENT_START_DUPLICATED");
    await evalPage(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Write a cover letter'); b.closest('section').querySelector('[role="alert"] button').click(); })()`);
    await wait(`document.body?.innerText.includes('Your document was started.')`);
    if (!await evalPage(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Write a cover letter')?.disabled`)) throw new Error("DOCUMENT_START_ENABLED_BEFORE_OBSERVED");
    stage = "document_tab_return_guard";
    // Another of the job's tabs, then back: the guard holds on both.
    await clickText('[aria-label="This job"] a', "Interview");
    await wait(`document.body?.innerText.includes('Your document was started.') && !![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Prepare for an interview')?.disabled`);
    state.hideDocumentRead = true;
    await clickText('[aria-label="This job"] a', "Cover letter");
    await wait(`document.body?.innerText.includes('Your document was started.')`);
    if (!await evalPage(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Write a cover letter')?.disabled`)) throw new Error("DOCUMENT_START_ENABLED_AFTER_TAB_RETURN");
    stage = "document_storage_before_reload";
    if (!await evalPage(`sessionStorage.getItem('resumatic:document-start:' + JSON.stringify(['synthetic-user', 'application-1'])) === 'document-1'`)) throw new Error("DOCUMENT_START_NOT_STORED");
    stage = "document_reload_guard";
    state.alwaysHideDocuments = true;
    await call("Page.reload");
    await wait(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Write a cover letter')`);
    stage = "document_storage_after_reload";
    if (!await evalPage(`sessionStorage.getItem('resumatic:document-start:' + JSON.stringify(['synthetic-user', 'application-1'])) === 'document-1'`)) throw new Error("DOCUMENT_START_NOT_RESTORED");
    stage = "document_reload_pending";
    await wait(`document.body?.innerText.includes('Your document was started.')`);
    if (!await evalPage(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Write a cover letter')?.disabled`)) throw new Error("DOCUMENT_START_ENABLED_AFTER_RELOAD");
    state.alwaysHideDocuments = false;
    state.hideDocumentRead = false;
    await clickText("button", "Refresh its status");
    // The newest letter is open, with where each sentence came from.
    stage = "cover_letter"; await wait(`document.body?.innerText.includes('I built 12 payment services.') && !!document.querySelector('details.evidence[open]')`);
    await wait(`(() => { const link = [...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Download Word'); return link?.origin === location.origin && link.getAttribute('href') === '/api/documents/document-1/docx' && link.referrerPolicy === 'no-referrer'; })()`);
    stage = "saved_interview_answer";
    state.documents.push({ id: "question-doc", applicationId: "application-1", kind: "questions", state: "ready", version: 1, createdAt: 1, error: null, answeredQuestionIds: ["question-1"], result: { kind: "questions", units: [], questions: [{ id: "question-1", requirement: "Reliability", question: "How have you improved reliability?" }], report: { kept: 0, repaired: 0, replaced: 0, dropped: 0, gaps: [] } }, facts: {} });
    // Experience questions are on Fit.
    await evalPage(`location.hash = '#/jobs/application-1/fit'`);
    await call("Page.reload");
    await wait(`document.body?.innerText.includes("You’ve already saved an answer to this question.")`);
    stage = "answer_submission_lock";
    await evalPage(`document.querySelector('.gap-answer textarea').focus()`);
    await call("Input.insertText", { text: "Improved reliability with monitoring" });
    await clickText(".gap-answer button", "Save my answer as a fact");
    const finishAnswer = await waitForRelease(() => releaseAnswer);
    await wait(`!![...document.querySelectorAll('.gap-answer button')].find(x => x.textContent.trim() === 'Saving…')`);
    if (!await evalPage(`(() => { const f = document.querySelector('.gap-answer'); return f?.querySelector('textarea')?.disabled && f?.querySelector('select')?.disabled; })()`)) throw new Error("INTERVIEW_FIELDS_NOT_LOCKED");
    finishAnswer();
    await wait(`document.body?.innerText.includes('Saved to your facts')`);
    if (state.answer?.answer !== "Improved reliability with monitoring" || !await evalPage(`document.querySelector('.gap-answer textarea')?.value === 'Improved reliability with monitoring'`)) throw new Error("INTERVIEW_ANSWER_CHANGED_WHILE_SAVING");
    stage = "uncertain_document_cancellation";
    // Interview preparation is cancelled and retried on Interview.
    state.documents.push({ id: "document-2", applicationId: "application-1", kind: "prep", state: "running", dispatchUncertain: true, createdAt: 2, result: null, facts: {} });
    await clickText('[aria-label="This job"] a', "Interview");
    await wait(`document.body?.innerText.includes("Resumatic can’t confirm that preparation started")`);
    await clickText("button", "Cancel this document");
    await wait(`document.body?.innerText.includes("Cancellation is pending")`);
    if (!state.documents.find((d) => d.id === "document-2")?.cancellationPending) throw new Error("DOCUMENT_CANCEL_NOT_SENT");
    state.documents = state.documents.filter((d) => d.id !== "document-2");
    stage = "document_retry";
    state.documents.push({ id: "document-failed", applicationId: "application-1", kind: "prep", state: "failed", retryRunId: "document-failed", createdAt: 3, error: "unavailable", result: null, facts: {} });
    await clickText('[aria-label="This job"] a', "Cover letter"); await clickText('[aria-label="This job"] a', "Interview");
    await wait(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Retry interview preparation' && !x.disabled)`);
    await clickText("button", "Retry interview preparation");
    await wait(`document.body?.innerText.includes('Resumatic is busy right now')`);
    await clickText("button", "Retry interview preparation");
    await wait(`document.body?.innerText.includes('Preparing and checking your document')`);
    if (state.documentRetryKeys.length !== 2 || state.documentRetryKeys[0] !== state.documentRetryKeys[1]) throw new Error("DOCUMENT_RETRY_KEY_MISMATCH");
    state.documents = state.documents.filter((d) => d.id !== "document-retry");
    stage = "resume";
    await clickText('[aria-label="This job"] a', "Resume");
    await wait(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Tailor a resume' && !x.disabled)`);
    await clickText("button", "Tailor a resume"); await wait(`location.hash === '#/jobs/application-1/resume/resume-1' && !!document.querySelector('[aria-label="Resume preview"]')`); if (!state.tailored) throw new Error("TAILOR_NOT_STARTED");
    await wait(`document.querySelector('[aria-label="Resume preview"]')?.innerText.includes('Built 12 payment services')`);
    stage = "historic_level_guard"; state.resumeNeedsGroundingReview = true; await call("Page.reload");
    await wait(`document.body?.innerText.includes('wording or headings that haven’t been checked against your record')`);
    if (await evalPage(`!![...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Download PDF')`)) throw new Error('HISTORIC_LEVEL_DOWNLOAD_SHOWN');
    state.resumeNeedsGroundingReview = false; await call("Page.reload");
    await wait(`!![...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Download PDF')`);
    // Each line's tools are in its card, which opens from its mark beside the page.
    const openCard = (lineId) => evalPage(`(() => { const b = document.querySelector('[data-note-for="${lineId}"] button'); if (!b) return false; if (b.getAttribute('aria-expanded') !== 'true') b.click(); return true; })()`);
    // No mark beside the page overlaps the open card.
    const cardClear = `(() => { const c = document.querySelector('.app-line-card')?.getBoundingClientRect(); if (!c) return false; return [...document.querySelectorAll('.app-line-marks > li')].every((li) => { const m = li.getBoundingClientRect(); return m.bottom <= c.top + 0.5 || m.top >= c.bottom - 0.5 || m.right <= c.left || m.left >= c.right; }); })()`;
    stage = "resume_draft_during_refresh";
    await wait(`!!document.querySelector('[data-note-for="line-1"] button')`);
    await openCard("line-1");
    await wait(`!!document.querySelector('.app-line-card') && document.activeElement?.matches('.app-line-card h3')`);
    if (!await evalPage(cardClear)) throw new Error("LINE_CARD_OVERLAPS_MARK");
    await clickText(".app-line-card button", "Edit line");
    await evalPage(`(() => { const e = document.querySelector('.app-line-card textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(e, 'Unsaved wording stays here'); e.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    state.resumeVersion++;
    await evalPage(`window.dispatchEvent(new Event('resumatic:vault-change'))`);
    await wait(`document.body?.innerText.includes('A newer resume version is available')`);
    if (!await evalPage(`document.querySelector('.app-line-card textarea')?.value === 'Unsaved wording stays here' && [...document.querySelectorAll('.app-line-card button')].find(x => x.textContent.trim() === 'Check and save')?.disabled && document.querySelector('.version-picker select')?.disabled`)) throw new Error("RESUME_DRAFT_NOT_PRESERVED");
    await clickText(".app-line-card button", "Cancel");
    await wait(`!document.body?.innerText.includes('A newer resume version is available') && !document.querySelector('.version-picker select')?.disabled`);
    stage = "verified_manual_edit";
    await openCard("line-1");
    await wait(`!!document.querySelector('.app-line-card')`);
    await clickText(".app-line-card button", "Edit line");
    await evalPage(`(() => { const e = document.querySelector('.app-line-card textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(e, 'Built 12 reliable payment services'); e.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await clickText(".app-line-card button", "Check and save");
    await wait(`document.body?.innerText.includes("isn’t backed by the facts it cites")`);
    if (!await evalPage(`document.querySelector('.app-line-card textarea')?.value === 'Built 12 reliable payment services'`)) throw new Error("MANUAL_TEXT_LOST");
    await clickText(".app-line-card button", "Check and save");
    await wait(`document.querySelector('[aria-label="Resume preview"]')?.innerText.includes('Built 12 reliable payment services') && !document.querySelector('.app-line-card textarea')`);
    // After the check, the same line's card is open again, with focus on its heading.
    await wait(`document.querySelector('.app-line-card')?.dataset.cardFor === 'line-1' && document.activeElement?.matches('.app-line-card h3')`);
    if (!await evalPage(cardClear)) throw new Error("LINE_CARD_OVERLAPS_MARK_AFTER_CHECK");
    stage = "uncited_remediation";
    state.resumeUncited = true; await call("Page.reload");
    await wait(`document.body?.innerText.includes('wording or headings that haven’t been checked against your record')`);
    if (await evalPage(`!![...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Download PDF')`)) throw new Error("UNVERIFIED_DOWNLOAD_SHOWN");
    await openCard("line-1");
    await wait(`!!document.querySelector('.app-line-card')`);
    await clickText(".app-line-card button", "Edit line");
    await wait(`!!document.querySelector('.app-line-card fieldset input[type="checkbox"]')`);
    await evalPage(`document.querySelector('.app-line-card fieldset input[type="checkbox"]').click()`);
    await clickText(".app-line-card button", "Check and save");
    await wait(`!![...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Download PDF')`);
    if (JSON.stringify(state.manualEdits.at(-1)?.manualFactIds) !== '["fact-1"]') throw new Error("REMEDIATION_FACT_MISSING");
    stage = "legacy_resume_review";
    state.resumeNeedsGroundingReview = true; await call("Page.reload");
    await wait(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Start review')`);
    await clickText("button", "Start review");
    await wait(`document.body?.innerText.includes('0 of 2 lines checked') && document.body?.innerText.includes("headings and skills don’t match")`);
    // Two marks now: the card for the first line pushes the second down rather than covering it.
    await openCard("line-1");
    await wait(`!!document.querySelector('.app-line-card')`);
    if (!await evalPage(cardClear)) throw new Error("LINE_CARD_OVERLAPS_SECOND_MARK");
    await openCard("line-extra");
    await wait(`document.querySelector('.app-line-card')?.dataset.cardFor === 'line-extra'`);
    await clickText(".app-line-card button", "Remove line (keeps earlier versions)");
    await wait(`document.body?.innerText.includes('0 of 1 lines checked') && !document.querySelector('[aria-label="Resume preview"]')?.innerText.includes('Unsupported historical line')`);
    if (state.legacyExtraLine) throw new Error("LEGACY_REMOVE_NOT_SENT");
    await wait(`!!document.querySelector('button[aria-label="Remove skill Unconfirmed skill"]')`);
    await evalPage(`document.querySelector('button[aria-label="Remove skill Unconfirmed skill"]').click()`);
    await wait(`!document.body?.innerText.includes('Unconfirmed skill')`);
    if (state.legacySkill) throw new Error("LEGACY_SKILL_REMOVE_NOT_SENT");
    if (!state.resumeLegacy) throw new Error("SNAPSHOT_REVIEW_NOT_STARTED");
    if (!await evalPage(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Create checked version')?.disabled`)) throw new Error("LEGACY_FINALIZE_NOT_BLOCKED");
    await openCard("line-1");
    await wait(`!!document.querySelector('.app-line-card')`);
    await clickText(".app-line-card button", "Review line");
    await wait(`!!document.querySelector('.app-line-card fieldset input[type="checkbox"]')`);
    await evalPage(`document.querySelector('.app-line-card fieldset input[type="checkbox"]').click()`);
    await clickText(".app-line-card button", "Check and save");
    await wait(`document.body?.innerText.includes('1 of 1 lines checked')`);
    if (!await evalPage(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Create checked version')?.disabled`)) throw new Error("LEGACY_HEADER_NOT_BLOCKED");
    state.legacyHeadersReady = true; await call("Page.reload");
    await wait(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Create checked version' && !x.disabled)`);
    await clickText("button", "Create checked version");
    await wait(`!![...document.querySelectorAll('a')].find(x => x.textContent.trim() === 'Download PDF')`);
    if (!state.legacyFinalized || state.resumeLegacy || JSON.stringify(state.manualEdits.at(-1)?.manualFactIds) !== '["fact-1"]') throw new Error("LEGACY_REVIEW_NOT_COMPLETED");
    stage = "remove_checked_skill";
    state.checkedSkill = true; await call("Page.reload");
    await wait(`!!document.querySelector('button[aria-label="Remove skill Go"]')`);
    await evalPage(`document.querySelector('button[aria-label="Remove skill Go"]').click()`);
    await wait(`document.querySelector('.app-sheet-tools [role="alert"]')?.textContent.includes('busy')`);
    if (!await evalPage(`!!document.querySelector('button[aria-label="Remove skill Go"]')`)) throw new Error("CHECKED_SKILL_RETRY_MISSING");
    await evalPage(`document.querySelector('button[aria-label="Remove skill Go"]').click()`);
    await wait(`!document.querySelector('button[aria-label="Remove skill Go"]')`);
    if (state.checkedSkill) throw new Error("CHECKED_SKILL_REMOVE_NOT_SENT");
    if (state.checkedSkillRequests.length !== 2 || JSON.stringify(state.checkedSkillRequests[0]) !== JSON.stringify(state.checkedSkillRequests[1])) throw new Error("CHECKED_SKILL_RETRY_CHANGED");
    stage = "remove_checked_line";
    await openCard("line-1");
    await wait(`!!document.querySelector('.app-line-card')`);
    await clickText(".app-line-card button", "Remove line (keeps earlier versions)");
    await wait(`document.body?.innerText.includes('This resume has no lines')`);
    if (!state.resumeLineRemoved) throw new Error("CHECKED_LINE_REMOVE_NOT_SENT");
    state.resumeLineRemoved = false;
    stage = "line_card_sheet";
    // Below 860px a line's card is a sheet from the bottom of the screen, and Escape closes it.
    await call("Emulation.setDeviceMetricsOverride", { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
    await call("Page.reload");
    await wait(`!!document.querySelector('[data-note-for="line-1"] button')`);
    await openCard("line-1");
    await wait(`(() => { const c = document.querySelector('.app-line-card'); return !!c && getComputedStyle(c).position === 'fixed' && c.dataset.presentation === 'sheet' && c.getAttribute('role') === 'dialog' && c.contains(document.activeElement); })()`);
    await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await wait(`!document.querySelector('.app-line-card') && document.activeElement === document.querySelector('[data-note-for="line-1"] button')`);
    await call("Emulation.clearDeviceMetricsOverride");
    stage = "uncertain_resume_cancellation";
    state.resumeRunning = true; await call("Page.reload");
    await wait(`document.body?.innerText.includes("Resumatic can’t confirm that tailoring started")`);
    await clickText("button", "Cancel tailoring");
    await wait(`document.body?.innerText.includes("Cancellation is pending")`);
    if (!state.resumeCancel) throw new Error("RESUME_CANCEL_NOT_SENT");
    stage = "export_disclosure";
    // Account opens from the menu under the person's name.
    await evalPage(`document.querySelector('button.rs-who').click()`);
    await wait(`!!document.querySelector('.app-menu:not([hidden])')`);
    await clickText(".app-menu a", "Your data");
    await wait(`document.body?.innerText.includes('up to 128 files and 100 MiB')`);
    stage = "profile_submission_lock";
    await evalPage(`(() => { const e = document.querySelector('input[autocomplete="name"]'); e.focus(); e.setSelectionRange(e.value.length, e.value.length); })()`);
    await call("Input.insertText", { text: " Senior" });
    await clickText("button", "Save profile");
    let finishProfile = await waitForRelease(() => releaseProfile); releaseProfile = undefined;
    await wait(`document.querySelector('form[aria-labelledby="profile-heading"] input[autocomplete="name"]')?.readOnly`);
    if (!await evalPage(`(() => { const f = document.querySelector('form[aria-labelledby="profile-heading"]'); return f?.getAttribute('aria-busy') === 'true' && [...f.querySelectorAll('input, textarea')].every(e => e.readOnly) && document.activeElement === f.querySelector('input[autocomplete="name"]'); })()`)) throw new Error("PROFILE_SAVING_FOCUS_LOST");
    await call("Input.insertText", { text: " should not be inserted" });
    if (!await evalPage(`document.querySelector('input[autocomplete="name"]')?.value === 'Avery Example Senior'`)) throw new Error("PROFILE_EDITABLE_DURING_SAVE");
    finishProfile();
    await wait(`!!document.querySelector('form[aria-labelledby="profile-heading"] [role="alert"]') && !document.querySelector('input[autocomplete="name"]')?.readOnly`);
    if (!await evalPage(`document.querySelector('input[autocomplete="name"]')?.value === 'Avery Example Senior' && document.activeElement === document.querySelector('input[autocomplete="name"]')`)) throw new Error("PROFILE_FAILURE_DRAFT_OR_FOCUS_LOST");
    await clickText("button", "Save profile");
    finishProfile = await waitForRelease(() => releaseProfile); releaseProfile = undefined;
    await wait(`document.querySelector('input[autocomplete="name"]')?.readOnly`);
    finishProfile();
    await wait(`document.body?.innerText.includes('Profile saved.')`);
    if (state.profileRequests.length !== 2 || state.profileRequests.some((body) => body.name !== "Avery Example Senior") || !await evalPage(`document.querySelector('input[autocomplete="name"]')?.value === 'Avery Example Senior' && !document.querySelector('input[autocomplete="name"]')?.readOnly && document.activeElement === document.querySelector('input[autocomplete="name"]')`)) throw new Error("PROFILE_SAVE_RESULT_WRONG");
    stage = "profile_concurrent_edit";
    me.profile = { ...me.profile, name: "Changed elsewhere", revision: me.profile.revision + 1 };
    await call("Input.insertText", { text: " Local" });
    await clickText("button", "Save profile");
    finishProfile = await waitForRelease(() => releaseProfile); releaseProfile = undefined;
    finishProfile();
    await wait(`!!document.querySelector('form[aria-labelledby="profile-heading"] [role="alert"]') && !document.querySelector('input[autocomplete="name"]')?.readOnly`);
    if (state.profileRequests[2].expectedRevision !== 2 || !await evalPage(`document.querySelector('input[autocomplete="name"]')?.value === 'Avery Example Senior Local'`)) throw new Error("PROFILE_STALE_DRAFT_LOST");
    await clickText("button", "Load saved profile");
    await wait(`document.querySelector('input[autocomplete="name"]')?.value === 'Changed elsewhere'`);
    stage = "profile_lost_response";
    await evalPage(`(() => { const e = document.querySelector('input[autocomplete="name"]'); e.focus(); e.setSelectionRange(e.value.length, e.value.length); })()`);
    await call("Input.insertText", { text: " Reconciled" });
    await clickText("button", "Save profile");
    finishProfile = await waitForRelease(() => releaseProfile); releaseProfile = undefined;
    finishProfile();
    await wait(`document.body?.innerText.includes('Profile saved.')`);
    if (me.profile.revision !== 4 || me.profile.name !== "Changed elsewhere Reconciled" || !await evalPage(`document.querySelector('input[autocomplete="name"]')?.value === 'Changed elsewhere Reconciled'`)) throw new Error("PROFILE_LOST_RESPONSE_NOT_RECONCILED");
    // The copies shared with a coach are on Sharing › Coaches, and the downloads on Account.
    await evalPage(`location.hash = '#/sharing/coaches'`);
    await wait(`document.body?.innerText.includes('This link is currently unavailable.')`);
    if (!await evalPage(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Revoke link')`)) throw new Error("SHARE_REVOKE_MISSING");
    await evalPage(`location.hash = '#/account/data'`);
    await wait(`!!document.querySelector('a[href="/api/export/archive"]')`);
    if (!await evalPage(`!!document.querySelector('a[href="/api/export/archive"]')`)) throw new Error("ARCHIVE_LINK_MISSING");
    if (!await evalPage(`!!document.querySelector('a[href="/api/export"]') && [...document.querySelectorAll('a[href="#/facts/check"]')].some(x => x.textContent.includes('Facts'))`)) throw new Error("EXPORT_DOWNLOAD_LINKS_MISSING");
    stage = "resource_reload";
    if (!await evalPage(`import('/test/support/resource-browser.tsx').then(m => m.checkResourceReload())`)) throw new Error("RESOURCE_RELOAD_DID_NOT_SETTLE");
    stage = "share_retry";
    await call("Page.navigate", { url: `${origin}/share#synthetic-share` });
    await wait(`document.body?.innerText.includes("This copy couldn’t be opened")`);
    if (await evalPage(`location.hash !== ''`) || state.shareSessions !== 1) throw new Error("SHARE_TOKEN_OR_FIRST_ATTEMPT");
    await clickText("button", "Try again");
    for (let i = 0; i < 100 && !state.shareReads; i++) await delay(100);
    await wait(`document.body?.innerText.includes("This copy couldn’t be opened")`);
    if (state.shareSessions !== 2 || state.shareReads !== 1) throw new Error("SHARE_EXCHANGE_RETRY");
    await clickText("button", "Try again");
    await wait(`document.body?.innerText.includes('Shared career snapshot')`);
    if (state.shareSessions !== 2 || state.shareReads !== 2 || await evalPage(`location.hash !== ''`)) throw new Error("SHARE_SNAPSHOT_RETRY");
    // The address names the copy, so a reload opens the same one, and the tab says whose it is.
    if (!await evalPage(`location.pathname + location.search === '/share?g=${shareGrant}' && document.title.startsWith('Avery Example, shared copy') && document.body.innerText.includes('From Avery Example.')`)) throw new Error("SHARE_COPY_NOT_NAMED");
    stage = "share_expired";
    await call("Page.navigate", { url: `${origin}/share?invalid=1#synthetic-invalid` });
    await wait(`document.body?.innerText.includes('Share unavailable')`);
    if (await evalPage(`location.hash !== '' || location.search !== '' || !![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Try again')`)) throw new Error("EXPIRED_SHARE_NOT_TERMINAL");
    console.log(JSON.stringify({ status: "passed", promotionEligible: false, mode: "synthetic-api-standin", checks: { signInNavigation: true, uploadRetryKey: true, ocrDownloadLinks: true, sourceRoleOnly: true, sourceEmpty: true, pollRecovery: true, pollNonTransient: true, uncertainSourceCancellation: true, sourceReadingRetry: true, roleAndFactReview: true, roleDraftDuringRefresh: true, factDraftDuringRefresh: true, sourceConfirmationDuringDraft: true, secondReviewEditorBlocked: true, reviewLockReleasedOnNavigation: true, roleEditLostResponse: true, factLevelReview: true, factEditLostResponse: true, manualFactRetryKey: true, manualFactSubmissionLock: true, manualRoleSubmissionLock: true, manualRoleRetryKey: true, editorFocusReturn: true, applicationCreation: true, jobSubmissionLock: true, jobRetryKey: true, profileSubmissionLock: true, profileConcurrentEdit: true, profileLostResponse: true, jobOpenedFromRow: true, applicationTracking: true, trackingDraftOnRefresh: true, boardKeyboardScroll: true, documentRefreshAfterStart: true, documentTabReturnGuard: true, coverLetterDisplay: true, documentWordDownloadLink: true, savedInterviewAnswer: true, interviewSubmissionLock: true, tailoredResumeDisplay: true, historicLevelGuard: true, resumeDraftDuringRefresh: true, verifiedManualEdit: true, uncitedRemediation: true, lineCardFocusAfterCheck: true, lineCardNoOverlap: true, lineCardSheet: true, legacyResumeReview: true, legacySkillRemoval: true, checkedSkillRemoval: true, checkedLineRemoval: true, uncertainDocumentCancellation: true, documentRetry: true, uncertainResumeCancellation: true, exportDisclosure: true, unavailableShareNotice: true, stableResourceReload: true, shareRetry: true, expiredShare: true } }));
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
