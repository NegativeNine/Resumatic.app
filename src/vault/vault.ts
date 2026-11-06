import type { InterviewAnswer } from "../shared/interview";
import {
  refinementCacheKey,
  cacheRefinement,
  cachedRefinementDraft,
} from "../pipeline/refine-cache";
import { ExtractionFeedback } from "./extraction-feedback";
import { conversionQuality } from "../pipeline/extract/quality";
import { retryable } from "cloudflare:durable-objects";
import { DurableObject } from "cloudflare:workers";
import { runModels } from "../workflows/models";
import { base64url, sha256 } from "../worker/crypto";
import { extractorFor, sourceFormat } from "../pipeline/extract";
import { McpGrantStore } from "./mcp-grants";
import type { McpClaims, McpScope, McpGrant, NewMcpGrant } from "../shared/mcp";
import type {
  ApplicationView,
  FactKind,
  FactPatch,
  FactView,
  Level,
  Me,
  NewFact,
  NewRole,
  Profile,
  Quota,
  ResumeBody,
  ResumeReport,
  ResumeState,
  ResumeView,
  ReviewRequest,
  ReviewState,
  RoleKind,
  RolePatch,
  RoleView,
  SourceState,
  SourceView,
} from "../shared/api";
import { DATE_PATTERN, MAX_LINE_CHARS, MAX_UPLOAD_BYTES } from "../shared/api";
import { AppError } from "../shared/errors";
import { isMissingWorkflowInstance } from "../shared/workflow-errors";
import { directoryForUser } from "../shared/stubs";
import type {
  Analysis,
  Candidate,
  Draft,
  Extraction,
  FactRecord,
  RenderData,
  RoleRecord,
  Selection,
  TailorInput,
  VerifiedDraft,
  Who,
} from "../shared/types";
import { UploadStore, uploadDescriptorDigest, type UploadDescriptor } from "./uploads";
import { sourceKey } from "../shared/r2";
import { validateTranscriptionInput, type TranscriptionInput } from "../ai/transcribe";
import { ExportCache, EXPORT_CACHE_ITEM_BYTES } from "./export-cache";
import { VaultOperations, ReembedStore } from "./operations";
import {
  isMaintenanceFenced,
  requireMaintenanceFence,
  type TransferManifest,
  type TransferPage,
  type TransferTable,
} from "../shared/operations";
import { vault as vaultStub } from "../shared/stubs";
import { createSchema, hasSchema, migrate, SCHEMA_VERSION } from "./schema";
import { assertGroundedResume, evidenceForFacts, SnapshotStore, type ResumeVersion } from "./snapshots";
import { mergeRefinementEvidence } from "./refinement-evidence";
import { validateTailorCheckpoint, validateTailorPublication } from "./tailor-publication";
import { finalLegacyEvidence, legacyReceipt, legacyReview } from "./legacy-remediation";
import { RunStore } from "./runs";
import { ShareStore } from "./shares";
import { billingConfig } from "../shared/billing";
import { stripeClient, type Entitlement } from "../worker/billing";
import { CheckoutCoordinator } from "./checkout";
import type { QuotaBucket } from "../shared/runs";
import type {
  DocumentInput,
  DocumentPlan,
  DocumentDraft,
  DocumentResult,
} from "../pipeline/documents";
import type { NewDocument, DocumentView } from "../shared/documents";
import { freeQuotaBucket, type RunRecord } from "../shared/runs";
import { packVector, toUnit, topMatches, unpackVector } from "./search";

/** A running Tailor row older than this is checked against the Workflow before it blocks a new run. */
const STALE_RUN_MS = 30 * 60 * 1000;
const DEFAULT_TAILOR_LIMIT = 20;
/** Uploads being read at once, and uploads kept per vault: each upload costs model calls. */
const MAX_QUEUED_SOURCES = 3;
const MAX_SOURCES = 50;
/** Bound unresolved experimental cache writes without silently settling any. */
const MAX_CACHE_WRITE_ATTEMPTS = 64;
const REFINE_CACHE_TTL_MS = 30 * 86400000;
// Same-ID recovery is bounded. A retry never resolves the original uncertainty.
const REDISPATCH_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

type SourceRow = {
  ocr_image_count: number | null;
  origin: "upload" | "ocr";
  extractor: string | null;
  parent_source_id: string | null;
  id: string;
  filename: string;
  r2_key: string;
  markdown: string | null;
  state: string;
  error: string | null;
  run_id: string | null;
  created_at: number;
};
type RoleRow = {
  revision: number;
  start: number | null;
  end: number | null;
  id: string;
  kind: string;
  org: string;
  title: string | null;
  start_date: string | null;
  end_date: string | null;
  unknown_end_start_date: string | null;
  state: string;
  source_id: string | null;
  quote: string | null;
};
type FactRow = {
  interview_document_id?: string | null;
  interview_question_id?: string | null;
  interview_question?: string | null;
  interview_quote?: string | null;
  evidence_origin?: "upload" | "ocr";
  confidence?: number | null;
  review_reasons?: string;
  revision: number;
  start: number | null;
  end: number | null;
  id: string;
  role_id: string | null;
  kind: string;
  text: string;
  level: string | null;
  level_revision: number | null;
  origin: string;
  state: string;
  source_id: string | null;
  quote: string | null;
};
type ResumeRow = {
  run_analysis: string | null;
  id: string;
  application_id: string;
  state: string;
  step: string | null;
  error: string | null;
  selection: string | null;
  draft: string | null;
  verified: string | null;
  body: string | null;
  report: string | null;
  version: number;
  quota_month: string | null;
  run_id: string | null;
  created_at: number;
};
type ApplicationRow = {
  revision: number;
  status: import("../shared/api").ApplicationStatus;
  applied_at: string | null;
  notes: string;
  id: string;
  company: string | null;
  title: string | null;
  jd_text: string;
  requirements: string | null;
  created_at: number;
};

export interface ResumePatch {
  selection?: Selection;
  draft?: Draft;
  verified?: VerifiedDraft;
  body?: ResumeBody;
  report?: ResumeReport;
  state?: ResumeState;
}

export interface VaultExport {
  interviewAnswers: Record<string, string | number | null>[];
  generationInputs: Record<string, string | number | null>[];
  generationItems: Record<string, string | number | null>[];
  documentRequests: Record<string, string | number | null>[];
  format: number;
  sourceRevisions: Record<string, string | number | null>[];
  evidence: Record<string, string | number | null>[];
  resumeVersions: {
    resume_id: string;
    version: number;
    data: ResumeVersion;
    created_at: number;
  }[];
  documents: Record<string, string | number | null>[];
  documentVersions: {
    document_id: string;
    version: number;
    data: {
      result: DocumentResult;
      facts: Record<string, { text: string; quote: string | null }>;
      profile: Profile;
    };
    created_at: number;
  }[];
  runs: Record<string, string | number | null>[];
  providerUsage: Record<string, string | number | null>[];
  quotaPeriods: Record<string, string | number | null>[];
  shares: import("../shared/sharing").ShareGrant[];
  connectedApps: Omit<McpGrant, "oauthGrantId">[];
  billing: Entitlement | null;
  exportedAt: string;
  profile: Profile;
  /** `file` is the download path of the original upload. */
  sources: {
    id: string;
    filename: string;
    state: string;
    createdAt: number;
    markdown: string | null;
    file: string;
  }[];
  roles: RoleView[];
  facts: FactView[];
  applications: {
    id: string;
    company: string | null;
    title: string | null;
    jobDescription: string;
    createdAt: number;
  }[];
  resumes: {
    id: string;
    applicationId: string;
    state: string;
    createdAt: number;
    body: ResumeBody | null;
    report: ResumeReport | null;
  }[];
}

export function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** The day a quota month's count resets, such as "December 1" for "2026-11". */
export function resetDay(month: string): string {
  const [year, m] = month.split("-").map(Number);
  const next = new Date(Date.UTC(year ?? 1970, m ?? 1, 1));
  return `${MONTH_NAMES[next.getUTCMonth()]} 1`;
}

/**
 * Data plane. One object per user, created only by the Directory, holding that user's
 * whole career record. Every method checks that the vault exists and is open; user
 * calls also check the session's owner and generation.
 */
export class Vault extends DurableObject<Env> {
  private initialised = false;
  private gone = false;
  private destroying = false;
  // Set synchronously before deletion awaits any storage operation.
  private closing = false;
  private vectorCache: Map<string, Float32Array> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      // Only init() creates the schema, so a destroyed vault stays empty when it wakes.
      if (hasSchema(this.sql)) {
        migrate(this.sql, (fn) => this.ctx.storage.transactionSync(fn));
        this.initialised = true;
        if (!this.meta("embedding_model"))
          this.setMeta("embedding_model", "@cf/baai/bge-m3");
      }
    });
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private get runs(): RunStore {
    return new RunStore(this.sql, (fn) => this.ctx.storage.transactionSync(fn));
  }

  private get snapshots(): SnapshotStore {
    return new SnapshotStore(this.sql);
  }

  private get vaultId(): string {
    return this.ctx.id.toString();
  }

  // ---------------------------------------------------------------- lifecycle (Directory)

  async init(userId: string): Promise<void> {
    if (this.gone) throw new AppError("gone", "this vault was destroyed");
    if (!this.initialised) {
      createSchema(this.sql, (fn) => this.ctx.storage.transactionSync(fn));
      this.initialised = true;
    }
    const owner = this.meta("user_id");
    if (owner && owner !== userId)
      throw new AppError("conflict", "vault belongs to another user");
    if (owner) return;
    this.ctx.storage.transactionSync(() => {
      this.setMeta("user_id", userId);
      this.setMeta("session_gen", "1");
      this.setMeta("security_epoch", "legacy");
      this.setMeta(
        "embedding_model",
        this.env.EMBEDDING_MODEL ?? "@cf/baai/bge-m3",
      );
      this.setMeta("state", "open");
      this.setMeta("quota_month", monthOf(Date.now()));
      this.setMeta("quota_used", "0");
      this.sql.exec(`INSERT OR IGNORE INTO profile (id) VALUES (1)`);
    });
  }

  /** Revoke access independently of whether the run inventory is settled. */
  quiesce(): void {
    if (this.gone || !this.initialised) return;
    this.closing = true;
    this.setMeta("state", "closing");
    for (const ws of this.ctx.getWebSockets()) ws.close(1008, "Account closed");
  }

  /** Refuses new work and lists the runs to stop. Safe to repeat, and safe on an empty vault. */
  async close(): Promise<{
    distill: string[];
    tailor: string[];
    other?: { kind: string; id: string }[];
  }> {
    this.quiesce();
    if (this.gone || !this.initialised) {
      this.requireNoUnidentifiedTables();
      return { distill: [], tailor: [] };
    }
    this.requireNoUnsettledDispatches();
    const distill = this.sql
      .exec<{ run_id: string }>(
        `SELECT run_id FROM sources WHERE run_id IS NOT NULL UNION SELECT id AS run_id FROM runs WHERE kind = 'distill'`,
      )
      .toArray()
      .map((r) => r.run_id);
    const tailor = this.sql
      .exec<{ run_id: string }>(
        `SELECT run_id FROM resumes WHERE run_id IS NOT NULL UNION SELECT id AS run_id FROM runs WHERE kind = 'tailor'`,
      )
      .toArray()
      .map((r) => r.run_id);
    const other = this.sql
      .exec<{ kind: string; id: string }>(
        `SELECT kind,id FROM runs WHERE kind NOT IN ('distill','tailor','embed')`,
      )
      .toArray();
    return other.length ? { distill, tailor, other } : { distill, tailor };
  }

  async destroy(): Promise<void> {
    this.closing = true;
    if (!this.gone && this.initialised) {
      this.setMeta("state", "closing");
      this.requireNoUnsettledDispatches();
    } else this.requireNoUnidentifiedTables();
    this.destroying = true;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.gone = true;
    this.initialised = false;
    this.vectorCache = null;
  }

  // ---------------------------------------------------------------- sessions

  async openSession(userId: string): Promise<{ gen: number; epoch: string }> {
    this.requireOpen();
    if (this.meta("user_id") !== userId)
      throw new AppError("forbidden", "not this user's vault");
    return {
      gen: Number(this.meta("session_gen")),
      epoch: this.meta("security_epoch") ?? "legacy",
    };
  }

  async checkSession(who: Who): Promise<void> {
    this.requireOwner(who);
  }

  /** Record a cache write before the Worker can send it to R2. */
  beginCacheWrite(who: Who, attemptId: string, kind: "pdf" | "docx" | "source", keyDigest?: string): void {
    this.requireOwner(who);
    this.recordR2Dispatch(attemptId, kind, keyDigest);
  }

  /** The caller must make its lifecycle check without yielding before this insert. */
  private recordR2Dispatch(attemptId: string, kind: "pdf" | "docx" | "source", keyDigest?: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId) || !["pdf", "docx", "source"].includes(kind) || (keyDigest !== undefined && !/^[0-9a-f]{64}$/.test(keyDigest)))
      throw new AppError("invalid", "invalid cache write attempt");
    if (this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM r2_cache_dispatches`).one().n >= MAX_CACHE_WRITE_ATTEMPTS)
      throw new AppError("unavailable", "too many export cache writes are unresolved");
    // No await between the open-state check and durable marker insertion.
    this.sql.exec(`INSERT INTO r2_cache_dispatches (attempt_id,kind,created_at,key_digest) VALUES (?,?,?,?)`, attemptId, kind, Date.now(), keyDigest ?? null);
  }

  /** A known R2 acknowledgement can settle its own opaque attempt after revocation. */
  finishCacheWrite(userId: string, attemptId: string): void {
    if (this.gone || !this.initialised || this.meta("user_id") !== userId)
      throw new AppError("forbidden", "not this user's vault");
    // This internal capability is never returned by an HTTP route. Completion
    // intentionally survives sign-out and closure, but may clear only its ID.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId))
      throw new AppError("invalid", "invalid cache write attempt");
    this.sql.exec(`DELETE FROM r2_cache_dispatches WHERE attempt_id = ?`, attemptId);
  }

  /** Authenticate and close access atomically, before the cross-object deletion call. */
  async beginAccountDeletion(who: Who): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      this.requireNotUnderMaintenance();
      if (
        this.initialised && !this.gone &&
        this.meta("state") === "closing" &&
        this.meta("account_deletion_intent") === "1"
      ) {
        this.requireIdentity(who);
      } else {
        this.requireOwner(who);
        this.setMeta("account_deletion_intent", "1");
        this.setMeta("state", "closing");
      }
      // If the Worker crashes before notifying Directory, the Vault itself
      // retries. Preserve any earlier alarm so other work is never delayed.
      const at = Date.now() + 60_000;
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > at) await this.ctx.storage.setAlarm(at);
    });
    this.quiesce();
  }

  async signOutEverywhere(who: Who): Promise<void> {
    this.requireOwner(who);
    this.setMeta("session_gen", String(Number(this.meta("session_gen")) + 1));
    for (const ws of this.ctx.getWebSockets()) ws.close(1008, "Session ended");
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response(null, { status: 426 });
    let who: Who & { exp: number };
    try {
      who = JSON.parse(request.headers.get("x-vault-session") ?? "");
    } catch {
      return new Response(null, { status: 401 });
    }
    this.requireOwner(who);
    if (!Number.isFinite(who.exp) || who.exp <= Date.now())
      throw new AppError("unauthenticated", "session expired");
    if (this.ctx.getWebSockets().length >= 8)
      throw new AppError("quota", "too many live connections");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(who);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async webSocketMessage(
    ws: WebSocket,
    _message: string | ArrayBuffer,
  ): Promise<void> {
    try {
      const who = ws.deserializeAttachment() as Who & { exp: number };
      this.requireOwner(who);
      if (who.exp <= Date.now()) throw new Error();
    } catch {
      ws.close(1008, "Session ended");
    }
  }
  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    ws.close(code);
  }
  async webSocketError(ws: WebSocket): Promise<void> {
    ws.close(1011, "Reconnect");
  }
  private broadcast(
    type: "source" | "resume" | "document" | "run",
    id: string,
  ): void {
    const frame = JSON.stringify([{ type, id }]);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const who = ws.deserializeAttachment() as Who & { exp: number };
        this.requireOwner(who);
        if (who.exp <= Date.now()) throw new Error();
        ws.send(frame);
      } catch {
        try {
          ws.close(1008, "Session ended");
        } catch {
          /* Closed peer. */
        }
      }
    }
  }

  // ---------------------------------------------------------------- profile

  async me(who: Who): Promise<Me> {
    this.requireOwner(who);
    return {
      userId: who.userId,
      profile: this.readProfile(),
      quota: this.quota(),
      capabilities: {
        ocr: !!this.env.MODEL_TRANSCRIBE,
        connectedApps: this.env.MCP_ENABLED === "true",
        roleDateUnknownEnd: this.env.ROLE_UNKNOWN_END_ENABLED === "true",
      },
    };
  }

  async getProfile(who: Who): Promise<Profile> {
    this.requireOwner(who);
    return this.readProfile();
  }

  async updateProfile(who: Who, patch: Partial<Profile>): Promise<Profile> {
    this.requireOwner(who);
    const next = { ...this.readProfile(), ...patch };
    this.sql.exec(
      `UPDATE profile SET name = ?, email = ?, phone = ?, location = ?, links = ?, revision = revision + 1 WHERE id = 1`,
      next.name,
      next.email,
      next.phone,
      next.location,
      JSON.stringify(next.links),
    );
    return this.readProfile();
  }

  // ---------------------------------------------------------------- sources (user)

  private get extractionFeedbackStore(): ExtractionFeedback {
    return new ExtractionFeedback(this.sql);
  }
  async extractionFeedback() {
    this.requireOpen();
    return this.extractionFeedbackStore.list();
  }

  private extractionStrategy(
    origin: "upload" | "ocr" | undefined,
    filename: string,
  ): string {
    try {
      return extractorFor(
        this.env,
        this.vaultId,
        sourceFormat(origin, filename),
      ).id.replace(/llm:default$/, `llm:${this.env.MODEL_EXTRACT}`);
    } catch {
      // Treat bad deployment configuration as an operational failure and never
      // include its contents in an error, log, or user response.
      throw new AppError(
        "unavailable",
        "extraction is temporarily unavailable",
      );
    }
  }

  private get uploads(): UploadStore {
    return new UploadStore(
      this.sql,
      (fn) => this.ctx.storage.transactionSync(fn),
      {
        vaultId: this.vaultId,
        maxSources: MAX_SOURCES,
        maxQueued: MAX_QUEUED_SOURCES,
      },
    );
  }
  async reserveUpload(who: Who, input: UploadDescriptor) {
    this.requireOwner(who);
    const store = this.uploads;
    // Validate deployment routing before a new reservation can lead to an R2
    // write. Completed retries remain available under a later bad deployment.
    if (store.get(input.requestKey)?.state !== "complete")
      this.extractionStrategy(input.origin, input.filename);
    const reservation = store.reserve(input);
    const next = store.nextAlarm();
    if (next !== null) await this.scheduleRunAlarm(next);
    // Alarm scheduling yields: the vault may have closed or the session may
    // have been revoked before the Worker is allowed to dispatch its put.
    this.requireOwner(who);
    // The intent may also have expired or completed during that yield. Return
    // its current durable state so the Worker neither writes an expired key
    // nor repeats a put after another retry already committed the source.
    return { ...reservation, intent: store.reserve(input).intent };
  }
  /** Fence one R2 put, including a retry for the same upload request. */
  beginSourceWrite(who: Who, input: UploadDescriptor, attemptId: string, keyDigest: string): { sourceId?: string } {
    this.requireOwner(who);
    const reservation = this.uploads.reserve(input);
    if (reservation.intent.state === "complete") return { sourceId: reservation.intent.sourceId };
    // No await between the open-state check and the durable dispatch marker.
    // A Worker crash before put therefore leaves a conservative unresolved marker.
    this.ctx.storage.transactionSync(() => {
      this.recordR2Dispatch(attemptId, "source", keyDigest);
      this.sql.exec(`INSERT INTO source_write_links (attempt_id,source_id) VALUES (?,?)`, attemptId, reservation.intent.sourceId);
    });
    return {};
  }
  /**
   * Send a reserved source from the vault, so an observed R2 acknowledgement
   * settles its own fence without depending on a later Worker-to-Vault RPC.
   * A rejected or interrupted put remains unresolved, even if the caller
   * retries. The reservation and per-attempt fence predate all R2 I/O.
   */
  async writeReservedSource(who: Who, input: UploadDescriptor, bytes: ArrayBuffer, originalFilename: string): Promise<{ sourceId?: string }> {
    this.requireOwner(who);
    if (!input || typeof input !== "object" || typeof input.requestKey !== "string" ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestKey) || typeof input.descriptorDigest !== "string")
      throw new AppError("invalid", "invalid upload identity");
    const maxBytes = input.origin === "ocr" ? 12 * 1024 * 1024 + 1024 : MAX_UPLOAD_BYTES;
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 1 || bytes.byteLength > maxBytes ||
        typeof originalFilename !== "string" || originalFilename.length < 1 || originalFilename.length > 8192 ||
        !/^[a-f0-9]{64}$/.test(input.descriptorDigest) ||
        (input.origin !== "ocr" && bytes.byteLength !== input.byteLength))
      throw new AppError("invalid", "invalid upload contents");
    const recorded = this.uploads.get(input.requestKey);
    if (!recorded) throw new AppError("conflict", "reserve the upload before storing its file");
    // Validate the complete descriptor before hashing, including its metadata
    // limits and its binding to the existing reservation. This operation has
    // no await and cannot create a new reservation after the lookup above.
    this.uploads.reserve(input);
    const expectedKey = sourceKey(this.vaultId, `${input.requestKey}-${input.descriptorDigest}${input.origin === "ocr" ? ".ocr.json" : ""}`);
    if (input.r2Key !== expectedKey)
      throw new AppError("invalid", "invalid upload path");
    let digestBody: ArrayBuffer | string = bytes;
    if (input.origin === "ocr") {
      const prefix = new Uint8Array(bytes, 0, Math.min(3, bytes.byteLength));
      if (prefix.length === 3 && prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf)
        throw new AppError("invalid", "invalid image transcription input");
      let decoded: string;
      let parsed: TranscriptionInput;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
        parsed = validateTranscriptionInput(JSON.parse(decoded));
      } catch {
        throw new AppError("invalid", "invalid image transcription input");
      }
      if (originalFilename !== input.filename ||
          parsed.referenceDate !== new Date(recorded.createdAt).toISOString().slice(0, 10))
        throw new AppError("invalid", "invalid image transcription input");
      const stable = JSON.stringify({ images: parsed.images });
      if (decoded !== JSON.stringify({ images: parsed.images, referenceDate: parsed.referenceDate }) ||
          new TextEncoder().encode(stable).byteLength !== input.byteLength)
        throw new AppError("invalid", "invalid image transcription input");
      digestBody = stable;
    }
    const [digest, keyHash] = await Promise.all([
      uploadDescriptorDigest({ filename: originalFilename, contentType: input.contentType, origin: input.origin, parentSourceId: input.parentSourceId }, digestBody),
      sha256(input.r2Key),
    ]);
    // Hashing yields. Recheck the lifecycle and reservation before dispatch.
    this.requireOwner(who);
    if (digest !== input.descriptorDigest) throw new AppError("conflict", "upload contents do not match the reservation");
    const keyDigest = Array.from(new Uint8Array(keyHash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const attemptId = crypto.randomUUID();
    const reservation = this.beginSourceWrite(who, input, attemptId, keyDigest);
    if (reservation.sourceId) return reservation;
    const put = (async () => {
      let result: R2Object | null;
      try {
        result = await this.env.FILES.put(input.r2Key, bytes, {
          httpMetadata: { contentType: input.contentType },
          customMetadata: { resumatic_cache_attempt: attemptId },
        });
        // With no conditional put, null or inconsistent metadata is
        // unexpected and cannot establish that this attempt succeeded.
        if (!result || result.key !== input.r2Key || result.size !== bytes.byteLength)
          throw new Error("unexpected R2 acknowledgement");
      } catch {
        // Provider exceptions can contain request details; the attempt is
        // still uncertain, and only a fixed message may cross the RPC boundary.
        throw new AppError("unavailable", "the upload outcome is unresolved");
      }
      // No await between observing the acknowledgement and clearing its fence.
      // This settlement remains allowed after closure, but cannot clear another
      // attempt or resurrect the source.
      this.finishCacheWrite(who.userId, attemptId);
    })();
    // Let the object observe a late acknowledgement after the Worker
    // disconnects when the runtime permits; this is not an erasure guarantee.
    this.ctx.waitUntil(put.catch(() => {}));
    await put;
    return {};
  }
  expiredUploadForCleanup(who: Who, input: UploadDescriptor): boolean {
    this.requireOwner(who);
    return this.uploads.isExpired(input);
  }
  async completeUpload(
    who: Who,
    input: UploadDescriptor,
  ): Promise<{ sourceId: string }> {
    this.requireOwner(who);
    const result = this.uploads.complete(input, (intent) => {
      // Resolve only for a new source. A committed upload replay must keep its
      // pinned strategy even if the deployment configuration later changes.
      const extractor = this.extractionStrategy(intent.origin, intent.filename);
      const id = intent.sourceId;
      this.runs.begin(
        {
          id,
          kind: "distill",
          targetId: id,
          requestKey: `source:${input.requestKey}`,
          inputDigest: input.descriptorDigest,
          steps: ["convert", "extract", "embed"],
        },
        () => {
          this.sql.exec(
            `INSERT INTO sources (id,filename,r2_key,state,run_id,created_at,origin,parent_source_id,extractor) VALUES (?,?,?,'queued',?,?,?,?,?)`,
            id,
            intent.filename,
            intent.r2Key,
            id,
            intent.createdAt,
            intent.origin,
            intent.parentSourceId,
            extractor,
          );
          this.extractionFeedbackStore.start(id, intent.createdAt);
        },
      );
    });
    if (!result.replay)
      await this.dispatchRun(this.runs.get(result.intent.sourceId)!);
    return { sourceId: result.intent.sourceId };
  }

  async addSource(
    who: Who,
    s: {
      filename: string;
      r2Key: string;
      origin?: "upload" | "ocr";
      parentSourceId?: string;
      requestKey?: string;
    },
  ): Promise<{ sourceId: string }> {
    this.requireOwner(who);
    const prior = s.requestKey
      ? this.runs.findRequest(`source:${s.requestKey}`)
      : null;
    if (prior) {
      if (prior.inputDigest !== s.r2Key)
        throw new AppError("conflict", "upload request changed");
      return { sourceId: prior.targetId };
    }
    if (!s.r2Key.startsWith(`vaults/${this.vaultId}/sources/`))
      throw new AppError("invalid", "invalid upload path");
    if (s.parentSourceId) this.sourceRow(s.parentSourceId);
    const counts = this.sql
      .exec<{ total: number; queued: number }>(
        `SELECT COUNT(*) AS total, COALESCE(SUM(state = 'queued'), 0) AS queued FROM sources`,
      )
      .one();
    if (counts.queued >= MAX_QUEUED_SOURCES)
      throw new AppError(
        "conflict",
        "wait for your other uploads to finish reading",
      );
    if (counts.total >= MAX_SOURCES)
      throw new AppError(
        "quota",
        `you can keep at most ${MAX_SOURCES} uploads`,
      );
    const id = crypto.randomUUID();
    const extractor = this.extractionStrategy(s.origin, s.filename);
    this.runs.begin(
      {
        id,
        kind: "distill",
        targetId: id,
        requestKey: `source:${s.requestKey ?? id}`,
        inputDigest: s.r2Key,
        steps: ["convert", "extract", "embed"],
      },
      () => {
        this.sql.exec(
          `INSERT INTO sources (id, filename, r2_key, state, run_id, created_at, origin, parent_source_id, extractor) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
          id,
          s.filename,
          s.r2Key,
          id,
          Date.now(),
          s.origin ?? "upload",
          s.parentSourceId ?? null,
          extractor,
        );
        this.extractionFeedbackStore.start(id, this.sourceRow(id).created_at);
      },
    );
    await this.dispatchRun(this.runs.get(id)!);
    return { sourceId: id };
  }

  async listSources(who: Who): Promise<SourceView[]> {
    this.requireOwner(who);
    await this.rearmPendingRuns();
    this.requireOwner(who);
    await this.reconcileStaleSources();
    this.requireOwner(who);
    return this.sql
      .exec<{
        id: string;
        filename: string;
        state: string;
        error: string | null;
        created_at: number;
        proposed: number;
        origin: "upload" | "ocr";
        parent_source_id: string | null;
        extractor: string | null;
        markdown: string | null;
        ocr_image_count: number | null;
        run_id: string | null;
      }>(
        `SELECT s.id, s.filename, s.state, s.error, s.created_at, s.origin, s.parent_source_id, s.extractor, s.markdown, s.ocr_image_count, s.run_id,
           (SELECT COUNT(*) FROM facts f WHERE f.source_id = s.id AND f.state = 'proposed') AS proposed
         FROM sources s ORDER BY s.created_at DESC`,
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        filename: r.filename,
        state: r.state as SourceState,
        retryRunId: r.state === "failed" && r.run_id &&
          ["failed", "cancelled"].includes(this.runs.get(r.run_id)?.state ?? "")
          ? r.run_id : undefined,
        dispatchUncertain: r.state === "queued" && this.dispatchUncertain(r.run_id),
        cancellationPending: r.state === "queued" && this.cancellationPending(r.run_id),
        error: r.error,
        createdAt: r.created_at,
        proposed: r.proposed,
        origin: r.origin,
        parentSourceId: r.parent_source_id,
        extractor: r.extractor,
        conversionImageCount: r.origin === "ocr" ? r.ocr_image_count : null,
        conversionWarnings:
          r.markdown !== null &&
          (r.origin === "ocr" ||
            (r.origin === "upload" && /\.pdf$/i.test(r.filename)))
            ? conversionQuality(
                r.markdown,
                r.origin === "ocr" ? r.ocr_image_count : null,
              ).reasons
            : [],
      }));
  }

  /** Where this source's stored object can be downloaded. OCR sources contain image input JSON. */
  async sourceFile(
    who: Who,
    sourceId: string,
  ): Promise<{ r2Key: string; filename: string; origin: "upload" | "ocr" }> {
    this.requireOwner(who);
    const row = this.sourceRow(sourceId);
    return { r2Key: row.r2_key, filename: row.filename, origin: row.origin };
  }

  // ---------------------------------------------------------------- sources (Distill)

  async sourceInfo(sourceId: string): Promise<{
    r2Key: string;
    filename: string;
    createdAt: number;
    origin: "upload" | "ocr";
  }> {
    this.requireOpen();
    const row = this.sourceRow(sourceId);
    return {
      r2Key: row.r2_key,
      filename: row.filename,
      createdAt: row.created_at,
      origin: row.origin,
    };
  }

  async sourceProgress(
    sourceId: string,
    runId: string,
  ): Promise<{
    convertedChars: number | null;
    extraction: { roles: number; facts: number; dropped: number } | null;
    extractor: string;
  }> {
    this.requireOpen();
    const source = this.sourceRow(sourceId);
    if (source.run_id !== runId)
      throw new AppError("conflict", "this attempt was superseded");
    const run = this.workflowRun(runId, "distill", sourceId);
    if (!["starting", "running", "succeeded"].includes(run.state))
      throw new AppError("conflict", "this run stopped");
    const extractor =
      source.extractor ??
      this.extractionStrategy(source.origin, source.filename);
    if (!source.extractor)
      this.sql.exec(
        `UPDATE sources SET extractor = ? WHERE id = ?`,
        extractor,
        sourceId,
      );
    const extraction =
      this.sql
        .exec<{ roles: number; facts: number; dropped: number }>(
          `SELECT roles,facts,dropped FROM extraction_commits WHERE source_id = ?`,
          sourceId,
        )
        .toArray()[0] ?? null;
    return {
      convertedChars: source.markdown?.length ?? null,
      extraction,
      extractor,
    };
  }

  async sourceEvidence(who: Who, sourceId: string) {
    this.requireOwner(who);
    const source = this.sourceRow(sourceId);
    if (source.markdown === null)
      throw new AppError("conflict", "this source has not been read yet");
    return {
      markdown: source.markdown,
      revisionId: `${sourceId}:1`,
      origin: source.origin,
    };
  }

  async sourceText(sourceId: string): Promise<string> {
    this.requireOpen();
    const row = this.sourceRow(sourceId);
    if (row.markdown === null)
      throw new AppError("invalid", "source has not been converted yet");
    return row.markdown;
  }

  async saveSource(
    sourceId: string,
    patch: {
      markdown?: string;
      state?: SourceState;
      error?: string | null;
      ocrImageCount?: number;
    },
    runId?: string,
  ): Promise<void> {
    this.requireOpen();
    const source = this.sourceRow(sourceId);
    if (!runId) throw new AppError("invalid", "workflow identity is required");
    if (runId && source.run_id !== runId)
      throw new AppError("conflict", "this attempt was superseded");
    if (runId) this.workflowRun(runId, "distill", sourceId);
    if (
      patch.ocrImageCount !== undefined &&
      (source.origin !== "ocr" ||
        patch.markdown === undefined ||
        !Number.isInteger(patch.ocrImageCount) ||
        patch.ocrImageCount < 1 ||
        patch.ocrImageCount > 4)
    )
      throw new AppError("invalid", "invalid transcription image count");
    const id = source.run_id ?? sourceId;
    const write = () => {
      if (patch.markdown !== undefined && source.markdown === null) {
        this.sql.exec(
          `INSERT INTO source_revisions (id, source_id, markdown, created_at) VALUES (?, ?, ?, ?)`,
          `${sourceId}:1`,
          sourceId,
          patch.markdown,
          Date.now(),
        );
        this.sql.exec(
          `UPDATE sources SET markdown = ?, ocr_image_count = ? WHERE id = ?`,
          patch.markdown,
          patch.ocrImageCount ?? null,
          sourceId,
        );
      }
      if (patch.state !== undefined)
        this.sql.exec(
          `UPDATE sources SET state = ? WHERE id = ?`,
          patch.state,
          sourceId,
        );
      if (patch.error !== undefined)
        this.sql.exec(
          `UPDATE sources SET error = ? WHERE id = ?`,
          patch.error,
          sourceId,
        );
    };
    if (this.runs.get(id)) {
      if (patch.state === "failed") {
        const run = this.runs.get(id)!;
        if (["starting", "running"].includes(run.state))
          this.ctx.storage.transactionSync(() => {
            this.runs.fail(id, "extraction_failed");
            write();
          });
      } else if (patch.state === "ready") {
        if (this.runs.finish(id, write).applied) this.recordRunTotal(id);
      } else if (patch.markdown !== undefined)
        this.runs.commitStep(id, "convert", write);
    } else this.ctx.storage.transactionSync(write);
    this.broadcast("source", sourceId);
  }

  async completeSourceStep(
    sourceId: string,
    step: string,
    runId: string,
  ): Promise<void> {
    this.requireOpen();
    if (this.sourceRow(sourceId).run_id !== runId)
      throw new AppError("conflict", "this attempt was superseded");
    this.workflowRun(runId, "distill", sourceId);
    this.runs.commitStep(runId, step, () => {});
  }

  /** Saves proposed roles and facts. A retried step replaces its own earlier proposals. */
  async saveExtraction(
    sourceId: string,
    x: Extraction,
    runId?: string,
    extractor?: string,
    dropped = 0,
  ): Promise<{ roles: number; facts: number }> {
    this.requireOpen();
    const source = this.sourceRow(sourceId);
    if (!runId) throw new AppError("invalid", "workflow identity is required");
    if (runId && source.run_id !== runId)
      throw new AppError("conflict", "this attempt was superseded");
    if (runId) this.workflowRun(runId, "distill", sourceId);
    const committed = this.sql
      .exec<{ roles: number; facts: number }>(
        `SELECT roles, facts FROM extraction_commits WHERE source_id = ?`,
        sourceId,
      )
      .toArray()[0];
    if (committed) return committed;
    if (runId) this.runs.claim(runId);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `DELETE FROM facts WHERE source_id = ? AND state = 'proposed' AND origin = 'extracted'`,
        sourceId,
      );
      this.sql.exec(
        `DELETE FROM roles WHERE source_id = ? AND state = 'proposed'`,
        sourceId,
      );
      this.sql.exec(
        `DELETE FROM evidence WHERE source_id = ?
           AND id NOT IN (SELECT evidence_id FROM facts WHERE evidence_id IS NOT NULL)
           AND id NOT IN (SELECT evidence_id FROM roles WHERE evidence_id IS NOT NULL)`,
        sourceId,
      );
      const evidence = new Map<string, string>();
      const evidenceFor = (quote: string, span?: [number, number]): string => {
        const key = JSON.stringify([quote, span]);
        const known = evidence.get(key);
        if (known) return known;
        const id = crypto.randomUUID();
        const markdown = this.sourceRow(sourceId).markdown ?? "";
        const located =
          span ??
          (markdown.includes(quote)
            ? [markdown.indexOf(quote), markdown.indexOf(quote) + quote.length]
            : null);
        if (
          !located ||
          !quote ||
          markdown.slice(located[0], located[1]) !== quote
        )
          throw new AppError("invalid", "evidence does not match its source");
        this.sql.exec(
          `INSERT INTO evidence (id, source_id, quote, start, end, source_revision_id) VALUES (?, ?, ?, ?, ?, ?)`,
          id,
          sourceId,
          quote,
          located?.[0] ?? null,
          located?.[1] ?? null,
          `${sourceId}:1`,
        );
        evidence.set(key, id);
        return id;
      };
      const roleIds = new Map<string, string>();
      for (const r of x.roles) {
        const id = crypto.randomUUID();
        const unknownStart = this.env.ROLE_UNKNOWN_END_ENABLED === "true" ? (r.unknownEndStartDate ?? null) : null;
        if (unknownStart && (!DATE_PATTERN.test(unknownStart) || r.startDate !== null || r.endDate !== null))
          throw new AppError("invalid", "an unknown end cannot be combined with other dates");
        this.sql.exec(
          `INSERT INTO roles (id, kind, org, title, start_date, end_date, unknown_end_start_date, evidence_id, source_id, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed')`,
          id,
          r.kind,
          r.org,
          r.title,
          r.startDate,
          r.endDate,
          unknownStart,
          evidenceFor(r.quote, r.span),
          sourceId,
        );
        roleIds.set(r.key, id);
      }
      for (const f of x.facts) {
        this.sql.exec(
          `INSERT INTO facts (id, role_id, kind, text, level, evidence_id, source_id, origin, state, updated_at, confidence, review_reasons)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'extracted', 'proposed', ?, ?, ?)`,
          crypto.randomUUID(),
          f.roleKey ? (roleIds.get(f.roleKey) ?? null) : null,
          f.kind,
          f.text,
          f.level,
          evidenceFor(f.quote, f.span),
          sourceId,
          now,
          f.confidence ?? null,
          JSON.stringify(f.reviewReasons ?? []),
        );
      }
      this.extractionFeedbackStore.proposals(sourceId);
      if (extractor)
        this.sql.exec(
          `UPDATE sources SET extractor = ? WHERE id = ?`,
          extractor,
          sourceId,
        );
      this.sql.exec(
        `INSERT INTO extraction_commits (source_id, roles, facts, dropped) VALUES (?, ?, ?, ?)`,
        sourceId,
        x.roles.length,
        x.facts.length,
        dropped,
      );
    });
    this.vectorCache = null;
    return { roles: x.roles.length, facts: x.facts.length };
  }

  async unembeddedFacts(
    sourceId: string,
    runId?: string,
  ): Promise<{ id: string; text: string; revision: number }[]> {
    this.requireOpen();
    if (!runId) throw new AppError("invalid", "workflow identity is required");
    if (runId) {
      if (this.sourceRow(sourceId).run_id !== runId)
        throw new AppError("conflict", "this attempt was superseded");
      const run = this.workflowRun(runId, "distill", sourceId);
      if (!["starting", "running"].includes(run.state))
        throw new AppError("conflict", "this run no longer accepts work");
    }
    return this.sql
      .exec<{ id: string; text: string; revision: number }>(
        `SELECT id, text, revision FROM facts WHERE source_id = ? AND vector IS NULL`,
        sourceId,
      )
      .toArray();
  }

  async saveVectors(
    vectors: { factId: string; vector: number[]; revision?: number }[],
    expectedModel?: string,
    context?: { runId: string; sourceId: string },
  ): Promise<void> {
    this.requireOpen();
    if (!context) throw new AppError("invalid", "workflow identity is required");
    if (context) {
      if (this.sourceRow(context.sourceId).run_id !== context.runId)
        throw new AppError("conflict", "this attempt was superseded");
      const run = this.workflowRun(context.runId, "distill", context.sourceId);
      if (!["starting", "running"].includes(run.state))
        throw new AppError("conflict", "this run no longer accepts work");
      for (const vector of vectors) {
        if (!this.sql.exec(`SELECT id FROM facts WHERE id = ? AND source_id = ?`, vector.factId, context.sourceId).toArray().length)
          throw new AppError("conflict", "fact is not part of this source");
      }
    }
    if (expectedModel && expectedModel !== this.activeEmbeddingModel())
      throw new AppError("conflict", "the search index changed; try again");
    this.ctx.storage.transactionSync(() => {
      for (const v of vectors) {
        if (v.revision !== undefined)
          this.sql.exec(
            `UPDATE facts SET vector = ? WHERE id = ? AND revision = ?`,
            packVector(v.vector),
            v.factId,
            v.revision,
          );
        else
          this.sql.exec(
            `UPDATE facts SET vector = ? WHERE id = ?`,
            packVector(v.vector),
            v.factId,
          );
      }
    });
    this.vectorCache = null;
  }

  // ---------------------------------------------------------------- roles and facts (user)

  async listRoles(who: Who): Promise<RoleView[]> {
    this.requireOwner(who);
    return this.readRoles();
  }

  private readRoles(): RoleView[] {
    return this.sql
      .exec<RoleRow>(
        `SELECT r.id, r.kind, r.org, r.title, r.start_date, r.end_date, r.unknown_end_start_date, r.state, r.source_id, r.revision, e.quote, e.start, e.end
         FROM roles r LEFT JOIN evidence e ON e.id = r.evidence_id
         ORDER BY COALESCE(r.end_date, CASE WHEN r.unknown_end_start_date IS NOT NULL THEN r.unknown_end_start_date WHEN r.start_date IS NOT NULL THEN '9999' ELSE '' END) DESC,
                  COALESCE(r.start_date, r.unknown_end_start_date) DESC`,
      )
      .toArray()
      .map(roleView);
  }

  /** A role the user adds is their own claim, so it is confirmed at once and has no quote. */
  async addRole(who: Who, r: NewRole): Promise<{ roleId: string }> {
    this.requireOwner(who);
    const id = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO roles (id, kind, org, title, start_date, end_date, state) VALUES (?, ?, ?, ?, ?, ?, 'confirmed')`,
      id,
      r.kind,
      r.org,
      r.title,
      r.startDate,
      r.endDate,
    );
    return { roleId: id };
  }

  /** Versioned RPC: older Vault code cannot silently discard the new field. */
  async addRoleV2(who: Who, r: NewRole): Promise<{ roleId: string }> {
    this.requireOwner(who);
    if (this.env.ROLE_UNKNOWN_END_ENABLED !== "true")
      throw new AppError("unavailable", "unknown end dates are not enabled");
    const unknown = r.unknownEndStartDate ?? null;
    if (unknown && (!DATE_PATTERN.test(unknown) || r.startDate !== null || r.endDate !== null))
      throw new AppError("invalid", "an unknown end cannot be combined with other dates");
    const id = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO roles (id, kind, org, title, start_date, end_date, unknown_end_start_date, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed')`,
      id, r.kind, r.org, r.title, r.startDate, r.endDate, unknown,
    );
    return { roleId: id };
  }

  /** Versioned RPC: a lost response can be retried without duplicating a role. */
  async addRoleIdempotent(who: Who, r: NewRole, requestKey: string, workerAllowsUnknownEnd: boolean): Promise<{ roleId: string }> {
    this.requireOwner(who);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(requestKey))
      throw new AppError("invalid", "invalid request key");
    const hasUnknownEnd = r.unknownEndStartDate !== undefined;
    const digest = base64url(await sha256(JSON.stringify([
      r.kind, r.org, r.title, r.startDate, r.endDate,
      hasUnknownEnd, r.unknownEndStartDate ?? null,
    ])));
    this.requireOwner(who);
    return this.ctx.storage.transactionSync(() => {
      const previous = this.sql.exec<{ input_digest: string; role_id: string }>(
        `SELECT input_digest, role_id FROM role_create_requests WHERE request_key = ?`, requestKey,
      ).toArray()[0];
      if (previous) {
        if (previous.input_digest !== digest)
          throw new AppError("conflict", "this role request changed");
        return { roleId: previous.role_id };
      }
      if (hasUnknownEnd && (workerAllowsUnknownEnd !== true || this.env.ROLE_UNKNOWN_END_ENABLED !== "true"))
        throw new AppError("unavailable", "unknown end dates are not enabled");
      const unknown = r.unknownEndStartDate ?? null;
      if (unknown && (!DATE_PATTERN.test(unknown) || r.startDate !== null || r.endDate !== null))
        throw new AppError("invalid", "an unknown end cannot be combined with other dates");
      const id = crypto.randomUUID();
      this.sql.exec(
        `INSERT INTO roles (id, kind, org, title, start_date, end_date, unknown_end_start_date, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed')`,
        id, r.kind, r.org, r.title, r.startDate, r.endDate, unknown,
      );
      this.sql.exec(`INSERT INTO role_create_requests (request_key, input_digest, role_id) VALUES (?, ?, ?)`, requestKey, digest, id);
      return { roleId: id };
    });
  }

  /** Versioned edit validates the effective dates before making any change. */
  async editRoleV2(who: Who, id: string, patch: RolePatch): Promise<void> {
    this.requireOwner(who);
    if (this.env.ROLE_UNKNOWN_END_ENABLED !== "true")
      throw new AppError("unavailable", "unknown end dates are not enabled");
    const role = this.sql.exec<{ revision: number; start_date: string | null; end_date: string | null; unknown_end_start_date: string | null }>(
      `SELECT revision, start_date, end_date, unknown_end_start_date FROM roles WHERE id = ?`, id,
    ).toArray()[0];
    if (!role) throw new AppError("not_found", "no such role");
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== role.revision)
      throw new AppError("conflict", "this role changed; refresh and try again");
    const start = patch.startDate === undefined ? role.start_date : patch.startDate;
    const end = patch.endDate === undefined ? role.end_date : patch.endDate;
    const unknown = patch.unknownEndStartDate === undefined ? role.unknown_end_start_date : patch.unknownEndStartDate;
    if (unknown && (!DATE_PATTERN.test(unknown) || start !== null || end !== null))
      throw new AppError("invalid", "an unknown end cannot be combined with other dates");
    const fields: [string, string | null][] = [];
    if (patch.kind !== undefined) fields.push(["kind", patch.kind]);
    if (patch.org !== undefined) fields.push(["org", patch.org]);
    if (patch.title !== undefined) fields.push(["title", patch.title]);
    if (patch.startDate !== undefined) fields.push(["start_date", patch.startDate]);
    if (patch.endDate !== undefined) fields.push(["end_date", patch.endDate]);
    if (patch.unknownEndStartDate !== undefined) fields.push(["unknown_end_start_date", patch.unknownEndStartDate]);
    this.ctx.storage.transactionSync(() => {
      for (const [column, value] of fields)
        this.sql.exec(`UPDATE roles SET ${column} = ? WHERE id = ?`, value, id);
      if (fields.length) this.sql.exec(`UPDATE roles SET revision = revision + 1 WHERE id = ?`, id);
    });
  }

  async editRole(who: Who, id: string, patch: RolePatch): Promise<void> {
    this.requireOwner(who);
    const role = this.sql
      .exec<{ id: string; revision: number }>(
        `SELECT id, revision FROM roles WHERE id = ?`,
        id,
      )
      .toArray()[0];
    if (!role) throw new AppError("not_found", "no such role");
    if (
      patch.expectedRevision !== undefined &&
      patch.expectedRevision !== role.revision
    )
      throw new AppError(
        "conflict",
        "this role changed; refresh and try again",
      );
    const fields: [string, string | null][] = [];
    if (patch.kind !== undefined) fields.push(["kind", patch.kind]);
    if (patch.org !== undefined) fields.push(["org", patch.org]);
    if (patch.title !== undefined) fields.push(["title", patch.title]);
    if (patch.startDate !== undefined)
      fields.push(["start_date", patch.startDate]);
    if (patch.endDate !== undefined) fields.push(["end_date", patch.endDate]);
    this.ctx.storage.transactionSync(() => {
      for (const [column, value] of fields)
        this.sql.exec(`UPDATE roles SET ${column} = ? WHERE id = ?`, value, id);
      if (fields.length)
        this.sql.exec(
          `UPDATE roles SET revision = revision + 1 WHERE id = ?`,
          id,
        );
    });
  }

  async listFacts(who: Who, state?: ReviewState): Promise<FactView[]> {
    this.requireOwner(who);
    return this.readFacts(state);
  }

  private readFacts(state?: ReviewState): FactView[] {
    const where = state ? `WHERE f.state = ?` : ``;
    const params = state ? [state] : [];
    return this.sql
      .exec<FactRow>(
        `SELECT f.id, f.role_id, f.kind, f.text, f.level, f.level_revision, f.origin, f.state, f.source_id, f.revision, f.confidence, f.review_reasons, e.quote, e.start, e.end, s.origin AS evidence_origin, i.document_id AS interview_document_id, i.question_id AS interview_question_id, i.question AS interview_question, i.quote AS interview_quote
         FROM facts f LEFT JOIN evidence e ON e.id = f.evidence_id LEFT JOIN sources s ON s.id = f.source_id LEFT JOIN interview_answers i ON i.fact_id = f.id ${where}
         ORDER BY f.updated_at DESC`,
        ...params,
      )
      .toArray()
      .map(factView);
  }

  /** Confirms or rejects roles and facts by ID. Confirming a fact confirms its role; rejecting a role rejects its proposed facts. */
  async review(who: Who, r: ReviewRequest): Promise<void> {
    this.requireOwner(who);
    this.ctx.storage.transactionSync(() => {
      for (const [id, expected] of Object.entries(r.expectedRevisions ?? {})) {
        const current = this.sql
          .exec<{ revision: number }>(
            `SELECT revision FROM facts WHERE id = ? UNION ALL SELECT revision FROM roles WHERE id = ?`,
            id,
            id,
          )
          .toArray()[0];
        if (!current || current.revision !== expected)
          throw new AppError(
            "conflict",
            "experience changed; refresh and review again",
          );
      }
      // A confirmed fact is unusable while its role is rejected. Require an
      // explicit role confirmation instead of silently accepting a fact that
      // cannot participate in tailoring. Check the whole request first so a
      // conflicting batch leaves every review decision unchanged.
      const confirming = new Set(r.confirm);
      const rejecting = new Set(r.reject);
      for (const id of r.confirm) {
        const role = this.sql.exec<{ id: string; state: ReviewState }>(
          `SELECT r.id, r.state FROM facts f JOIN roles r ON r.id = f.role_id WHERE f.id = ?`,
          id,
        ).toArray()[0];
        if (role && (rejecting.has(role.id) || (role.state === "rejected" && !confirming.has(role.id))))
          throw new AppError("conflict", "confirm the role before confirming its facts");
      }
      for (const id of r.confirm) {
        this.extractionFeedbackStore.review(id, "confirmed", Date.now());
        this.sql.exec(
          `UPDATE roles SET state = 'confirmed', revision = revision + 1 WHERE id = ? AND state <> 'confirmed'`,
          id,
        );
        this.sql.exec(
          `UPDATE facts SET state = 'confirmed', level_revision = CASE WHEN origin = 'user' AND level_revision = revision THEN revision + 1 ELSE level_revision END, revision = revision + 1, updated_at = ? WHERE id = ? AND state <> 'confirmed'`,
          Date.now(),
          id,
        );
        this.sql.exec(
          `UPDATE roles SET state = 'confirmed', revision = revision + 1 WHERE id = (SELECT role_id FROM facts WHERE id = ?) AND state = 'proposed'`,
          id,
        );
      }
      for (const id of r.reject) {
        this.extractionFeedbackStore.rejectRole(id, Date.now());
        this.extractionFeedbackStore.review(id, "rejected", Date.now());
        this.sql.exec(
          `UPDATE roles SET state = 'rejected', revision = revision + 1 WHERE id = ? AND state <> 'rejected'`,
          id,
        );
        this.sql.exec(
          `UPDATE facts SET state = 'rejected', level_revision = CASE WHEN origin = 'user' AND level_revision = revision THEN revision + 1 ELSE level_revision END, revision = revision + 1 WHERE role_id = ? AND state = 'proposed'`,
          id,
        );
        this.sql.exec(
          `UPDATE facts SET state = 'rejected', level_revision = CASE WHEN origin = 'user' AND level_revision = revision THEN revision + 1 ELSE level_revision END, revision = revision + 1, updated_at = ? WHERE id = ? AND state <> 'rejected'`,
          Date.now(),
          id,
        );
      }
    });
    this.vectorCache = null;
  }

  /** Answers are user-authored; retries identify the exact question and answer before model I/O. */
  async answerInterview(
    who: Who,
    documentId: string,
    questionId: string,
    input: InterviewAnswer,
    requestKey: string,
  ): Promise<{ factId: string }> {
    const answer = input.answer.trim();
    if (
      !answer ||
      answer.length > 600 ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(requestKey)
    )
      throw new AppError("invalid", "invalid interview answer");
    const digest = base64url(
      await sha256(
        JSON.stringify([documentId, questionId, input.roleId, answer]),
      ),
    );
    this.requireOwner(who);
    const existing = () =>
      this.sql
        .exec<{ fact_id: string; input_digest: string }>(
          `SELECT fact_id,input_digest FROM interview_answers WHERE request_key = ?`,
          requestKey,
        )
        .toArray()[0];
    const previous = existing();
    if (previous) {
      if (previous.input_digest !== digest)
        throw new AppError("conflict", "this answer request changed");
      return { factId: previous.fact_id };
    }
    const question = this.interviewQuestion(documentId, questionId);
    if (input.roleId) this.requireUsableRole(input.roleId);
    const embeddingModel = this.activeEmbeddingModel();
    const vector = await this.embedOne(answer);
    this.requireOwner(who);
    if (embeddingModel !== this.activeEmbeddingModel())
      throw new AppError("conflict", "the search index changed; try again");
    const factId = this.ctx.storage.transactionSync(() => {
      const prior = existing();
      if (prior) {
        if (prior.input_digest !== digest)
          throw new AppError("conflict", "this answer request changed");
        return prior.fact_id;
      }
      if (this.interviewQuestion(documentId, questionId) !== question)
        throw new AppError(
          "conflict",
          "this question changed; refresh and try again",
        );
      if (input.roleId) this.requireUsableRole(input.roleId);
      const id = crypto.randomUUID(),
        now = Date.now();
      this.sql.exec(
        `INSERT INTO facts (id,role_id,kind,text,level,origin,state,vector,updated_at) VALUES (?,?,'accomplishment',?,NULL,'user','confirmed',?,?)`,
        id,
        input.roleId,
        answer,
        packVector(vector),
        now,
      );
      this.sql.exec(
        `INSERT INTO interview_answers (fact_id,document_id,question_id,question,quote,request_key,input_digest,created_at) VALUES (?,?,?,?,?,?,?,?)`,
        id,
        documentId,
        questionId,
        question,
        answer,
        requestKey,
        digest,
        now,
      );
      this.extractionFeedbackStore.manual(id, now);
      return id;
    });
    this.vectorCache = null;
    return { factId };
  }

  private interviewQuestion(documentId: string, questionId: string): string {
    const row = this.sql
      .exec<{ kind: string; state: string; data: string | null }>(
        `SELECT d.kind,d.state,v.data FROM documents d LEFT JOIN document_versions v ON v.document_id=d.id AND v.version=d.version WHERE d.id=?`,
        documentId,
      )
      .toArray()[0];
    if (!row) throw new AppError("not_found", "no such document");
    if (row.kind !== "questions" || row.state !== "ready" || !row.data)
      throw new AppError("conflict", "the questions are not ready");
    const parsed = JSON.parse(row.data) as {
      result?: { questions?: { id: string; question: string }[] };
    };
    const question = parsed.result?.questions?.find(
      (q) => q.id === questionId,
    )?.question;
    if (typeof question !== "string" || !question || question.length > 1000)
      throw new AppError("not_found", "no such question");
    return question;
  }

  /** A fact the user types is their own claim, so it is confirmed at once. */
  async addFact(who: Who, f: NewFact): Promise<{ factId: string }> {
    this.requireOwner(who);
    if (f.roleId) this.requireUsableRole(f.roleId);
    const vector = await this.embedOne(f.text);
    this.requireOwner(who);
    if (f.roleId) this.requireUsableRole(f.roleId);
    const id = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.sql.exec(
        `INSERT INTO facts (id, role_id, kind, text, level, origin, state, vector, updated_at, level_revision)
         VALUES (?, ?, ?, ?, ?, 'user', 'confirmed', ?, ?, ?)`,
        id,
        f.roleId,
        f.kind,
        f.text,
        f.level,
        packVector(vector),
        now,
        f.level === null ? null : 1,
      );
      this.extractionFeedbackStore.manual(id, now);
    });
    this.vectorCache = null;
    return { factId: id };
  }

  /** A request key returns the same fact after an uncertain response. */
  async addFactIdempotent(
    who: Who,
    f: NewFact,
    requestKey: string,
  ): Promise<{ factId: string }> {
    this.requireOwner(who);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(requestKey))
      throw new AppError("invalid", "invalid request key");
    const digest = base64url(await sha256(JSON.stringify([f.roleId, f.kind, f.text, f.level])));
    this.requireOwner(who);
    const previous = () => {
      const row = this.sql.exec<{ input_digest: string; fact_id: string }>(
        `SELECT input_digest, fact_id FROM fact_create_requests WHERE request_key = ?`, requestKey,
      ).toArray()[0];
      if (!row) return null;
      if (row.input_digest !== digest)
        throw new AppError("conflict", "this fact request changed");
      return row.fact_id;
    };
    const existing = previous();
    if (existing) return { factId: existing };
    if (f.roleId) this.requireUsableRole(f.roleId);
    const model = this.activeEmbeddingModel();
    const vector = await this.embedOne(f.text);
    this.requireOwner(who);
    const factId = this.ctx.storage.transactionSync(() => {
      // Another copy of this request may have committed while embedding.
      const prior = previous();
      if (prior) return prior;
      if (model !== this.activeEmbeddingModel())
        throw new AppError("conflict", "the search index changed; try again");
      if (f.roleId) this.requireUsableRole(f.roleId);
      const id = crypto.randomUUID(), now = Date.now();
      this.sql.exec(
        `INSERT INTO facts (id, role_id, kind, text, level, origin, state, vector, updated_at, level_revision)
         VALUES (?, ?, ?, ?, ?, 'user', 'confirmed', ?, ?, ?)`,
        id, f.roleId, f.kind, f.text, f.level, packVector(vector), now,
        f.level === null ? null : 1,
      );
      this.sql.exec(
        `INSERT INTO fact_create_requests (request_key, input_digest, fact_id) VALUES (?, ?, ?)`,
        requestKey, digest, id,
      );
      this.extractionFeedbackStore.manual(id, now);
      return id;
    });
    this.vectorCache = null;
    return { factId };
  }

  /**
   * Rewords a fact, moves it to another role (or to none), or both. Either change makes it the
   * user's own claim; its original quote stays beside it.
   */
  async editFact(who: Who, id: string, patch: FactPatch): Promise<void> {
    this.requireOwner(who);
    const fact = this.sql
      .exec<{ text: string; revision: number; role_id: string | null; origin: string; level: string | null; level_revision: number | null }>(
        `SELECT text, revision, role_id, origin, level, level_revision FROM facts WHERE id = ?`,
        id,
      )
      .toArray()[0];
    if (!fact) throw new AppError("not_found", "no such fact");
    if (
      patch.expectedRevision !== undefined &&
      patch.expectedRevision !== fact.revision
    )
      throw new AppError(
        "conflict",
        "this fact changed; refresh and try again",
      );
    if (patch.roleId) this.requireUsableRole(patch.roleId);
    const text = patch.text ?? fact.text;
    const vector =
      patch.text !== undefined && patch.text !== fact.text
        ? await this.embedOne(text)
        : null;
    this.requireOwner(who);
    if (patch.roleId) this.requireUsableRole(patch.roleId);
    this.ctx.storage.transactionSync(() => {
      const current = this.sql
        .exec<{ revision: number }>(
          `SELECT revision FROM facts WHERE id = ?`,
          id,
        )
        .toArray()[0];
      if (!current || current.revision !== fact.revision)
        throw new AppError(
          "conflict",
          "this fact changed while saving; refresh and try again",
        );
      const roleId = patch.roleId === undefined ? fact.role_id : patch.roleId;
      if (text !== fact.text || roleId !== fact.role_id)
        this.extractionFeedbackStore.edit(id, Date.now());
      if (roleId) this.requireUsableRole(roleId);
      if (vector)
        this.sql.exec(
          `UPDATE facts SET text = ?, vector = ? WHERE id = ?`,
          text,
          packVector(vector),
          id,
        );
      if (patch.roleId !== undefined)
        this.sql.exec(
          `UPDATE facts SET role_id = ? WHERE id = ?`,
          patch.roleId,
          id,
        );
      const level = patch.level === undefined ? fact.level : patch.level;
      const levelRevision = patch.level !== undefined
        ? (patch.level === null ? null : fact.revision + 1)
        : text !== fact.text
          ? null
          : fact.origin === "user" && fact.level_revision === fact.revision
            ? fact.revision + 1 : null;
      this.sql.exec(
        `UPDATE facts SET origin = 'user', level = ?, level_revision = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
        level, levelRevision, Date.now(), id,
      );
    });
    this.vectorCache = null;
  }

  // ---------------------------------------------------------------- applications and tailoring (user)

  async addApplication(
    who: Who,
    jdText: string,
  ): Promise<{ applicationId: string }> {
    this.requireOwner(who);
    const id = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO applications (id, jd_text, created_at) VALUES (?, ?, ?)`,
      id,
      jdText,
      Date.now(),
    );
    return { applicationId: id };
  }

  /** A retried job submission returns its original application. */
  async addApplicationIdempotent(
    who: Who,
    jdText: string,
    requestKey: string,
  ): Promise<{ applicationId: string }> {
    this.requireOwner(who);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(requestKey))
      throw new AppError("invalid", "invalid request key");
    const digest = base64url(await sha256(JSON.stringify([jdText])));
    this.requireOwner(who);
    return this.ctx.storage.transactionSync(() => {
      const prior = this.sql.exec<{ input_digest: string; application_id: string }>(
        `SELECT input_digest, application_id FROM application_create_requests WHERE request_key = ?`, requestKey,
      ).toArray()[0];
      if (prior) {
        if (prior.input_digest !== digest)
          throw new AppError("conflict", "this job request changed");
        return { applicationId: prior.application_id };
      }
      const id = crypto.randomUUID();
      this.sql.exec(
        `INSERT INTO applications (id, jd_text, created_at) VALUES (?, ?, ?)`,
        id, jdText, Date.now(),
      );
      this.sql.exec(
        `INSERT INTO application_create_requests (request_key, input_digest, application_id) VALUES (?, ?, ?)`,
        requestKey, digest, id,
      );
      return { applicationId: id };
    });
  }

  async listApplications(who: Who): Promise<ApplicationView[]> {
    this.requireOwner(who);
    await this.rearmPendingRuns();
    this.requireOwner(who);
    const resumes = this.sql
      .exec<{
        id: string;
        application_id: string;
        state: string;
        created_at: number;
        run_id: string | null;
      }>(
        `SELECT id, application_id, state, created_at, run_id FROM resumes ORDER BY created_at DESC`,
      )
      .toArray();
    return this.sql
      .exec<ApplicationRow>(
        `SELECT * FROM applications ORDER BY created_at DESC`,
      )
      .toArray()
      .map((a) => ({
        id: a.id,
        revision: a.revision,
        status: a.status,
        appliedAt: a.applied_at,
        notes: a.notes,
        company: a.company,
        title: a.title,
        excerpt: excerptOf(a.jd_text),
        createdAt: a.created_at,
        resumes: resumes
          .filter((r) => r.application_id === a.id)
          .map((r) => ({
            id: r.id,
            state: r.state as ResumeState,
            dispatchUncertain: r.state === "running" && this.dispatchUncertain(r.run_id),
            cancellationPending: r.state === "running" && this.cancellationPending(r.run_id),
            createdAt: r.created_at,
          })),
      }));
  }

  /**
   * Starts a Tailor run. The quota is counted and the running row written before the first
   * await, so two starts cannot both pass the one-run rule; a failed start is refunded.
   */
  async tailor(
    who: Who,
    applicationId: string,
    requestKey = crypto.randomUUID(),
  ): Promise<{ resumeId: string; runId: string }> {
    return this.tailorWithGuard(who, applicationId, requestKey, () => {});
  }

  /** The connected-app guard is rechecked after external reconciliation and before any new run. */
  private async tailorWithGuard(
    who: Who,
    applicationId: string,
    requestKey: string,
    guard: () => void,
  ): Promise<{ resumeId: string; runId: string }> {
    guard();
    this.requireOwner(who);
    const app = this.sql
      .exec<ApplicationRow>(
        `SELECT * FROM applications WHERE id = ?`,
        applicationId,
      )
      .toArray()[0];
    if (!app) throw new AppError("not_found", "no such application");
    const key = `tailor:${requestKey}`;
    const replay = () => {
      const previous = this.runs.findRequest(key);
      if (!previous) return null;
      if (previous.inputDigest !== applicationId)
        throw new AppError(
          "conflict",
          "request key was used for another application",
        );
      return { resumeId: previous.targetId, runId: previous.id };
    };
    const previous = replay();
    if (previous) return previous;
    await this.reconcileStaleRuns();
    this.requireOwner(who);
    guard();
    // A second request with the same key may have started the run while
    // reconciliation was waiting on a Workflow status call.
    const concurrent = replay();
    if (concurrent) return concurrent;
    if (
      this.runs
        .listPending()
        .some((r) => ["tailor", "refine", "letter", "prep", "questions"].includes(r.kind))
    ) {
      throw new AppError(
        "conflict",
        "a document is already being generated; wait for it to finish",
      );
    }
    const quota = this.quota();
    if (quota.used + (quota.reserved ?? 0) >= quota.limit)
      throw new AppError(
        "quota",
        `you have used all ${quota.limit} tailored resumes for this month; more on ${resetDay(quota.month)}`,
      );
    const id = crypto.randomUUID();
    this.runs.begin(
      {
        id,
        kind: "tailor",
        targetId: id,
        requestKey: key,
        inputDigest: applicationId,
        steps: ["analyze", "select", "write", "verify"],
        quota: this.quotaBucket(),
      },
      () => {
        this.sql.exec(
          `INSERT INTO resumes (id, application_id, state, quota_month, run_id, created_at) VALUES (?, ?, 'running', ?, ?, ?)`,
          id,
          applicationId,
          quota.month,
          id,
          Date.now(),
        );
        this.snapshots.capture(
          id,
          {
            applicationId,
            jdText: app.jd_text,
            analysis: app.requirements
              ? {
                  company: app.company,
                  title: app.title,
                  requirements: JSON.parse(app.requirements),
                }
              : null,
            profile: this.readProfile(),
            embeddingModel: this.activeEmbeddingModel(),
          },
          this.usableFacts(),
          this.confirmedRoles(),
          this.vectors(),
        );
      },
    );
    await this.dispatchRun(this.runs.get(id)!);
    return { resumeId: id, runId: id };
  }

  async getResume(who: Who, id: string, version?: number): Promise<ResumeView> {
    this.requireOwner(who);
    await this.rearmPendingRuns();
    this.requireOwner(who);
    const row = this.resumeRow(id);
    const ready = row.state === "ready";
    const saved = ready ? this.resumeVersion(row, version) : null;
    let needsGroundingReview = false;
    if (saved) {
      try { assertGroundedResume(saved.render, saved.facts, saved.provenance, saved.evidence); }
      catch { needsGroundingReview = true; }
    }
    return {
      id: row.id,
      applicationId: row.application_id,
      state: row.state as ResumeState,
      dispatchUncertain: row.state === "running" && this.dispatchUncertain(row.run_id),
      cancellationPending: row.state === "running" && this.cancellationPending(row.run_id),
      step: row.step,
      error: row.error,
      version: version ?? row.version,
      createdAt: row.created_at,
      body: saved?.render.body ?? null,
      report: saved?.report ?? null,
      facts: saved?.facts ?? {},
      provenance: saved?.provenance,
      ...(needsGroundingReview ? { needsGroundingReview: true } : {}),
      ...(saved?.provenance === "legacy" ? { legacyReview: legacyReview(saved, this.usableFacts(), this.confirmedRoles()) } : {}),
    };
  }

  async resumeVersions(who: Who, id: string) {
    this.requireOwner(who);
    const row = this.resumeRow(id);
    if (row.state === "ready") this.resumeVersion(row);
    return this.snapshots.versions(id);
  }

  /** Start a fresh per-line review without changing the blocked snapshot. */
  beginResumeReview(who: Who, resumeId: string, expectedVersion: number): { version: number } {
    this.requireOwner(who);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw new AppError("invalid", "the resume version is required");
    const result = this.ctx.storage.transactionSync(() => {
      this.requireOwner(who);
      const row = this.resumeRow(resumeId);
      if (row.state !== "ready" || !row.body) throw new AppError("conflict", "the resume is not ready");
      if (row.version === expectedVersion + 1) {
        const saved = this.snapshots.read(resumeId, row.version);
        if (saved?.provenance === "legacy" && saved.reviewStartedFrom === expectedVersion)
          return { version: row.version };
      }
      if (row.version !== expectedVersion) throw new AppError("conflict", "the resume changed; refresh and try again");
      if (this.runs.listPending().some((run) => ["tailor", "refine", "letter", "prep", "questions"].includes(run.kind)))
        throw new AppError("conflict", "wait for the current document to finish");
      const base = this.resumeVersion(row);
      if (base.provenance !== "snapshot") throw new AppError("conflict", "this resume is already in review");
      let blocked = false;
      try { assertGroundedResume(base.render, base.facts, base.provenance, base.evidence); }
      catch { blocked = true; }
      if (!blocked) throw new AppError("conflict", "this resume does not need grounding review");
      const version = row.version + 1;
      const saved: ResumeVersion = {
        ...base,
        render: { ...base.render, version },
        provenance: "legacy",
        legacyReceipts: {},
        reviewStartedFrom: expectedVersion,
        legacyFinalizedFrom: undefined,
      };
      this.snapshots.save(resumeId, version, saved);
      this.sql.exec(`UPDATE resumes SET version=? WHERE id=?`, version, resumeId);
      return { version };
    });
    this.broadcast("resume", resumeId);
    return result;
  }

  /** Remove one line from a new review version; old versions and shares are immutable. */
  removeLegacyLine(who: Who, resumeId: string, lineId: string, expectedVersion: number): { version: number } {
    this.requireOwner(who);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !lineId || lineId.length > 256)
      throw new AppError("invalid", "the line and resume version are required");
    const result = this.ctx.storage.transactionSync(() => {
      this.requireOwner(who);
      const row = this.resumeRow(resumeId);
      if (row.state !== "ready" || !row.body) throw new AppError("conflict", "the resume is not ready");
      if (row.version === expectedVersion + 1) {
        const saved = this.snapshots.read(resumeId, row.version);
        if (saved?.provenance === "legacy" && saved.legacyRemoved?.fromVersion === expectedVersion && saved.legacyRemoved.lineId === lineId)
          return { version: row.version };
      }
      if (row.version !== expectedVersion) throw new AppError("conflict", "the resume changed; refresh and try again");
      if (this.runs.listPending().some((run) => ["tailor", "refine", "letter", "prep", "questions"].includes(run.kind)))
        throw new AppError("conflict", "wait for the current document to finish");
      const base = this.resumeVersion(row);
      if (base.provenance !== "legacy") throw new AppError("conflict", "only a review version can remove a line");
      const body = structuredClone(base.render.body);
      const matches = Number(body.summary?.id === lineId) + body.sections.reduce((n, section) => n + section.lines.filter((line) => line.id === lineId).length, 0);
      if (matches !== 1) throw new AppError("conflict", "the review line is missing or ambiguous");
      if (body.summary?.id === lineId) body.summary = null;
      body.sections = body.sections.flatMap((section) => {
        if (!section.lines.some((line) => line.id === lineId)) return [section];
        const lines = section.lines.filter((line) => line.id !== lineId);
        return lines.length ? [{ ...section, lines }] : [];
      });
      const receipts = { ...base.legacyReceipts };
      delete receipts[lineId];
      const version = row.version + 1;
      this.snapshots.save(resumeId, version, {
        ...base, render: { ...base.render, body, version }, legacyReceipts: receipts,
        legacyRemoved: { fromVersion: expectedVersion, lineId },
      });
      this.sql.exec(`UPDATE resumes SET body=?,version=? WHERE id=?`, JSON.stringify(body), version, resumeId);
      return { version };
    });
    this.broadcast("resume", resumeId);
    return result;
  }

  /** Remove a line from a checked resume in a new, independently printable version. */
  removeResumeLine(who: Who, resumeId: string, lineId: string, expectedVersion: number): { version: number } {
    this.requireOwner(who);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !lineId || lineId.length > 256)
      throw new AppError("invalid", "the line and resume version are required");
    const result = this.ctx.storage.transactionSync(() => {
      this.requireOwner(who);
      const row = this.resumeRow(resumeId);
      if (row.state !== "ready" || !row.body) throw new AppError("conflict", "the resume is not ready");
      if (row.version === expectedVersion + 1) {
        const saved = this.snapshots.read(resumeId, row.version);
        if (saved?.provenance === "snapshot" && saved.lineRemoved?.fromVersion === expectedVersion && saved.lineRemoved.lineId === lineId)
          return { version: row.version };
      }
      if (row.version !== expectedVersion) throw new AppError("conflict", "the resume changed; refresh and try again");
      if (this.runs.listPending().some((run) => ["tailor", "refine", "letter", "prep", "questions"].includes(run.kind)))
        throw new AppError("conflict", "wait for the current document to finish");
      const base = this.resumeVersion(row);
      // A deletion must never promote a blocked or legacy version into a checked one.
      assertGroundedResume(base.render, base.facts, base.provenance, base.evidence);
      const body = structuredClone(base.render.body);
      const matches = Number(body.summary?.id === lineId) + body.sections.reduce((n, section) => n + section.lines.filter((line) => line.id === lineId).length, 0);
      if (matches !== 1) throw new AppError("conflict", "the line is missing or ambiguous");
      if (body.summary?.id === lineId) body.summary = null;
      body.sections = body.sections.flatMap((section) => {
        if (!section.lines.some((line) => line.id === lineId)) return [section];
        const lines = section.lines.filter((line) => line.id !== lineId);
        return lines.length ? [{ ...section, lines }] : [];
      });
      const lines = [...(body.summary ? [body.summary] : []), ...body.sections.flatMap((section) => section.lines)];
      const report = base.report ? {
        ...base.report,
        kept: lines.filter((line) => line.status === "kept").length,
        repaired: lines.filter((line) => line.status === "repaired").length,
        replaced: lines.filter((line) => line.status === "replaced").length,
      } : null;
      const version = row.version + 1;
      const saved: ResumeVersion = {
        ...base, render: { ...base.render, body, version }, report,
        lineRemoved: { fromVersion: expectedVersion, lineId },
      };
      assertGroundedResume(saved.render, saved.facts, saved.provenance, saved.evidence);
      this.snapshots.save(resumeId, version, saved);
      this.sql.exec(`UPDATE resumes SET body=?,report=?,version=? WHERE id=?`, JSON.stringify(body), JSON.stringify(report), version, resumeId);
      return { version };
    });
    this.broadcast("resume", resumeId);
    return result;
  }

  /** Promote only a fully rechecked current legacy version; never mutate history. */
  finalizeLegacyResume(who: Who, resumeId: string, expectedVersion: number): { version: number } {
    this.requireOwner(who);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw new AppError("invalid", "the resume version is required");
    const result = this.ctx.storage.transactionSync(() => {
      this.requireOwner(who);
      const row = this.resumeRow(resumeId);
      if (row.state !== "ready" || !row.body) throw new AppError("conflict", "the resume is not ready");
      if (row.version === expectedVersion + 1) {
        const saved = this.snapshots.read(resumeId, row.version);
        if (saved?.provenance === "snapshot" && saved.legacyFinalizedFrom === expectedVersion)
          return { version: row.version };
      }
      if (row.version !== expectedVersion) throw new AppError("conflict", "the resume changed; refresh and try again");
      if (this.runs.listPending().some((run) => ["tailor", "refine", "letter", "prep", "questions"].includes(run.kind)))
        throw new AppError("conflict", "wait for the current document to finish");
      const base = this.resumeVersion(row);
      const verified = finalLegacyEvidence(base, this.usableFacts(), this.confirmedRoles());
      const version = row.version + 1;
      const saved: ResumeVersion = {
        ...base,
        render: { ...base.render, profile: this.readProfile(), version },
        facts: verified.facts,
        evidence: verified.evidence,
        report: { kept: verified.count, repaired: 0, replaced: 0, dropped: 0, gaps: [] },
        provenance: "snapshot",
        legacyFinalizedFrom: expectedVersion,
      };
      assertGroundedResume(saved.render, saved.facts, saved.provenance, saved.evidence);
      this.snapshots.save(resumeId, version, saved);
      this.sql.exec(`UPDATE resumes SET version=?,body=?,report=? WHERE id=?`, version,
        JSON.stringify(saved.render.body), JSON.stringify(saved.report), resumeId);
      return { version };
    });
    this.broadcast("resume", resumeId);
    return result;
  }

  /** Direct edits cannot establish entailment; use the verified document workflow. */
  async editLine(
    who: Who,
    resumeId: string,
    lineId: string,
    text: string,
    expectedVersion?: number,
  ): Promise<void> {
    this.requireOwner(who);
    const row = this.resumeRow(resumeId);
    if (row.state !== "ready" || !row.body)
      throw new AppError("conflict", "the resume is not ready yet");
    if (expectedVersion !== undefined && expectedVersion !== row.version)
      throw new AppError(
        "conflict",
        "the document changed; refresh before editing",
      );
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_LINE_CHARS)
      throw new AppError(
        "invalid",
        `a line must be 1 to ${MAX_LINE_CHARS} characters`,
      );
    const saved = this.resumeVersion(row);
    const line = [
      ...(saved.render.body.summary ? [saved.render.body.summary] : []),
      ...saved.render.body.sections.flatMap((s) => s.lines),
    ].find((l) => l.id === lineId);
    if (!line) throw new AppError("not_found", "no such line");
    if (line.text === trimmed) return;
    throw new AppError("conflict", "use verified editing to change this line");
  }

  async renderData(
    who: Who,
    resumeId: string,
    version?: number,
  ): Promise<RenderData> {
    this.requireOwner(who);
    const row = this.resumeRow(resumeId);
    if (row.state !== "ready" || !row.body)
      throw new AppError("conflict", "the resume is not ready yet");
    const saved = this.resumeVersion(row, version);
    assertGroundedResume(saved.render, saved.facts, saved.provenance, saved.evidence);
    return saved.render;
  }

  // ---------------------------------------------------------------- tailoring (Tailor Workflow)

  async tailorInput(resumeId: string, runId?: string): Promise<TailorInput> {
    this.requireOpen();
    if (!runId) throw new AppError("invalid", "workflow identity is required");
    const row = this.resumeRow(resumeId);
    if (runId && row.run_id !== runId)
      throw new AppError("conflict", "this attempt was superseded");
    const id = row.run_id ?? resumeId;
    const run = this.runs.get(id);
    if (runId) this.workflowRun(runId, "tailor", resumeId);
    if (
      run &&
      run.state !== "running" &&
      run.state !== "starting" &&
      run.state !== "succeeded"
    )
      throw new AppError("conflict", "this run no longer accepts work");
    const input = this.snapshots.metadata(id);
    if (!input)
      throw new AppError(
        "conflict",
        "this older run has no saved inputs; generate it again",
      );
    return {
      applicationId: input.applicationId,
      jdText: input.jdText,
      analysis: parseOrNull<Analysis>(row.run_analysis) ?? input.analysis,
      selection: parseOrNull<Selection>(row.selection),
      draft: parseOrNull<Draft>(row.draft),
      verified: parseOrNull<VerifiedDraft>(row.verified),
      facts: this.snapshots.items<FactRecord>(id, "fact"),
      roles: this.snapshots.items<RoleRecord>(id, "role"),
    };
  }

  async saveAnalysis(
    applicationId: string,
    a: Analysis,
    resumeId?: string,
    runId?: string,
  ): Promise<void> {
    this.requireOpen();
    if (!resumeId || !runId) throw new AppError("invalid", "workflow identity is required");
    if (resumeId) {
      const resume = this.resumeRow(resumeId);
      if (resume.application_id !== applicationId || resume.run_id !== runId)
        throw new AppError("conflict", "this attempt was superseded");
      const run = this.workflowRun(runId, "tailor", resumeId);
      if (!["starting", "running"].includes(run.state))
        throw new AppError("conflict", "this run no longer accepts work");
      this.sql.exec(
        `UPDATE resumes SET run_analysis = ? WHERE id = ? AND state = 'running'`,
        JSON.stringify(a),
        resumeId,
      );
    }
    this.sql.exec(
      `UPDATE applications SET company = ?, title = ?, requirements = ? WHERE id = ?`,
      a.company,
      a.title,
      JSON.stringify(a.requirements),
      applicationId,
    );
  }

  /** For each query vector, the k closest usable confirmed facts. */
  async searchFacts(
    queries: number[][],
    k: number,
    runId?: string,
  ): Promise<Candidate[]> {
    this.requireOpen();
    return runId
      ? this.snapshots.search(runId, queries, k)
      : topMatches(queries, this.vectors(), k);
  }

  async saveStep(
    resumeId: string,
    step: string,
    patch: ResumePatch,
    runId?: string,
  ): Promise<void> {
    this.requireOpen();
    const row = this.resumeRow(resumeId);
    if (!runId) throw new AppError("invalid", "workflow identity is required");
    if (runId && row.run_id !== runId)
      throw new AppError("conflict", "this attempt was superseded");
    const id = row.run_id ?? resumeId;
    if (runId) this.workflowRun(runId, "tailor", resumeId);
    const write = () => {
      if (row.state !== "running")
        throw new AppError(
          "conflict",
          "this resume no longer accepts workflow writes",
        );
      validateTailorCheckpoint(step, patch);
      // The finish call may only publish the already-verified draft. Never let
      // a stale or malformed Workflow patch replace its evidence, report or
      // headers while turning the run into a printable snapshot.
      let publication: { body: ResumeBody; report: ResumeReport } | undefined;
      if (patch.state === "ready") {
        publication = validateTailorPublication(
          patch.body, patch.report, row.verified, row.selection,
          this.snapshots.items<RoleRecord>(id, "role"),
          this.snapshots.items<FactRecord>(id, "fact"),
        );
      }
      const updates: [string, string][] = [["step", step]];
      if (patch.selection)
        updates.push(["selection", JSON.stringify(patch.selection)]);
      if (patch.draft) updates.push(["draft", JSON.stringify(patch.draft)]);
      if (patch.verified)
        updates.push(["verified", JSON.stringify(patch.verified)]);
      if (patch.body) updates.push(["body", JSON.stringify(publication?.body ?? patch.body)]);
      if (patch.report) updates.push(["report", JSON.stringify(publication?.report ?? patch.report)]);
      if (patch.state) updates.push(["state", patch.state]);
      if (publication) {
        this.snapshots.assertCurrent(id, publication.body);
        const input = this.snapshots.metadata(id)!;
        const capturedFacts = this.snapshots.items<FactRecord>(id, "fact");
        const facts = Object.fromEntries(capturedFacts.map((f) => [f.id, { text: f.text, quote: f.quote }]));
        const analysis =
          parseOrNull<Analysis>(row.run_analysis) ?? input.analysis;
        this.snapshots.save(resumeId, row.version, {
          render: {
            profile: input.profile,
            body: publication.body,
            version: row.version,
            company: analysis?.company ?? null,
            title: analysis?.title ?? null,
          },
          report: publication.report,
          facts,
          evidence: evidenceForFacts(capturedFacts),
          provenance: "snapshot",
        });
      }
      for (const [column, value] of updates)
        this.sql.exec(
          `UPDATE resumes SET ${column} = ? WHERE id = ?`,
          value,
          resumeId,
        );
    };
    if (this.runs.get(id)) {
      if (patch.state === "ready") {
        if (this.runs.finish(id, write).applied) this.recordRunTotal(id);
      } else this.runs.commitStep(id, step, write);
    } else this.ctx.storage.transactionSync(write);
    this.broadcast("resume", resumeId);
  }

  async failResume(
    resumeId: string,
    error: string,
    runId?: string,
  ): Promise<void> {
    if (this.gone || !this.initialised) return;
    if (!runId) return;
    if (runId && this.resumeRow(resumeId).run_id !== runId) return;
    if (runId) {
      const run = this.runs.get(runId);
      if (!run || run.kind !== "tailor" || run.targetId !== resumeId) return;
    }
    this.markResumeFailed(resumeId, error);
  }

  private get mcpGrants(): McpGrantStore {
    return new McpGrantStore(this.sql, {
      authorizeOwner: (who) => this.requireOwner(who),
      requireOpen: () => this.requireOpen(),
      currentEpoch: () => this.meta("security_epoch") ?? "legacy",
    });
  }
  async mcpIdentity(who: Who) {
    this.requireOwner(who);
    return { epoch: this.meta("security_epoch") ?? "legacy" };
  }
  async createMcpGrant(who: Who, input: NewMcpGrant) {
    return this.mcpGrants.create(who, input);
  }
  async bindMcpGrant(claims: McpClaims, remoteId: string) {
    if (claims.vid !== this.vaultId)
      throw new AppError("forbidden", "wrong account");
    this.mcpGrants.bind(claims, remoteId);
  }
  async listMcpGrants(who: Who) {
    return this.mcpGrants.list(who);
  }
  async revokeMcpGrant(who: Who, id: string) {
    return this.mcpGrants.revoke(who, id);
  }
  async authorizeMcp(claims: McpClaims, scope: McpScope) {
    return this.requireMcp(claims, scope);
  }
  private requireMcp(claims: McpClaims, scope: McpScope): Who {
    if (claims.vid !== this.vaultId)
      throw new AppError("forbidden", "wrong account");
    return this.mcpGrants.authorize(claims, scope);
  }
  async mcpFacts(claims: McpClaims, input: { query?: string; limit?: number }) {
    this.requireMcp(claims, "vault:read");
    const words = (input.query ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    return this.usableFacts()
      .filter((f) => words.every((w) => f.text.toLowerCase().includes(w)))
      .slice(0, Math.min(100, Math.max(1, input.limit ?? 50)))
      .map((f) => ({
        id: f.id,
        roleId: f.roleId,
        kind: f.kind,
        text: f.text,
        level: f.level,
      }));
  }
  async mcpResume(claims: McpClaims, id: string, version?: number) {
    const who = this.requireMcp(claims, "vault:read");
    const resume = await this.getResume(who, id, version);
    this.requireMcp(claims, "vault:read");
    if (resume.state !== "ready")
      throw new AppError("conflict", "the resume is not ready");
    const render = await this.renderData(who, id, resume.version);
    this.requireMcp(claims, "vault:read");
    return {
      id: resume.id,
      version: resume.version,
      body: render.body,
      provenance: resume.provenance,
    };
  }
  async mcpTailor(
    claims: McpClaims,
    applicationId: string,
    requestKey: string,
  ) {
    const who = this.requireMcp(claims, "vault:generate");
    return this.tailorWithGuard(
      who,
      applicationId,
      `mcp_${claims.grantId}_${requestKey}`,
      () => { this.requireMcp(claims, "vault:generate"); },
    );
  }

  private get shares(): ShareStore {
    return new ShareStore(this.sql, {
      authorizeOwner: (who) => this.requireOwner(who),
      requireOpen: () => this.requireOpen(),
      currentEpoch: () => this.meta("security_epoch") ?? "legacy",
    });
  }

  async createShare(
    who: Who,
    selection: {
      factIds: string[];
      resumes: { id: string; version: number }[];
      expiresAt?: number;
    },
  ) {
    // Capture the selected facts, roles and resume versions together with the
    // grant. A role can change independently of its facts, so checking only
    // fact revisions after awaiting separate reads is not sufficient.
    const grant = this.ctx.storage.transactionSync(() => {
      this.requireOwner(who);
      const facts = this.readFacts("confirmed").filter((f) =>
        selection.factIds.includes(f.id),
      );
      if (facts.length !== selection.factIds.length)
        throw new AppError("invalid", "select confirmed facts from your vault");
      const roles = this.readRoles();
      const resumes = selection.resumes.map(({ id, version }) => ({
        id,
        ...this.resumeVersion(this.resumeRow(id), version),
      }));
      return this.shares.create(
        who,
        { facts, roles, resumes },
        selection.expiresAt,
      );
    });
    await this.scheduleRunAlarm(grant.expiresAt);
    return grant;
  }
  async listShares(who: Who) {
    return this.shares.list(who);
  }
  async revokeShare(who: Who, id: string) {
    this.shares.revoke(who, id);
  }
  async readShare(claims: { grantId: string; epoch: string }) {
    return this.shares.read(claims);
  }

  async updateApplication(
    who: Who,
    id: string,
    patch: {
      status?: import("../shared/api").ApplicationStatus;
      appliedAt?: string | null;
      notes?: string;
      expectedRevision?: number;
    },
  ): Promise<void> {
    this.requireOwner(who);
    const row = this.sql
      .exec<ApplicationRow>(`SELECT * FROM applications WHERE id = ?`, id)
      .toArray()[0];
    if (!row) throw new AppError("not_found", "no such application");
    if (
      patch.expectedRevision !== undefined &&
      row.revision !== patch.expectedRevision
    )
      throw new AppError(
        "conflict",
        "the application changed; refresh and try again",
      );
    this.sql.exec(
      `UPDATE applications SET status = ?, applied_at = ?, notes = ?, revision = revision + 1 WHERE id = ?`,
      patch.status ?? row.status,
      patch.appliedAt === undefined ? row.applied_at : patch.appliedAt,
      patch.notes ?? row.notes,
      id,
    );
  }

  async startDocument(
    who: Who,
    applicationId: string,
    options: NewDocument,
    requestKey: string,
  ): Promise<{ documentId: string; runId: string }> {
    const digest = base64url(
      await sha256(JSON.stringify([applicationId, options])),
    );
    this.requireOwner(who);
    if (options.manualText !== undefined &&
        (options.kind !== "refine" || options.expectedVersion === undefined ||
         !options.resumeId || options.lineIds?.length !== 1 ||
         !options.manualText.trim() || options.manualText !== options.manualText.trim() ||
         options.manualText.length > MAX_LINE_CHARS))
      throw new AppError("invalid", "choose one line and enter a valid edit");
    if (options.manualFactIds !== undefined &&
        (options.manualText === undefined || options.manualFactIds.length < 1 ||
         options.manualFactIds.length > 4 || new Set(options.manualFactIds).size !== options.manualFactIds.length))
      throw new AppError("invalid", "choose up to four distinct confirmed facts");
    const app = this.sql
      .exec<ApplicationRow>(
        `SELECT * FROM applications WHERE id = ?`,
        applicationId,
      )
      .toArray()[0];
    if (!app) throw new AppError("not_found", "no such application");
    const key = `document:${requestKey}`;
    const existing = this.runs.findRequest(key);
    if (existing) {
      if (existing.inputDigest !== digest)
        throw new AppError(
          "conflict",
          "request key already used with other input",
        );
      return { documentId: existing.id, runId: existing.id };
    }
    if (
      this.runs
        .listPending()
        .some((r) =>
          ["tailor", "refine", "letter", "prep", "questions"].includes(r.kind),
        )
    )
      throw new AppError("conflict", "wait for the current document to finish");
    let base: ResumeVersion | undefined;
    if (options.kind === "refine") {
      if (!options.resumeId)
        throw new AppError("invalid", "choose a resume to refine");
      const resume = this.resumeRow(options.resumeId);
      if (resume.application_id !== applicationId || resume.state !== "ready")
        throw new AppError(
          "invalid",
          "the resume is not ready for this application",
        );
      if (
        options.expectedVersion !== undefined &&
        options.expectedVersion !== resume.version
      )
        throw new AppError(
          "conflict",
          "the resume changed; refresh before refining",
        );
      options = { ...options, expectedVersion: resume.version };
      base = this.resumeVersion(resume);
      if (base.provenance === "legacy" && (options.manualText === undefined || !options.manualFactIds?.length))
        throw new AppError("invalid", "choose confirmed facts to verify this historical line");
      if (options.manualText === undefined)
        assertGroundedResume(base.render, base.facts, base.provenance, base.evidence);
    }
    const id = crypto.randomUUID();
    this.quota();
    this.runs.begin(
      {
        id,
        kind: options.kind,
        targetId: id,
        requestKey: key,
        inputDigest: digest,
        steps: ["plan", "write", "verify"],
        ...(options.kind !== "questions" ? { quota: this.quotaBucket() } : {}),
      },
      () => {
        this.sql.exec(
          `INSERT INTO documents (id, application_id, kind, state, created_at) VALUES (?, ?, ?, 'running', ?)`,
          id,
          applicationId,
          options.kind,
          Date.now(),
        );
        this.sql.exec(
          `INSERT INTO document_requests (run_id, application_id, kind, options) VALUES (?, ?, ?, ?)`,
          id,
          applicationId,
          options.kind,
          JSON.stringify({ ...options, base: base?.render.body }),
        );
        this.snapshots.capture(
          id,
          {
            applicationId,
            jdText: app.jd_text,
            analysis: app.requirements
              ? {
                  company: app.company,
                  title: app.title,
                  requirements: JSON.parse(app.requirements),
                }
              : null,
            profile: base?.render.profile ?? this.readProfile(),
            embeddingModel: this.activeEmbeddingModel(),
          },
          this.usableFacts(),
          this.confirmedRoles(),
          this.vectors(),
        );
      },
    );
    await this.dispatchRun(this.runs.get(id)!);
    return { documentId: id, runId: id };
  }

  async documentInput(runId: string): Promise<
    DocumentInput & {
      plan?: DocumentPlan;
      draft?: DocumentDraft;
      result?: DocumentResult;
    }
  > {
    this.requireOpen();
    const run = this.workflowRun(runId, "document", runId);
    if (!["starting", "running", "succeeded"].includes(run.state))
      throw new AppError("conflict", "this run no longer accepts work");
    const row = this.sql
      .exec<{
        options: string;
        plan: string | null;
        draft: string | null;
        result: string | null;
      }>(`SELECT * FROM document_requests WHERE run_id = ?`, runId)
      .toArray()[0];
    const input = this.snapshots.metadata(runId);
    if (!row || !input)
      throw new AppError("not_found", "no such document request");
    return {
      ...JSON.parse(row.options),
      jdText: input.jdText,
      analysis: input.analysis,
      facts: this.snapshots.items<FactRecord>(runId, "fact"),
      roles: this.snapshots.items<RoleRecord>(runId, "role"),
      plan: row.plan ? JSON.parse(row.plan) : undefined,
      draft: row.draft ? JSON.parse(row.draft) : undefined,
      result: row.result ? JSON.parse(row.result) : undefined,
    };
  }

  async cachedRefinement(runId: string): Promise<DocumentDraft | null> {
    const input = await this.documentInput(runId);
    const key = await refinementCacheKey(input, this.env.MODEL_WRITE);
    this.requireOpen();
    const run = this.runs.get(runId);
    if (!key || !run || !["starting", "running"].includes(run.state))
      return null;
    const row = this.sql
      .exec<{ draft: string }>(
        `SELECT draft FROM refine_cache WHERE cache_key = ? AND created_at > ?`,
        key,
        Date.now() - REFINE_CACHE_TTL_MS,
      )
      .toArray()[0];
    if (!row) return null;
    try {
      return cachedRefinementDraft(input, JSON.parse(row.draft));
    } catch {
      return null;
    }
  }

  async saveDocumentStep(
    runId: string,
    step: string,
    patch: {
      plan?: DocumentPlan;
      draft?: DocumentDraft;
      result?: DocumentResult;
    },
  ): Promise<void> {
    this.requireOpen();
    this.workflowRun(runId, "document", runId);
    this.runs.commitStep(runId, step, () => {
      for (const field of ["plan", "draft", "result"] as const)
        if (patch[field] !== undefined)
          this.sql.exec(
            `UPDATE document_requests SET ${field} = ? WHERE run_id = ?`,
            JSON.stringify(patch[field]),
            runId,
          );
    });
  }

  async finishDocument(runId: string, result: DocumentResult): Promise<void> {
    this.requireOpen();
    this.workflowRun(runId, "document", runId);
    const options = JSON.parse(
      this.sql
        .exec<{ options: string }>(
          `SELECT options FROM document_requests WHERE run_id = ?`,
          runId,
        )
        .one().options,
    ) as NewDocument & { base?: ResumeBody };
    if (options.kind === "refine") {
      const verified = this.sql.exec<{ result: string | null }>(
        `SELECT result FROM document_requests WHERE run_id = ?`, runId,
      ).one().result;
      if (!verified || verified !== JSON.stringify(result))
        throw new AppError("conflict", "the verified refinement changed");
    }
    const cachedInput =
      options.kind === "refine" ? await this.documentInput(runId) : null;
    const cacheKey = cachedInput
      ? await refinementCacheKey(cachedInput, this.env.MODEL_WRITE)
      : null;
    this.requireOpen();
    const legacyManual = options.manualText !== undefined && !!options.resumeId &&
      this.resumeVersion(this.resumeRow(options.resumeId)).provenance === "legacy";
    const unchanged =
      options.kind === "refine" &&
      !legacyManual &&
      !!result.body &&
      JSON.stringify(options.base) === JSON.stringify(result.body);
    const completed = this.runs.finish(
      runId,
      () => {
        const input = this.snapshots.metadata(runId)!;
        const roles = this.snapshots.items<RoleRecord>(runId, "role");
        let checkBody: ResumeBody = result.body ?? {
          summary: null,
          skills: [],
          sections: roles
            .filter((r) => result.units.some((u) => u.roleId === r.id))
            .map((r) => ({
              ...r,
              roleId: r.id,
              lines: result.units
                .filter((u) => u.roleId === r.id)
                .map((u) => ({ ...u, status: u.status ?? "kept" })),
            })),
        };
        if (!result.body) {
          const global = result.units.filter((u) => u.roleId === null);
          if (global.length)
            checkBody.summary = {
              id: "global",
              text: "",
              factIds: global.flatMap((u) => u.factIds),
              status: "kept",
            };
        }
        if (legacyManual && result.body) {
          // Other historical lines and headers may still need review. Validate
          // only the checked line now; finalization rechecks the entire body.
          const target = options.lineIds?.[0];
          const summary = result.body.summary?.id === target ? result.body.summary : null;
          const sections = result.body.sections.flatMap((section) => {
            const lines = section.lines.filter((line) => line.id === target);
            return lines.length ? [{ ...section, lines }] : [];
          });
          if (Number(!!summary) + sections.reduce((n, section) => n + section.lines.length, 0) !== 1)
            throw new AppError("conflict", "the checked line changed");
          checkBody = { summary, sections, skills: [] };
        }
        this.snapshots.assertCurrent(runId, checkBody);
        const capturedFacts = this.snapshots.items<FactRecord>(runId, "fact");
        const facts = Object.fromEntries(capturedFacts.map((f) => [f.id, { text: f.text, quote: f.quote }]));
        if (
          options.kind === "refine" &&
          result.body &&
          options.resumeId &&
          !unchanged
        ) {
          const row = this.resumeRow(options.resumeId);
          if (row.version !== options.expectedVersion)
            throw new AppError(
              "conflict",
              "the resume changed while refining; try again",
            );
          const base = this.resumeVersion(row);
          if (legacyManual) {
            // A stored result must still be exactly the requested one-line
            // change. No other legacy content can acquire trust implicitly.
            const expected = structuredClone(base.render.body);
            const all = [
              ...(expected.summary ? [expected.summary] : []),
              ...expected.sections.flatMap((section) => section.lines),
            ];
            const targets = all.filter((line) => line.id === options.lineIds?.[0]);
            if (targets.length !== 1 || !options.manualFactIds?.length || options.manualText === undefined)
              throw new AppError("conflict", "the checked line changed");
            targets[0]!.text = options.manualText;
            targets[0]!.factIds = [...options.manualFactIds];
            targets[0]!.status = "kept";
            if (JSON.stringify(expected) !== JSON.stringify(result.body))
              throw new AppError("conflict", "the checked line changed");
          }
          const savedEvidence = mergeRefinementEvidence(base, result.body, capturedFacts, roles);
          const receipt = legacyManual ? legacyReceipt(result.body, options.lineIds![0]!, capturedFacts, roles) : undefined;
          // Even an identical checked line needs fresh evidence for the owner
          // to inspect; older unverified versions remain untouched.
          if (receipt) for (const fact of receipt.facts) {
            savedEvidence.facts[fact.id] = { text: fact.text, quote: fact.quote };
            savedEvidence.evidence![fact.id] = fact;
          }
          const receipts = receipt
            ? { ...base.legacyReceipts, [options.lineIds![0]!]: receipt }
            : base.legacyReceipts;
          const version = row.version + 1;
          this.snapshots.save(row.id, version, {
            ...base,
            render: { ...base.render, body: result.body, version },
            report: result.report,
            ...savedEvidence,
            legacyReceipts: receipts,
            provenance: options.manualText !== undefined ? base.provenance : "snapshot",
          });
          this.sql.exec(
            `UPDATE resumes SET body = ?, report = ?, version = ? WHERE id = ?`,
            JSON.stringify(result.body),
            JSON.stringify(result.report),
            version,
            row.id,
          );
        }
        if (cacheKey && cachedInput) {
          const verified = this.sql
            .exec<{ result: string | null }>(
              `SELECT result FROM document_requests WHERE run_id = ?`,
              runId,
            )
            .one().result;
          if (!verified || verified !== JSON.stringify(result))
            throw new AppError("conflict", "the verified refinement changed");
          const draft = JSON.stringify(cacheRefinement(cachedInput, result));
          if (new TextEncoder().encode(draft).byteLength <= 65536) {
            this.sql.exec(
              `DELETE FROM refine_cache WHERE created_at <= ?`,
              Date.now() - REFINE_CACHE_TTL_MS,
            );
            this.sql.exec(
              `INSERT INTO refine_cache (cache_key,draft,created_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET draft=excluded.draft,created_at=excluded.created_at`,
              cacheKey,
              draft,
              Date.now(),
            );
            this.sql.exec(
              `DELETE FROM refine_cache WHERE cache_key IN (SELECT cache_key FROM refine_cache ORDER BY created_at DESC, cache_key DESC LIMIT -1 OFFSET 200)`,
            );
          }
        }
        this.sql.exec(
          `INSERT INTO document_versions (document_id, version, data, created_at) VALUES (?, 1, ?, ?)`,
          runId,
          JSON.stringify({ result, facts, profile: input.profile }),
          Date.now(),
        );
        this.sql.exec(
          `UPDATE documents SET state = 'ready', result = ? WHERE id = ?`,
          JSON.stringify(result),
          runId,
        );
      },
      !unchanged,
    );
    if (completed.applied) this.recordRunTotal(runId);
    if (completed.applied && cacheKey) {
      const next = this.sql
        .exec<{ at: number | null }>(
          `SELECT MIN(created_at) + ? AS at FROM refine_cache`,
          REFINE_CACHE_TTL_MS,
        )
        .one().at;
      if (next !== null) await this.scheduleRunAlarm(next);
    }
    this.broadcast("document", runId);
    if (options.resumeId) this.broadcast("resume", options.resumeId);
  }

  async failDocument(runId: string, message: string): Promise<void> {
    this.requireOpen();
    this.ctx.storage.transactionSync(() => {
      const run = this.runs.get(runId);
      if (
        !run ||
        !["refine", "letter", "prep", "questions"].includes(run.kind) ||
        run.targetId !== runId ||
        !["starting", "running"].includes(run.state)
      ) return;
      this.runs.fail(runId, "generation_failed");
      this.sql.exec(
        `UPDATE documents SET state = 'failed', error = ? WHERE id = ? AND state = 'running'`,
        message,
        runId,
      );
    });
  }

  async listDocuments(
    who: Who,
    applicationId: string,
  ): Promise<DocumentView[]> {
    this.requireOwner(who);
    await this.rearmPendingRuns();
    this.requireOwner(who);
    const ids = this.sql
      .exec<{ id: string }>(
        `SELECT id FROM documents WHERE application_id = ? ORDER BY created_at DESC`,
        applicationId,
      )
      .toArray();
    return ids.map(({ id }) => this.documentView(id));
  }

  async getDocument(who: Who, id: string): Promise<DocumentView> {
    this.requireOwner(who);
    await this.rearmPendingRuns();
    this.requireOwner(who);
    return this.documentView(id);
  }

  /** Build a view only after its caller has checked ownership. */
  private documentView(id: string): DocumentView {
    const row = this.sql
      .exec<{
        id: string;
        application_id: string;
        kind: DocumentView["kind"];
        state: DocumentView["state"];
        version: number;
        created_at: number;
        error: string | null;
        result: string | null;
      }>(`SELECT * FROM documents WHERE id = ?`, id)
      .toArray()[0];
    if (!row) throw new AppError("not_found", "no such document");
    const version = this.sql
      .exec<{ data: string }>(
        `SELECT data FROM document_versions WHERE document_id = ? AND version = ?`,
        id,
        row.version,
      )
      .toArray()[0];
    const data = version ? JSON.parse(version.data) : null;
    return {
      id,
      applicationId: row.application_id,
      kind: row.kind,
      state: row.state,
      retryRunId: row.state === "failed" && ["failed", "cancelled"].includes(this.runs.get(row.id)?.state ?? "")
        ? row.id : undefined,
      dispatchUncertain: row.state === "running" && this.dispatchUncertain(row.id),
      cancellationPending: row.state === "running" && this.cancellationPending(row.id),
      version: row.version,
      createdAt: row.created_at,
      error: row.error,
      result: data?.result ?? null,
      facts: data?.facts ?? {},
      ...(row.kind === "questions" ? {
        answeredQuestionIds: this.sql.exec<{ question_id: string }>(
          `SELECT DISTINCT question_id FROM interview_answers WHERE document_id = ? ORDER BY question_id`,
          id,
        ).toArray().map((answer) => answer.question_id),
      } : {}),
    };
  }

  // ---------------------------------------------------------------- export

  async exportAll(who: Who): Promise<VaultExport> {
    return this.exportSnapshot(who);
  }

  /** Capture the rows and original-object keys in one synchronous object turn. */
  exportArchiveSnapshot(who: Who): { data: VaultExport; files: { id: string; filename: string; origin: string; key: string }[] } {
    const data = this.exportSnapshot(who);
    const files = data.sources.map((source) => {
      const row = this.sourceRow(source.id);
      if (!row.r2_key.startsWith(`vaults/${this.vaultId}/sources/`))
        throw new AppError("unavailable", "a source file has an invalid storage key");
      return { id: row.id, filename: row.filename, origin: row.origin, key: row.r2_key };
    });
    return { data, files };
  }

  private exportSnapshot(who: Who): VaultExport {
    this.requireOwner(who);
    return {
      format: 2,
      interviewAnswers: this.sql
        .exec<Record<string, string | number | null>>(
          `SELECT fact_id,document_id,question_id,question,quote,created_at FROM interview_answers`,
        )
        .toArray(),
      generationInputs: this.sql
        .exec<Record<string, string | number | null>>(
          `SELECT * FROM generation_inputs`,
        )
        .toArray(),
      generationItems: this.sql
        .exec<Record<string, string | number | null>>(
          `SELECT run_id,kind,item_id,data FROM generation_input_items`,
        )
        .toArray(),
      documentRequests: this.sql
        .exec<Record<string, string | number | null>>(
          `SELECT * FROM document_requests`,
        )
        .toArray(),
      sourceRevisions: this.sql
        .exec<Record<string, string | number | null>>(
          `SELECT * FROM source_revisions`,
        )
        .toArray(),
      evidence: this.sql
        .exec<Record<string, string | number | null>>(`SELECT * FROM evidence`)
        .toArray(),
      resumeVersions: this.sql
        .exec<{
          resume_id: string;
          version: number;
          data: string;
          created_at: number;
        }>(`SELECT * FROM resume_versions ORDER BY resume_id,version`)
        .toArray()
        .map((r) => ({ ...r, data: JSON.parse(r.data) })),
      documents: this.sql
        .exec<Record<string, string | number | null>>(`SELECT * FROM documents`)
        .toArray(),
      documentVersions: this.sql
        .exec<{
          document_id: string;
          version: number;
          data: string;
          created_at: number;
        }>(`SELECT * FROM document_versions ORDER BY document_id,version`)
        .toArray()
        .map((r) => ({ ...r, data: JSON.parse(r.data) })),
      runs: this.sql
        .exec<Record<string, string | number | null>>(`SELECT * FROM runs`)
        .toArray(),
      providerUsage: this.sql
        .exec<Record<string, string | number | null>>(
          `SELECT * FROM model_attempts`,
        )
        .toArray(),
      quotaPeriods: this.sql
        .exec<Record<string, string | number | null>>(
          `SELECT * FROM quota_buckets`,
        )
        .toArray(),
      shares: this.shares.export(who),
      connectedApps: this.mcpGrants
        .list(who)
        .map(({ oauthGrantId: _remote, ...grant }) => grant),
      billing: this.meta("entitlement")
        ? JSON.parse(this.meta("entitlement")!)
        : null,
      exportedAt: new Date().toISOString(),
      profile: this.readProfile(),
      sources: this.sql
        .exec<SourceRow>(`SELECT * FROM sources ORDER BY created_at`)
        .toArray()
        .map((s) => ({
          id: s.id,
          filename: s.filename,
          state: s.state,
          createdAt: s.created_at,
          markdown: s.markdown,
          origin: s.origin,
          extractor: s.extractor,
          parentSourceId: s.parent_source_id,
          conversionImageCount: s.origin === "ocr" ? s.ocr_image_count : null,
          file: `/api/sources/${s.id}/file`,
        })),
      roles: this.readRoles(),
      facts: this.readFacts(),
      applications: this.sql
        .exec<ApplicationRow>(`SELECT * FROM applications ORDER BY created_at`)
        .toArray()
        .map((a) => ({
          id: a.id,
          company: a.company,
          title: a.title,
          jobDescription: a.jd_text,
          createdAt: a.created_at,
          status: a.status,
          appliedAt: a.applied_at,
          notes: a.notes,
        })),
      resumes: this.sql
        .exec<ResumeRow>(`SELECT * FROM resumes ORDER BY created_at`)
        .toArray()
        .map((r) => ({
          id: r.id,
          applicationId: r.application_id,
          state: r.state,
          createdAt: r.created_at,
          body: parseOrNull<ResumeBody>(r.body),
          report: parseOrNull<ResumeReport>(r.report),
        })),
    };
  }

  private activeEmbeddingModel(): string {
    return this.meta("embedding_model") ?? "@cf/baai/bge-m3";
  }
  async embeddingModel(runId?: string): Promise<string> {
    this.requireOpen();
    const input = runId ? this.snapshots.metadata(runId) : null;
    return input
      ? (input.embeddingModel ?? "@cf/baai/bge-m3")
      : this.activeEmbeddingModel();
  }
  private get reembeddings(): ReembedStore {
    return new ReembedStore(this.sql, (fn) =>
      this.ctx.storage.transactionSync(fn),
    );
  }
  async startReembed(
    model: string,
    dimensions: number,
    requestKey = crypto.randomUUID(),
  ): Promise<{ runId: string }> {
    this.requireOpen();
    if (model !== (this.env.EMBEDDING_MODEL ?? "@cf/baai/bge-m3"))
      throw new AppError(
        "invalid",
        "configure the target embedding model before rebuilding",
      );
    const prior = this.runs.findRequest(`reembed:${requestKey}`);
    if (prior) {
      if (prior.inputDigest !== `${model}:${dimensions}`)
        throw new AppError("conflict", "rebuild request changed");
      return { runId: prior.id };
    }
    const id = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      this.reembeddings.begin(id, model, dimensions);
      this.runs.begin({
        id,
        kind: "reembed",
        targetId: id,
        requestKey: `reembed:${requestKey}`,
        inputDigest: `${model}:${dimensions}`,
        steps: [],
      });
    });
    await this.dispatchRun(this.runs.get(id)!);
    return { runId: id };
  }
  async reembedStatus(id: string) {
    this.requireOpen();
    return this.reembeddings.status(id);
  }
  async reembedBatch(id: string) {
    this.requireOpen();
    this.workflowRun(id, "reembed", id);
    this.runs.claim(id);
    return {
      model: this.reembeddings.status(id).model,
      items: this.reembeddings.nextBatch(id),
    };
  }
  async saveReembedBatch(
    id: string,
    items: { id: string; revision: number; vector: number[] }[],
  ) {
    this.requireOpen();
    this.workflowRun(id, "reembed", id);
    this.runs.claim(id);
    return this.reembeddings.saveBatch(id, items);
  }
  async finishReembed(id: string) {
    this.requireOpen();
    this.workflowRun(id, "reembed", id);
    this.runs.finish(id, () => {
      this.reembeddings.activate(id);
    });
    this.vectorCache = null;
  }
  async failReembed(id: string) {
    this.requireOpen();
    const run = this.runs.get(id);
    if (!run || run.kind !== "reembed" || run.targetId !== id || !["starting", "running"].includes(run.state)) return;
    this.ctx.storage.transactionSync(() => {
      this.reembeddings.cancel(id);
      this.runs.fail(id, "embedding_rebuild_failed");
    });
  }

  private get operations(): VaultOperations {
    if (!this.initialised || this.gone)
      throw new AppError("gone", "this vault is unavailable");
    return new VaultOperations(
      this.sql,
      (fn) => this.ctx.storage.transactionSync(fn),
      {
        vaultId: this.vaultId,
        userId: this.meta("user_id")!,
        schemaVersion: SCHEMA_VERSION,
        requireMaintenanceFence: () => this.requireMaintenanceAccess(),
      },
    );
  }
  async transferManifest(operationId: string) {
    await this.prepareMaintenance();
    return this.operations.beginExport(operationId);
  }
  async transferPage(
    operationId: string,
    table: TransferTable,
    after = 0,
    limit = 50,
  ) {
    return this.operations.exportPage(operationId, table, after, limit);
  }
  async importManifest(manifest: TransferManifest) {
    return this.operations.beginImport(manifest);
  }
  async importPage(page: TransferPage) {
    return this.operations.importPage(page);
  }
  async prepareMaintenance(): Promise<void> {
    this.requireMaintenanceAccess();
    this.requireNoUnsettledDispatches();
    for (const run of this.runs.listPending()) {
      if (run.kind === "embed")
        throw new AppError(
          "conflict",
          "wait for the in-flight fact save to settle before maintenance",
        );
      const binding =
        run.kind === "distill"
          ? this.env.DISTILL
          : run.kind === "tailor"
            ? this.env.TAILOR
            : run.kind === "reembed"
              ? this.env.REEMBED
              : this.env.DOCUMENTS;
      try {
        const instance = await binding.get(run.id);
        this.requireMaintenanceAccess();
        const status = await instance.status();
        this.requireMaintenanceAccess();
        if (!["complete", "terminated", "errored"].includes(status.status)) {
          await instance.terminate();
          this.requireMaintenanceAccess();
        }
        await instance.delete();
      } catch (error) {
        if (!isMissingWorkflowInstance(error, run.id)) throw error;
      }
      this.requireMaintenanceAccess();
      this.runs.requestCancel(run.id);
      this.runs.cancel(run.id);
      if (run.kind === "reembed") {
        try {
          this.reembeddings.cancel(run.id);
        } catch {
          /* Already finished generation. */
        }
      }
    }
    for (const ws of this.ctx.getWebSockets()) ws.close(1008, "Maintenance");
  }
  async controlCheckpoint() {
    this.requireMaintenanceAccess();
    this.requireNoUnsettledDispatches();
    if (this.runs.listPending().length)
      throw new AppError(
        "conflict",
        "work must be stopped before transferring",
      );
    const control = {
      ownerId: this.meta("user_id")!,
      meta: this.sql
        .exec<{ key: string; value: string }>(
          `SELECT key,value FROM meta WHERE key IN ('stripe_customer','billing_customer_requested','billing_customer_requested_at','billing_checkout_sessions','entitlement','entitlement_revision','checkout_intent','quota_month','quota_used') OR key GLOB 'legacy_quota_import:*'`,
        )
        .toArray(),
      quota: this.sql
        .exec<Record<string, string | number | null>>(
          `SELECT * FROM quota_buckets`,
        )
        .toArray(),
      runs: this.sql
        .exec<Record<string, string | number | null>>(`SELECT * FROM runs`)
        .toArray(),
      attempts: this.sql
        .exec<Record<string, string | number | null>>(
          `SELECT * FROM model_attempts`,
        )
        .toArray(),
    };
    if (
      new TextEncoder().encode(JSON.stringify(control)).byteLength >
      8 * 1024 * 1024
    )
      throw new AppError(
        "too_large",
        "control state needs a paginated maintenance export",
      );
    return control;
  }
  async finishImport(operationId: string, sourceVaultId: string) {
    requireMaintenanceFence(sourceVaultId, this.env.RESTORE_FENCE_IDS);
    this.requireMaintenanceAccess();
    const operation = this.sql
      .exec<{ manifest: string }>(
        `SELECT manifest FROM vault_operations WHERE id = ? AND kind = 'import'`,
        operationId,
      )
      .toArray()[0];
    if (
      !operation ||
      JSON.parse(operation.manifest).sourceVaultId !== sourceVaultId
    )
      throw new AppError("conflict", "wrong source vault");
    const existing = this.operations.importStatus(operationId);
    if (existing.state === "ready") return existing;
    // Fix the source inventory before the first await. Once every table is
    // complete, importPage accepts only identical replays and cannot add a
    // source after the copy list has been read.
    if (existing.completedTables !== existing.totalTables)
      throw new AppError("conflict", "the content import is incomplete");
    const source = vaultStub(this.env, sourceVaultId);
    const control = await source.controlCheckpoint();
    this.requireMaintenanceAccess();
    if (control.ownerId !== this.meta("user_id"))
      throw new AppError("forbidden", "wrong account");
    // Only original sources need copying; immutable output caches are regenerated on demand.
    for (const row of this.sql
      .exec<{ r2_key: string }>(`SELECT r2_key FROM sources`)
      .toArray()) {
      const original =
        `vaults/${sourceVaultId}/` +
        row.r2_key.slice(`vaults/${this.vaultId}/`.length);
      const object = await this.env.FILES.get(original);
      try {
        this.requireMaintenanceAccess();
      } catch (error) {
        if (object) await object.body.cancel().catch(() => {});
        throw error;
      }
      if (!object) throw new AppError("conflict", "a source file is missing");
      const bytes = await object.arrayBuffer();
      this.requireMaintenanceAccess();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      this.requireMaintenanceAccess();
      const keyHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(row.r2_key));
      this.requireMaintenanceAccess();
      const current = this.operations.importStatus(operationId);
      if (current.state === "ready") return current;
      const attemptId = crypto.randomUUID();
      const keyDigest = Array.from(new Uint8Array(keyHash), (byte) => byte.toString(16).padStart(2, "0")).join("");
      // No await between the final lifecycle/operation checks and this marker.
      // Every retry has its own marker; a rejected put remains unresolved.
      this.recordR2Dispatch(attemptId, "source", keyDigest);
      await this.env.FILES.put(row.r2_key, bytes, {
        sha256: digest,
        httpMetadata: object.httpMetadata,
        customMetadata: { ...object.customMetadata, resumatic_cache_attempt: attemptId },
      });
      // Only this put's acknowledged response can release its own marker.
      // It remains safe to record the acknowledgement after quiescence.
      this.sql.exec(`DELETE FROM r2_cache_dispatches WHERE attempt_id=?`, attemptId);
      this.requireMaintenanceAccess();
      const check = await this.env.FILES.head(row.r2_key);
      this.requireMaintenanceAccess();
      if (
        !check ||
        check.size !== bytes.byteLength ||
        !check.checksums.sha256 ||
        base64url(check.checksums.sha256) !== base64url(digest)
      )
        throw new AppError(
          "unavailable",
          "a source file did not verify after copying",
        );
    }
    this.requireNoUnsettledDispatches();
    return this.operations.finishImport(
      operationId,
      crypto.randomUUID(),
      () => {
        for (const [table, rows] of [
          ["quota_buckets", control.quota],
          ["runs", control.runs],
          ["model_attempts", control.attempts],
        ] as const) {
          for (const row of rows) {
            const columns = Object.keys(row);
            if (columns.some((c) => !/^[a-z_]+$/.test(c)))
              throw new AppError("invalid", "invalid control column");
            this.sql.exec(
              `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
              ...columns.map((c) => row[c]!),
            );
          }
        }
        for (const { key, value } of control.meta) this.setMeta(key, value);
      },
    );
  }
  async activateImport(operationId: string, ownerId: string): Promise<void> {
    this.requireMaintenanceAccess();
    if (
      this.meta("user_id") !== ownerId ||
      this.operations.importStatus(operationId).state !== "ready"
    )
      throw new AppError("conflict", "replacement is not ready");
    this.setMeta("state", "open");
  }

  // ---------------------------------------------------------------- helpers

  /** Both the external deployment fence and the Vault's live lifecycle must allow maintenance. */
  private requireMaintenanceAccess(): void {
    requireMaintenanceFence(this.vaultId, this.env.RESTORE_FENCE_IDS);
    if (this.gone || !this.initialised || this.closing || this.destroying ||
        !["open", "maintenance"].includes(this.meta("state") ?? "") ||
        this.meta("account_deletion_intent") === "1")
      throw new AppError("gone", "this account is being deleted");
  }

  private requireOpen(): void {
    this.requireNotUnderMaintenance();
    if (this.gone || !this.initialised)
      throw new AppError("gone", "this vault no longer exists");
    if (this.meta("state") !== "open")
      throw new AppError("gone", "this account is being deleted");
  }

  private requireNotUnderMaintenance(): void {
    if (isMaintenanceFenced(this.vaultId, this.env.RESTORE_FENCE_IDS))
      throw new AppError(
        "unavailable",
        "this account is temporarily unavailable during maintenance",
      );
  }

  private requireOwner(who: Who): void {
    this.requireOpen();
    this.requireIdentity(who);
  }

  /** Called only after open-state checks or for an existing deletion intent. */
  private requireIdentity(who: Who): void {
    if (who.userId !== this.meta("user_id"))
      throw new AppError("forbidden", "not this user's vault");
    if ((who.epoch ?? "legacy") !== (this.meta("security_epoch") ?? "legacy"))
      throw new AppError("unauthenticated", "this session is no longer valid");
    if (who.gen !== Number(this.meta("session_gen")))
      throw new AppError("unauthenticated", "this session was signed out");
  }

  private meta(key: string): string | null {
    if (!this.initialised) return null;
    const row = this.sql
      .exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)
      .toArray()[0];
    return row ? row.value : null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private quotaBucket(): QuotaBucket {
    const cfg = billingConfig(this.env);
    const now = Date.now();
    const plan = this.meta("entitlement")
      ? (JSON.parse(this.meta("entitlement")!) as Entitlement)
      : null;
    if (
      plan?.validUntil &&
      plan.validUntil > now &&
      plan.planId !== "free"
    ) {
      const startAt = Number(plan.bucket.split(":").at(-1)) * 1000;
      if (Number.isSafeInteger(startAt) && startAt <= now) return {
        key: plan.bucket,
        startAt,
        endAt: plan.validUntil,
        limit: plan.generationLimit,
      };
    }
    const configured =
      cfg?.free.generationLimit ?? Number(this.env.TAILOR_MONTHLY_LIMIT);
    return freeQuotaBucket(
      Date.now(),
      Number.isSafeInteger(configured) && configured >= 0
        ? configured
        : DEFAULT_TAILOR_LIMIT,
    );
  }

  private quota(): Quota {
    return this.ctx.storage.transactionSync(() => this.quotaInTransaction());
  }

  /** The caller holds a transaction, including when publishing an entitlement. */
  private quotaInTransaction(): Quota {
    this.settleLegacyQuotaImports();
    const month = monthOf(Date.now());
    const bucket = this.quotaBucket();
    const existed = !!this.runs.quota(bucket.key);
    let balance = this.runs.setBucketInTransaction(bucket);
    const legacy =
      bucket.key.startsWith("free:") && this.meta("quota_month") === month
        ? Number(this.meta("quota_used") ?? 0)
        : 0;
    // Existing buckets have no marker showing whether the legacy usage was
    // copied. Adding it again would risk double-charging the user.
    if (!existed && legacy) {
      this.sql.exec(
        `UPDATE quota_buckets SET used = ? WHERE bucket_key = ?`,
        legacy,
        bucket.key,
      );
      balance = this.runs.quota(bucket.key)!;
      // Only a newly created bucket proves which legacy counter was imported.
      // Capture the still-running legacy resumes in this same transaction;
      // current-ledger runs reserve their own credit and must not be included.
      const pending = this.sql.exec<{ id: string }>(
        `SELECT id FROM resumes WHERE state = 'running' AND quota_month = ? AND run_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.id = resumes.run_id)`,
        month,
      ).toArray();
      // Older ledger-backed failure code could decrement the legacy counter
      // even though that newer run never incremented it. Once such history
      // exists, the aggregate alone cannot prove the pending charges remain.
      const hasLedgerHistory = this.sql.exec(
        `SELECT 1 FROM runs WHERE kind = 'tailor' LIMIT 1`,
      ).toArray().length > 0;
      // Inconsistent historical counters cannot establish which run was paid
      // for. Preserve the imported count for manual reconciliation instead.
      if (!hasLedgerHistory && Number.isSafeInteger(legacy) && legacy >= pending.length) {
        for (const row of pending) this.setMeta(`legacy_quota_import:${row.id}`, bucket.key);
      }
    }
    return {
      used: balance.used,
      reserved: balance.reserved,
      limit: balance.limit,
      month,
      periodEnd: balance.endAt,
    };
  }

  /** Refund a marked historical charge once after an observed failed resume. */
  private settleLegacyQuotaImports(): void {
    const imports = this.sql.exec<{ key: string; bucket: string; state: string | null; month: string | null }>(
      `SELECT m.key, m.value AS bucket, r.state, r.quota_month AS month FROM meta m
       LEFT JOIN resumes r ON r.id = substr(m.key, length('legacy_quota_import:') + 1)
       WHERE m.key GLOB 'legacy_quota_import:*'`,
    ).toArray();
    for (const marker of imports) {
      if (!marker.month || marker.bucket !== `free:${marker.month}`) continue;
      if (marker.state === 'ready') {
        this.sql.exec(`DELETE FROM meta WHERE key = ?`, marker.key);
      } else if (marker.state === 'failed') {
        const balance = this.runs.quota(marker.bucket);
        if (!balance || balance.used < 1) continue;
        this.sql.exec(`UPDATE quota_buckets SET used = used - 1 WHERE bucket_key = ?`, marker.bucket);
        this.sql.exec(`DELETE FROM meta WHERE key = ?`, marker.key);
      }
    }
  }

  async setPlan(revision: number, plan: Entitlement): Promise<void> {
    this.requireOpen();
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new AppError("invalid", "invalid entitlement revision");
    if (revision <= Number(this.meta("entitlement_revision") ?? 0)) return;
    this.ctx.storage.transactionSync(() => {
      this.setMeta("entitlement", JSON.stringify(plan));
      this.setMeta("entitlement_revision", String(revision));
      this.quotaInTransaction();
    });
  }

  /** Regenerable output caches are owner-scoped and serialized with Vault closure. */
  async readExportCache(who: Who, key: string): Promise<Uint8Array | null> {
    this.requireOwner(who);
    const entry = new ExportCache(this.sql, (fn) => this.ctx.storage.transactionSync(fn), this.vaultId).read(key);
    if (!entry) return null;
    const digest = base64url(await crypto.subtle.digest("SHA-256", new Uint8Array(entry.bytes).buffer));
    this.requireOwner(who);
    return digest === entry.digest ? entry.bytes : null;
  }

  async putExportCache(who: Who, key: string, input: ArrayBuffer | Uint8Array): Promise<boolean> {
    this.requireOwner(who);
    if (!(input instanceof Uint8Array) && !(input instanceof ArrayBuffer)) throw new AppError("invalid", "invalid export cache bytes");
    if (!input.byteLength || input.byteLength > EXPORT_CACHE_ITEM_BYTES) return false;
    // Isolate the bytes from callers while hashing can yield to closure or sign-out.
    const bytes = new Uint8Array(input instanceof Uint8Array ? input : input.slice(0));
    const digest = base64url(await crypto.subtle.digest("SHA-256", bytes.buffer));
    this.requireOwner(who);
    return new ExportCache(this.sql, (fn) => this.ctx.storage.transactionSync(fn), this.vaultId).put(key, bytes, digest);
  }
  async billingInfo(who: Who) {
    this.requireOwner(who);
    const cfg = billingConfig(this.env);
    const current = this.meta("entitlement");
    return {
      enabled: !!cfg,
      plans:
        cfg?.paid.map(({ id, generationLimit }) => ({ id, generationLimit })) ??
        [],
      current: current ? (JSON.parse(current) as Entitlement) : null,
    };
  }
  private checkoutCoordinator(who: Who): CheckoutCoordinator {
    this.requireOwner(who);
    const cfg = billingConfig(this.env);
    if (!cfg) throw new AppError("unavailable", "billing is not configured");
    return new CheckoutCoordinator(who.userId, stripeClient(cfg), {
      readIntent: () => this.meta("checkout_intent"),
      writeIntent: (value) => this.setMeta("checkout_intent", value),
      clearIntent: () => {
        this.sql.exec(`DELETE FROM meta WHERE key = 'checkout_intent'`);
      },
      customerId: () => this.meta("stripe_customer"),
      markCustomerRequested: () => {
        if (this.meta("billing_customer_requested") !== "1") {
          this.setMeta("billing_customer_requested_at", String(Date.now()));
          this.setMeta("billing_customer_requested", "1");
        }
      },
      requireOwner: () => this.requireOwner(who),
      beginCustomerDispatch: () => this.beginBillingCustomerDispatch(who),
      settleCustomerDispatch: (id) => this.settleBillingCustomerDispatch(id),
      beginCheckoutDispatch: () => this.ctx.storage.transactionSync(() => {
        this.requireOwner(who);
        const count = Number(this.meta("billing_checkout_dispatches") ?? "0");
        if (!Number.isSafeInteger(count) || count < 0 || count >= Number.MAX_SAFE_INTEGER)
          throw new AppError("unavailable", "checkout dispatch state requires operator review");
        this.setMeta("billing_checkout_dispatches", String(count + 1));
      }),
      settleCheckoutDispatch: (sessionId) => this.ctx.storage.transactionSync(() => {
        const count = Number(this.meta("billing_checkout_dispatches") ?? "0");
        if (!Number.isSafeInteger(count) || count < 1)
          throw new AppError("unavailable", "checkout dispatch state requires operator review");
        if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId) || sessionId.length > 255)
          throw new AppError("unavailable", "checkout session requires operator review");
        const sessions = this.billingCheckoutSessionsForDeletion();
        if (!sessions.includes(sessionId)) sessions.push(sessionId);
        if (sessions.length > 2000)
          throw new AppError("unavailable", "checkout history requires operator review");
        this.setMeta("billing_checkout_sessions", JSON.stringify(sessions));
        this.setMeta("billing_checkout_dispatches", String(count - 1));
      }),
    });
  }

  async billingCheckout(
    who: Who,
    planId: string,
    _requestKey: string,
  ): Promise<{ url: string }> {
    this.requireOwner(who);
    const cfg = billingConfig(this.env);
    if (!cfg) throw new AppError("unavailable", "billing is not configured");
    if (!cfg.paid.some((plan) => plan.id === planId))
      throw new AppError("invalid", "unknown plan");
    return this.checkoutCoordinator(who).open(planId);
  }

  async billingCancelCheckout(who: Who): Promise<void> {
    await this.checkoutCoordinator(who).cancel();
  }
  private beginBillingCustomerDispatch(who?: Who): void {
    this.ctx.storage.transactionSync(() => {
      if (who) this.requireOwner(who);
      else if (!this.initialised || this.gone || this.destroying)
        throw new AppError("gone", "account is unavailable");
      const count = Number(this.meta("billing_customer_dispatches") ?? "0");
      if (!Number.isSafeInteger(count) || count < 0 || count >= Number.MAX_SAFE_INTEGER)
        throw new AppError("unavailable", "customer dispatch state requires operator review");
      this.setMeta("billing_customer_dispatches", String(count + 1));
    });
  }

  private settleBillingCustomerDispatch(customerId: string): void {
    this.ctx.storage.transactionSync(() => {
      const count = Number(this.meta("billing_customer_dispatches") ?? "0");
      if (!Number.isSafeInteger(count) || count < 1 || !/^cus_[A-Za-z0-9_]+$/.test(customerId) || customerId.length > 255)
        throw new AppError("unavailable", "customer dispatch state requires operator review");
      const current = this.meta("stripe_customer");
      if (current && current !== customerId)
        throw new AppError("unavailable", "billing customer requires operator review");
      this.setMeta("stripe_customer", customerId);
      this.setMeta("billing_customer_dispatches", String(count - 1));
    });
  }
  billingCheckoutSessionsForDeletion(): string[] {
    if (!this.initialised || this.gone) return [];
    try {
      const sessions: unknown = JSON.parse(this.meta("billing_checkout_sessions") ?? "[]");
      if (!Array.isArray(sessions) || sessions.length > 2000 || sessions.some((id) => typeof id !== "string" || id.length > 255 || !/^cs_[A-Za-z0-9_]+$/.test(id))) throw new Error();
      return sessions;
    } catch {
      throw new AppError("unavailable", "checkout history requires operator review");
    }
  }
  async billingCustomerForDeletion(): Promise<string | null> {
    if (!this.initialised || this.gone) return null;
    const customer = this.meta("stripe_customer");
    if (customer) return customer;
    if (this.meta("billing_customer_requested") !== "1") return null;
    const requestedAt = Number(this.meta("billing_customer_requested_at"));
    if (
      !Number.isFinite(requestedAt) ||
      requestedAt <= 0 ||
      Date.now() - requestedAt >= 23 * 60 * 60 * 1000
    )
      throw new AppError(
        "unavailable",
        "billing customer confirmation requires operator reconciliation",
      );
    const cfg = billingConfig({ ...this.env, BILLING_ENABLED: "true" });
    if (!cfg)
      throw new AppError("unavailable", "billing cleanup is not configured");
    this.beginBillingCustomerDispatch();
    const created = await stripeClient(cfg).createCustomer(
      this.meta("user_id")!,
      `customer:${this.meta("user_id")}`,
    );
    this.settleBillingCustomerDispatch(created.id);
    return created.id;
  }
  async recoverBillingCustomer(customerId: string): Promise<void> {
    if (!this.initialised || this.gone)
      throw new AppError("gone", "account is unavailable");
    const userId = this.meta("user_id")!;
    const existing = this.meta("stripe_customer");
    if (existing && existing !== customerId)
      throw new AppError(
        "conflict",
        "a different billing customer is already recorded",
      );
    const cfg = billingConfig({ ...this.env, BILLING_ENABLED: "true" });
    if (!cfg)
      throw new AppError("unavailable", "billing cleanup is not configured");
    const customer = await stripeClient(cfg).customer(customerId);
    if (customer.id !== customerId || customer.metadata.account_uid !== userId)
      throw new AppError(
        "forbidden",
        "billing customer does not belong to this account",
      );
    if (!this.initialised || this.gone || this.meta("user_id") !== userId)
      throw new AppError("gone", "account is unavailable");
    const current = this.meta("stripe_customer");
    if (current && current !== customerId)
      throw new AppError(
        "conflict",
        "a different billing customer is already recorded",
      );
    this.setMeta("stripe_customer", customerId);
  }
  async billingPortal(who: Who, key: string) {
    this.requireOwner(who);
    const cfg = billingConfig(this.env);
    const customer = this.meta("stripe_customer");
    if (!cfg || !customer)
      throw new AppError("unavailable", "no billing account is available");
    const result = await stripeClient(cfg).portal(
      customer,
      `portal:${who.userId}:${key}`,
    );
    this.requireOwner(who);
    return { url: result.url };
  }

  private resumeVersion(row: ResumeRow, version = row.version): ResumeVersion {
    const saved = this.snapshots.read(row.id, version);
    if (saved) return saved;
    if (version !== row.version || !row.body)
      throw new AppError("not_found", "no such document version");
    const app = this.sql
      .exec<ApplicationRow>(
        `SELECT * FROM applications WHERE id = ?`,
        row.application_id,
      )
      .toArray()[0];
    const legacy: ResumeVersion = {
      render: {
        profile: this.readProfile(),
        body: JSON.parse(row.body),
        version,
        company: app?.company ?? null,
        title: app?.title ?? null,
      },
      report: parseOrNull<ResumeReport>(row.report),
      facts: {},
      provenance: "legacy",
    };
    this.snapshots.save(row.id, version, legacy);
    return legacy;
  }

  /** Set once before the synthetic staging account makes any model calls. */
  async freezeModelBudget(
    who: Who,
    maxCostMicros: number,
    maxCalls: number,
  ): Promise<void> {
    this.requireOwner(who);
    if (
      !this.env.TEST_SIGNIN_KEY ||
      this.env.ALLOW_TEST_SIGNIN !== "true" ||
      !Number.isSafeInteger(maxCostMicros) ||
      maxCostMicros < 1 ||
      !Number.isSafeInteger(maxCalls) ||
      maxCalls < 1
    )
      throw new AppError("invalid", "invalid test model budget");
    this.ctx.storage.transactionSync(() => {
      const encoded = JSON.stringify({ maxCostMicros, maxCalls });
      const existing = this.meta("test_model_budget");
      if (existing) {
        if (existing !== encoded)
          throw new AppError(
            "conflict",
            "the test model budget is already fixed",
          );
        return;
      }
      if (
        this.sql.exec(`SELECT id FROM model_attempts LIMIT 1`).toArray().length
      )
        throw new AppError("conflict", "model calls already started");
      this.setMeta("test_model_budget", encoded);
    });
  }

  async reserveModelAttempt(
    runId: string,
    step: string,
    attempt: import("../ai/usage").ModelAttempt,
    maxCostMicros: number,
    dailyCapMicros: number,
  ): Promise<void> {
    this.requireOpen();
    this.runs.reserveAttempt(
      {
        id: attempt.attemptId,
        runId,
        step,
        attempt: 1,
        model: attempt.model,
        maxCostMicros,
      },
      dailyCapMicros,
      this.meta("test_model_budget")
        ? JSON.parse(this.meta("test_model_budget")!)
        : undefined,
    );
  }
  async settleModelAttempt(
    id: string,
    costMicros: number | null,
    inputTokens: number | null,
    outputTokens: number | null,
  ): Promise<void> {
    this.requireOpen();
    if (costMicros === null) this.runs.markAttemptUnknown(id);
    else
      this.runs.settleAttempt(
        id,
        costMicros,
        inputTokens !== null && outputTokens !== null
          ? { inputTokens, outputTokens }
          : undefined,
      );
  }

  private workflowRun(
    runId: string,
    kind: "distill" | "tailor" | "document" | "reembed",
    targetId: string,
  ): RunRecord {
    const run = this.runs.get(runId);
    if (!run) throw new AppError("not_found", "no such run");
    const kinds = kind === "document" ? ["refine", "letter", "prep", "questions"] : [kind];
    if (!kinds.includes(run.kind) || run.targetId !== targetId)
      throw new AppError("conflict", "run does not match this workflow");
    return run;
  }

  async claimRun(
    runId: string,
    expected: { kind: "distill" | "tailor" | "document"; targetId: string },
  ): Promise<void> {
    this.requireOpen();
    if (!expected || !["distill", "tailor", "document"].includes(expected.kind))
      throw new AppError("invalid", "workflow identity is required");
    this.workflowRun(runId, expected.kind, expected.targetId);
    this.runs.claim(runId);
  }

  async deletionProbe(): Promise<{ rows: number }> {
    // An uninitialized or partially destroyed object can still contain rows.
    // Inspect SQLite itself rather than inferring erasure from lifecycle flags.
    const tables = this.applicationTables();
    let rows = 0;
    for (const { name } of tables) {
      // Identifiers come from SQLite, but must still be quoted and escaped.
      // Skipping an unfamiliar table would make the audit report a false zero.
      const identifier = name.replaceAll('"', '""');
      rows += this.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "${identifier}"`)
        .one().n;
    }
    return { rows };
  }

  private applicationTables(): { name: string }[] {
    return this.sql
      .exec<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,7) <> 'sqlite_'`,
      )
      .toArray();
  }

  /** An absent lifecycle schema is not evidence that no Workflow was created. */
  private requireNoUnidentifiedTables(): void {
    if (this.applicationTables().length)
      throw new AppError("unavailable", "vault schema is incomplete; operator review is required");
  }
  async adminRuns() {
    this.requireOpen();
    await this.rearmPendingRuns();
    this.requireOpen();
    return this.runs.list();
  }

  /** Metadata-only diagnostics, not proof that earlier writers are quiescent. */
  cacheWriteFences(): { status: "available"; total: number; attempts: { id: string; kind: string; createdAt: number; keyDigest: string | null }[] } | { status: "unavailable" } {
    if (!this.initialised || this.gone || !hasSchema(this.sql)) return { status: "unavailable" };
    const total = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM r2_cache_dispatches`).one().n;
    const attempts = this.sql.exec<{ attempt_id: string; kind: string; created_at: number; key_digest: string | null }>(
      `SELECT attempt_id,kind,created_at,key_digest FROM r2_cache_dispatches ORDER BY created_at,attempt_id LIMIT 100`,
    ).toArray().map((row) => ({ id: row.attempt_id, kind: row.kind, createdAt: row.created_at, keyDigest: row.key_digest }));
    return { status: "available", total, attempts };
  }

  async retryRun(
    who: Who,
    id: string,
    key: string,
  ): Promise<{ runId: string; targetId: string }> {
    this.requireOwner(who);
    const run = this.runs.get(id);
    if (!run || !["failed", "cancelled"].includes(run.state))
      throw new AppError("conflict", "only stopped work can be retried");
    if (run.kind === "tailor") {
      const result = await this.tailor(
        who,
        this.resumeRow(run.targetId).application_id,
        key,
      );
      return { runId: result.runId, targetId: result.resumeId };
    }
    if (["refine", "letter", "prep", "questions"].includes(run.kind)) {
      const row = this.sql
        .exec<{ application_id: string; options: string }>(
          `SELECT application_id,options FROM document_requests WHERE run_id=?`,
          id,
        )
        .one();
      const options = JSON.parse(row.options) as NewDocument;
      const result = await this.startDocument(
        who,
        row.application_id,
        {
          kind: options.kind,
          instruction: options.instruction,
          resumeId: options.resumeId,
          expectedVersion: options.expectedVersion,
          lineIds: options.lineIds,
          manualText: options.manualText,
          manualFactIds: options.manualFactIds,
        },
        key,
      );
      return { runId: result.runId, targetId: result.documentId };
    }
    if (run.kind !== "distill")
      throw new AppError(
        "invalid",
        "start a new maintenance operation instead",
      );
    const requestKey = `retry:${id}:${key}`;
    const prior = this.runs.findRequest(requestKey);
    if (prior) return { runId: prior.id, targetId: prior.targetId };
    const source = this.sourceRow(run.targetId);
    if (source.run_id !== id)
      throw new AppError("conflict", "this source already has a newer run");
    if (
      this.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM sources WHERE state='queued'`,
        )
        .one().n >= MAX_QUEUED_SOURCES
    )
      throw new AppError("conflict", "wait for other uploads to finish");
    const next = crypto.randomUUID();
    this.runs.begin(
      {
        id: next,
        kind: "distill",
        targetId: source.id,
        requestKey,
        inputDigest: id,
        steps: ["convert", "extract", "embed"],
      },
      () => {
        this.sql.exec(
          `UPDATE sources SET state='queued',error=NULL,run_id=? WHERE id=?`,
          next,
          source.id,
        );
      },
    );
    await this.dispatchRun(this.runs.get(next)!);
    return { runId: next, targetId: source.id };
  }
  async adminRetry(id: string, key: string) {
    this.requireOpen();
    return this.retryRun(
      {
        userId: this.meta("user_id")!,
        gen: Number(this.meta("session_gen")),
        epoch: this.meta("security_epoch") ?? "legacy",
      },
      id,
      key,
    );
  }

  async listRuns(who: Who) {
    this.requireOwner(who);
    await this.rearmPendingRuns();
    this.requireOwner(who);
    return this.runs.list();
  }

  async runInfo(who: Who, runId: string) {
    this.requireOwner(who);
    await this.rearmPendingRuns();
    this.requireOwner(who);
    const run = this.runs.get(runId);
    if (!run) throw new AppError("not_found", "no such run");
    return run;
  }

  private async dispatchRun(run: RunRecord): Promise<void> {
    // The marker is durable before external I/O. Once closing starts, no new
    // create may begin, even if an alarm resumed after an unrelated await.
    if (this.closing || this.gone || !this.initialised || this.meta("state") !== "open") return;
    if (isMaintenanceFenced(this.vaultId, this.env.RESTORE_FENCE_IDS)) return;
    if (this.hasUnsettledDispatch(run.id)) return;
    this.sql.exec(`INSERT INTO workflow_dispatches (run_id) VALUES (?)`, run.id);
    let createIssued = false;
    try {
      // Arrange recovery before outbound I/O: eviction while create is pending
      // must not leave a starting run without an alarm.
      await this.scheduleRunAlarm(Date.now() + 60_000);
      const current = this.redispatchableRun(run.id);
      if (!current) {
        // This invocation never issued create. A concurrent recovery may have
        // installed a separate sticky fence, which must never be removed.
        this.sql.exec(`DELETE FROM workflow_dispatches WHERE run_id = ?`, run.id);
        return;
      }
      createIssued = true;
      await this.createWorkflow(current);
      // A successful acknowledgement rules out this particular create arriving
      // after deletion's inventory. Errors remain uncertain and fail closed.
      this.sql.exec(
        `DELETE FROM workflow_dispatches WHERE run_id = ? AND NOT EXISTS (SELECT 1 FROM workflow_redispatches WHERE run_id = ?)`,
        run.id,
        run.id,
      );
    } catch {
      if (createIssued) this.runs.noteUncertain(run.id, "dispatch_uncertain");
      else this.failBeforeDispatch(run.id);
    }
  }

  /** Alarm setup failed before create was issued; a concurrent retry stays fenced. */
  private failBeforeDispatch(id: string): void {
    this.ctx.storage.transactionSync(() => {
      const run = this.runs.get(id);
      const sticky = this.sql.exec(
        `SELECT run_id FROM workflow_redispatches WHERE run_id = ?`, id,
      ).toArray().length > 0;
      if (sticky) {
        if (run) this.runs.noteUncertain(id, "dispatch_uncertain");
        return;
      }
      // A missing or non-starting ledger may reflect another execution or a
      // damaged inventory. This invocation sent no request, but cannot settle
      // a potentially independent one; preserve a durable fence.
      if (!run || !["starting", "cancel_requested"].includes(run.state)) {
        this.sql.exec(
          `INSERT OR IGNORE INTO workflow_redispatches (run_id, attempts, next_at) VALUES (?, 0, 0)`, id,
        );
        if (run) this.runs.noteUncertain(id, "dispatch_uncertain");
        return;
      }
      this.sql.exec(`DELETE FROM workflow_dispatches WHERE run_id = ?`, id);
      if (run.state === "cancel_requested") {
        this.finishCancelledRun(run);
        return;
      }
      if (run.state !== "starting") return;
      this.runs.fail(id, "dispatch_not_started");
      const message = "Could not start this request. Please try again.";
      if (run.kind === "distill")
        this.sql.exec(`UPDATE sources SET state='failed', error=? WHERE id=? AND run_id=? AND state='queued'`, message, run.targetId, id);
      else if (run.kind === "tailor")
        this.sql.exec(`UPDATE resumes SET state='failed', error=? WHERE id=? AND run_id=? AND state='running'`, message, run.targetId, id);
      else if (["refine", "letter", "prep", "questions"].includes(run.kind))
        this.sql.exec(`UPDATE documents SET state='failed', error=? WHERE id=? AND state='running'`, message, run.targetId);
      else if (run.kind === "reembed") this.reembeddings.cancel(id);
    });
    this.broadcast("run", id);
  }

  private async createWorkflow(run: RunRecord): Promise<void> {
    if (run.kind === "tailor")
      await this.env.TAILOR.create({ id: run.id, params: { vaultId: this.vaultId, resumeId: run.targetId } });
    else if (run.kind === "reembed")
      await this.env.REEMBED.create({ id: run.id, params: { vaultId: this.vaultId, runId: run.id } });
    else if (run.kind === "distill")
      await this.env.DISTILL.create({ id: run.id, params: { vaultId: this.vaultId, sourceId: run.targetId } });
    else if (["refine", "letter", "prep", "questions"].includes(run.kind))
      await this.env.DOCUMENTS.create({ id: run.id, params: { vaultId: this.vaultId, runId: run.id } });
    else throw new AppError("invalid", "unsupported workflow run");
  }

  private async scheduleRunAlarm(at: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (this.closing || this.gone || !this.initialised || this.meta("state") !== "open") return;
    if (existing === null || existing > at) {
      await this.ctx.storage.setAlarm(at);
      // A close can begin while setAlarm is in flight. An alarm is not useful
      // after closing and must not survive a completed destroy.
      if (this.closing || this.gone || !this.initialised || this.meta("state") !== "open") {
        if (!this.gone && !this.destroying && this.initialised && this.meta("account_deletion_intent") === "1")
          await this.scheduleDeletionAlarm(Date.now() + 60_000);
        else
          await this.ctx.storage.deleteAlarm();
      }
    }
  }

  /** Preserve an earlier alarm and never reinstall one after destruction. */
  private async scheduleDeletionAlarm(at: number): Promise<void> {
    if (this.gone || this.destroying || !this.initialised || this.meta("account_deletion_intent") !== "1") return;
    const current = await this.ctx.storage.getAlarm();
    if (this.gone || this.destroying || !this.initialised || this.meta("account_deletion_intent") !== "1") return;
    if (current === null || current > at) {
      await this.ctx.storage.setAlarm(at);
      if (this.gone || this.destroying || !this.initialised || this.meta("account_deletion_intent") !== "1")
        await this.ctx.storage.deleteAlarm();
    }
  }

  /** Re-read after every await; a stale alarm must not start new work. */
  private redispatchableRun(id: string): RunRecord | null {
    if (this.closing || this.gone || !this.initialised || this.meta("state") !== "open") return null;
    if (isMaintenanceFenced(this.vaultId, this.env.RESTORE_FENCE_IDS)) return null;
    const run = this.runs.get(id);
    if (!run || run.state !== "starting") return null;
    if (run.kind === "distill") {
      if (!this.sql.exec(`SELECT id FROM sources WHERE id = ? AND run_id = ? AND state = 'queued'`, run.targetId, id).toArray().length) return null;
    } else if (run.kind === "tailor") {
      if (!this.sql.exec(`SELECT id FROM resumes WHERE id = ? AND run_id = ? AND state = 'running'`, run.targetId, id).toArray().length) return null;
    } else if (["refine", "letter", "prep", "questions"].includes(run.kind)) {
      if (run.targetId !== id || !this.sql.exec(`SELECT id FROM documents WHERE id = ? AND state = 'running'`, id).toArray().length) return null;
    } else if (run.kind === "reembed") {
      if (run.targetId !== id || !this.sql.exec(`SELECT id FROM embedding_jobs WHERE id = ? AND state = 'building'`, id).toArray().length) return null;
    } else return null;
    return run;
  }

  /** Bounded liveness recovery. The sticky fence survives every outcome. */
  private async redispatchUncertain(id: string): Promise<void> {
    if (!this.hasUnsettledDispatch(id) || !this.redispatchableRun(id)) return;
    let row = this.sql.exec<{ attempts: number; next_at: number }>(
      `SELECT attempts, next_at FROM workflow_redispatches WHERE run_id = ?`, id,
    ).toArray()[0];
    if (row && (row.attempts >= REDISPATCH_DELAYS_MS.length || row.next_at > Date.now())) return;
    // Install the permanent fence before yielding; an older create ACK may
    // concurrently delete workflow_dispatches, but cannot delete this row.
    this.sql.exec(`INSERT OR IGNORE INTO workflow_redispatches (run_id, attempts, next_at) VALUES (?, 0, 0)`, id);
    await this.scheduleRunAlarm(Date.now() + 60_000);
    const current = this.redispatchableRun(id);
    if (!current) return;
    row = this.sql.exec<{ attempts: number; next_at: number }>(
      `SELECT attempts, next_at FROM workflow_redispatches WHERE run_id = ?`, id,
    ).toArray()[0];
    if (!row || row.attempts >= REDISPATCH_DELAYS_MS.length || row.next_at > Date.now()) return;
    const delay = REDISPATCH_DELAYS_MS[row.attempts]!;
    this.sql.exec(`UPDATE workflow_redispatches SET attempts = attempts + 1, next_at = ? WHERE run_id = ?`, Date.now() + delay, id);
    try {
      // No await between the final lifecycle check and the external create.
      await this.createWorkflow(current);
    } catch {
      // A duplicate, transport error, or unknown response cannot settle any
      // earlier create. Poll the instance; do not remove the sticky fence.
    }
  }

  private requireNoUnsettledDispatches(): void {
    if (this.sql.exec(`SELECT attempt_id FROM r2_cache_dispatches WHERE kind = 'source' LIMIT 1`).toArray().length)
      throw new AppError("unavailable", "source write is unresolved; operator review is required");
    if (this.sql.exec(`SELECT attempt_id FROM r2_cache_dispatches LIMIT 1`).toArray().length)
      throw new AppError("unavailable", "export cache write is unresolved; operator review is required");
    if (this.sql.exec(`SELECT run_id FROM workflow_dispatches UNION ALL SELECT run_id FROM workflow_redispatches LIMIT 1`).toArray().length)
      throw new AppError("unavailable", "workflow creation is unresolved; retry after it is settled");
    const customerDispatches = Number(this.meta("billing_customer_dispatches") ?? "0");
    if (!Number.isSafeInteger(customerDispatches) || customerDispatches !== 0)
      throw new AppError("unavailable", "customer creation is unresolved; operator review may be required");
    const checkoutDispatches = Number(this.meta("billing_checkout_dispatches") ?? "0");
    if (!Number.isSafeInteger(checkoutDispatches) || checkoutDispatches !== 0)
      throw new AppError("unavailable", "checkout creation is unresolved; operator review may be required");
  }

  private hasUnsettledDispatch(runId: string | null): boolean {
    return Boolean(
      runId &&
        this.sql
          .exec(`SELECT run_id FROM workflow_dispatches WHERE run_id = ? UNION ALL SELECT run_id FROM workflow_redispatches WHERE run_id = ? LIMIT 1`, runId, runId)
          .toArray().length,
    );
  }

  private dispatchUncertain(runId: string | null): boolean {
    const run = runId ? this.runs.get(runId) : null;
    return Boolean(
      run?.state === "starting" &&
        this.hasUnsettledDispatch(runId) &&
        (run.errorCode === "dispatch_uncertain" ||
          run.errorCode === "status_uncertain" ||
          Date.now() - run.updatedAt >= 30_000),
    );
  }

  private cancellationPending(runId: string | null): boolean {
    return Boolean(runId && this.runs.get(runId)?.state === "cancel_requested");
  }

  /** A status poll can recover a missing alarm for an active run. */
  private async rearmPendingRuns(): Promise<void> {
    if (
      !this.sql.exec(`SELECT id FROM runs WHERE state IN ('starting', 'running', 'cancel_requested') LIMIT 1`).toArray().length
    ) return;
    try {
      // Keep any earlier alarm; a later authenticated poll retries if storage is
      // unavailable. This schedules reconciliation, never settles a run or
      // clears a possibly in-flight Workflow dispatch.
      await this.scheduleRunAlarm(Date.now() + 60_000);
    } catch {
      // Status remains readable and a future poll can attempt to rearm again.
    }
  }

  async alarm(): Promise<void> {
    if (!this.initialised || this.gone) return;
    if (this.meta("account_deletion_intent") === "1") {
      // An RPC can remain unresolved indefinitely. Install the next attempt
      // before leaving the Vault so interruption cannot consume the only alarm.
      await this.scheduleDeletionAlarm(Date.now() + 60_000);
      try {
        const userId = this.meta("user_id");
        if (!userId) throw new Error("deletion_owner_missing");
        await directoryForUser(this.env, userId).deleteAccount(userId, this.vaultId);
        // Directory has acknowledged its own durable deletion alarm. A crash
        // before this cleanup causes only an idempotent extra retry.
        if (!this.gone && !this.destroying && this.initialised && this.meta("account_deletion_intent") === "1")
          await this.ctx.storage.deleteAlarm();
      } catch {
        // Directory may have committed despite a lost reply. A durable retry
        // is safe and must not recreate an alarm after the vault is destroyed.
        await this.scheduleDeletionAlarm(Date.now() + 60_000);
      }
      return;
    }
    if (this.meta("state") !== "open") return;
    const canContinue = () => !this.closing && !this.gone && this.initialised && this.meta("state") === "open";
    // A failed or stalled external operation must not consume the only alarm
    // that could retry queued work. A harmless final alarm may run once after
    // that work completes; it does not rearm when nothing remains.
    const uploadsToClean = this.uploads.cleanupCandidates();
    if (uploadsToClean.length || this.runs.listPending().length) {
      await this.scheduleRunAlarm(Date.now() + 60_000);
      if (!canContinue()) return;
    }
    this.shares.purgeExpired();
    this.mcpGrants.purgeExpired();
    this.sql.exec(
      `DELETE FROM refine_cache WHERE created_at <= ?`,
      Date.now() - REFINE_CACHE_TTL_MS,
    );
    for (const intent of uploadsToClean) {
      // Expiry prevents another authorization for this reservation. New
      // attempts have an atomic server-generated reservation link; old or
      // unlinked attempts cannot be attributed and conservatively block all
      // cleanup. Never use the diagnostic key digest as proof of attribution.
      if (this.sql.exec(
        `SELECT d.attempt_id FROM r2_cache_dispatches d
         LEFT JOIN source_write_links l ON l.attempt_id = d.attempt_id
         WHERE d.kind = 'source' AND (l.attempt_id IS NULL OR l.source_id = ?) LIMIT 1`,
        intent.sourceId,
      ).toArray().length) continue;
      try {
        await this.env.FILES.delete(intent.r2Key);
        if (!canContinue()) return;
        this.uploads.markCleaned(intent.requestKey, intent.r2Key);
      } catch {
        if (!canContinue()) return;
        // Leave the reservation eligible for the already-scheduled retry and
        // continue processing other uploads and Workflow runs.
        console.error("upload cleanup pending", { code: "upload_cleanup_pending" });
      }
    }
    for (const run of this.runs.listPending()) {
      if (!canContinue()) return;
      if (run.kind === "embed") {
        if (Date.now() - run.createdAt > 600_000)
          this.runs.fail(run.id, "embedding_interrupted");
        continue;
      }
      const binding =
        run.kind === "tailor"
          ? this.env.TAILOR
          : run.kind === "distill"
            ? this.env.DISTILL
            : run.kind === "reembed"
              ? this.env.REEMBED
              : this.env.DOCUMENTS;
      if (!binding) continue;
      try {
        const instance = await binding.get(run.id);
        if (!canContinue()) return;
        const { status } = await instance.status();
        if (!canContinue()) return;
        if (run.state === "cancel_requested") {
          if (!["complete", "errored", "terminated"].includes(status))
            await instance.terminate();
          if (!canContinue()) return;
          if (!this.hasUnsettledDispatch(run.id))
            this.finishCancelledRun(run);
        } else if (["complete", "errored", "terminated"].includes(status)) {
          if (run.kind === "tailor")
            this.markResumeFailed(
              run.targetId,
              "Generation stopped. Try again.",
            );
          else if (run.kind === "reembed") await this.failReembed(run.id);
          else if (run.kind !== "distill")
            await this.failDocument(run.id, "Generation stopped. Try again.");
          else {
            // Cancellation or a newer attempt may arrive while status() is in
            // flight. Check the current ledger and source together before
            // publishing failure from the stale alarm snapshot.
            this.ctx.storage.transactionSync(() => {
              const current = this.runs.get(run.id);
              if (!current || current.kind !== "distill" || current.targetId !== run.targetId || !["starting", "running"].includes(current.state)) return;
              this.runs.fail(run.id, "execution_failed");
              this.sql.exec(
                `UPDATE sources SET state = 'failed', error = 'Reading stopped. Try again.' WHERE id = ? AND run_id = ? AND state = 'queued'`,
                run.targetId,
                run.id,
              );
            });
          }
        }
      } catch (error) {
        if (!canContinue()) return;
        // The platform's explicit not-found result is the only safe reason to create again.
        if (isMissingWorkflowInstance(error, run.id) && run.state === "starting") {
          // The run may have been cancelled while get()/status() was pending.
          if (this.runs.get(run.id)?.state !== "starting") continue;
          if (this.hasUnsettledDispatch(run.id)) {
            this.runs.noteUncertain(run.id, "dispatch_uncertain");
            await this.redispatchUncertain(run.id);
          } else if (this.redispatchableRun(run.id)) {
            // A prior acknowledged create may not yet be visible. A missing
            // instance is not proof that another create is a first attempt.
            // Install both fences before retrying so neither this nor a late
            // older acknowledgement can release deletion or maintenance.
            this.ctx.storage.transactionSync(() => {
              this.sql.exec(`INSERT OR IGNORE INTO workflow_dispatches (run_id) VALUES (?)`, run.id);
              this.sql.exec(`INSERT OR IGNORE INTO workflow_redispatches (run_id, attempts, next_at) VALUES (?, 0, 0)`, run.id);
            });
            this.runs.noteUncertain(run.id, "dispatch_uncertain");
            await this.redispatchUncertain(run.id);
          }
        } else if (isMissingWorkflowInstance(error, run.id) && run.state === "cancel_requested" && !this.hasUnsettledDispatch(run.id))
          this.finishCancelledRun(run);
        else if (!this.dispatchUncertain(run.id))
          this.runs.noteUncertain(run.id, "status_uncertain");
      }
    }
    if (this.closing || this.gone || !this.initialised || this.meta("state") !== "open") return;
    const expiry = this.sql
      .exec<{ at: number | null }>(
        `SELECT MIN(expires_at) AS at FROM share_grants`,
      )
      .one().at;
    const candidates = [
      this.runs.listPending().length ? Date.now() + 60_000 : null,
      expiry,
      // An unresolved source write blocks expiry cleanup. Do not turn its
      // immediate retry into a one-second alarm loop; the retry already
      // installed at the top of this alarm remains scheduled.
      this.uploads.nextAlarm({ skipExpired: this.sql.exec(`SELECT attempt_id FROM r2_cache_dispatches WHERE kind = 'source' LIMIT 1`).toArray().length > 0 }),
      this.sql
        .exec<{ at: number | null }>(
          `SELECT MIN(created_at) + ? AS at FROM refine_cache`,
          REFINE_CACHE_TTL_MS,
        )
        .one().at,
    ].filter((n): n is number => n !== null);
    if (candidates.length)
      await this.scheduleRunAlarm(Math.max(Date.now() + 1000, Math.min(...candidates)));
  }

  private finishCancelledRun(run: RunRecord): void {
    this.ctx.storage.transactionSync(() => {
      // The alarm may have awaited a status response while another alarm
      // finalized cancellation and started a newer attempt for the target.
      const current = this.runs.get(run.id);
      if (!current || current.state !== "cancel_requested" || current.kind !== run.kind || current.targetId !== run.targetId) return;
      this.runs.cancel(current.id);
      if (current.kind === "reembed") {
        this.reembeddings.cancel(current.id);
        return;
      }
      if (current.kind === "distill")
        this.sql.exec(`UPDATE sources SET state='failed', error='Cancelled.' WHERE id=? AND run_id=? AND state='queued'`, current.targetId, current.id);
      else if (current.kind === "tailor")
        this.sql.exec(`UPDATE resumes SET state='failed', error='Cancelled.' WHERE id=? AND run_id=? AND state='running'`, current.targetId, current.id);
      else
        this.sql.exec(`UPDATE documents SET state='failed', error='Cancelled.' WHERE id=? AND state='running'`, current.targetId);
    });
  }

  async cancelRun(who: Who, id: string): Promise<void> {
    this.requireOwner(who);
    this.runs.requestCancel(id);
    await this.scheduleRunAlarm(Date.now());
    this.broadcast("run", id);
  }

  async cancelResume(who: Who, resumeId: string): Promise<void> {
    this.requireOwner(who);
    const resume = this.resumeRow(resumeId);
    if (resume.state !== "running" || !resume.run_id)
      throw new AppError("conflict", "this resume is no longer being prepared");
    // Resolve the current run from the resume rather than assuming the IDs match.
    this.workflowRun(resume.run_id, "tailor", resumeId);
    await this.cancelRun(who, resume.run_id);
  }

  async cancelSource(who: Who, sourceId: string): Promise<void> {
    this.requireOwner(who);
    const source = this.sourceRow(sourceId);
    if (source.state !== "queued" || !source.run_id)
      throw new AppError("conflict", "this source is no longer being read");
    // A retry can use a different run ID; only cancel the current reading run.
    this.workflowRun(source.run_id, "distill", sourceId);
    await this.cancelRun(who, source.run_id);
  }

  private readProfile(): Profile {
    const row = this.sql
      .exec<{
        revision: number;
        name: string;
        email: string;
        phone: string;
        location: string;
        links: string;
      }>(
        `SELECT revision, name, email, phone, location, links FROM profile WHERE id = 1`,
      )
      .toArray()[0];
    if (!row)
      return { name: "", email: "", phone: "", location: "", links: [] };
    return {
      revision: row.revision,
      name: row.name,
      email: row.email,
      phone: row.phone,
      location: row.location,
      links: JSON.parse(row.links) as string[],
    };
  }

  private sourceRow(id: string): SourceRow {
    const row = this.sql
      .exec<SourceRow>(`SELECT * FROM sources WHERE id = ?`, id)
      .toArray()[0];
    if (!row) throw new AppError("not_found", "no such source");
    return row;
  }

  private resumeRow(id: string): ResumeRow {
    const row = this.sql
      .exec<ResumeRow>(`SELECT * FROM resumes WHERE id = ?`, id)
      .toArray()[0];
    if (!row) throw new AppError("not_found", "no such resume");
    return row;
  }

  /** A fact without a vector could never be selected, so a failed embedding fails the edit. */
  private async embedOne(text: string): Promise<number[]> {
    const embeddingModel = this.activeEmbeddingModel();
    const id = crypto.randomUUID();
    this.runs.begin({
      id,
      kind: "embed",
      targetId: id,
      requestKey: `embed:${id}`,
      inputDigest: id,
      steps: ["embed"],
    });
    this.runs.claim(id);
    await this.scheduleRunAlarm(Date.now() + 60_000);
    let vector: number[] | undefined;
    try {
      this.requireOpen();
      [vector] = await runModels(this.env, this.vaultId, id, "embed", "vault").embed(
        [text],
        { model: embeddingModel },
      );
      if (embeddingModel !== this.activeEmbeddingModel())
        throw new AppError("conflict", "the search index changed; try again");
      if (!vector?.length) throw new Error("embedding_empty");
      this.requireOpen();
      this.runs.commitStep(id, "embed", () => {});
      this.runs.finish(id, () => {});
    } catch {
      if (this.initialised && !this.gone && this.meta("state") === "open")
        this.runs.fail(id, "embedding_failed");
      throw new AppError(
        "unavailable",
        "could not save that fact right now; try again",
      );
    }
    if (!vector?.length)
      throw new AppError(
        "unavailable",
        "could not save that fact right now; try again",
      );
    return vector;
  }

  private requireUsableRole(roleId: string): void {
    const role = this.sql
      .exec<{ state: string }>(`SELECT state FROM roles WHERE id = ?`, roleId)
      .toArray()[0];
    if (!role) throw new AppError("not_found", "no such role");
    if (role.state === "rejected")
      throw new AppError("invalid", "that role was rejected");
  }

  /** Confirmed facts whose role is confirmed, or that belong to no role. */
  private usableFacts(): FactRecord[] {
    return this.sql
      .exec<FactRow>(
        `SELECT f.id, f.role_id, f.kind, f.text, f.level, f.level_revision, f.origin, f.state, f.source_id, f.revision, e.quote, e.start, e.end
         FROM facts f LEFT JOIN evidence e ON e.id = f.evidence_id LEFT JOIN roles r ON r.id = f.role_id
         WHERE f.state = 'confirmed' AND (f.role_id IS NULL OR r.state = 'confirmed')`,
      )
      .toArray()
      .map(factRecord);
  }

  private confirmedRoles(): RoleRecord[] {
    return this.sql
      .exec<RoleRow>(
        `SELECT id, revision, kind, org, title, start_date, end_date, unknown_end_start_date, state, source_id, NULL AS quote FROM roles WHERE state = 'confirmed'`,
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        revision: r.revision,
        kind: r.kind as RoleKind,
        org: r.org,
        title: r.title,
        startDate: r.start_date,
        endDate: r.end_date,
        unknownEndStartDate: r.unknown_end_start_date,
      }));
  }

  private vectors(): Map<string, Float32Array> {
    if (this.vectorCache) return this.vectorCache;
    const usable = new Set(this.usableFacts().map((f) => f.id));
    const cache = new Map<string, Float32Array>();
    for (const row of this.sql
      .exec<{ id: string; vector: ArrayBuffer }>(
        `SELECT id, vector FROM facts WHERE state = 'confirmed' AND vector IS NOT NULL`,
      )
      .toArray()) {
      if (usable.has(row.id))
        cache.set(row.id, toUnit(unpackVector(row.vector)));
    }
    this.vectorCache = cache;
    return cache;
  }

  private recordRunTotal(id: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    this.env.METRICS?.writeDataPoint({
      indexes: [this.vaultId],
      blobs: [
        run.kind,
        "run_total",
        run.kind,
        "",
        run.state === "succeeded" ? "ok" : "failed",
      ],
      doubles: [Date.now() - run.createdAt, 0, 0, 0],
    });
  }

  private markResumeFailed(resumeId: string, error: string): void {
    this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec<ResumeRow>(`SELECT * FROM resumes WHERE id = ?`, resumeId)
        .toArray()[0];
      if (!row || row.state !== "running") return;
      const run = row.run_id ? this.runs.get(row.run_id) : null;
      // fail() leaves cancellation and terminal states alone, so the resume
      // must not be changed to failed when the ledger did not transition.
      if (run && !["starting", "running"].includes(run.state)) return;
      if (run) this.runs.fail(run.id, "generation_failed");
      this.sql.exec(
        `UPDATE resumes SET state = 'failed', error = ? WHERE id = ?`,
        error,
        resumeId,
      );
      if (!run && row.quota_month && row.quota_month === this.meta("quota_month")) {
        this.setMeta(
          "quota_used",
          String(Math.max(0, Number(this.meta("quota_used") ?? 0) - 1)),
        );
      }
      if (!run) this.settleLegacyQuotaImports();
    });
  }

  /** A running row older than STALE_RUN_MS whose Workflow has stopped is marked failed. */
  private async reconcileStaleRuns(): Promise<void> {
    const stale = this.sql
      .exec<{ id: string; run_id: string | null }>(
        `SELECT id, run_id FROM resumes WHERE state = 'running' AND created_at < ?`,
        Date.now() - STALE_RUN_MS,
      )
      .toArray();
    for (const row of stale) {
      if (this.hasUnsettledDispatch(row.run_id)) continue;
      if (
        (await runStopped(this.env.TAILOR, row.run_id)) &&
        !this.hasUnsettledDispatch(row.run_id)
      )
        this.markResumeFailed(
          row.id,
          "Tailoring stopped unexpectedly. Try again.",
        );
    }
  }

  /** Likewise for uploads, so a source whose Distill run died never shows as reading forever. */
  private async reconcileStaleSources(): Promise<void> {
    const stale = this.sql
      .exec<{ id: string; run_id: string | null }>(
        `SELECT id, run_id FROM sources WHERE state = 'queued' AND created_at < ?`,
        Date.now() - STALE_RUN_MS,
      )
      .toArray();
    for (const row of stale) {
      if (this.hasUnsettledDispatch(row.run_id)) continue;
      if (await runStopped(this.env.DISTILL, row.run_id)) {
        this.requireOpen();
        if (this.hasUnsettledDispatch(row.run_id)) continue;
        this.ctx.storage.transactionSync(() => {
          // The source may have been retried while status() was in flight.
          // Fence both the ledger transition and row update to the exact
          // observed attempt. IS handles legacy rows whose run ID is null.
          const current = this.sql.exec<{ run_id: string | null }>(
            `SELECT run_id FROM sources WHERE id = ? AND state = 'queued' AND run_id IS ?`,
            row.id,
            row.run_id,
          ).toArray()[0];
          if (!current) return;
          const run = row.run_id ? this.runs.get(row.run_id) : null;
          if (run && (run.kind !== "distill" || run.targetId !== row.id || !["starting", "running"].includes(run.state))) return;
          if (run) this.runs.fail(run.id, "execution_failed");
          this.sql.exec(
            `UPDATE sources SET state = 'failed', error = ? WHERE id = ? AND state = 'queued' AND run_id IS ?`,
            "Reading this file stopped unexpectedly.",
            row.id,
            row.run_id,
          );
        });
      }
    }
  }
}

/** True when a Workflow run has finished, failed, been stopped, or cannot be found. */
async function runStopped(
  workflow: Workflow,
  runId: string | null,
): Promise<boolean> {
  if (!runId) return true;
  try {
    const { status } = await (await workflow.get(runId)).status();
    return (
      status === "errored" || status === "terminated" || status === "complete"
    );
  } catch (error) {
    return isMissingWorkflowInstance(error, runId);
  }
}

{
  const p = Vault.prototype;
  retryable(
    p.sourceInfo,
    p.sourceText,
    p.sourceProgress,
    p.tailorInput,
    p.documentInput,
    p.cachedRefinement,
    p.saveSource,
    p.saveExtraction,
    p.saveVectors,
    p.saveStep,
    p.saveDocumentStep,
    p.finishDocument,
    p.claimRun,
    p.settleModelAttempt,
    p.reserveModelAttempt,
    p.setPlan,
  );
}

/** The start of a job description, for naming the job before Tailor has read it. */
function excerptOf(jdText: string): string {
  const flat = jdText.replace(/\s+/g, " ").trim();
  return flat.length > 100
    ? `${flat.slice(0, 100).replace(/\s+\S*$/, "")}…`
    : flat;
}

function parseOrNull<T>(json: string | null): T | null {
  return json ? (JSON.parse(json) as T) : null;
}

function roleView(r: RoleRow): RoleView {
  return {
    id: r.id,
    revision: r.revision,
    span: r.start != null && r.end != null ? [r.start, r.end] : null,
    kind: r.kind as RoleKind,
    org: r.org,
    title: r.title,
    startDate: r.start_date,
    endDate: r.end_date,
    unknownEndStartDate: r.unknown_end_start_date ?? null,
    state: r.state as ReviewState,
    quote: r.quote,
    sourceId: r.source_id,
  };
}

function factView(f: FactRow): FactView {
  return {
    id: f.id,
    revision: f.revision,
    span: f.start != null && f.end != null ? [f.start, f.end] : null,
    roleId: f.role_id,
    kind: f.kind as FactKind,
    text: f.text,
    level: (f.origin === "user" && f.level_revision !== f.revision ? null : f.level) as Level | null,
    ...(f.origin === "user" && f.level !== null && f.level_revision !== f.revision
      ? { levelNeedsReview: true, previousLevel: f.level as Level } : {}),
    origin: f.origin as FactView["origin"],
    state: f.state as ReviewState,
    quote: f.quote,
    sourceId: f.source_id,
    interview:
      f.interview_document_id &&
      f.interview_question_id &&
      f.interview_question &&
      f.interview_quote
        ? {
            documentId: f.interview_document_id,
            questionId: f.interview_question_id,
            question: f.interview_question,
            quote: f.interview_quote,
          }
        : null,
    evidenceOrigin: f.evidence_origin,
    confidence: f.confidence ?? null,
    reviewReasons: f.review_reasons ? JSON.parse(f.review_reasons) : [],
  };
}

function factRecord(f: FactRow): FactRecord {
  return {
    id: f.id,
    revision: f.revision,
    origin: f.origin as FactRecord["origin"],
    roleId: f.role_id,
    kind: f.kind as FactKind,
    text: f.text,
    level: (f.origin === "user" && f.level_revision !== f.revision ? null : f.level) as Level | null,
    ...(f.origin === "user" ? { levelExplicit: f.level !== null && f.level_revision === f.revision } : {}),
    quote: f.origin === "user" ? null : f.quote,
  };
}
