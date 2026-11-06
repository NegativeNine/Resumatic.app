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
import { DATE_PATTERN, MAX_LINE_CHARS } from "../shared/api";
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
import { UploadStore, type UploadDescriptor } from "./uploads";
import { VaultOperations, ReembedStore } from "./operations";
import {
  requireMaintenanceFence,
  type TransferManifest,
  type TransferPage,
  type TransferTable,
} from "../shared/operations";
import { vault as vaultStub } from "../shared/stubs";
import { createSchema, hasSchema, migrate, SCHEMA_VERSION } from "./schema";
import { SnapshotStore, type ResumeVersion } from "./snapshots";
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
    if (this.gone || !this.initialised) return { distill: [], tailor: [] };
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
    }
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
    return reservation;
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
    await this.reconcileStaleSources();
    await this.rearmPendingCancellation();
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
        extractor: string | null;
        markdown: string | null;
        ocr_image_count: number | null;
        run_id: string | null;
      }>(
        `SELECT s.id, s.filename, s.state, s.error, s.created_at, s.origin, s.extractor, s.markdown, s.ocr_image_count, s.run_id,
           (SELECT COUNT(*) FROM facts f WHERE f.source_id = s.id AND f.state = 'proposed') AS proposed
         FROM sources s ORDER BY s.created_at DESC`,
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        filename: r.filename,
        state: r.state as SourceState,
        dispatchUncertain: r.state === "queued" && this.dispatchUncertain(r.run_id),
        cancellationPending: r.state === "queued" && this.cancellationPending(r.run_id),
        error: r.error,
        createdAt: r.created_at,
        proposed: r.proposed,
        origin: r.origin,
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

  /** Where the user's original upload is stored, for downloading it again. */
  async sourceFile(
    who: Who,
    sourceId: string,
  ): Promise<{ r2Key: string; filename: string }> {
    this.requireOwner(who);
    const row = this.sourceRow(sourceId);
    return { r2Key: row.r2_key, filename: row.filename };
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
    const where = state ? `WHERE f.state = ?` : ``;
    const params = state ? [state] : [];
    return this.sql
      .exec<FactRow>(
        `SELECT f.id, f.role_id, f.kind, f.text, f.level, f.origin, f.state, f.source_id, f.revision, f.confidence, f.review_reasons, e.quote, e.start, e.end, s.origin AS evidence_origin, i.document_id AS interview_document_id, i.question_id AS interview_question_id, i.question AS interview_question, i.quote AS interview_quote
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
      for (const id of r.confirm) {
        this.extractionFeedbackStore.review(id, "confirmed", Date.now());
        this.sql.exec(
          `UPDATE roles SET state = 'confirmed', revision = revision + 1 WHERE id = ? AND state <> 'confirmed'`,
          id,
        );
        this.sql.exec(
          `UPDATE facts SET state = 'confirmed', revision = revision + 1, updated_at = ? WHERE id = ? AND state <> 'confirmed'`,
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
          `UPDATE facts SET state = 'rejected', revision = revision + 1 WHERE role_id = ? AND state = 'proposed'`,
          id,
        );
        this.sql.exec(
          `UPDATE facts SET state = 'rejected', revision = revision + 1, updated_at = ? WHERE id = ? AND state <> 'rejected'`,
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
        `INSERT INTO facts (id, role_id, kind, text, level, origin, state, vector, updated_at)
         VALUES (?, ?, ?, ?, ?, 'user', 'confirmed', ?, ?)`,
        id,
        f.roleId,
        f.kind,
        f.text,
        f.level,
        packVector(vector),
        now,
      );
      this.extractionFeedbackStore.manual(id, now);
    });
    this.vectorCache = null;
    return { factId: id };
  }

  /**
   * Rewords a fact, moves it to another role (or to none), or both. Either change makes it the
   * user's own claim; its original quote stays beside it.
   */
  async editFact(who: Who, id: string, patch: FactPatch): Promise<void> {
    this.requireOwner(who);
    const fact = this.sql
      .exec<{ text: string; revision: number; role_id: string | null }>(
        `SELECT text, revision, role_id FROM facts WHERE id = ?`,
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
      this.sql.exec(
        `UPDATE facts SET origin = 'user', revision = revision + 1, updated_at = ? WHERE id = ?`,
        Date.now(),
        id,
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

  async listApplications(who: Who): Promise<ApplicationView[]> {
    this.requireOwner(who);
    await this.rearmPendingCancellation();
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
    this.requireOwner(who);
    const app = this.sql
      .exec<ApplicationRow>(
        `SELECT * FROM applications WHERE id = ?`,
        applicationId,
      )
      .toArray()[0];
    if (!app) throw new AppError("not_found", "no such application");
    const key = `tailor:${requestKey}`;
    const previous = this.runs.findRequest(key);
    if (previous) {
      if (previous.inputDigest !== applicationId)
        throw new AppError(
          "conflict",
          "request key was used for another application",
        );
      return { resumeId: previous.targetId, runId: previous.id };
    }
    await this.reconcileStaleRuns();
    this.requireOwner(who);
    if (
      this.runs
        .listPending()
        .some((r) => ["tailor", "refine", "letter", "prep"].includes(r.kind))
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
    await this.rearmPendingCancellation();
    this.requireOwner(who);
    const row = this.resumeRow(id);
    const ready = row.state === "ready";
    const saved = ready ? this.resumeVersion(row, version) : null;
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
    };
  }

  async resumeVersions(who: Who, id: string) {
    this.requireOwner(who);
    const row = this.resumeRow(id);
    if (row.state === "ready") this.resumeVersion(row);
    return this.snapshots.versions(id);
  }

  /** A user edit is the user's own claim; the PDF cache key changes with the version. */
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
    line.text = trimmed;
    line.status = "edited";
    line.factIds = [];
    saved.render.version = row.version + 1;
    this.ctx.storage.transactionSync(() => {
      this.snapshots.save(resumeId, saved.render.version, saved);
      this.sql.exec(
        `UPDATE resumes SET body = ?, version = ? WHERE id = ?`,
        JSON.stringify(saved.render.body),
        saved.render.version,
        resumeId,
      );
    });
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
    return this.resumeVersion(row, version).render;
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
      const updates: [string, string][] = [["step", step]];
      if (patch.selection)
        updates.push(["selection", JSON.stringify(patch.selection)]);
      if (patch.draft) updates.push(["draft", JSON.stringify(patch.draft)]);
      if (patch.verified)
        updates.push(["verified", JSON.stringify(patch.verified)]);
      if (patch.body) updates.push(["body", JSON.stringify(patch.body)]);
      if (patch.report) updates.push(["report", JSON.stringify(patch.report)]);
      if (patch.state) updates.push(["state", patch.state]);
      if (patch.state === "ready" && patch.body) {
        this.snapshots.assertCurrent(id, patch.body);
        const input = this.snapshots.metadata(id)!;
        const facts = Object.fromEntries(
          this.snapshots
            .items<FactRecord>(id, "fact")
            .map((f) => [f.id, { text: f.text, quote: f.quote }]),
        );
        const analysis =
          parseOrNull<Analysis>(row.run_analysis) ?? input.analysis;
        this.snapshots.save(resumeId, row.version, {
          render: {
            profile: input.profile,
            body: patch.body,
            version: row.version,
            company: analysis?.company ?? null,
            title: analysis?.title ?? null,
          },
          report: patch.report ?? null,
          facts,
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
    if (claims.vid !== this.vaultId)
      throw new AppError("forbidden", "wrong account");
    return this.mcpGrants.authorize(claims, scope);
  }
  async mcpFacts(claims: McpClaims, input: { query?: string; limit?: number }) {
    await this.authorizeMcp(claims, "vault:read");
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
    const who = await this.authorizeMcp(claims, "vault:read");
    const resume = await this.getResume(who, id, version);
    if (resume.state !== "ready")
      throw new AppError("conflict", "the resume is not ready");
    return {
      id: resume.id,
      version: resume.version,
      body: resume.body,
      provenance: resume.provenance,
    };
  }
  async mcpTailor(
    claims: McpClaims,
    applicationId: string,
    requestKey: string,
  ) {
    return this.tailor(
      await this.authorizeMcp(claims, "vault:generate"),
      applicationId,
      `mcp_${claims.grantId}_${requestKey}`,
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
    this.requireOwner(who);
    const facts = (await this.listFacts(who, "confirmed")).filter((f) =>
      selection.factIds.includes(f.id),
    );
    if (facts.length !== selection.factIds.length)
      throw new AppError("invalid", "select confirmed facts from your vault");
    const roles = await this.listRoles(who);
    const resumes = selection.resumes.map(({ id, version }) => ({
      id,
      ...this.resumeVersion(this.resumeRow(id), version),
    }));
    const grant = this.ctx.storage.transactionSync(() => {
      for (const fact of facts) {
        const row = this.sql
          .exec<{ revision: number; state: string }>(
            `SELECT revision,state FROM facts WHERE id = ?`,
            fact.id,
          )
          .one();
        if (row.revision !== fact.revision || row.state !== "confirmed")
          throw new AppError(
            "conflict",
            "a selected fact changed; refresh and try again",
          );
      }
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
    const cachedInput =
      options.kind === "refine" ? await this.documentInput(runId) : null;
    const cacheKey = cachedInput
      ? await refinementCacheKey(cachedInput, this.env.MODEL_WRITE)
      : null;
    this.requireOpen();
    const unchanged =
      options.kind === "refine" &&
      !!result.body &&
      JSON.stringify(options.base) === JSON.stringify(result.body);
    const completed = this.runs.finish(
      runId,
      () => {
        const input = this.snapshots.metadata(runId)!;
        const roles = this.snapshots.items<RoleRecord>(runId, "role");
        const checkBody: ResumeBody = result.body ?? {
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
        this.snapshots.assertCurrent(runId, checkBody);
        const facts = Object.fromEntries(
          this.snapshots
            .items<FactRecord>(runId, "fact")
            .map((f) => [f.id, { text: f.text, quote: f.quote }]),
        );
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
          const version = row.version + 1;
          this.snapshots.save(row.id, version, {
            ...base,
            render: { ...base.render, body: result.body, version },
            report: result.report,
            facts,
            provenance: "snapshot",
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
    await this.rearmPendingCancellation();
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
    await this.rearmPendingCancellation();
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
      dispatchUncertain: row.state === "running" && this.dispatchUncertain(row.id),
      cancellationPending: row.state === "running" && this.cancellationPending(row.id),
      version: row.version,
      createdAt: row.created_at,
      error: row.error,
      result: data?.result ?? null,
      facts: data?.facts ?? {},
    };
  }

  // ---------------------------------------------------------------- export

  async exportAll(who: Who): Promise<VaultExport> {
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
      roles: await this.listRoles(who),
      facts: await this.listFacts(who),
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
        requireMaintenanceFence: () =>
          requireMaintenanceFence(this.vaultId, this.env.RESTORE_FENCE_IDS),
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
    requireMaintenanceFence(this.vaultId, this.env.RESTORE_FENCE_IDS);
    if (this.meta("account_deletion_intent") === "1")
      throw new AppError("gone", "this account is being deleted");
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
        const status = await instance.status();
        if (!["complete", "terminated", "errored"].includes(status.status))
          await instance.terminate();
        await instance.delete();
      } catch (error) {
        if (!isMissingWorkflowInstance(error)) throw error;
      }
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
    requireMaintenanceFence(this.vaultId, this.env.RESTORE_FENCE_IDS);
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
          `SELECT key,value FROM meta WHERE key IN ('stripe_customer','billing_customer_requested','billing_customer_requested_at','entitlement','entitlement_revision','checkout_intent','quota_month','quota_used')`,
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
    requireMaintenanceFence(this.vaultId, this.env.RESTORE_FENCE_IDS);
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
    const source = vaultStub(this.env, sourceVaultId);
    const control = await source.controlCheckpoint();
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
      if (!object) throw new AppError("conflict", "a source file is missing");
      const bytes = await object.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      await this.env.FILES.put(row.r2_key, bytes, {
        sha256: digest,
        httpMetadata: object.httpMetadata,
        customMetadata: object.customMetadata,
      });
      const check = await this.env.FILES.head(row.r2_key);
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
    requireMaintenanceFence(this.vaultId, this.env.RESTORE_FENCE_IDS);
    if (
      this.meta("user_id") !== ownerId ||
      this.operations.importStatus(operationId).state !== "ready"
    )
      throw new AppError("conflict", "replacement is not ready");
    this.setMeta("state", "open");
  }

  // ---------------------------------------------------------------- helpers

  private requireOpen(): void {
    this.requireNotUnderMaintenance();
    if (this.gone || !this.initialised)
      throw new AppError("gone", "this vault no longer exists");
    if (this.meta("state") !== "open")
      throw new AppError("gone", "this account is being deleted");
  }

  private requireNotUnderMaintenance(): void {
    if (
      (this.env.RESTORE_FENCE_IDS ?? "")
        .split(",")
        .map((v) => v.trim())
        .includes(this.vaultId)
    )
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
    const plan = this.meta("entitlement")
      ? (JSON.parse(this.meta("entitlement")!) as Entitlement)
      : null;
    if (
      plan?.validUntil &&
      plan.validUntil > Date.now() &&
      plan.planId !== "free"
    ) {
      const startAt = Number(plan.bucket.split(":").at(-1)) * 1000;
      return {
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
    const month = monthOf(Date.now());
    const bucket = this.quotaBucket();
    if (!this.runs.quota(bucket.key)) {
      this.runs.setBucket(bucket);
      const legacy =
        bucket.key.startsWith("free:") && this.meta("quota_month") === month
          ? Number(this.meta("quota_used") ?? 0)
          : 0;
      if (legacy)
        this.sql.exec(
          `UPDATE quota_buckets SET used = ? WHERE bucket_key = ?`,
          legacy,
          bucket.key,
        );
    }
    const balance = this.runs.setBucket(bucket);
    return {
      used: balance.used,
      reserved: balance.reserved,
      limit: balance.limit,
      month,
      periodEnd: balance.endAt,
    };
  }

  async setPlan(revision: number, plan: Entitlement): Promise<void> {
    this.requireOpen();
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new AppError("invalid", "invalid entitlement revision");
    if (revision <= Number(this.meta("entitlement_revision") ?? 0)) return;
    this.ctx.storage.transactionSync(() => {
      this.setMeta("entitlement", JSON.stringify(plan));
      this.setMeta("entitlement_revision", String(revision));
      this.runs.setBucket(this.quotaBucket());
    });
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
      setCustomer: (id) => {
        if (!this.gone) this.setMeta("stripe_customer", id);
      },
      markCustomerRequested: () => {
        if (this.meta("billing_customer_requested") !== "1") {
          this.setMeta("billing_customer_requested_at", String(Date.now()));
          this.setMeta("billing_customer_requested", "1");
        }
      },
      requireOwner: () => this.requireOwner(who),
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
    const created = await stripeClient(cfg).createCustomer(
      this.meta("user_id")!,
      `customer:${this.meta("user_id")}`,
    );
    if (!this.gone) this.setMeta("stripe_customer", created.id);
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
    if (!this.initialised || !hasSchema(this.sql)) return { rows: 0 };
    const tables = this.sql
      .exec<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      )
      .toArray();
    let rows = 0;
    for (const { name } of tables) {
      if (/^[a-z_]+$/.test(name))
        rows += this.sql
          .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name}"`)
          .one().n;
    }
    return { rows };
  }
  async adminRuns() {
    this.requireOpen();
    return this.runs.list();
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
    await this.rearmPendingCancellation();
    this.requireOwner(who);
    return this.runs.list();
  }

  async runInfo(who: Who, runId: string) {
    this.requireOwner(who);
    await this.rearmPendingCancellation();
    this.requireOwner(who);
    const run = this.runs.get(runId);
    if (!run) throw new AppError("not_found", "no such run");
    return run;
  }

  private async dispatchRun(run: RunRecord): Promise<void> {
    // The marker is durable before external I/O. Once closing starts, no new
    // create may begin, even if an alarm resumed after an unrelated await.
    if (this.closing || this.gone || !this.initialised || this.meta("state") !== "open") return;
    if ((this.env.RESTORE_FENCE_IDS ?? "").split(",").map((v) => v.trim()).includes(this.vaultId)) return;
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
    if ((this.env.RESTORE_FENCE_IDS ?? "").split(",").map((v) => v.trim()).includes(this.vaultId)) return null;
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
    row = this.sql.exec<{ attempts: number; next_at: number }>(
      `SELECT attempts, next_at FROM workflow_redispatches WHERE run_id = ?`, id,
    ).toArray()[0];
    if (!current || !row || row.attempts >= REDISPATCH_DELAYS_MS.length || row.next_at > Date.now()) return;
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
    if (this.sql.exec(`SELECT run_id FROM workflow_dispatches UNION ALL SELECT run_id FROM workflow_redispatches LIMIT 1`).toArray().length)
      throw new AppError("unavailable", "workflow creation is unresolved; retry after it is settled");
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

  /** A transient alarm failure must not strand an already accepted cancellation. */
  private async rearmPendingCancellation(): Promise<void> {
    if (
      !this.sql.exec(`SELECT id FROM runs WHERE state = 'cancel_requested' LIMIT 1`).toArray().length
    ) return;
    try {
      // Keep any earlier alarm; a later authenticated poll retries if storage is
      // unavailable. This schedules reconciliation, never settles the run.
      await this.scheduleRunAlarm(Date.now() + 60_000);
    } catch {
      // Status remains readable and a future poll can attempt to rearm again.
    }
  }

  async alarm(): Promise<void> {
    if (!this.initialised || this.gone) return;
    if (this.meta("account_deletion_intent") === "1") {
      try {
        const userId = this.meta("user_id");
        if (!userId) throw new Error("deletion_owner_missing");
        await directoryForUser(this.env, userId).deleteAccount(userId, this.vaultId);
      } catch {
        // Directory may have committed despite a lost reply. A durable retry
        // is safe and must not recreate an alarm after the vault is destroyed.
        await this.scheduleDeletionAlarm(Date.now() + 60_000);
      }
      return;
    }
    if (this.meta("state") !== "open") return;
    this.shares.purgeExpired();
    this.mcpGrants.purgeExpired();
    this.sql.exec(
      `DELETE FROM refine_cache WHERE created_at <= ?`,
      Date.now() - REFINE_CACHE_TTL_MS,
    );
    for (const intent of this.uploads.cleanupCandidates()) {
      await this.env.FILES.delete(intent.r2Key);
      this.uploads.markCleaned(intent.requestKey, intent.r2Key);
    }
    for (const run of this.runs.listPending()) {
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
        const { status } = await instance.status();
        if (run.state === "cancel_requested") {
          if (!["complete", "errored", "terminated"].includes(status))
            await instance.terminate();
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
        // The platform's explicit not-found result is the only safe reason to create again.
        if (isMissingWorkflowInstance(error) && run.state === "starting") {
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
        } else if (isMissingWorkflowInstance(error) && run.state === "cancel_requested" && !this.hasUnsettledDispatch(run.id))
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
      this.uploads.nextAlarm(),
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
      [vector] = await runModels(this.env, this.vaultId, id, "embed").embed(
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
        `SELECT f.id, f.role_id, f.kind, f.text, f.level, f.origin, f.state, f.source_id, f.revision, e.quote, e.start, e.end
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
      if (row.quota_month && row.quota_month === this.meta("quota_month")) {
        this.setMeta(
          "quota_used",
          String(Math.max(0, Number(this.meta("quota_used") ?? 0) - 1)),
        );
      }
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
        if (this.hasUnsettledDispatch(row.run_id)) continue;
        this.sql.exec(
          `UPDATE sources SET state = 'failed', error = ? WHERE id = ? AND state = 'queued'`,
          "Reading this file stopped unexpectedly.",
          row.id,
        );
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
    return isMissingWorkflowInstance(error);
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
    level: f.level as Level | null,
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
    level: f.level as Level | null,
    quote: f.origin === "user" ? null : f.quote,
  };
}
