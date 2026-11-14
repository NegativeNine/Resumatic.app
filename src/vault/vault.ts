import { SkillYearsStore } from "./skill-years";
import { MAX_SELECTED_SKILL_CLAIMS, SKILL_YEARS_OFF, type SkillIntervalInput, type SkillSubjectRef } from "../shared/skill-years";
import { withoutFindings } from "../shared/sheet";
import type { InterviewAnswer } from "../shared/interview";
import { reviewViewStream } from "./review-stream";
import { exportJsonChunks, exportJsonStream } from "./export-stream";
import { ARCHIVE_TOO_LARGE, ARCHIVE_TOO_MANY_FILES, MAX_ARCHIVE_BYTES } from "../render/archive";
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
import { MAX_APP_FIT_STARTS_PER_DAY, MCP_FIT_SCOPES, MCP_FIT_TEXT, type McpFit } from "../shared/mcp";
import { fitForApp } from "./mcp-fit";
import type {
  ApplicationDetail,
  ApplicationRef,
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
  SensitiveRequest,
  SourceOrigin,
  SourceState,
  SourceView,
} from "../shared/api";
import { DATE_PATTERN, MAX_JOB_NAME_CHARS, MAX_LINE_CHARS, MAX_SENSITIVE_IDS, MAX_UPLOAD_BYTES, isWebUrl, normalizePosting } from "../shared/api";
import type { Preferences, PreferenceValues } from "../shared/preferences";
import { PreferencesStore } from "./preferences";
import { EMAIL_OFF, NOTICE_KINDS, emailConfigured, emailFrom, emailOrigin, noticeMessage, type NoticeKind, type NoticeSettings } from "../shared/email-notices";
import { EmailNoticeStore, MAX_NOTICE_ATTEMPTS, noticeAddressCheck } from "./email-notices";
import { cloudflareSender, type NoticeErrorCode } from "./email-sender";
import { sessionEmail } from "../worker/session";
import {
  KIT_ANSWER_REFUSED,
  KIT_CHANGED,
  KIT_CHOICE_REFUSED,
  KIT_DOCUMENT_REFUSED,
  KIT_NOT_APPROVED,
  KIT_PROBLEMS,
  KIT_QUESTIONS_REFUSED,
  KIT_RESUME_REFUSED,
  KIT_SENSITIVE_NEVER_SAVED,
  MAX_KIT_RESUME_CHOICES,
  classifyDeterministic,
  cleanKitAnswer,
  cleanKitParts,
  cleanKitQuestions,
  readKitAnswerChange,
  refusedKind,
  type KitAnswerChange,
  type KitArchiveData,
  type KitChoice,
  type KitExport,
  type KitPart,
  type KitPartsUpdate,
  type KitProblem,
  type KitQuestionsUpdate,
  type KitQuestionRecord,
  type KitQuestionView,
  type KitView,
  type SavedAnswer,
  type SavedAnswerInput,
} from "../shared/kit";
import type { KitMatchAnswer } from "../ai/question-match";
import { ApplicationKitStore } from "./application-kit";
import { AppError, errorCode, logErrorCode } from "../shared/errors";
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
import { MAX_PASTE_BYTES, readPastedText } from "../shared/paste";
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
import { assertGroundedResume, evidenceForFacts, evidenceForRoles, SnapshotStore, type ResumeVersion } from "./snapshots";
import { captureConceptEvidence, conceptEvidenceCurrent } from "./concept-evidence";
import { canShareDocument, sharedDocument, SHAREABLE_DOCUMENT_KINDS, type DocumentVersion } from "./document-shares";
import { CoachClientStore, type CoachClientEntry } from "./coach-clients";
import type { CoachAccount } from "./shares";
import type { ShareableDocument, SharedDocument } from "../shared/sharing";
import { ShareCommentStore } from "./share-comments";
import type { CommentThread, NewShareComment, OwnerCommentThread, ShareComment } from "../shared/sharing";
import { isVisibleLine, targetText, unchangedWording, type NewSuggestion, type ShareSuggestion } from "../shared/sharing";
import { appliedVersion, boundCheck, coachStanding, currentLine, lineAsShown, ownerStanding } from "./share-suggestions";
import { rewritten } from "../pipeline/documents";
import type { ResumeLine } from "../shared/api";
import { mergeRefinementEvidence } from "./refinement-evidence";
import { validateTailorCheckpoint, validateTailorPublication } from "./tailor-publication";
import { finalLegacyEvidence, legacyReceipt, legacyReview } from "./legacy-remediation";
import { RunStore } from "./runs";
import { RecordStore } from "./record";
import { readCardMaterial } from "./card";
import { CARD_PREVIEW_OFF, type CardMaterial } from "../shared/card";
import { MAX_TODAY_LIST, MAX_TODAY_RECENT, TODAY_RECENT_MS, type Today } from "../shared/today";
import { countByState, proposedBySource } from "../shared/review-groups";
import { TodayStore, todayView, type KitCount } from "./today";
import { IDENTICAL_ROLE_METHOD, IDENTICAL_WORDING_METHOD, MAX_OFFER_PAIRS, OFFERS_PER_FACT, OFFER_MIN_COSINE, identicalMatches, type JudgedOffer, type OfferPair } from "../pipeline/match";
import { roleKey, sameRole, sameWording, stampProblem } from "../shared/record";
import { MAX_TAGS_PER_SAVE, MAX_TAG_FACTS, MAX_TAG_ROLES, TAG_JUDGE_METHOD, TAG_RULE_METHOD, TAG_VECTOR_METHOD, TAG_PART_JUDGE_METHOD, TAG_PART_VECTOR_METHOD, skillAsWritten, tagStamp, type HeldTag, type ProposedTag, type TagMade, type TagSubjects } from "../pipeline/tag";
import type { NewPart, RecordExport } from "../shared/record";
import { ShareStore } from "./shares";
import { markedWording, sensitiveUse, setSensitive, usableQuote, withheldFacts } from "./sensitive";
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
import { DOCUMENT_RUN_KINDS, FREE_DOCUMENT_KINDS, GENERATION_RUN_KINDS, freeQuotaBucket, type RunRecord } from "../shared/runs";
import { cosine, packVector, toUnit, topMatches, unpackVector } from "./search";

/** A running Tailor row older than this is checked against the Workflow before it blocks a new run. */
const STALE_RUN_MS = 30 * 60 * 1000;
/** What the owner is told when a job they name isn't in their vault. */
const JOB_NOT_FOUND = "This job can't be found. It may have been deleted.";
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
  origin: SourceOrigin;
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
  evidence_origin?: SourceOrigin;
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
  url: string | null;
  details_edited: number;
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

/** RecordExport adds how lines divide, their concepts and what was merged: every judgement held, with what made it. */
export interface VaultExport extends RecordExport, KitExport {
  interviewAnswers: Record<string, string | number | null>[];
  generationInputs: Record<string, string | number | null>[];
  generationItems: Record<string, string | number | null>[];
  documentRequests: Record<string, string | number | null>[];
  skillRecordIdentities: Record<string, string | number | null>[];
  skillUseIntervals: Record<string, string | number | null>[];
  skillDurationClaims: Record<string, string | number | null>[];
  skillYearRequests: Record<string, string | number | null>[];
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
  /** Copies other people shared with this account as their coach: whose, and until when. */
  coachClients: Omit<CoachClientEntry, "ownerVault">[];
  /** What a coach wrote on copies this account shared, and its owner's replies, as stored. */
  shareComments: Record<string, string | number | null>[];
  connectedApps: Omit<McpGrant, "oauthGrantId">[];
  billing: Entitlement | null;
  exportedAt: string;
  profile: Profile;
  /** Job preferences as stored. Revision 0, with nothing said, until the first save. */
  preferences: Preferences;
  /** Which email notices are on and how each last went, as stored: a check of the sign-in address, never the address. */
  emailNotices: Record<string, string | number | null>[];
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
    url?: string | null;
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

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An upload's or a paste's body digest, if it has a well-formed one. OCR page images are never compared. */
function uploadSha256(input: UploadDescriptor): string | null {
  if (input.origin === "ocr" || input.sha256 === undefined) return null;
  if (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256))
    throw new AppError("invalid", "invalid upload digest");
  return input.sha256;
}

/** A quota month as the interface writes it, such as "Nov 2026" for "2026-11". */
export function monthLabel(month: string): string {
  const [year, m] = month.split("-").map(Number);
  const start = new Date(Date.UTC(year ?? 1970, (m ?? 1) - 1, 1));
  return `${MONTH_NAMES[start.getUTCMonth()]} ${start.getUTCFullYear()}`;
}

/** The day a quota month's count resets, such as "1 Dec 2026" for "2026-11". */
export function resetDay(month: string): string {
  const [year, m] = month.split("-").map(Number);
  const next = new Date(Date.UTC(year ?? 1970, m ?? 1, 1));
  return `1 ${MONTH_NAMES[next.getUTCMonth()]} ${next.getUTCFullYear()}`;
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

  /** Parts of a line, tags and links. Only what is kept in shadow is written so far; all of it is exported with the vault. */
  private get skillYears(): SkillYearsStore {
    return new SkillYearsStore(this.sql, (fn) => this.ctx.storage.transactionSync(fn));
  }
  private requireSkillYears(who: Who): void {
    this.requireOwner(who);
    if (this.env.SKILL_YEARS_ENABLED !== "true") throw new AppError("not_found", SKILL_YEARS_OFF);
  }
  private requireOrdinaryFacts(ids: readonly string[]): void {
    if (ids.some((id) => this.skillYears.isBackingFact(id)))
      throw new AppError("conflict", "Manage a confirmed skill total through its skill periods.");
  }
  skillYearsView(who: Who) {
    this.requireSkillYears(who);
    return this.skillYears.view(withheldFacts(this.sql).ids);
  }
  saveSkillInterval(who: Who, input: SkillIntervalInput, requestKey: string, edit?: { id: string; expectedRevision: number }) {
    this.requireSkillYears(who);
    const id = this.skillYears.save(input, requestKey, withheldFacts(this.sql).ids, edit);
    return { id };
  }
  withdrawSkillInterval(who: Who, id: string, expectedRevision: number, requestKey: string): void {
    this.requireSkillYears(who);
    this.skillYears.withdraw(id, expectedRevision, requestKey);
  }
  async previewSkillDuration(who: Who, subject: SkillSubjectRef) {
    this.requireSkillYears(who);
    const result = await this.skillYears.preview(subject, withheldFacts(this.sql).ids);
    this.requireSkillYears(who);
    return result;
  }
  async confirmSkillDuration(who: Who, subject: SkillSubjectRef, asOf: string, inputHash: string, requestKey: string) {
    this.requireSkillYears(who);
    return this.skillYears.confirm(subject, asOf, inputHash, requestKey, () => {
      this.requireSkillYears(who);
      return withheldFacts(this.sql).ids;
    });
  }

  private get record(): RecordStore {
    return new RecordStore(this.sql, (fn) => this.ctx.storage.transactionSync(fn));
  }

  private get vaultId(): string {
    return this.ctx.id.toString();
  }

  // ---------------------------------------------------------------- lifecycle (Directory)

  async init(userId: string): Promise<void> {
    if (this.gone || this.destroying || this.closing || (this.initialised && this.meta("state") === "closing"))
      throw new AppError("gone", "this vault is closing or was destroyed");
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

  /** A retired-vault record may not close or erase another account's Vault. */
  private requireRetirementOwner(userId: string): void {
    if (typeof userId !== "string" || !userId || this.gone || !this.initialised || this.meta("user_id") !== userId)
      throw new AppError("unavailable", "retired vault ownership requires review");
  }

  quiesceForRetirement(userId: string): void {
    this.requireRetirementOwner(userId);
    this.quiesce();
  }

  knownRunsForRetirement(userId: string): ReturnType<Vault["knownRunsForDeletion"]> {
    this.requireRetirementOwner(userId);
    return this.knownRunsForDeletion();
  }

  closeForRetirement(userId: string): ReturnType<Vault["close"]> {
    this.requireRetirementOwner(userId);
    return this.close();
  }

  destroyForRetirement(userId: string): ReturnType<Vault["destroy"]> {
    this.requireRetirementOwner(userId);
    if (this.destroying || this.meta("state") !== "closing")
      throw new AppError("conflict", "retired vault must be closed before destruction");
    return this.destroy();
  }

  /** Account deletion, like retirement, must prove the persisted owner before touching the Vault. */
  private requireDeletionOwner(userId: string): void {
    if (typeof userId !== "string" || !userId || this.gone || !this.initialised || this.meta("user_id") !== userId)
      throw new AppError("unavailable", "account vault ownership requires review");
  }

  quiesceForAccountDeletion(userId: string): void {
    this.requireDeletionOwner(userId);
    this.quiesce();
  }

  knownRunsForAccountDeletion(userId: string): ReturnType<Vault["knownRunsForDeletion"]> {
    this.requireDeletionOwner(userId);
    return this.knownRunsForDeletion();
  }

  closeForAccountDeletion(userId: string): ReturnType<Vault["close"]> {
    this.requireDeletionOwner(userId);
    return this.close();
  }

  destroyForAccountDeletion(userId: string): ReturnType<Vault["destroy"]> {
    this.requireDeletionOwner(userId);
    if (this.destroying || this.meta("state") !== "closing")
      throw new AppError("conflict", "account vault must be closed before destruction");
    return this.destroy();
  }

  knownBillingForAccountDeletion(userId: string): ReturnType<Vault["knownBillingForDeletion"]> {
    this.requireDeletionOwner(userId);
    return this.knownBillingForDeletion();
  }

  async billingCustomerForAccountDeletion(userId: string): Promise<string | null> {
    this.requireDeletionOwner(userId);
    const customer = await this.billingCustomerForDeletion();
    this.requireDeletionOwner(userId);
    return customer;
  }

  billingCheckoutSessionsForAccountDeletion(userId: string): string[] {
    this.requireDeletionOwner(userId);
    return this.billingCheckoutSessionsForDeletion();
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
    return this.deletionRuns();
  }

  /** Provisional inventory only: unresolved dispatches still fence destruction. */
  knownRunsForDeletion(): {
    distill: string[];
    tailor: string[];
    other?: { kind: string; id: string }[];
  } {
    if (this.gone || !this.initialised) {
      this.requireNoUnidentifiedTables();
      return { distill: [], tailor: [] };
    }
    if (this.meta("state") !== "closing")
      throw new AppError("conflict", "vault must be closed before listing deletion runs");
    return this.deletionRuns();
  }

  private deletionRuns(): {
    distill: string[];
    tailor: string[];
    other?: { kind: string; id: string }[];
  } {
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
        `SELECT kind,id FROM runs WHERE kind NOT IN ('distill','tailor','embed','match')`,
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

  /**
   * `signInEmail` is the address this sign-in was made with, or null for none. Where any email
   * notice is on, each kind turned on with another address is paused, and one turned on with this
   * address is resumed. It is checked whether or not the deployment sends email now, so a later
   * switch-on never sends on a stale check. A caller that passes nothing (an older Worker) changes
   * no notice.
   */
  async openSession(userId: string, signInEmail?: string | null): Promise<{ gen: number; epoch: string }> {
    this.requireOpen();
    if (this.meta("user_id") !== userId)
      throw new AppError("forbidden", "not this user's vault");
    if (signInEmail !== undefined && this.notices.anyOn()) {
      const address = sessionEmail(signInEmail);
      const check = address ? await noticeAddressCheck(address) : null;
      this.requireOpen();
      if (this.meta("user_id") !== userId)
        throw new AppError("forbidden", "not this user's vault");
      this.ctx.storage.transactionSync(() => this.notices.signedIn(check));
    }
    return {
      gen: Number(this.meta("session_gen")),
      epoch: this.meta("security_epoch") ?? "legacy",
    };
  }

  async checkSession(who: Who): Promise<void> {
    this.requireOwner(who);
  }

  /** Record a cache write before the Worker can send it to R2. */
  beginCacheWrite(who: Who, attemptId: string, kind: "pdf" | "docx", keyDigest?: string): void {
    this.requireOwner(who);
    if (!["pdf", "docx"].includes(kind)) throw new AppError("invalid", "invalid cache write attempt");
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

  /** A known legacy export-cache acknowledgement can settle its own attempt after revocation. */
  finishCacheWrite(userId: string, attemptId: string): void {
    if (this.gone || !this.initialised || this.meta("user_id") !== userId)
      throw new AppError("forbidden", "not this user's vault");
    // This internal capability is never returned by an HTTP route. Completion
    // intentionally survives sign-out and closure, but may clear only its ID.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId))
      throw new AppError("invalid", "invalid cache write attempt");
    // This RPC belongs to legacy Worker-owned export writes. Source writes
    // are now Vault-owned and may be settled only by their own put handler.
    // An older Worker that tries to settle one stays blocked for review.
    if (this.sql.exec(`SELECT attempt_id FROM r2_cache_dispatches WHERE attempt_id = ? AND kind = 'source'`, attemptId).toArray().length)
      throw new AppError("unavailable", "source write requires its original acknowledgement");
    this.sql.exec(`DELETE FROM r2_cache_dispatches WHERE attempt_id = ? AND kind IN ('pdf', 'docx')`, attemptId);
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
      clients: this.coachClients.count(),
      newFromCoach: this.shareComments.unseen(),
      capabilities: {
        ocr: !!this.env.MODEL_TRANSCRIBE,
        connectedApps: this.env.MCP_ENABLED === "true",
        roleDateUnknownEnd: this.env.ROLE_UNKNOWN_END_ENABLED === "true",
        postingReader: this.env.POSTING_READER_ENABLED === "true",
        cardPreview: this.env.CARD_PREVIEW_ENABLED === "true",
        skillYears: this.env.SKILL_YEARS_ENABLED === "true",
        emailNotices: emailConfigured(this.env),
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

  /** Reject a stale editor rather than replacing contact details saved elsewhere. */
  async updateProfileChecked(who: Who, patch: Partial<Profile>, expectedRevision: number): Promise<Profile> {
    this.requireOwner(who);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
        this.readProfile().revision !== expectedRevision)
      throw new AppError("conflict", "Your profile was changed somewhere else. Load the saved profile, check it, then save again.");
    // updateProfile executes its write before returning its promise. There is
    // no await between the revision check and the write in this object.
    return this.updateProfile(who, patch);
  }

  // ---------------------------------------------------------------- job preferences
  // Read and saved by their owner, and exported with the vault. Nothing that makes a resume, a
  // document, a copy or a connected app's answer reads them: test/unit/preferences-reach.test.ts
  // holds the store to the two calls below and the export.

  private get preferences(): PreferencesStore {
    return new PreferencesStore(this.sql);
  }

  async getPreferences(who: Who): Promise<Preferences> {
    this.requireOwner(who);
    return this.preferences.read();
  }

  /** Replaces all four values, or refuses a stale editor as updateProfileChecked does. */
  async updatePreferences(who: Who, values: PreferenceValues, expectedRevision: number): Promise<Preferences> {
    this.requireOwner(who);
    // The store reads the revision and writes in one synchronous turn: nothing is awaited
    // between the owner check above and the write.
    return this.preferences.save(values, expectedRevision);
  }

  // ---------------------------------------------------------------- card preview
  // The owner's own card, as a recruiter would see it if they were ever found. This reads the
  // material only: concept IDs, how many facts show each, and job dates. The Worker turns them
  // into taxonomy groups, so nothing here awaits the taxonomy. Nothing is stored or sent anywhere.

  async cardMaterial(who: Who): Promise<CardMaterial> {
    this.requireOwner(who);
    if (this.env.CARD_PREVIEW_ENABLED !== "true") throw new AppError("unavailable", CARD_PREVIEW_OFF);
    // One synchronous turn with no await and no write, so it needs no transaction.
    return readCardMaterial(this.record, this.usableFacts(), withheldFacts(this.sql).ids, this.confirmedRoles().filter((role) => role.kind === "job"));
  }

  // ---------------------------------------------------------------- email notices
  // Turned on kind by kind by the owner, and sent by this vault's alarm to the address the
  // Directory holds for its owner, only while that address is the one the kind was turned on with
  // and the one used at the latest sign-in. A notice holds fixed words and the app's address.

  private get notices(): EmailNoticeStore {
    return new EmailNoticeStore(this.sql);
  }

  async emailNotices(who: Who): Promise<NoticeSettings> {
    this.requireOwner(who);
    if (!emailConfigured(this.env)) throw new AppError("unavailable", EMAIL_OFF);
    return this.notices.view();
  }

  /**
   * Turns one kind on or off. `signInEmail` is the verified session's address, never one a request
   * names. Setting a kind as it already is changes nothing, so a repeated request is harmless.
   */
  async setEmailNotice(who: Who, kind: NoticeKind, on: boolean, signInEmail: string | null | undefined): Promise<NoticeSettings> {
    this.requireOwner(who);
    if (!emailConfigured(this.env)) throw new AppError("unavailable", EMAIL_OFF);
    if (!(NOTICE_KINDS as readonly unknown[]).includes(kind) || typeof on !== "boolean")
      throw new AppError("invalid", "choose a notice to turn on or off");
    const address = sessionEmail(signInEmail);
    if (on && !address) throw new AppError("conflict", "sign out and in again to turn on email notices");
    const check = on && address ? await noticeAddressCheck(address) : null;
    this.requireOwner(who);
    this.ctx.storage.transactionSync(() => this.notices.set(kind, on, check, Date.now()));
    await this.scheduleNotices();
    return this.notices.view();
  }

  /** Brings the alarm forward to the next notice that may be due. Best effort: the alarm's own pass schedules it too. */
  private async scheduleNotices(): Promise<void> {
    try {
      const now = Date.now();
      const at = emailConfigured(this.env) ? this.notices.nextDue() : null;
      if (at !== null) await this.scheduleRunAlarm(Math.max(at, now + 1000));
    } catch {
      // A notice is never worth failing the write that queued it. The next alarm or write retries.
    }
  }

  /** One data point for a notice. It holds the kind, a code from a fixed list and the outcome: never an address or a provider's words. */
  private noticeMetric(kind: NoticeKind, code: NoticeErrorCode | null, outcome: "ok" | "retry" | "failed" | "paused", attempt: number): void {
    this.env.METRICS?.writeDataPoint({
      indexes: [this.vaultId],
      blobs: ["email", "email_notice", kind, code ?? "", outcome],
      doubles: [attempt, 0, 0, 0],
    });
    if (outcome === "retry" || outcome === "failed") console.error("email notice failed", { code, kind });
  }

  /**
   * Sends whatever notices are due, from the alarm. Where the deployment no longer sends email,
   * everything queued is dropped. Under the maintenance fence nothing is sent: the replacement's
   * alarm sends what was due. Each attempt is recorded before anything is awaited, and every step
   * after an await checks again that the vault is open and the kind is on as it was.
   */
  private async sendDueNotices(fenced: boolean, canContinue: () => boolean): Promise<void> {
    if (!emailConfigured(this.env)) {
      this.ctx.storage.transactionSync(() => this.notices.dropPending());
      return;
    }
    if (fenced) return;
    const origin = emailOrigin(this.env);
    const from = emailFrom(this.env);
    const userId = this.meta("user_id");
    if (!origin || !from || !userId) return;
    // The Directory is asked once an alarm, and only once a notice is due.
    let lookup: { address: string | null } | "unavailable" | undefined;
    for (const kind of NOTICE_KINDS) {
      if (!canContinue()) return;
      const attempt = this.ctx.storage.transactionSync(() => this.notices.begin(kind, Date.now()));
      if (!attempt) continue;
      if ("exhausted" in attempt) {
        this.noticeMetric(kind, "E_UNANSWERED", "failed", MAX_NOTICE_ATTEMPTS);
        continue;
      }
      // The next attempt is armed before anything leaves the vault, so a send that never returns
      // still has its retry, and its last one is settled.
      await this.scheduleRunAlarm(attempt.retryAt);
      if (!canContinue()) return;
      if (lookup === undefined) {
        try {
          lookup = { address: await directoryForUser(this.env, userId).noticeAddress(userId, this.vaultId) };
        } catch {
          lookup = "unavailable";
        }
        if (!canContinue()) return;
      }
      if (lookup === "unavailable") {
        // Temporary: the row stays in its retry, and a last attempt is settled when its time comes.
        this.noticeMetric(kind, "E_ADDRESS_UNAVAILABLE", "retry", attempt.attempt);
        continue;
      }
      const to = lookup.address;
      if (to === null) {
        this.ctx.storage.transactionSync(() => this.notices.settle(kind, attempt.onAt, "failed"));
        this.noticeMetric(kind, "E_NO_ADDRESS", "failed", attempt.attempt);
        continue;
      }
      const check = await noticeAddressCheck(to);
      if (!canContinue()) return;
      if (check !== attempt.addressCheck) {
        this.ctx.storage.transactionSync(() => this.notices.settle(kind, attempt.onAt, "paused"));
        this.noticeMetric(kind, "E_ADDRESS_CHANGED", "paused", attempt.attempt);
        continue;
      }
      if (!canContinue() || !this.notices.current(attempt)) continue;
      const outcome = await cloudflareSender(this.env.EMAIL, from).send(to, noticeMessage(kind, origin));
      if (!canContinue()) return;
      if (outcome.ok) {
        this.ctx.storage.transactionSync(() => this.notices.settle(kind, attempt.onAt, "sent"));
        this.noticeMetric(kind, null, "ok", attempt.attempt);
      } else if (!outcome.retry || attempt.attempt >= MAX_NOTICE_ATTEMPTS) {
        this.ctx.storage.transactionSync(() => this.notices.settle(kind, attempt.onAt, "failed"));
        this.noticeMetric(kind, outcome.code, "failed", attempt.attempt);
      } else this.noticeMetric(kind, outcome.code, "retry", attempt.attempt);
    }
  }

  // ---------------------------------------------------------------- saved answers and application kits
  // The owner's saved answers, and one kit per job of what they will send. Only the owner's calls
  // below, the export and the deletion of a job reach the store: test/unit/saved-answers-reach.test.ts
  // holds it there. A kit's answers are never facts or evidence, and no answer's text reaches a
  // model: the judge, where it is switched on, is given an employer's question and the labels alone.

  private get kits(): ApplicationKitStore {
    return new ApplicationKitStore(this.sql);
  }

  /** Every saved answer, each with what today's list says of it. */
  async listSavedAnswers(who: Who): Promise<SavedAnswer[]> {
    this.requireOwner(who);
    return this.kits.listSaved();
  }

  /** Adds a saved answer, or returns the one with the same label and words. */
  async addSavedAnswer(who: Who, input: SavedAnswerInput): Promise<SavedAnswer> {
    this.requireOwner(who);
    return this.ctx.storage.transactionSync(() => this.kits.addSaved(input, Date.now()));
  }

  /** Replaces a saved answer's label and words at the revision it was read at. Every kit using it is a draft again. */
  async editSavedAnswer(who: Who, id: string, input: SavedAnswerInput, expectedRevision: number): Promise<SavedAnswer> {
    this.requireOwner(who);
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const saved = this.kits.editSaved(id, input, expectedRevision, now);
      this.kits.resetKitsUsing(id, now);
      return saved;
    });
  }

  /** Deletes a saved answer. Questions matched to it ask again, and every kit using it is a draft again. */
  async deleteSavedAnswer(who: Who, id: string): Promise<void> {
    this.requireOwner(who);
    this.ctx.storage.transactionSync(() => this.kits.deleteSaved(id, Date.now()));
  }

  /** A job's kit, with every check worked out now. A job with no kit yet has one at revision 0. */
  async getKit(who: Who, applicationId: string): Promise<KitView> {
    this.requireOwner(who);
    this.kitJob(applicationId);
    return this.kitView(applicationId);
  }

  /**
   * Replaces a kit's questions with these, in this order. A question whose words are unchanged
   * keeps its answer; one that is new or reworded is matched again: the closed list first, then a
   * label word for word, then (switched on only) the judge, given the question and the labels.
   * The judge is asked between two checks, and its answer is used only if no saved answer changed
   * while it was asked.
   */
  async saveKitQuestions(who: Who, applicationId: string, input: KitQuestionsUpdate): Promise<KitView> {
    this.requireOwner(who);
    const submitted = cleanKitQuestions((input as { questions?: unknown } | null)?.questions);
    if (!submitted) throw new AppError("invalid", KIT_QUESTIONS_REFUSED);
    const expected = (input as { expectedRevision?: unknown }).expectedRevision;
    // What each question is, decided from the kit and the saved answers as they are when it runs.
    const decide = () => {
      this.kitJob(applicationId);
      if ((this.kits.kit(applicationId)?.revision ?? 0) !== expected) throw new AppError("conflict", KIT_CHANGED);
      const held = new Map(this.kits.questions(applicationId).map((row) => [row.id, row]));
      if (submitted.some((question) => question.id !== null && !held.has(question.id))) throw new AppError("invalid", KIT_QUESTIONS_REFUSED);
      const usable = this.kits.usableSaved();
      const questions = submitted.map((question) => {
        const was = question.id === null ? undefined : held.get(question.id);
        if (was && was.question === question.text) return { kept: was } as const;
        return { fresh: question, decided: classifyDeterministic(question.text, usable) } as const;
      });
      return { questions, usable, digest: this.kits.savedDigest() };
    };
    const before = decide();
    const unsettled = [...new Set(before.questions.flatMap((question) => ("fresh" in question && question.decided === null ? [question.fresh.text] : [])))];
    const labels = before.usable.map((saved) => ({ id: saved.id, label: saved.label }));
    const judged =
      unsettled.length > 0 && this.env.APPLICATION_KIT_ENABLED === "true" && labels.length > 0
        ? await this.askKitJudge(applicationId, unsettled.map((text) => ({ key: text, text })), labels, () => this.requireOwner(who))
        : new Map<string, KitMatchAnswer>();
    this.requireOwner(who);
    return this.ctx.storage.transactionSync(() => {
      const now = decide();
      // The labels the judge chose from are the ones every saved answer has now, or its answer is none.
      const sameSaved = now.digest === before.digest;
      const rows = now.questions.map((question) => {
        if ("kept" in question) {
          const { applicationId: _job, position: _was, ...kept } = question.kept!;
          return kept;
        }
        const base: Omit<KitQuestionRecord, "applicationId" | "position"> = {
          id: question.fresh.id ?? crypto.randomUUID(),
          question: question.fresh.text,
          state: "asks",
          matchedBy: null,
          savedAnswerId: null,
          confirmedRevision: null,
          sensitiveKind: null,
          typedAnswer: null,
        };
        const decided = question.decided;
        if (decided?.state === "sensitive") return { ...base, state: "sensitive" as const, sensitiveKind: decided.kind };
        if (decided?.state === "matched") return { ...base, state: "matched" as const, matchedBy: "label" as const, savedAnswerId: decided.savedAnswerId };
        const answer = sameSaved ? judged.get(question.fresh.text) : undefined;
        if (answer?.kind === "refused") return { ...base, state: "sensitive" as const, sensitiveKind: "judge" as const };
        const chosen = answer?.kind === "label" ? labels[answer.index] : undefined;
        if (chosen && now.usable.some((saved) => saved.id === chosen.id))
          return { ...base, state: "matched" as const, matchedBy: "judge" as const, savedAnswerId: chosen.id };
        return base;
      });
      this.kits.replaceQuestions(applicationId, rows);
      this.kits.touchDraft(applicationId, Date.now());
      return this.kitView(applicationId);
    });
  }

  /**
   * Asks the judge about each question, four at a time, in a `match` run of its own. Best effort:
   * any failure, building the models included, is no answer, so the question asks. Only codes are
   * logged: never a question, a label or an answer. `guard` is the caller's owner check, run after
   * every await: a session that ends between waves fails the run and asks nothing more.
   */
  private async askKitJudge(
    applicationId: string,
    items: { key: string; text: string }[],
    labels: { id: string; label: string }[],
    guard: () => void,
  ): Promise<Map<string, KitMatchAnswer>> {
    const id = crypto.randomUUID();
    let begun = false;
    let finished = false;
    try {
      const m = runModels(this.env, this.vaultId, id, "match", "vault");
      if (!m.matchQuestion) return new Map();
      this.runs.begin({ id, kind: "match", targetId: applicationId, requestKey: `match:${id}`, inputDigest: id, steps: ["match"] });
      begun = true;
      this.runs.claim(id);
      await this.scheduleRunAlarm(Date.now() + 60_000);
      const names = labels.map((label) => label.label);
      const answers = new Map<string, KitMatchAnswer>();
      for (let at = 0; at < items.length; at += 4) {
        guard();
        const wave = items.slice(at, at + 4);
        const results = await Promise.allSettled(wave.map((item) => m.matchQuestion!({ question: item.text, labels: names })));
        results.forEach((result, index) => {
          if (result.status === "fulfilled") answers.set(wave[index]!.key, result.value);
          else console.error("application kit match failed", { code: "kit_match_failed", cause: logErrorCode(result.reason) });
        });
      }
      guard();
      this.runs.commitStep(id, "match", () => {});
      this.runs.finish(id, () => {});
      finished = true;
      return answers;
    } catch (error) {
      console.error("application kit match failed", { code: "kit_match_failed", cause: logErrorCode(error) });
      if (begun && !finished && this.initialised && !this.gone && this.meta("state") === "open") {
        try {
          this.runs.fail(id, "match_failed");
        } catch {
          // The alarm fails a run that is left behind.
        }
      }
      return new Map();
    }
  }

  /** Chooses the kit's resume version, and its letter and preparation if any. Each must pass its gate now. */
  async chooseKitParts(who: Who, applicationId: string, input: KitPartsUpdate): Promise<KitView> {
    this.requireOwner(who);
    const parts = cleanKitParts(input);
    if (!parts) throw new AppError("invalid", KIT_CHOICE_REFUSED);
    return this.ctx.storage.transactionSync(() => {
      this.kitJob(applicationId);
      if ((this.kits.kit(applicationId)?.revision ?? 0) !== input.expectedRevision) throw new AppError("conflict", KIT_CHANGED);
      if (parts.resume) this.kitResume(applicationId, parts.resume);
      if (parts.letter) this.kitDocument(applicationId, parts.letter, "letter");
      if (parts.prep) this.kitDocument(applicationId, parts.prep, "prep");
      this.kits.setParts(applicationId, parts, Date.now());
      return this.kitView(applicationId);
    });
  }

  /** Answers one question: confirms or rejects its match, uses a saved answer, types an answer, or keeps a typed one as a saved answer. */
  async answerKitQuestion(who: Who, applicationId: string, questionId: string, change: KitAnswerChange, expectedRevision: number): Promise<KitView> {
    this.requireOwner(who);
    const read = readKitAnswerChange(change);
    if (!read) throw new AppError("invalid", KIT_ANSWER_REFUSED);
    return this.ctx.storage.transactionSync(() => {
      this.kitJob(applicationId);
      if ((this.kits.kit(applicationId)?.revision ?? 0) !== expectedRevision) throw new AppError("conflict", KIT_CHANGED);
      const question = this.kits.questions(applicationId).find((row) => row.id === questionId);
      if (!question) throw new AppError("not_found", "no such question");
      // A change that doesn't fit the question's state was made from a page that is out of date.
      const stale = () => new AppError("conflict", KIT_CHANGED);
      const never = () => new AppError("invalid", KIT_SENSITIVE_NEVER_SAVED);
      const now = Date.now();
      const matchedTo = (saved: SavedAnswer) =>
        ({ state: "matched", matchedBy: "owner", savedAnswerId: saved.id, confirmedRevision: saved.revision, typedAnswer: null }) as const;
      switch (read.kind) {
        case "confirm": {
          if (question.state !== "matched") throw stale();
          const saved = this.kits.saved(question.savedAnswerId!);
          if (!saved) throw stale();
          if (saved.refusedKind || refusedKind(question.question)) throw never();
          this.kits.answerQuestion(applicationId, question.id, { ...matchedTo(saved), matchedBy: question.matchedBy });
          break;
        }
        case "reject":
          if (question.state !== "matched") throw stale();
          this.kits.answerQuestion(applicationId, question.id, { state: "asks", matchedBy: null, savedAnswerId: null, confirmedRevision: null, typedAnswer: null });
          break;
        case "use": {
          if (question.state === "sensitive") throw never();
          if (question.state !== "asks") throw stale();
          if (refusedKind(question.question)) throw never();
          const saved = this.kits.saved(read.savedAnswerId);
          if (!saved) throw new AppError("not_found", "no such saved answer");
          if (saved.refusedKind) throw never();
          this.kits.answerQuestion(applicationId, question.id, matchedTo(saved));
          break;
        }
        case "type": {
          if (question.state === "matched") throw stale();
          const answer = cleanKitAnswer(read.answer);
          if (!answer) throw new AppError("invalid", KIT_ANSWER_REFUSED);
          this.kits.answerQuestion(applicationId, question.id, { state: question.state, matchedBy: null, savedAnswerId: null, confirmedRevision: null, typedAnswer: answer });
          break;
        }
        case "save": {
          if (question.state === "sensitive") throw never();
          if (question.state !== "asks") throw stale();
          if (refusedKind(question.question)) throw never();
          const saved = this.kits.addSaved({ label: read.label, answer: read.answer }, now);
          this.kits.answerQuestion(applicationId, question.id, matchedTo(saved));
          break;
        }
      }
      this.kits.touchDraft(applicationId, now);
      return this.kitView(applicationId);
    });
  }

  /** Approves a draft kit whose every check passes now. */
  async approveKit(who: Who, applicationId: string, expectedRevision: number): Promise<KitView> {
    this.requireOwner(who);
    return this.ctx.storage.transactionSync(() => {
      this.kitJob(applicationId);
      const kit = this.kits.kit(applicationId);
      if ((kit?.revision ?? 0) !== expectedRevision || kit?.state === "approved") throw new AppError("conflict", KIT_CHANGED);
      const [problem] = this.kitProblems(applicationId);
      if (problem || !kit) {
        const refusal = KIT_PROBLEMS[problem?.code ?? "no_resume"];
        throw new AppError(refusal.code, refusal.sentence);
      }
      this.kits.approve(applicationId, Date.now());
      return this.kitView(applicationId);
    });
  }

  /**
   * What an approved kit's ZIP is made from, if every check still passes: the resume as it
   * prints, the letter and preparation as a copy would show them, and each answer, a matched one
   * in its saved answer's words now.
   */
  async kitArchiveData(who: Who, applicationId: string): Promise<KitArchiveData<RenderData>> {
    this.requireOwner(who);
    return this.ctx.storage.transactionSync(() => {
      const job = this.kitJob(applicationId);
      const kit = this.kits.kit(applicationId);
      if (!kit || kit.state !== "approved" || kit.approvedAt === null) throw new AppError("conflict", KIT_NOT_APPROVED);
      const [problem] = this.kitProblems(applicationId);
      if (problem || !kit.resume) {
        const refusal = KIT_PROBLEMS[problem?.code ?? "no_resume"];
        throw new AppError(refusal.code, refusal.sentence);
      }
      return {
        revision: kit.revision,
        approvedAt: kit.approvedAt,
        job,
        resume: { id: kit.resume.id, render: this.kitResume(applicationId, kit.resume) },
        letter: kit.letter ? this.kitDocument(applicationId, kit.letter, "letter") : null,
        prep: kit.prep ? this.kitDocument(applicationId, kit.prep, "prep") : null,
        answers: this.kits.questions(applicationId).map((question) => ({
          question: question.question,
          answer: question.state === "matched" ? this.kits.saved(question.savedAnswerId!)!.answer : question.typedAnswer!,
        })),
      };
    });
  }

  /** The job a kit is for, or not found. */
  private kitJob(applicationId: string): { title: string | null; company: string | null } {
    const job = this.sql
      .exec<{ title: string | null; company: string | null }>(`SELECT title, company FROM applications WHERE id = ?`, applicationId)
      .toArray()[0];
    if (!job) throw new AppError("not_found", JOB_NOT_FOUND);
    return { title: job.title, company: job.company };
  }

  /** A kit as its owner reads it, with every check worked out now and nothing written. */
  private kitView(applicationId: string): KitView {
    const kit = this.kits.kit(applicationId);
    const saved = new Map(this.kits.listSaved().map((answer) => [answer.id, answer]));
    const questions: KitQuestionView[] = this.kits.questions(applicationId).map((row) => {
      const answer = row.state === "matched" && row.savedAnswerId !== null ? saved.get(row.savedAnswerId) ?? null : null;
      return {
        id: row.id,
        position: row.position,
        text: row.question,
        state: row.state,
        matchedBy: row.matchedBy,
        savedAnswer: answer,
        confirmed: answer !== null && row.confirmedRevision === answer.revision,
        sensitiveKind: row.sensitiveKind,
        typedAnswer: row.typedAnswer,
      };
    });
    const problems = this.kitProblems(applicationId);
    return {
      applicationId,
      revision: kit?.revision ?? 0,
      state: kit?.state ?? "draft",
      approvedAt: kit?.approvedAt ?? null,
      resume: kit?.resume ?? null,
      letter: kit?.letter ?? null,
      prep: kit?.prep ?? null,
      questions,
      choices: this.kitChoices(applicationId),
      problems,
      ready: kit?.state === "approved" && problems.length === 0,
      updatedAt: kit?.updatedAt ?? null,
    };
  }

  /**
   * Why a kit can't be approved or downloaded now, in order. Worked out on every read and never
   * written: a gate that fails after approval (a fact marked sensitive since, say) blocks the kit
   * without changing it.
   */
  private kitProblems(applicationId: string): KitProblem[] {
    const kit = this.kits.kit(applicationId);
    const passes = (check: () => unknown) => {
      try {
        check();
        return true;
      } catch {
        return false;
      }
    };
    const problems: KitProblem[] = [];
    const resume = kit?.resume;
    const letter = kit?.letter;
    const prep = kit?.prep;
    if (!resume) problems.push({ code: "no_resume" });
    else if (!passes(() => this.kitResume(applicationId, resume))) problems.push({ code: "resume_refused" });
    if (letter && !passes(() => this.kitDocument(applicationId, letter, "letter"))) problems.push({ code: "letter_refused" });
    if (prep && !passes(() => this.kitDocument(applicationId, prep, "prep"))) problems.push({ code: "prep_refused" });
    const { refused, unanswered } = this.kitQuestionProblems(applicationId);
    if (refused.length) problems.push({ code: "refused_kind", questionIds: refused });
    if (unanswered.length) problems.push({ code: "unanswered", questionIds: unanswered });
    return problems;
  }

  /**
   * Which of a kit's questions have an answer it can't use, and which have none it can, by ID. The
   * kit's page and Today both count from this, so they agree. It reads the questions alone: no
   * resume, letter or preparation is checked.
   */
  private kitQuestionProblems(applicationId: string): { refused: string[]; unanswered: string[] } {
    const refused: string[] = [];
    const unanswered: string[] = [];
    for (const question of this.kits.questions(applicationId)) {
      if (question.state === "matched") {
        const saved = question.savedAnswerId === null ? null : this.kits.saved(question.savedAnswerId);
        // The list can grow between releases: a match it refuses now is treated as sensitive.
        if (refusedKind(question.question) || saved?.refusedKind) refused.push(question.id);
        else if (!saved || question.confirmedRevision !== saved.revision) unanswered.push(question.id);
      } else if (question.typedAnswer === null) unanswered.push(question.id);
    }
    return { refused, unanswered };
  }

  /**
   * The resume versions, letters and preparation made for this job that can go in a kit now, newest
   * first. Each is gated on every kit read and write, so only the newest MAX_KIT_RESUME_CHOICES
   * resume versions and the newest 200 document versions are looked at.
   */
  private kitChoices(applicationId: string): KitView["choices"] {
    const resumes: KitChoice[] = [];
    for (const row of this.sql
      .exec<{ id: string; version: number; created_at: number }>(
        `SELECT r.id, v.version, v.created_at FROM resumes r JOIN resume_versions v ON v.resume_id = r.id
         WHERE r.application_id = ? AND r.state = 'ready' ORDER BY v.created_at DESC, r.id, v.version DESC LIMIT ?`,
        applicationId, MAX_KIT_RESUME_CHOICES,
      )
      .toArray()) {
      try {
        this.gatedRender(row.id, row.version);
        resumes.push({ id: row.id, version: row.version, createdAt: row.created_at });
      } catch {
        // Not offered: the version fails the gate now.
      }
    }
    const withheld = withheldFacts(this.sql);
    const documents = this.sql
      .exec<{ id: string; kind: string; version: number; data: string; created_at: number }>(
        `SELECT d.id, d.kind, v.version, v.data, v.created_at FROM documents d JOIN document_versions v ON v.document_id = d.id
         WHERE d.application_id = ? AND d.state = 'ready' AND d.kind IN ('letter', 'prep') ORDER BY v.created_at DESC, d.id, v.version DESC LIMIT 200`,
        applicationId,
      )
      .toArray()
      .filter((row) => {
        try {
          return canShareDocument(row.id, row.version, row.kind, parseOrNull<DocumentVersion>(row.data), withheld);
        } catch {
          return false;
        }
      });
    const choice = (row: { id: string; version: number; created_at: number }): KitChoice => ({ id: row.id, version: row.version, createdAt: row.created_at });
    return {
      resumes,
      letters: documents.filter((row) => row.kind === "letter").map(choice),
      preps: documents.filter((row) => row.kind === "prep").map(choice),
    };
  }

  /** A chosen resume version as it prints, or the refusal: not this job's or not finished, or failing the gate now. */
  private kitResume(applicationId: string, part: KitPart): RenderData {
    let row: ResumeRow;
    try {
      row = this.resumeRow(part.id);
    } catch {
      throw new AppError("invalid", KIT_CHOICE_REFUSED);
    }
    if (row.application_id !== applicationId || row.state !== "ready") throw new AppError("invalid", KIT_CHOICE_REFUSED);
    try {
      return this.gatedRender(part.id, part.version);
    } catch (error) {
      if (errorCode(error) === "not_found") throw new AppError("invalid", KIT_CHOICE_REFUSED);
      throw new AppError("conflict", KIT_RESUME_REFUSED);
    }
  }

  /** A chosen letter or preparation as a copy would show it, or the refusal: not this job's, of another kind or unfinished, or failing the gate now. */
  private kitDocument(applicationId: string, part: KitPart, kind: "letter" | "prep"): SharedDocument {
    const row = this.sql
      .exec<{ kind: string; state: string; application_id: string; data: string | null }>(
        `SELECT d.kind, d.state, d.application_id, v.data FROM documents d
         LEFT JOIN document_versions v ON v.document_id = d.id AND v.version = ? WHERE d.id = ?`,
        part.version, part.id,
      )
      .toArray()[0];
    if (!row || row.application_id !== applicationId || row.kind !== kind || row.state !== "ready" || !row.data)
      throw new AppError("invalid", KIT_CHOICE_REFUSED);
    try {
      return sharedDocument(part.id, part.version, kind, parseOrNull<DocumentVersion>(row.data), withheldFacts(this.sql));
    } catch {
      throw new AppError("conflict", KIT_DOCUMENT_REFUSED);
    }
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
    origin: SourceOrigin | undefined,
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
    // A retry of the same request replays its reservation; only a new one is checked.
    if (!store.get(input.requestKey)) this.refuseSecondCopy(input);
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
  /**
   * A second copy of a file the person already uploaded, or of text they already pasted, would only
   * propose the same roles and facts again. Failed readings and completed readings with no evidence
   * may be uploaded or pasted again.
   */
  private refuseSecondCopy(input: UploadDescriptor): void {
    const sha256 = uploadSha256(input);
    if (!sha256) return;
    const copy = this.sql
      .exec<{ filename: string; origin: SourceOrigin }>(
        `SELECT filename, origin FROM sources WHERE sha256 = ? AND state != 'failed'
         AND NOT (state = 'ready' AND EXISTS (
           SELECT 1 FROM extraction_commits WHERE source_id = sources.id AND roles = 0 AND facts = 0
         )) ORDER BY created_at LIMIT 1`,
        sha256,
      )
      .toArray()[0];
    if (copy && input.origin === "paste")
      throw new AppError(
        "conflict",
        copy.origin === "paste"
          ? "You've already pasted this text."
          : `You've already uploaded this text as ${copy.filename}.`,
      );
    if (copy)
      throw new AppError(
        "conflict",
        copy.filename === input.filename
          ? `You've already uploaded ${copy.filename}.`
          : `You've already uploaded this file as ${copy.filename}.`,
      );
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
    const maxBytes = input.origin === "ocr" ? 12 * 1024 * 1024 + 1024 : input.origin === "paste" ? MAX_PASTE_BYTES : MAX_UPLOAD_BYTES;
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
    // Pasted text is stored exactly as the Worker cleaned it, under the name its title gave,
    // and Distill reads it back through the same check.
    if (input.origin === "paste" && (originalFilename !== input.filename || readPastedText(bytes) === null))
      throw new AppError("invalid", "invalid pasted text");
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
    const [digest, keyHash, contentHash] = await Promise.all([
      uploadDescriptorDigest({ filename: originalFilename, contentType: input.contentType, origin: input.origin, parentSourceId: input.parentSourceId }, digestBody),
      sha256(input.r2Key),
      crypto.subtle.digest("SHA-256", bytes),
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
          sha256: contentHash,
        });
        // A same-key, same-size response could belong to a different retry.
        // Require this attempt's metadata and the checksum of the sent bytes.
        if (!result || result.key !== input.r2Key || result.size !== bytes.byteLength ||
            result.customMetadata?.resumatic_cache_attempt !== attemptId ||
            !result.checksums?.sha256 || base64url(result.checksums.sha256) !== base64url(contentHash))
          throw new Error("unexpected R2 acknowledgement");
      } catch {
        // Provider exceptions can contain request details; the attempt is
        // still uncertain, and only a fixed message may cross the RPC boundary.
        throw new AppError("unavailable", "the upload outcome is unresolved");
      }
      // No await between observing the acknowledgement and clearing its fence.
      // This settlement remains allowed after closure, but cannot clear another
      // attempt or resurrect the source.
      if (this.gone || !this.initialised || this.meta("user_id") !== who.userId)
        throw new AppError("unavailable", "the upload acknowledgement requires review");
      this.sql.exec(`DELETE FROM r2_cache_dispatches WHERE attempt_id = ? AND kind = 'source'`, attemptId);
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
            `INSERT INTO sources (id,filename,r2_key,state,run_id,created_at,origin,parent_source_id,extractor,sha256) VALUES (?,?,?,'queued',?,?,?,?,?,?)`,
            id,
            intent.filename,
            intent.r2Key,
            id,
            intent.createdAt,
            intent.origin,
            intent.parentSourceId,
            extractor,
            intent.origin === "ocr" ? null : uploadSha256(input),
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
      origin?: SourceOrigin;
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
        "Resumatic is still reading your other files. Wait for one to finish, then upload this file.",
      );
    if (counts.total >= MAX_SOURCES)
      throw new AppError(
        "quota",
        `You can keep up to ${MAX_SOURCES} files during the beta. Email support@resumatic.app if you need more.`,
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
    return this.readSources();
  }

  /** Capture the source-review screen after reconciliation, in one object turn. */
  async reviewView(who: Who): Promise<Response> {
    this.requireOwner(who);
    await this.rearmPendingRuns();
    this.requireOwner(who);
    await this.reconcileStaleSources();
    this.requireOwner(who);
    const view = this.ctx.storage.transactionSync(() => {
      this.requireOwner(who);
      return { sources: this.readSources(), ...this.copyReviewEntries() };
    });
    return new Response(reviewViewStream(view), { headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
  }

  /** Group only deterministic copies on an explicit owner action. Reads never write decisions. */
  async groupIdenticalCopies(who: Who): Promise<void> {
    this.requireOwner(who);
    if (this.env.IDENTICAL_REVIEW_ENABLED !== "true") throw new AppError("unavailable", "copy review is not enabled");
    this.ctx.storage.transactionSync(() => {
      const roles = this.readRoles(); const facts = this.readFacts();
      const roleOrder = new Map(this.sql.exec<{ id: string }>(`SELECT id FROM roles ORDER BY rowid`).toArray().map((r, i) => [r.id, i]));
      const factOrder = new Map(this.sql.exec<{ id: string }>(`SELECT id FROM facts ORDER BY rowid`).toArray().map((r, i) => [r.id, i]));
      const matches = identicalMatches(
        [...roles].sort((a, b) => roleOrder.get(a.id)! - roleOrder.get(b.id)!),
        [...facts].sort((a, b) => factOrder.get(a.id)! - factOrder.get(b.id)!),
      );
      for (const match of matches) {
        try {
          this.record.proposeLink({ ...match, relation: "same", confirm: true, stamp: {
            proposedBy: "rule", model: null, method: match.kind === "role" ? IDENTICAL_ROLE_METHOD : IDENTICAL_WORDING_METHOD,
            taxonomyVersion: null, confidence: null, shadow: false,
          } });
        } catch (error) {
          // Separated pairs and roles stay apart. Capacity leaves copies visible.
          if (!["conflict", "too_large", "not_found"].includes(errorCode(error) ?? "")) throw error;
        }
      }
    });
  }

  /** Owner-only metadata about deterministic links. No shadow/model judgements are exposed. */
  private copyReviewEntries(): { roles: RoleView[]; facts: FactView[] } {
    let roles = this.readRoles(); let facts = this.readFacts();
    if (this.env.RECORD_PROPOSAL_REVIEW_ENABLED === "true") {
      roles = roles.map((role) => ({ ...role, proposalReviewEnabled: true }));
      facts = facts.map((fact) => ({ ...fact, proposalReviewEnabled: true }));
    }
    if (this.env.IDENTICAL_REVIEW_ENABLED !== "true") return { roles, facts };
    const decorate = <T extends { id: string; revision?: number }>(rows: T[], kind: "role" | "fact"): (T & { copyReview: import("../shared/api").CopyReviewView })[] => {
      const byId = new Map(rows.map((row) => [row.id, row]));
      return rows.map((row) => {
        const links = this.record.links(kind, row.id).filter((link) => link.relation === "same" &&
          link.proposedBy === "rule" && link.method === (kind === "role" ? IDENTICAL_ROLE_METHOD : IDENTICAL_WORDING_METHOD));
        const view = (link: (typeof links)[number]) => ({ id: link.id, from: link.from, to: link.to,
          fromRevision: byId.get(link.from)?.revision ?? 1, toRevision: byId.get(link.to)?.revision ?? 1, decisionVersion: link.decidedAt ?? 0 });
        return { ...row, copyReview: { rootId: this.record.root(kind, row.id),
          links: links.filter((link) => link.state === "confirmed" && link.holds).map(view),
          separations: links.filter((link) => link.state === "rejected" && link.decidedBy === "owner").map(view) } };
      });
    };
    return { roles: decorate(roles, "role"), facts: decorate(facts, "fact") };
  }

  /** Separate or rejoin deterministic copies. An owner can never decide a shadow/model link here. */
  async decideIdenticalCopy(who: Who, id: string, input: { decision: "confirmed" | "rejected"; fromRevision: number; toRevision: number; expectedDecisionVersion: number }): Promise<void> {
    this.requireOwner(who);
    if (this.env.IDENTICAL_REVIEW_ENABLED !== "true") throw new AppError("unavailable", "copy review is not enabled");
    this.ctx.storage.transactionSync(() => {
      const link = this.sql.exec<{ kind: string; from_id: string; to_id: string; method: string; proposed_by: string; shadow: number; relation: string; decided_at: number | null }>(
        `SELECT kind, from_id, to_id, method, proposed_by, shadow, relation, decided_at FROM record_links WHERE id = ?`, id,
      ).toArray()[0];
      if (!link || link.shadow || link.relation !== "same" || link.proposed_by !== "rule" ||
        (link.kind !== "role" && link.kind !== "fact") || link.method !== (link.kind === "role" ? IDENTICAL_ROLE_METHOD : IDENTICAL_WORDING_METHOD)) throw new AppError("not_found", "no such copy link");
      if ((link.decided_at ?? 0) !== input.expectedDecisionVersion)
        throw new AppError("conflict", "The decision about these copies changed. Refresh the page, then try again.");
      const table = link.kind === "role" ? "roles" : "facts";
      const revisions = this.sql.exec<{ id: string; revision: number }>(`SELECT id, revision FROM ${table} WHERE id IN (?, ?)`, link.from_id, link.to_id).toArray();
      if (revisions.find((r) => r.id === link.from_id)?.revision !== input.fromRevision || revisions.find((r) => r.id === link.to_id)?.revision !== input.toRevision)
        throw new AppError("conflict", "These copies changed. Refresh the page, then try again.");
      if (input.decision === "confirmed") {
        if (link.kind === "role") {
          const rows = this.readRoles();
          if (!sameRole(rows.find((r) => r.id === link.from_id)!, rows.find((r) => r.id === link.to_id)!)) throw new AppError("conflict", "These roles are no longer identical.");
        } else {
          const rows = this.readFacts();
          const a = rows.find((r) => r.id === link.from_id)!; const b = rows.find((r) => r.id === link.to_id)!;
          if (a.kind !== b.kind || !sameWording(a.text, b.text)) throw new AppError("conflict", "These facts are no longer identical.");
        }
      }
      this.record.decideLink(id, input.decision);
    });
  }

  /** Existing non-shadow proposals only. No read creates or promotes a judgement. */
  async recordProposals(who: Who): Promise<import("../shared/proposal-review").RecordProposals> {
    this.requireOwner(who);
    if (this.env.RECORD_PROPOSAL_REVIEW_ENABLED !== "true") throw new AppError("unavailable", "proposal review is not enabled");
    return this.ctx.storage.transactionSync(() => {
      const factRows = this.readFacts(); const roleRows = this.readRoles();
      const factById = new Map(factRows.map((fact) => [fact.id, fact]));
      const roleById = new Map(roleRows.map((role) => [role.id, role]));
      const facts = factRows.map((fact) => {
        const split = this.record.split(fact.id);
        return { fact, split, rejectedSplits: this.record.rejectedSplits(fact.id), tags: this.record.tags({ kind: "fact", id: fact.id }),
          partTags: (split?.parts ?? []).map((part) => ({ part, tags: this.record.tags({ kind: "part", id: part.id }) })).filter((row) => row.tags.length > 0) };
      }).filter((row) => row.split !== null || row.rejectedSplits.length > 0 || row.tags.length > 0 || row.partTags.length > 0);
      const roles = roleRows.map((role) => ({ role, tags: this.record.tags({ kind: "role", id: role.id }) })).filter((row) => row.tags.length > 0);
      const offers = this.sql.exec<{ from_id: string }>(
        `SELECT DISTINCT from_id FROM record_links WHERE kind = 'fact' AND proposed_by = 'model' AND shadow = 0 AND relation IN ('same', 'fuller') ORDER BY from_id`,
      ).toArray().flatMap(({ from_id }) => this.record.links("fact", from_id)
        .filter((link) => link.from === from_id && link.proposedBy === "model" && !link.shadow && (link.relation === "same" || link.relation === "fuller"))
        .flatMap((link) => {
          const from = factById.get(link.from); const to = factById.get(link.to);
          return from && to ? [{ link, from, to, fromRole: from.roleId ? roleById.get(from.roleId) ?? null : null,
            toRole: to.roleId ? roleById.get(to.roleId) ?? null : null }] : [];
        }));
      return { facts, roles, offers };
    });
  }

  /** Decide only an existing, visible split or tag, against the subject and decision last shown. */
  async decideRecordProposal(who: Who, kind: "split" | "tag", id: string, input: import("../shared/proposal-review").ProposalDecision): Promise<void> {
    this.requireOwner(who);
    if (this.env.RECORD_PROPOSAL_REVIEW_ENABLED !== "true") throw new AppError("unavailable", "proposal review is not enabled");
    if (kind !== "split" && kind !== "tag") throw new AppError("invalid", "unknown proposal kind");
    this.ctx.storage.transactionSync(() => {
      const row = kind === "split"
        ? this.sql.exec<{ state: string; decided_at: number | null; revision: number }>(
          `SELECT s.state, s.decided_at, f.revision FROM fact_splits s JOIN facts f ON f.id = s.fact_id WHERE s.id = ? AND s.shadow = 0`, id,
        ).toArray()[0]
        : this.sql.exec<{ state: string; decided_at: number | null; revision: number }>(
          `SELECT t.state, t.decided_at, CASE WHEN t.subject_kind = 'role' THEN r.revision ELSE f.revision END AS revision
           FROM record_tags t
           LEFT JOIN roles r ON t.subject_kind = 'role' AND r.id = t.subject_id
           LEFT JOIN fact_parts p ON t.subject_kind = 'part' AND p.id = t.subject_id
           LEFT JOIN fact_splits s ON s.id = p.split_id AND s.shadow = 0 AND s.state <> 'rejected'
           LEFT JOIN facts f ON f.id = CASE WHEN t.subject_kind = 'fact' THEN t.subject_id ELSE s.fact_id END
           WHERE t.id = ? AND t.shadow = 0 AND (r.id IS NOT NULL OR f.id IS NOT NULL)`, id,
        ).toArray()[0];
      if (!row) throw new AppError("not_found", "no such proposal");
      if (row.revision !== input.expectedSubjectRevision || row.state !== input.expectedState || row.decided_at !== input.expectedDecidedAt)
        throw new AppError("conflict", "This proposal changed. Refresh the page, then review it again.");
      if (kind === "split") this.record.decideSplit(id, input.decision);
      else this.record.decideTag(id, input.decision);
    });
  }

  /** An explicit owner choice about two existing lines; never a rewrite or a shadow promotion. */
  async decideSemanticOffer(who: Who, id: string, input: import("../shared/proposal-review").SemanticOfferDecision): Promise<void> {
    this.requireOwner(who);
    if (this.env.RECORD_PROPOSAL_REVIEW_ENABLED !== "true") throw new AppError("unavailable", "proposal review is not enabled");
    this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec<{ state: string; decided_at: number | null; from_revision: number; to_revision: number;
        from_role_revision: number | null; to_role_revision: number | null; from_kind: string; to_kind: string }>(
        `SELECT l.state, l.decided_at, f.revision AS from_revision, t.revision AS to_revision,
           r1.revision AS from_role_revision, r2.revision AS to_role_revision, f.kind AS from_kind, t.kind AS to_kind
         FROM record_links l JOIN facts f ON f.id = l.from_id JOIN facts t ON t.id = l.to_id
         LEFT JOIN roles r1 ON r1.id = f.role_id LEFT JOIN roles r2 ON r2.id = t.role_id
         WHERE l.id = ? AND l.kind = 'fact' AND l.proposed_by = 'model' AND l.shadow = 0 AND l.relation IN ('same', 'fuller')`, id,
      ).toArray()[0];
      if (!row) throw new AppError("not_found", "no such offer");
      if (row.from_revision !== input.expectedFromRevision || row.to_revision !== input.expectedToRevision ||
        row.from_role_revision !== input.expectedFromRoleRevision || row.to_role_revision !== input.expectedToRoleRevision ||
        row.state !== input.expectedState || row.decided_at !== input.expectedDecidedAt)
        throw new AppError("conflict", "This offer or its facts changed. Refresh the page, then review it again.");
      if (input.decision === "confirmed" && row.from_kind !== row.to_kind)
        throw new AppError("conflict", "These facts have different kinds and cannot be joined.");
      this.record.decideLink(id, input.decision);
    });
  }

  // ---------------------------------------------------------------- today
  // What waits for the owner in each room, worked out from their own vault on every request and
  // stored nowhere. It is read after the same reconciliation as the review screen, in one
  // transaction, and holds counts, IDs and names: no fact, comment, question, answer or stored
  // error. It loads with every room, so it reads each file's name and state alone, and each kit's
  // questions for two counts per job. Where each room stands is numbers only: files, roles and facts
  // by review state, jobs by status, open copies and active connected apps.

  private get todayStore(): TodayStore {
    return new TodayStore(this.sql);
  }

  async today(who: Who): Promise<Today> {
    this.requireOwner(who);
    await this.rearmPendingRuns();
    this.requireOwner(who);
    await this.reconcileStaleSources();
    this.requireOwner(who);
    return this.ctx.storage.transactionSync(() => {
      this.requireOwner(who);
      const now = Date.now();
      const since = now - TODAY_RECENT_MS;
      const kits: KitCount[] = [];
      for (const applicationId of this.kits.applicationsWithQuestions()) {
        const { refused, unanswered } = this.kitQuestionProblems(applicationId);
        if (refused.length || unanswered.length) kits.push({ applicationId, unanswered: unanswered.length, sensitive: refused.length });
      }
      // Roles and facts are read once: To check and where Facts stands are counted from the same rows.
      const entries = this.copyReviewEntries();
      const states = countByState(entries);
      return todayView(
        {
          check: proposedBySource(entries),
          sourceNames: this.todayStore.sourceNames(),
          unreadable: this.todayStore.unreadable(),
          comments: this.shareComments.unseenByCopy(),
          suggestions: this.shareComments.waitingSuggestionsByCopy(),
          kits,
          jobNames: this.todayStore.jobNames(kits.slice(0, MAX_TODAY_LIST).map((kit) => kit.applicationId)),
          working: this.todayStore.working(MAX_TODAY_LIST),
          resumesReady: this.todayStore.resumesReady(since, MAX_TODAY_RECENT),
          copiesOpened: this.shares.recentlyOpened(since, MAX_TODAY_RECENT),
          coachComments: this.shareComments.recentByCopy(since, MAX_TODAY_RECENT),
          confirmed: states.confirmed,
          leftOut: states.rejected,
          jobs: this.todayStore.jobsByStatus(),
          copies: this.shares.openCounts(now),
          apps: this.mcpGrants.activeCount(who, now),
        },
        now,
      );
    });
  }

  private readSources(): SourceView[] {
    return this.sql
      .exec<{
        id: string;
        filename: string;
        state: string;
        error: string | null;
        created_at: number;
        proposed: number;
        origin: SourceOrigin;
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
  ): Promise<{ r2Key: string; filename: string; origin: SourceOrigin }> {
    this.requireOwner(who);
    const row = this.sourceRow(sourceId);
    return { r2Key: row.r2_key, filename: row.filename, origin: row.origin };
  }

  // ---------------------------------------------------------------- sources (Distill)

  async sourceInfo(sourceId: string): Promise<{
    r2Key: string;
    filename: string;
    createdAt: number;
    origin: SourceOrigin;
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
      throw new AppError("conflict", "This file hasn't been read yet. Wait for it to finish, then try again.");
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
      throw new AppError("invalid", "This file hasn't been read yet. Wait for it to finish, then try again.");
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
      // The same words carry the mark together, so words already marked sensitive arrive marked.
      // Read before the delete below: when an upload is read again, the only marked copy of a
      // line can be one of the proposals this reading is about to replace.
      const markedWords = new Set<string>();
      for (const id of withheldFacts(this.sql).ids) {
        const marked = this.sql.exec<{ text: string }>(`SELECT text FROM facts WHERE id = ?`, id).toArray()[0];
        const words = marked ? markedWording(marked.text) : "";
        if (words) markedWords.add(words);
      }
      const arrivingMarked: string[] = [];
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
        const id = crypto.randomUUID();
        this.sql.exec(
          `INSERT INTO facts (id, role_id, kind, text, level, evidence_id, source_id, origin, state, updated_at, confidence, review_reasons)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'extracted', 'proposed', ?, ?, ?)`,
          id,
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
        if (markedWords.has(markedWording(f.text))) arrivingMarked.push(id);
      }
      setSensitive(this.sql, arrivingMarked, true);
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

  /** The run reading this upload, still at work. Every call a reading makes on a vault proves it is that run. */
  private requireReading(sourceId: string, runId: string | undefined): void {
    this.requireOpen();
    if (!runId) throw new AppError("invalid", "workflow identity is required");
    if (this.sourceRow(sourceId).run_id !== runId)
      throw new AppError("conflict", "this attempt was superseded");
    const run = this.workflowRun(runId, "distill", sourceId);
    if (!["starting", "running"].includes(run.state))
      throw new AppError("conflict", "this run no longer accepts work");
  }

  /** The lines a reading proposed that could divide into more than one claim. A skill is one item. */
  async splitCandidates(sourceId: string, runId?: string): Promise<{ id: string; text: string }[]> {
    this.requireReading(sourceId, runId);
    // A line marked sensitive is not asked about, so it is never put to the splitter or the judge.
    const withheld = withheldFacts(this.sql).ids;
    return this.sql
      .exec<{ id: string; text: string }>(
        `SELECT id, text FROM facts WHERE source_id = ? AND origin = 'extracted' AND kind <> 'skill' ORDER BY rowid LIMIT 300`,
        sourceId,
      )
      .toArray()
      .filter((line) => !withheld.has(line.id));
  }

  /**
   * Keeps divisions of this upload's lines in shadow: stored to be measured, shown to nobody and
   * read by nothing else. A division worked out against wording a line no longer has is left out.
   */
  async saveShadowSplits(
    sourceId: string,
    runId: string | undefined,
    made: { model: string; method: string },
    splits: { factId: string; line: string; parts: NewPart[] }[],
  ): Promise<{ stored: number }> {
    this.requireReading(sourceId, runId);
    let stored = 0;
    for (const split of splits) {
      if (!this.sql.exec(`SELECT id FROM facts WHERE id = ? AND source_id = ?`, split.factId, sourceId).toArray().length)
        throw new AppError("conflict", "fact is not part of this source");
      try {
        this.record.proposeSplit({
          factId: split.factId,
          line: split.line,
          parts: split.parts,
          stamp: { proposedBy: "model", model: made.model, method: made.method, taxonomyVersion: null, confidence: null, shadow: true },
        });
        stored++;
      } catch (error) {
        // The line changed, or the record refused the parts: either way the line stays whole.
        if (!["conflict", "invalid", "not_found"].includes(errorCode(error) ?? "")) throw error;
      }
    }
    return { stored };
  }

  /**
   * Looks across the whole record for roles and facts that say again, word for word, what an
   * earlier one said, and keeps each finding in shadow: stored to be measured, shown to nobody,
   * merging nothing. It uses no model. What it found before is not stored again.
   */
  async matchShadow(sourceId: string, runId?: string): Promise<{ roles: number; facts: number; stored: number }> {
    this.requireReading(sourceId, runId);
    const roles = this.sql
      .exec<{ id: string; kind: string; org: string; title: string | null; start_date: string | null; end_date: string | null; unknown_end_start_date: string | null }>(
        `SELECT id, kind, org, title, start_date, end_date, unknown_end_start_date FROM roles ORDER BY rowid`,
      )
      .toArray()
      .map((role) => ({ id: role.id, kind: role.kind, org: role.org, title: role.title, startDate: role.start_date, endDate: role.end_date, unknownEndStartDate: role.unknown_end_start_date }));
    const facts = this.sql
      .exec<{ id: string; role_id: string | null; kind: string; text: string }>(`SELECT id, role_id, kind, text FROM facts WHERE NOT EXISTS (SELECT 1 FROM skill_duration_claims d WHERE d.fact_id=facts.id) ORDER BY rowid`)
      .toArray()
      .map((fact) => ({ id: fact.id, roleId: fact.role_id, kind: fact.kind, text: fact.text }));
    const matches = identicalMatches(roles, facts);
    const known = new Set(
      this.sql
        .exec<{ kind: string; from_id: string; to_id: string }>(`SELECT kind, from_id, to_id FROM record_links WHERE shadow = 1 AND relation = 'same'`)
        .toArray()
        .map((link) => `${link.kind} ${link.from_id} ${link.to_id}`),
    );
    let stored = 0;
    for (const match of matches) {
      if (known.has(`${match.kind} ${match.from} ${match.to}`)) continue;
      try {
        this.record.proposeLink({
          kind: match.kind,
          from: match.from,
          to: match.to,
          relation: "same",
          stamp: {
            proposedBy: "rule",
            model: null,
            method: match.kind === "role" ? IDENTICAL_ROLE_METHOD : IDENTICAL_WORDING_METHOD,
            taxonomyVersion: null,
            confidence: null,
            shadow: true,
          },
        });
        stored++;
      } catch (error) {
        // Already matched to another row, or as many links as a row can hold: nothing is lost by leaving it.
        if (!["conflict", "too_large", "not_found"].includes(errorCode(error) ?? "")) throw error;
      }
    }
    return { roles: matches.filter((match) => match.kind === "role").length, facts: matches.filter((match) => match.kind === "fact").length, stored };
  }

  /**
   * The pairs worth asking the judge about: each line this upload proposed, beside the lines
   * nearest to it in meaning that another upload, or the owner, put in the same role. Lines with
   * the same words are left out, since a rule already finds those, and so is any pair that has
   * been linked or offered before. A skill is one item and is never paired.
   */
  async offerCandidates(sourceId: string, runId?: string): Promise<OfferPair[]> {
    this.requireReading(sourceId, runId);
    // Roles alike in every field that names a role are one role here. Any other role is only itself.
    const roleOf = new Map(
      this.sql
        .exec<{ id: string; kind: string; org: string; title: string | null; start_date: string | null; end_date: string | null; unknown_end_start_date: string | null }>(
          `SELECT id, kind, org, title, start_date, end_date, unknown_end_start_date FROM roles`,
        )
        .toArray()
        .map((role) => [
          role.id,
          roleKey({ kind: role.kind, org: role.org, title: role.title, startDate: role.start_date, endDate: role.end_date, unknownEndStartDate: role.unknown_end_start_date }) ?? `only ${role.id}`,
        ]),
    );
    // A line marked sensitive is on neither side of a pair, so it is never put to the judge.
    const withheld = withheldFacts(this.sql).ids;
    const rows = this.sql
      .exec<{ id: string; role_id: string; kind: string; text: string; source_id: string | null; vector: ArrayBuffer }>(
        `SELECT id, role_id, kind, text, source_id, vector FROM facts WHERE kind <> 'skill' AND role_id IS NOT NULL AND vector IS NOT NULL ORDER BY rowid`,
      )
      .toArray()
      .filter((row) => !withheld.has(row.id));
    const linked = new Set(
      this.sql
        .exec<{ from_id: string; to_id: string }>(`SELECT from_id, to_id FROM record_links WHERE kind = 'fact'`)
        .toArray()
        .flatMap((link) => [`${link.from_id} ${link.to_id}`, `${link.to_id} ${link.from_id}`]),
    );
    const others = rows.filter((row) => row.source_id !== sourceId).map((row) => ({ row, unit: toUnit(unpackVector(row.vector)) }));
    const pairs: OfferPair[] = [];
    for (const fact of rows.filter((row) => row.source_id === sourceId)) {
      const unit = toUnit(unpackVector(fact.vector));
      const near = others
        .filter(({ row }) => row.kind === fact.kind && roleOf.get(row.role_id) === roleOf.get(fact.role_id) && !linked.has(`${fact.id} ${row.id}`) && !sameWording(row.text, fact.text))
        .map(({ row, unit: other }) => ({ row, score: cosine(unit, other) ?? -1 }))
        .filter(({ score }) => score >= OFFER_MIN_COSINE)
        .sort((a, b) => b.score - a.score)
        .slice(0, OFFERS_PER_FACT);
      for (const { row } of near) pairs.push({ later: { id: fact.id, text: fact.text }, earlier: { id: row.id, text: row.text } });
      if (pairs.length >= MAX_OFFER_PAIRS) break;
    }
    return pairs.slice(0, MAX_OFFER_PAIRS);
  }

  /**
   * Keeps what the judge found about this upload's lines as offers in shadow: shown to nobody,
   * merging nothing. An offer about wording that either line no longer has is left out.
   */
  async saveShadowOffers(sourceId: string, runId: string | undefined, made: { model: string; method: string }, found: JudgedOffer[]): Promise<{ stored: number }> {
    this.requireReading(sourceId, runId);
    const says = (factId: string) => this.sql.exec<{ text: string }>(`SELECT text FROM facts WHERE id = ?`, factId).toArray()[0]?.text;
    let stored = 0;
    for (const offer of found) {
      if (!this.sql.exec(`SELECT id FROM facts WHERE id IN (?, ?) AND source_id = ?`, offer.from, offer.to, sourceId).toArray().length)
        throw new AppError("conflict", "fact is not part of this source");
      // A judgement is about particular words, and the judge was asked before this was called.
      // Nothing is awaited from here to the link being stored, so no edit can fall between them.
      if (says(offer.from) !== offer.lines.from || says(offer.to) !== offer.lines.to) continue;
      try {
        this.record.proposeLink({
          kind: "fact",
          from: offer.from,
          to: offer.to,
          relation: offer.relation,
          stamp: { proposedBy: "model", model: made.model, method: made.method, taxonomyVersion: null, confidence: null, shadow: true },
        });
        stored++;
      } catch (error) {
        // Already linked another way, or as many links as a fact can hold: nothing is lost by leaving it.
        if (!["conflict", "too_large", "not_found", "invalid"].includes(errorCode(error) ?? "")) throw error;
      }
    }
    return { stored };
  }

  /**
   * What a reading may tag: this upload's first job roles and extracted facts, how many of each
   * it has in all, and the shadow tags each row already holds or another row with the same words
   * holds. A skill is marked as written when its text is, character for character, one item of
   * the line it was read from; the line itself is not given out. A fact marked sensitive is not
   * given out at all. The rows are read as they stand while the upload is read. Nothing is
   * awaited and nothing is written.
   */
  async tagCandidates(sourceId: string, runId?: string): Promise<TagSubjects> {
    this.requireReading(sourceId, runId);
    const roles = this.sql
      .exec<{ id: string; title: string }>(
        `SELECT id, title FROM roles WHERE source_id = ? AND kind = 'job' AND title IS NOT NULL AND title <> '' ORDER BY rowid LIMIT ?`,
        sourceId,
        MAX_TAG_ROLES,
      )
      .toArray();
    // A line marked sensitive is not tagged, so its words are never looked up in the taxonomy or
    // put to the judge. It is left out before the cap, so it takes no other line's place.
    const withheld = withheldFacts(this.sql).ids;
    const usable = this.sql
      .exec<{ id: string; role_id: string | null; kind: string; text: string; revision: number; quote: string | null }>(
        `SELECT f.id, f.role_id, f.kind, f.text, f.revision, e.quote FROM facts f LEFT JOIN evidence e ON e.id = f.evidence_id
         WHERE f.source_id = ? AND f.origin = 'extracted' ORDER BY f.rowid`,
        sourceId,
      )
      .toArray()
      .filter((fact) => !withheld.has(fact.id));
    const facts = usable.slice(0, MAX_TAG_FACTS);
    const total = {
      roles: this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM roles WHERE source_id = ? AND kind = 'job' AND title IS NOT NULL AND title <> ''`, sourceId).one().n,
      facts: usable.length,
    };
    // A tag is a judgement about particular words. One held by any row that says the same words,
    // in this upload or an earlier one, is that judgement already made.
    type Held = { subject_id: string; holder_id: string; concept_id: string; method: string; model: string | null; taxonomy_version: string | null };
    const heldBy = (rows: Held[], returned: readonly { id: string }[]): Map<string, HeldTag[]> => {
      const held = new Map<string, HeldTag[]>(returned.map((row) => [row.id, []]));
      const seen = new Set<string>();
      for (const row of rows) {
        const tag: HeldTag = { conceptId: row.concept_id, method: row.method, model: row.model, taxonomyVersion: row.taxonomy_version, own: row.holder_id === row.subject_id };
        // However many rows say these words, one entry says all that matters of what they hold.
        const key = JSON.stringify([row.subject_id, tag.conceptId, tag.method, tag.model, tag.taxonomyVersion, tag.own]);
        if (seen.has(key)) continue;
        seen.add(key);
        held.get(row.subject_id)?.push(tag);
      }
      return held;
    };
    const roleTags = heldBy(
      this.sql
        .exec<Held>(
          `SELECT r.id AS subject_id, o.id AS holder_id, t.concept_id, t.method, t.model, t.taxonomy_version
           FROM roles r JOIN roles o ON o.kind = 'job' AND o.title = r.title
           JOIN record_tags t ON t.subject_kind = 'role' AND t.subject_id = o.id AND t.shadow = 1
           WHERE r.source_id = ? AND r.kind = 'job' AND r.title IS NOT NULL AND r.title <> ''`,
          sourceId,
        )
        .toArray(),
      roles,
    );
    const factTags = heldBy(
      this.sql
        .exec<Held>(
          `SELECT f.id AS subject_id, o.id AS holder_id, t.concept_id, t.method, t.model, t.taxonomy_version
           FROM facts f JOIN facts o ON o.kind = f.kind AND o.text = f.text
           JOIN record_tags t ON t.subject_kind = 'fact' AND t.subject_id = o.id AND t.shadow = 1
           WHERE f.source_id = ? AND f.origin = 'extracted'`,
          sourceId,
        )
        .toArray(),
      facts,
    );
    const parts: NonNullable<TagSubjects["parts"]> = [];
    for (const fact of usable) {
      const split = this.record.split(fact.id, { shadow: true });
      if (!split) continue;
      for (const part of split.parts) {
        // A mention merely names something. Only verified standalone claims/results can show experience.
        if (part.kind === "mention") continue;
        parts.push({ id: part.id, roleId: fact.role_id, kind: fact.kind, text: part.text, asWritten: false,
          held: this.record.tags({ kind: "part", id: part.id }, { shadow: true }).map((tag) => ({
            conceptId: tag.conceptId, method: tag.method, model: tag.model, taxonomyVersion: tag.taxonomyVersion, own: true,
          })), part: { factId: fact.id, revision: fact.revision, splitId: split.id, line: fact.text, kind: part.kind } });
      }
    }
    return {
      roles: roles.map((role) => ({ id: role.id, title: role.title, held: roleTags.get(role.id) ?? [] })),
      facts: facts.map((fact) => ({
        id: fact.id,
        roleId: fact.role_id,
        kind: fact.kind,
        text: fact.text,
        asWritten: fact.kind === "skill" && skillAsWritten(fact.quote, fact.text),
        held: factTags.get(fact.id) ?? [],
      })),
      ...(parts.length ? { parts: parts.slice(0, Math.max(0, MAX_TAG_FACTS - facts.length)) } : {}),
      total: parts.length ? { ...total, parts: parts.length } : total,
    };
  }

  /**
   * Which of these facts their owner has marked sensitive since the reading read them. The stage
   * asks before every call to the judge about facts, and leaves the marked ones out of it, so a
   * line marked while it is at work is put to the judge no more. It awaits nothing and writes nothing.
   */
  async tagWithheld(sourceId: string, runId: string | undefined, factIds: string[]): Promise<string[]> {
    this.requireReading(sourceId, runId);
    if (!Array.isArray(factIds) || factIds.length > MAX_TAG_FACTS || factIds.some((id) => typeof id !== "string"))
      throw new AppError("invalid", "a reading asks about at most one upload's facts at once");
    const withheld = withheldFacts(this.sql).ids;
    return factIds.filter((id) => withheld.has(id));
  }

  /**
   * Keeps tags a reading decided for this upload's facts and job roles, in shadow: stored to be
   * measured, shown to nobody and read by nothing else. A tag is about particular words, so one
   * decided about words its row no longer has is left out, and so is the rule's tag for a skill
   * that is no longer one item of its line as written. So is a tag for a fact its owner has marked
   * sensitive since it was read. A tag the same decider stored before is left exactly as it is,
   * and so is a word-for-word tag a vector tag names again: the vector tag is left out.
   * What the record itself refuses is counted, and the rest are kept.
   */
  async saveShadowTags(sourceId: string, runId: string | undefined, made: TagMade, tags: ProposedTag[]): Promise<{ stored: number; refused: number }> {
    this.requireReading(sourceId, runId);
    if (!Array.isArray(tags)) throw new AppError("invalid", "tags are proposed for facts and job roles");
    if (tags.length > MAX_TAGS_PER_SAVE) throw new AppError("invalid", "too many tags for one upload");
    for (const tag of tags) {
      if (tag?.method !== TAG_JUDGE_METHOD && tag?.method !== TAG_RULE_METHOD && tag?.method !== TAG_VECTOR_METHOD && tag?.method !== TAG_PART_JUDGE_METHOD && tag?.method !== TAG_PART_VECTOR_METHOD) throw new AppError("invalid", "unknown tagging method");
      if ((tag.subject?.kind !== "fact" && tag.subject?.kind !== "role" && tag.subject?.kind !== "part") || typeof tag.subject.id !== "string")
        throw new AppError("invalid", "tags are proposed for facts and job roles");
      if (tag.subject.kind === "part" && (!tag.parent || typeof tag.parent.factId !== "string" ||
        !Number.isSafeInteger(tag.parent.revision) || tag.parent.revision < 1 || typeof tag.parent.splitId !== "string" ||
        typeof tag.parent.line !== "string" || (tag.method !== TAG_PART_JUDGE_METHOD && tag.method !== TAG_PART_VECTOR_METHOD)))
        throw new AppError("invalid", "part tags require their current parent and split");
    }
    const unstamped = made && typeof made === "object" ? stampProblem(tagStamp(TAG_JUDGE_METHOD, made)) : "a judgement says what made it";
    if (unstamped) throw new AppError("invalid", unstamped);
    // A line marked sensitive is not tagged, even where the mark landed while the judge was being asked about it.
    const withheld = withheldFacts(this.sql).ids;
    let stored = 0;
    let refused = 0;
    for (const tag of tags) {
      if (tag.subject.kind === "requirement") throw new AppError("invalid", "requirements are not person tags");
      // The judge was asked, and the taxonomy read, before this was called. Nothing is awaited
      // from here to the tag being stored, so no edit or mark can fall between these checks and the write.
      if (tag.subject.kind === "part") {
        const parent = tag.parent;
        if (!parent || typeof parent.factId !== "string" || !Number.isSafeInteger(parent.revision) || parent.revision < 1 ||
          typeof parent.splitId !== "string" || typeof parent.line !== "string" ||
          (tag.method !== TAG_PART_JUDGE_METHOD && tag.method !== TAG_PART_VECTOR_METHOD)) { refused++; continue; }
        const fact = this.sql.exec<{ id: string; text: string; revision: number }>(
          `SELECT f.id, f.text, f.revision FROM fact_parts p JOIN fact_splits s ON s.id = p.split_id JOIN facts f ON f.id = s.fact_id
           WHERE p.id = ? AND f.source_id = ? AND s.id = ? AND s.shadow = 1 AND s.state <> 'rejected' AND p.kind IN ('clause', 'result')`,
          tag.subject.id, sourceId, parent.splitId,
        ).toArray()[0];
        if (!fact || fact.id !== parent.factId || fact.revision !== parent.revision || fact.text !== parent.line || withheld.has(fact.id)) { refused++; continue; }
        const part = this.record.split(fact.id, { shadow: true })?.parts.find((part) => part.id === tag.subject.id);
        if (!part || part.kind === "mention" || part.text !== tag.words || part.kind !== parent.kind) { refused++; continue; }
      } else if (tag.subject.kind === "fact") {
        if (tag.method === TAG_PART_JUDGE_METHOD || tag.method === TAG_PART_VECTOR_METHOD) { refused++; continue; }
        const fact = this.sql
          .exec<{ kind: string; text: string; quote: string | null }>(
            `SELECT f.kind, f.text, e.quote FROM facts f LEFT JOIN evidence e ON e.id = f.evidence_id WHERE f.id = ? AND f.source_id = ?`,
            tag.subject.id,
            sourceId,
          )
          .toArray()[0];
        if (!fact) throw new AppError("conflict", "fact is not part of this source");
        if (fact.text !== tag.words || withheld.has(tag.subject.id)) continue;
        if (tag.method === TAG_RULE_METHOD && !(fact.kind === "skill" && skillAsWritten(fact.quote, fact.text))) continue;
      } else {
        const role = this.sql.exec<{ kind: string; title: string | null }>(`SELECT kind, title FROM roles WHERE id = ? AND source_id = ?`, tag.subject.id, sourceId).toArray()[0];
        if (!role) throw new AppError("conflict", "role is not part of this source");
        // Only a job is given an occupation, and the rule is for listed skills: a job's is always asked about.
        if (role.kind !== "job" || role.title !== tag.words || tag.method === TAG_RULE_METHOD || tag.method === TAG_PART_JUDGE_METHOD || tag.method === TAG_PART_VECTOR_METHOD) continue;
      }
      const stamp = tagStamp(tag.method, made);
      // A concept found word for word in the row is that row's from its words. A vector tag for it
      // is left, since proposing it again would restamp the word-for-word row as a vector one.
      if (
        (tag.method === TAG_VECTOR_METHOD || tag.method === TAG_PART_VECTOR_METHOD) &&
        this.sql
          .exec(
            `SELECT 1 FROM record_tags WHERE subject_kind = ? AND subject_id = ? AND concept_id = ? AND shadow = 1 AND method IN (?, ?, ?)`,
            tag.subject.kind,
            tag.subject.id,
            tag.conceptId,
            TAG_JUDGE_METHOD,
            TAG_RULE_METHOD,
            TAG_PART_JUDGE_METHOD,
          )
          .toArray().length > 0
      )
        continue;
      // Found before, by the same decider against the same taxonomy: the row stays as it was stored.
      const before =
        typeof tag.conceptId === "string" &&
        this.sql
          .exec(
            `SELECT id FROM record_tags WHERE subject_kind = ? AND subject_id = ? AND concept_id = ? AND shadow = 1
             AND taxonomy_version IS ? AND method = ? AND model IS ?`,
            tag.subject.kind,
            tag.subject.id,
            tag.conceptId,
            stamp.taxonomyVersion,
            stamp.method,
            stamp.model,
          )
          .toArray().length > 0;
      if (before) continue;
      try {
        this.record.proposeTag({ subject: { kind: tag.subject.kind, id: tag.subject.id }, conceptId: tag.conceptId, conceptKind: tag.conceptKind, label: tag.label, stamp });
        stored++;
      } catch (error) {
        // Not a tag the record stores, or as many tags as the row can hold: this one is left, and the rest are kept.
        if (!["conflict", "invalid", "too_large", "not_found"].includes(errorCode(error) ?? "")) throw error;
        refused++;
      }
    }
    return { stored, refused };
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
      throw new AppError("conflict", "This role changed since you opened it. Refresh the page, then try again.");
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
        "This role changed since you opened it. Refresh the page, then try again.",
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

  /**
   * The owner's own view of their facts, and their export: every fact, a marked one saying so.
   * It feeds nothing generated, copied or shown to anyone else. That is `usableFacts()`.
   */
  private readFacts(state?: ReviewState): FactView[] {
    const where = `WHERE NOT EXISTS (SELECT 1 FROM skill_duration_claims d WHERE d.fact_id=f.id)${state ? " AND f.state = ?" : ""}`;
    const params = state ? [state] : [];
    const marked = withheldFacts(this.sql).ids;
    return this.sql
      .exec<FactRow>(
        `SELECT f.id, f.role_id, f.kind, f.text, f.level, f.level_revision, f.origin, f.state, f.source_id, f.revision, f.confidence, f.review_reasons, e.quote, e.start, e.end, s.origin AS evidence_origin, i.document_id AS interview_document_id, i.question_id AS interview_question_id, i.question AS interview_question, i.quote AS interview_quote
         FROM facts f LEFT JOIN evidence e ON e.id = f.evidence_id LEFT JOIN sources s ON s.id = f.source_id LEFT JOIN interview_answers i ON i.fact_id = f.id ${where}
         ORDER BY f.updated_at DESC`,
        ...params,
      )
      .toArray()
      .map((row) => (marked.has(row.id) ? { ...factView(row), sensitive: true } : factView(row)));
  }

  /** Confirms or rejects roles and facts by ID. Confirming a fact confirms its role; rejecting a role rejects its proposed facts. */
  async review(who: Who, r: ReviewRequest): Promise<void> {
    this.requireOwner(who);
    this.requireOrdinaryFacts([...r.confirm, ...r.reject]);
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
            "Your facts changed. Refresh the page, then review again.",
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
          throw new AppError("conflict", "Confirm the role before confirming its facts.");
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

  /**
   * Marks facts sensitive, or unmarks them, with every fact that has the same words, whatever its
   * review state: each upload brings its own copy of a line, and a copy left unmarked would put
   * the words back in use unseen. Only the owner does this. The mark changes nothing a line may
   * claim, so no revision moves and no model is called; it is read where facts are chosen and
   * where finished work is sent out.
   */
  async markSensitive(who: Who, r: SensitiveRequest): Promise<void> {
    this.requireOwner(who);
    const ids = r?.ids;
    if (Array.isArray(ids)) this.requireOrdinaryFacts(ids);
    const expectedRevisions = r?.expectedRevisions ?? {};
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_SENSITIVE_IDS || typeof r.sensitive !== "boolean" ||
        ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length ||
        typeof expectedRevisions !== "object" || Array.isArray(expectedRevisions))
      throw new AppError("invalid", `choose 1 to ${MAX_SENSITIVE_IDS} facts`);
    this.ctx.storage.transactionSync(() => {
      const words = new Set<string>();
      for (const id of ids) {
        const fact = this.sql.exec<{ text: string }>(`SELECT text FROM facts WHERE id = ?`, id).toArray()[0];
        if (!fact) throw new AppError("not_found", "no such fact");
        const own = markedWording(fact.text);
        if (own) words.add(own);
      }
      for (const [id, expected] of Object.entries(expectedRevisions)) {
        const current = this.sql.exec<{ revision: number }>(`SELECT revision FROM facts WHERE id = ?`, id).toArray()[0];
        if (!current || current.revision !== expected)
          throw new AppError("conflict", "Your facts changed. Refresh the page, then try again.");
      }
      // The facts named, and every other fact that says the same words.
      const targets = new Set(ids);
      for (const fact of this.sql.exec<{ id: string; text: string }>(`SELECT id, text FROM facts`).toArray())
        if (words.has(markedWording(fact.text))) targets.add(fact.id);
      setSensitive(this.sql, targets, r.sensitive);
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
    this.requireOrdinaryFacts([id]);
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
    url: string | null = null,
    /** What the posting's page calls the job. The analysis may still rename it, as for any job the person hasn't named. */
    name: { title: string | null; company: string | null } = { title: null, company: null },
  ): Promise<{ applicationId: string }> {
    this.requireOwner(who);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(requestKey))
      throw new AppError("invalid", "invalid request key");
    if (url !== null && !isWebUrl(url)) throw new AppError("invalid", "Enter the job's web address, starting with https://.");
    const title = name.title?.trim() || null;
    const company = name.company?.trim() || null;
    if ([title, company].some((value) => value !== null && (value.length > MAX_JOB_NAME_CHARS || /[\r\n]/.test(value))))
      throw new AppError("invalid", "keep the job's title and company to one line each");
    // A request without a link, and one without a name, keep the digests they had before each
    // existed, so a retry that spans the upgrade still finds its job.
    const named = title !== null || company !== null;
    const digest = base64url(await sha256(JSON.stringify(
      named ? [jdText, url, title, company] : url === null ? [jdText] : [jdText, url],
    )));
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
        `INSERT INTO applications (id, jd_text, url, title, company, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        id, jdText, url, title, company, Date.now(),
      );
      this.sql.exec(
        `INSERT INTO application_create_requests (request_key, input_digest, application_id) VALUES (?, ?, ?)`,
        requestKey, digest, id,
      );
      return { applicationId: id };
    });
  }

  /** The saved job whose posting has the same text, if there is one. Nothing is written. */
  async findDuplicateApplication(who: Who, jdText: string): Promise<ApplicationRef | null> {
    this.requireOwner(who);
    const wanted = normalizePosting(jdText);
    const row = this.sql
      .exec<ApplicationRow>(`SELECT * FROM applications ORDER BY created_at DESC`)
      .toArray()
      .find((a) => normalizePosting(a.jd_text) === wanted);
    return row
      ? { id: row.id, company: row.company, title: row.title, excerpt: excerptOf(row.jd_text), createdAt: row.created_at }
      : null;
  }

  /** One job with its whole posting. */
  async getApplication(who: Who, id: string): Promise<ApplicationDetail> {
    const view = (await this.listApplications(who)).find((a) => a.id === id);
    this.requireOwner(who);
    const row = this.sql.exec<ApplicationRow>(`SELECT * FROM applications WHERE id = ?`, id).toArray()[0];
    if (!view || !row) throw new AppError("not_found", JOB_NOT_FOUND);
    return { ...view, jdText: row.jd_text, canDelete: !this.applicationHasWork(id) };
  }

  /** Resumes and documents are kept, so a job that has either can only be closed. */
  private applicationHasWork(id: string): boolean {
    return ["resumes", "documents", "document_requests"].some(
      (table) => this.sql.exec(`SELECT 1 FROM ${table} WHERE application_id = ? LIMIT 1`, id).toArray().length > 0,
    );
  }

  /**
   * Removes a job that has nothing attached to it: a posting pasted by mistake, or a second copy.
   * A job with a resume or a document is refused, because their history, files and shared copies
   * would have to go with it; the person marks it Closed instead.
   */
  async deleteApplication(who: Who, id: string): Promise<void> {
    this.requireOwner(who);
    this.ctx.storage.transactionSync(() => {
      if (!this.sql.exec(`SELECT 1 FROM applications WHERE id = ?`, id).toArray().length)
        throw new AppError("not_found", JOB_NOT_FOUND);
      if (this.applicationHasWork(id))
        throw new AppError("conflict", "This job has resumes or documents, so it can't be deleted. Mark it Closed instead.");
      this.sql.exec(`DELETE FROM application_create_requests WHERE application_id = ?`, id);
      // A kit is not work that keeps a job: its chosen resume already does. It goes with the job.
      this.kits.deleteKit(id);
      this.sql.exec(`DELETE FROM applications WHERE id = ?`, id);
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
        url: a.url,
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

  async tailorWithSkillClaims(who: Who, applicationId: string, claimIds: string[], requestKey: string) {
    this.requireSkillYears(who);
    if (!Array.isArray(claimIds) || claimIds.length > MAX_SELECTED_SKILL_CLAIMS ||
        claimIds.some((id) => typeof id !== "string" || !id || id.length > 100) || new Set(claimIds).size !== claimIds.length)
      throw new AppError("invalid", "Choose distinct current skill totals.");
    return this.tailorWithGuard(who, applicationId, requestKey, () => this.requireSkillYears(who), [...claimIds].sort());
  }

  /** The connected-app guard is rechecked after external reconciliation and before any new run. */
  private async tailorWithGuard(
    who: Who,
    applicationId: string,
    requestKey: string,
    guard: () => void,
    skillDurationClaimIds: string[] = [],
  ): Promise<{ resumeId: string; runId: string }> {
    guard();
    this.requireOwner(who);
    const app = this.sql
      .exec<ApplicationRow>(
        `SELECT * FROM applications WHERE id = ?`,
        applicationId,
      )
      .toArray()[0];
    if (!app) throw new AppError("not_found", JOB_NOT_FOUND);
    const key = `tailor:${requestKey}`;
    const inputDigest = skillDurationClaimIds.length ? JSON.stringify([applicationId, skillDurationClaimIds]) : applicationId;
    const replay = () => {
      const previous = this.runs.findRequest(key);
      if (!previous) return null;
      if (previous.inputDigest !== inputDigest)
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
        .some((r) => GENERATION_RUN_KINDS.includes(r.kind))
    ) {
      throw new AppError(
        "conflict",
        "Another resume or document is still being made, and Resumatic works on one at a time. Wait for it to finish, then try again.",
      );
    }
    const quota = this.quota();
    if (quota.used + (quota.reserved ?? 0) >= quota.limit)
      throw new AppError(
        "quota",
        `You've used all ${quota.limit} tailored resumes for ${monthLabel(quota.month)}. You can tailor more from ${resetDay(quota.month)}.`,
      );
    const id = crypto.randomUUID();
    this.runs.begin(
      {
        id,
        kind: "tailor",
        targetId: id,
        requestKey: key,
        inputDigest,
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
            ...(this.env.TAILOR_CONCEPTS_ENABLED === "true" ? { conceptEvidence: captureConceptEvidence(this.sql, this.usableFacts()) } : {}),
            ...(skillDurationClaimIds.length ? { skillDurationClaimIds } : {}),
          },
          [...this.usableFacts(), ...this.skillYears.selectedFacts(skillDurationClaimIds, withheldFacts(this.sql).ids)],
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
      try { assertGroundedResume(saved.render, saved.facts, saved.provenance, saved.evidence, saved.roleEvidence, { ids: new Set(), quotes: new Set(), invalidDerived: withheldFacts(this.sql).invalidDerived }); }
      catch { needsGroundingReview = true; }
    }
    // Its owner still reads a version that uses a fact marked since, and is told which lines and
    // skills keep it from being downloaded or shared. That is not a version needing review.
    const sensitive = saved ? sensitiveUse(saved.render.body, saved.facts, saved.evidence, withheldFacts(this.sql)) : null;
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
      ...(saved?.conceptCoverage ? { conceptCoverage: saved.conceptCoverage } : {}),
      // The sheet in the app prints the same contact details as this version's PDF.
      ...(saved ? { profile: saved.render.profile } : {}),
      provenance: saved?.provenance,
      ...(needsGroundingReview ? { needsGroundingReview: true } : {}),
      ...(sensitive && (sensitive.lineIds.length > 0 || sensitive.skills.length > 0) ? { sensitiveUse: sensitive } : {}),
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
      if (row.state !== "ready" || !row.body) throw new AppError("conflict", "This resume isn't ready yet. Wait for tailoring to finish, then try again.");
      if (row.version === expectedVersion + 1) {
        const saved = this.snapshots.read(resumeId, row.version);
        if (saved?.provenance === "legacy" && saved.reviewStartedFrom === expectedVersion)
          return { version: row.version };
      }
      if (row.version !== expectedVersion) throw new AppError("conflict", "This resume changed since you opened it. Refresh the page, then try again.");
      if (this.runs.listPending().some((run) => GENERATION_RUN_KINDS.includes(run.kind)))
        throw new AppError("conflict", "Another resume or document is still being made, and Resumatic works on one at a time. Wait for it to finish, then try again.");
      const base = this.resumeVersion(row);
      if (base.provenance !== "snapshot") throw new AppError("conflict", "This resume is already being checked line by line.");
      let blocked = false;
      try { assertGroundedResume(base.render, base.facts, base.provenance, base.evidence, base.roleEvidence); }
      catch { blocked = true; }
      if (!blocked) throw new AppError("conflict", "This resume doesn't need a line-by-line check.");
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
      if (row.state !== "ready" || !row.body) throw new AppError("conflict", "This resume isn't ready yet. Wait for tailoring to finish, then try again.");
      if (row.version === expectedVersion + 1) {
        const saved = this.snapshots.read(resumeId, row.version);
        if (saved?.provenance === "legacy" && saved.legacyRemoved?.fromVersion === expectedVersion && saved.legacyRemoved.lineId === lineId)
          return { version: row.version };
      }
      if (row.version !== expectedVersion) throw new AppError("conflict", "This resume changed since you opened it. Refresh the page, then try again.");
      if (this.runs.listPending().some((run) => GENERATION_RUN_KINDS.includes(run.kind)))
        throw new AppError("conflict", "Another resume or document is still being made, and Resumatic works on one at a time. Wait for it to finish, then try again.");
      const base = this.resumeVersion(row);
      if (base.provenance !== "legacy") throw new AppError("conflict", "Only a version being checked line by line can remove a line.");
      const body = structuredClone(base.render.body);
      const matches = Number(body.summary?.id === lineId) + body.sections.reduce((n, section) => n + section.lines.filter((line) => line.id === lineId).length, 0);
      if (matches !== 1) throw new AppError("conflict", "That line can't be found in this version. Refresh the resume, then try again.");
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

  /** Remove a whole section from a new review version, retaining immutable history. */
  removeLegacySection(who: Who, resumeId: string, sectionIndex: number, expectedVersion: number): { version: number } {
    this.requireOwner(who);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !Number.isSafeInteger(sectionIndex) || sectionIndex < 0)
      throw new AppError("invalid", "the section and resume version are required");
    const result = this.ctx.storage.transactionSync(() => {
      this.requireOwner(who);
      const row = this.resumeRow(resumeId);
      if (row.state !== "ready" || !row.body) throw new AppError("conflict", "This resume isn't ready yet. Wait for tailoring to finish, then try again.");
      if (row.version === expectedVersion + 1) {
        const saved = this.snapshots.read(resumeId, row.version);
        if (saved?.provenance === "legacy" && saved.legacySectionRemoved?.fromVersion === expectedVersion && saved.legacySectionRemoved.sectionIndex === sectionIndex)
          return { version: row.version };
      }
      if (row.version !== expectedVersion) throw new AppError("conflict", "This resume changed since you opened it. Refresh the page, then try again.");
      if (this.runs.listPending().some((run) => GENERATION_RUN_KINDS.includes(run.kind)))
        throw new AppError("conflict", "Another resume or document is still being made, and Resumatic works on one at a time. Wait for it to finish, then try again.");
      const base = this.resumeVersion(row);
      if (base.provenance !== "legacy") throw new AppError("conflict", "Only a version being checked line by line can remove a section.");
      const body = structuredClone(base.render.body);
      const section = body.sections[sectionIndex];
      if (!section || !Array.isArray(section.lines))
        throw new AppError("conflict", "That section can't be found in this version. Refresh the resume, then try again.");
      const receipts = { ...base.legacyReceipts };
      for (const line of section.lines) if (line && typeof line.id === "string") delete receipts[line.id];
      body.sections.splice(sectionIndex, 1);
      const version = row.version + 1;
      this.snapshots.save(resumeId, version, {
        ...base, render: { ...base.render, body, version }, legacyReceipts: receipts,
        legacySectionRemoved: { fromVersion: expectedVersion, sectionIndex },
      });
      this.sql.exec(`UPDATE resumes SET body=?,version=? WHERE id=?`, JSON.stringify(body), version, resumeId);
      return { version };
    });
    this.broadcast("resume", resumeId);
    return result;
  }

  /** Remove a skill from a new review version, retaining prior versions and receipts. */
  removeLegacySkill(who: Who, resumeId: string, skillIndex: number, expectedVersion: number): { version: number } {
    this.requireOwner(who);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || expectedVersion >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(skillIndex) || skillIndex < 0)
      throw new AppError("invalid", "the skill and resume version are required");
    const result = this.ctx.storage.transactionSync(() => {
      this.requireOwner(who);
      const row = this.resumeRow(resumeId);
      if (row.state !== "ready" || !row.body) throw new AppError("conflict", "This resume isn't ready yet. Wait for tailoring to finish, then try again.");
      if (row.version === expectedVersion + 1) {
        const saved = this.snapshots.read(resumeId, row.version);
        if (saved?.provenance === "legacy" && saved.legacySkillRemoved?.fromVersion === expectedVersion && saved.legacySkillRemoved.skillIndex === skillIndex)
          return { version: row.version };
      }
      if (row.version !== expectedVersion) throw new AppError("conflict", "This resume changed since you opened it. Refresh the page, then try again.");
      if (this.runs.listPending().some((run) => GENERATION_RUN_KINDS.includes(run.kind)))
        throw new AppError("conflict", "Another resume or document is still being made, and Resumatic works on one at a time. Wait for it to finish, then try again.");
      const base = this.resumeVersion(row);
      if (base.provenance !== "legacy") throw new AppError("conflict", "Only a version being checked line by line can remove a skill.");
      const body = structuredClone(base.render.body);
      if (!Array.isArray(body.skills) || skillIndex >= body.skills.length)
        throw new AppError("conflict", "That skill can't be found in this version. Refresh the resume, then try again.");
      body.skills.splice(skillIndex, 1);
      const version = row.version + 1;
      this.snapshots.save(resumeId, version, {
        ...base, render: { ...base.render, body, version },
        legacySkillRemoved: { fromVersion: expectedVersion, skillIndex },
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
      if (row.state !== "ready" || !row.body) throw new AppError("conflict", "This resume isn't ready yet. Wait for tailoring to finish, then try again.");
      if (row.version === expectedVersion + 1) {
        const saved = this.snapshots.read(resumeId, row.version);
        if (saved?.provenance === "snapshot" && saved.lineRemoved?.fromVersion === expectedVersion && saved.lineRemoved.lineId === lineId)
          return { version: row.version };
      }
      if (row.version !== expectedVersion) throw new AppError("conflict", "This resume changed since you opened it. Refresh the page, then try again.");
      if (this.runs.listPending().some((run) => GENERATION_RUN_KINDS.includes(run.kind)))
        throw new AppError("conflict", "Another resume or document is still being made, and Resumatic works on one at a time. Wait for it to finish, then try again.");
      const base = this.resumeVersion(row);
      // A deletion must never promote a blocked or legacy version into a checked one.
      assertGroundedResume(base.render, base.facts, base.provenance, base.evidence, base.roleEvidence);
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
      assertGroundedResume(saved.render, saved.facts, saved.provenance, saved.evidence, saved.roleEvidence);
      this.snapshots.save(resumeId, version, saved);
      this.sql.exec(`UPDATE resumes SET body=?,report=?,version=? WHERE id=?`, JSON.stringify(body), JSON.stringify(report), version, resumeId);
      return { version };
    });
    this.broadcast("resume", resumeId);
    return result;
  }

  /** Remove one printed skill from a checked resume without changing prior versions. */
  removeResumeSkill(who: Who, resumeId: string, skillIndex: number, expectedVersion: number): { version: number } {
    this.requireOwner(who);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || expectedVersion >= Number.MAX_SAFE_INTEGER ||
        !Number.isSafeInteger(skillIndex) || skillIndex < 0)
      throw new AppError("invalid", "the skill and resume version are required");
    const result = this.ctx.storage.transactionSync(() => {
      this.requireOwner(who);
      const row = this.resumeRow(resumeId);
      if (row.state !== "ready" || !row.body) throw new AppError("conflict", "This resume isn't ready yet. Wait for tailoring to finish, then try again.");
      if (row.version === expectedVersion + 1) {
        const saved = this.snapshots.read(resumeId, row.version);
        if (saved?.provenance === "snapshot" && saved.skillRemoved?.fromVersion === expectedVersion && saved.skillRemoved.skillIndex === skillIndex)
          return { version: row.version };
      }
      if (row.version !== expectedVersion) throw new AppError("conflict", "This resume changed since you opened it. Refresh the page, then try again.");
      if (this.runs.listPending().some((run) => GENERATION_RUN_KINDS.includes(run.kind)))
        throw new AppError("conflict", "Another resume or document is still being made, and Resumatic works on one at a time. Wait for it to finish, then try again.");
      const base = this.resumeVersion(row);
      // Removing a skill cannot turn a legacy or otherwise blocked version
      // into a checked version; both snapshots must pass the export guard.
      assertGroundedResume(base.render, base.facts, base.provenance, base.evidence, base.roleEvidence);
      const body = structuredClone(base.render.body);
      if (skillIndex >= body.skills.length) throw new AppError("conflict", "the skill is missing");
      body.skills.splice(skillIndex, 1);
      const version = row.version + 1;
      const saved: ResumeVersion = {
        ...base, render: { ...base.render, body, version },
        skillRemoved: { fromVersion: expectedVersion, skillIndex },
      };
      assertGroundedResume(saved.render, saved.facts, saved.provenance, saved.evidence, saved.roleEvidence);
      this.snapshots.save(resumeId, version, saved);
      this.sql.exec(`UPDATE resumes SET body=?,version=? WHERE id=?`, JSON.stringify(body), version, resumeId);
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
      if (row.state !== "ready" || !row.body) throw new AppError("conflict", "This resume isn't ready yet. Wait for tailoring to finish, then try again.");
      if (row.version === expectedVersion + 1) {
        const saved = this.snapshots.read(resumeId, row.version);
        if (saved?.provenance === "snapshot" && saved.legacyFinalizedFrom === expectedVersion)
          return { version: row.version };
      }
      if (row.version !== expectedVersion) throw new AppError("conflict", "This resume changed since you opened it. Refresh the page, then try again.");
      if (this.runs.listPending().some((run) => GENERATION_RUN_KINDS.includes(run.kind)))
        throw new AppError("conflict", "Another resume or document is still being made, and Resumatic works on one at a time. Wait for it to finish, then try again.");
      const base = this.resumeVersion(row);
      const roles = this.confirmedRoles();
      const verified = finalLegacyEvidence(base, this.usableFacts(), roles);
      const version = row.version + 1;
      const saved: ResumeVersion = {
        ...base,
        render: { ...base.render, profile: this.readProfile(), version },
        facts: verified.facts,
        evidence: verified.evidence,
        roleEvidence: evidenceForRoles(roles),
        report: { kept: verified.count, repaired: 0, replaced: 0, dropped: 0, gaps: [] },
        provenance: "snapshot",
        legacyFinalizedFrom: expectedVersion,
      };
      assertGroundedResume(saved.render, saved.facts, saved.provenance, saved.evidence, saved.roleEvidence, withheldFacts(this.sql));
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
      throw new AppError("conflict", "This resume isn't ready yet. Wait for tailoring to finish, then try again.");
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
    return this.gatedRender(resumeId, version);
  }

  /**
   * A ready resume version as it prints, if it passes the gate now. PDF, Word, the print preview, a
   * connected app's read and an application kit all come through here. A version that uses a fact
   * marked sensitive is refused before any cached file is looked for.
   */
  private gatedRender(resumeId: string, version?: number): RenderData {
    const row = this.resumeRow(resumeId);
    if (row.state !== "ready" || !row.body)
      throw new AppError("conflict", "This resume isn't ready yet. Wait for tailoring to finish, then try again.");
    const saved = this.resumeVersion(row, version);
    assertGroundedResume(saved.render, saved.facts, saved.provenance, saved.evidence, saved.roleEvidence, withheldFacts(this.sql));
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
    // A finished run only repeats what it already published. One still at work stops here.
    if (run?.state !== "succeeded") this.requireNothingWithheld(id);
    const input = this.snapshots.metadata(id);
    if (!input)
      throw new AppError(
        "conflict",
        "this older run has no saved inputs; generate it again",
      );
    return {
      applicationId: input.applicationId,
      ...(input.conceptEvidence !== undefined ? { conceptEvidence: input.conceptEvidence } : {}),
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
    // A title or company the person typed stays theirs. One the analysis didn't find leaves what
    // is there, which for a job read from a link is what the posting's own page calls it.
    this.sql.exec(
      `UPDATE applications SET company = CASE WHEN details_edited = 1 THEN company ELSE COALESCE(?, company) END,
         title = CASE WHEN details_edited = 1 THEN title ELSE COALESCE(?, title) END, requirements = ? WHERE id = ?`,
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
    // No await separates this check from the synchronous commit below.
    if (this.snapshots.metadata(id)?.conceptEvidence !== undefined) this.requireNothingWithheld(id);
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
        const snapshot: ResumeVersion = {
          ...(parseOrNull<Selection>(row.selection)?.concepts ? { conceptCoverage: parseOrNull<Selection>(row.selection)!.concepts } : {}),
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
          roleEvidence: evidenceForRoles(this.snapshots.items<RoleRecord>(id, "role")),
          provenance: "snapshot",
        };
        // Rendering and sharing apply this same deterministic gate. Check it
        // before committing the run so a bad checkpoint cannot consume credit
        // and leave the user with a "ready" resume that cannot be exported.
        assertGroundedResume(snapshot.render, snapshot.facts, snapshot.provenance, snapshot.evidence, snapshot.roleEvidence);
        this.snapshots.save(resumeId, row.version, snapshot);
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
    this.markResumeFailed(resumeId, error, runId);
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
    const grant = this.mcpGrants.create(who, input);
    // A grant is erased by the alarm when it ends, so holding one sets it. Its end is fixed here:
    // nothing later moves it.
    const next = this.mcpGrants.nextAlarm();
    if (next !== null) await this.scheduleRunAlarm(next);
    return grant;
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
      throw new AppError("conflict", "This resume isn't ready yet. Wait for tailoring to finish, then try again.");
    const render = await this.renderData(who, id, resume.version);
    this.requireMcp(claims, "vault:read");
    return {
      id: resume.id,
      version: resume.version,
      body: withoutFindings(render.body),
      provenance: resume.provenance,
    };
  }
  /**
   * Saved jobs for a connected app that was given the jobs permission: enough to name each one
   * and find its resumes. Notes are the person's own, and the posting is long, so neither is sent.
   */
  async mcpJobs(claims: McpClaims, input: { limit?: number }) {
    const who = this.requireMcp(claims, "vault:jobs");
    const jobs = await this.listApplications(who);
    this.requireMcp(claims, "vault:jobs");
    return jobs.slice(0, Math.min(100, Math.max(1, input.limit ?? 50))).map((job) => ({
      id: job.id,
      title: job.title,
      company: job.company,
      excerpt: job.excerpt,
      url: job.url ?? null,
      status: job.status ?? "saved",
      addedAt: job.createdAt,
      resumes: job.resumes.map((resume) => ({ id: resume.id, state: resume.state, createdAt: resume.createdAt })),
    }));
  }

  /**
   * Saves a job a connected app found. A posting that is already saved is returned as it is, so
   * an app that searches every day doesn't fill the list with copies.
   */
  async mcpAddJob(claims: McpClaims, input: { description: string; url: string | null }, requestKey: string) {
    const who = this.requireMcp(claims, "vault:jobs");
    const key = `mcp_${claims.grantId}_${requestKey}`;
    // A retry of the request that made a job gets the same answer, not "already saved".
    const replayed = this.sql.exec(`SELECT 1 FROM application_create_requests WHERE request_key = ?`, key).toArray().length > 0;
    const existing = replayed ? null : await this.findDuplicateApplication(who, input.description);
    this.requireMcp(claims, "vault:jobs");
    if (existing) return { id: existing.id, alreadySaved: true };
    const { applicationId } = await this.addApplicationIdempotent(who, input.description, key, input.url);
    return { id: applicationId, alreadySaved: false };
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

  /**
   * A fit preview of one saved job, for a connected app holding read, jobs and generation together.
   * A preview that is still current (same posting, same usable facts) is returned, whoever asked for
   * it; otherwise one is started, at most once per grant and request key, and the app asks again.
   * Everything from the grant check after the one await to the start happens in one turn, so the
   * checks, the day's count and the run's rows can't be interleaved. Refusals are thrown; states are
   * answers.
   */
  async mcpFit(claims: McpClaims, applicationId: string, requestKey: string): Promise<McpFit> {
    const guard = (): Who => {
      let who: Who | undefined;
      for (const scope of MCP_FIT_SCOPES) who = this.requireMcp(claims, scope);
      return who!;
    };
    guard();
    const key = `mcp_${claims.grantId}_${requestKey}`;
    if (!requestKey || !/^[a-zA-Z0-9_-]{1,100}$/.test(key)) throw new AppError("invalid", "invalid request key");
    const digest = await this.documentDigest(applicationId, { kind: "fit" });
    const who = guard();
    const answer = (state: Exclude<McpFit["state"], "ready">, message: string): McpFit => ({ state, applicationId, message });
    const app = this.sql
      .exec<ApplicationRow>(`SELECT * FROM applications WHERE id = ?`, applicationId)
      .toArray()[0];
    if (!app) throw new AppError("not_found", "no such application");
    const prior = this.runs.findRequest(`document:${key}`);
    if (prior && prior.inputDigest !== digest)
      throw new AppError("conflict", "request key already used with other input");
    // The only facts an app may be told of, read in the same turn as the answer.
    const facts = this.usableFacts();
    const current = this.currentFit(applicationId, app.jd_text, facts);
    if (current) {
      const requirements = fitForApp(current.data, facts);
      return {
        state: "ready",
        applicationId,
        checkedAt: current.createdAt,
        requirements,
        note: requirements.length ? MCP_FIT_TEXT.note : MCP_FIT_TEXT.noRequirements,
      };
    }
    // A preview of this job is under way, whoever started it: never a second one beside it.
    if (this.sql.exec(`SELECT 1 FROM documents WHERE application_id = ? AND kind = 'fit' AND state = 'running' LIMIT 1`, applicationId).toArray().length) {
      await this.rearmPendingRuns();
      guard();
      return answer("preparing", MCP_FIT_TEXT.preparing);
    }
    // This key's run has ended. It is never started again by asking again.
    if (prior) {
      const document = this.sql
        .exec<{ state: string; error: string | null }>(`SELECT state, error FROM documents WHERE id = ?`, prior.targetId)
        .toArray()[0];
      if (document?.state === "ready") return answer("changed", MCP_FIT_TEXT.changed);
      return answer("failed", document?.error === "quota" ? MCP_FIT_TEXT.stopped : MCP_FIT_TEXT.failed);
    }
    if (this.runs.listPending().some((run) => GENERATION_RUN_KINDS.includes(run.kind)))
      return answer("busy", MCP_FIT_TEXT.busy);
    if (this.appFitStartsToday() >= MAX_APP_FIT_STARTS_PER_DAY) return answer("limit", MCP_FIT_TEXT.limit);
    const begun = this.beginDocument(who, applicationId, { kind: "fit" }, key, digest);
    if (begun.replay) return answer("preparing", MCP_FIT_TEXT.preparing);
    this.broadcast("document", begun.id);
    await this.dispatchRun(this.runs.get(begun.id)!);
    guard();
    return answer("preparing", MCP_FIT_TEXT.preparing);
  }

  /**
   * The newest finished fit preview of this job that measured this posting against exactly these
   * facts, each unchanged since. Nothing is measured afresh and nothing stored is changed: a preview
   * stops being current when the posting or the usable facts do, a fact marked sensitive included.
   */
  private currentFit(applicationId: string, jdText: string, facts: FactRecord[]): { createdAt: number; data: unknown } | null {
    const ids = new Set(facts.map((fact) => fact.id));
    for (const row of this.sql
      .exec<{ id: string; created_at: number; data: string }>(
        `SELECT d.id, d.created_at, v.data FROM documents d
         JOIN document_versions v ON v.document_id = d.id AND v.version = d.version
         WHERE d.application_id = ? AND d.kind = 'fit' AND d.state = 'ready'
         ORDER BY d.created_at DESC, d.id LIMIT 5`,
        applicationId,
      )
      .toArray()) {
      if (this.snapshots.metadata(row.id)?.jdText !== jdText || !this.snapshots.factsUnchanged(row.id, ids)) continue;
      let data: unknown = null;
      try {
        data = JSON.parse(row.data);
      } catch {
        // fitForApp refuses what can't be read.
      }
      return { createdAt: row.created_at, data };
    }
    return null;
  }

  /** Fit previews connected apps have started on this account since UTC midnight, the day model spend is counted by. */
  private appFitStartsToday(now = Date.now()): number {
    // GLOB, because `_` is a wildcard in LIKE. The web app's keys are UUIDs, so the owner's own never match.
    return this.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM runs WHERE kind = 'fit' AND request_key GLOB 'document:mcp_*' AND created_at >= ?`,
        Math.floor(now / 86_400_000) * 86_400_000,
      )
      .one().n;
  }

  private get coachClients(): CoachClientStore {
    return new CoachClientStore(this.sql);
  }

  private get shares(): ShareStore {
    return new ShareStore(this.sql, {
      authorizeOwner: (who) => this.requireOwner(who),
      requireOpen: () => this.requireOpen(),
      currentEpoch: () => this.meta("security_epoch") ?? "legacy",
      // Asked for before a copy is read, so a vault that has closed or gone says so as it always
      // has, and is never asked about facts it no longer holds.
      withheld: () => {
        this.requireOpen();
        return withheldFacts(this.sql);
      },
    });
  }

  /**
   * Comments on shared copies. Nothing else reads their table: not tailoring, a check, a copy or a
   * connected app. The suggestion methods below read a suggested wording's row, and only its owner's
   * accepting puts the wording into a check.
   */
  private get shareComments(): ShareCommentStore {
    return new ShareCommentStore(this.sql, this.shares, (who) => this.requireOwner(who), (row, side) => this.suggestionFor(row, side));
  }

  async createShare(
    who: Who,
    selection: {
      factIds: string[];
      resumes: { id: string; version: number }[];
      expiresAt?: number;
      /** The owner's own note of who the link is for. The reader never sees it. */
      label?: string;
      /** True puts the owner's name at the top of the copy. */
      showName?: boolean;
      /** True says which job each shared resume or document was made for. */
      showJobs?: boolean;
      /** Finished cover letters and interview preparation. */
      documents?: { id: string; version: number }[];
      /** The sign-in address of the one account that may act as this copy's coach. */
      coachEmail?: string;
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
        throw new AppError("invalid", "Choose confirmed facts from your record.");
      const roles = this.readRoles();
      // The job a resume is for and the owner's name are left off unless the owner asks for them:
      // where someone is applying is theirs to tell, and a copy of facts alone names nobody.
      // Named as the owner has the job now, which is how the list they chose from names it.
      const jobOf = (applicationId: string) => {
        if (selection.showJobs !== true) return null;
        const job = this.sql
          .exec<{ title: string | null; company: string | null }>(`SELECT title, company FROM applications WHERE id = ?`, applicationId)
          .toArray()[0];
        return job && (job.title || job.company) ? { title: job.title, company: job.company } : null;
      };
      const jobs: Record<string, { title: string | null; company: string | null }> = {};
      const resumes = selection.resumes.map(({ id, version }) => {
        const row = this.resumeRow(id);
        const job = jobOf(row.application_id);
        if (job) jobs[id] = job;
        const { conceptCoverage: _privateCoverage, ...sharedVersion } = this.resumeVersion(row, version);
        return { id, ...sharedVersion };
      });
      const documentJobs: Record<string, { title: string | null; company: string | null }> = {};
      const documents = (selection.documents ?? []).map(({ id, version }) => {
        const row = this.sql
          .exec<{ kind: string; state: string; application_id: string; data: string | null }>(
            `SELECT d.kind, d.state, d.application_id, v.data FROM documents d
             LEFT JOIN document_versions v ON v.document_id = d.id AND v.version = ? WHERE d.id = ?`,
            version, id,
          )
          .toArray()[0];
        if (!row || row.state !== "ready" || !row.data)
          throw new AppError("invalid", "Choose finished cover letters or interview preparation from your record.");
        const job = jobOf(row.application_id);
        if (job) documentJobs[id] = job;
        return { id, version, kind: row.kind, data: JSON.parse(row.data) as DocumentVersion };
      });
      const name = selection.showName === true ? this.readProfile().name : "";
      return this.shares.create(
        who,
        { facts, roles, resumes, documents },
        selection.expiresAt,
        undefined,
        { label: selection.label ?? null, owner: name.trim() ? { name } : null, jobs, documentJobs, coachEmail: selection.coachEmail ?? null },
      );
    });
    await this.scheduleRunAlarm(grant.expiresAt);
    return grant;
  }
  /**
   * The person's finished cover letters and interview preparation, newest first, and whether each
   * can go into a copy. One written before its evidence was kept cannot, and has to be written again.
   */
  async listShareableDocuments(who: Who): Promise<ShareableDocument[]> {
    this.requireOwner(who);
    const withheld = withheldFacts(this.sql);
    return this.sql
      .exec<{ id: string; kind: string; application_id: string; version: number; created_at: number; data: string | null }>(
        `SELECT d.id, d.kind, d.application_id, d.version, d.created_at, v.data FROM documents d
         LEFT JOIN document_versions v ON v.document_id = d.id AND v.version = d.version
         WHERE d.state = 'ready' AND d.kind IN ('letter', 'prep') ORDER BY d.created_at DESC, d.id LIMIT 100`,
      )
      .toArray()
      .map((row) => {
        const data = row.data ? (JSON.parse(row.data) as DocumentVersion) : null;
        const shareable = canShareDocument(row.id, row.version, row.kind, data, withheld);
        return {
          id: row.id,
          kind: row.kind as ShareableDocument["kind"],
          applicationId: row.application_id,
          version: row.version,
          createdAt: row.created_at,
          shareable,
          // Said only when the mark is the one thing in the way, so the owner knows a new one will do.
          ...(!shareable && canShareDocument(row.id, row.version, row.kind, data) ? { usesSensitive: true } : {}),
        };
      });
  }

  async listShares(who: Who) {
    return this.shares.list(who);
  }
  async revokeShare(who: Who, id: string) {
    this.shares.revoke(who, id);
  }
  /**
   * `opened` is true when the reader's page asks for the copy, not when a link is only exchanged.
   * `account` is the signed-in reader, if there is one, as the Worker verified them. It decides
   * only what the copy says about its named coach, never whether the copy can be read.
   */
  async readShare(claims: { grantId: string; epoch: string }, opened = false, account: CoachAccount | null = null) {
    const view = this.shares.read(claims);
    if (opened) this.shares.recordRead(claims.grantId);
    return { ...view, reviewer: this.shares.reviewer(claims, account) };
  }

  // ---------------------------------------------------------------- coaches
  // Three calls reach an owner's vault on behalf of a signed-in reader. Each is given the account
  // the Worker verified, and the grant itself decides whether that account is its named coach.

  async joinShareAsCoach(claims: { grantId: string; epoch: string }, coach: CoachAccount) {
    return this.shares.join(claims, coach);
  }

  async openShareForCoach(grantId: string, coach: CoachAccount) {
    return this.shares.openForCoach(grantId, coach);
  }

  /**
   * The copy itself, for the account that took it up, read in the app with no link and no cookie.
   * One transaction with nothing awaited checks the open vault, the account against the grant, the
   * live grant and its epoch, and that every part rebuilds exactly with nothing marked sensitive,
   * then notes that the copy was opened, as a read through the link does. Every failure is the one
   * `gone` a dead link gives.
   */
  async readShareForCoach(grantId: string, coach: CoachAccount) {
    return this.ctx.storage.transactionSync(() => {
      const { view } = this.shares.copyForCoach(grantId, coach);
      this.shares.recordRead(grantId);
      return { ...view, reviewer: "joined" as const };
    });
  }

  async coachShareStatus(grantId: string, coach: CoachAccount) {
    return this.shares.coachStatus(grantId, coach);
  }

  // Comments on a copy, kept here in its owner's vault. A coach's three calls arrive as the ones
  // above do, with the account the Worker verified, and the grant decides each time. Every call
  // makes its check and its read or write in one transaction with nothing awaited, so a copy that
  // ends takes no comment that was allowed a moment before.

  async coachComments(grantId: string, coach: CoachAccount): Promise<CommentThread[]> {
    return this.ctx.storage.transactionSync(() => this.shareComments.listForCoach(grantId, coach));
  }

  async commentAsCoach(grantId: string, coach: CoachAccount, input: NewShareComment, requestKey: string): Promise<ShareComment> {
    const made = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const made = this.shareComments.addAsCoach(grantId, coach, input, requestKey, now);
      // Only a comment made now marks a notice: a retry gets the earlier row, made before now.
      if (made.createdAt === now && emailConfigured(this.env)) this.notices.note("comment", now);
      return made;
    });
    await this.scheduleNotices();
    return made;
  }

  async removeCommentAsCoach(grantId: string, coach: CoachAccount, id: string): Promise<void> {
    this.ctx.storage.transactionSync(() => this.shareComments.removeAsCoach(grantId, coach, id));
  }

  // The owner's side of the same threads.

  async listShareComments(who: Who): Promise<OwnerCommentThread[]> {
    // The list says where each suggestion's check stands, so it re-arms a run that lost its alarm,
    // as every status read does, and asks again who is calling once that is done.
    this.requireOwner(who);
    await this.rearmPendingRuns();
    return this.ctx.storage.transactionSync(() => this.shareComments.listForOwner(who));
  }

  async replyToShareComment(who: Who, commentId: string, body: string, requestKey: string): Promise<ShareComment> {
    return this.ctx.storage.transactionSync(() => this.shareComments.replyAsOwner(who, commentId, body, requestKey));
  }

  async removeShareComment(who: Who, id: string): Promise<void> {
    this.ctx.storage.transactionSync(() => this.shareComments.removeAsOwner(who, id));
  }

  /**
   * Marks every coach's comment seen. Kept, with its old name and arguments, for a page or Worker
   * from before the page named what it showed, so neither is refused in a mixed rollout.
   */
  async markShareCommentsSeen(who: Who): Promise<void> {
    this.ctx.storage.transactionSync(() => this.shareComments.markAllSeen(who));
  }

  /** Marks seen only the comments the page says it showed, so one written since stays new. */
  async markShownShareCommentsSeen(who: Who, ids: string[]): Promise<void> {
    this.ctx.storage.transactionSync(() => this.shareComments.markSeen(who, ids));
  }

  // Suggested wording. A coach writes it as they write a comment, through the copy and nothing
  // else; it reads no resume. Its owner accepts it as their own verified line edit with exactly
  // that wording, or declines it. What the coach is told is worked out from the copy and from the
  // check its owner started, never from the owner's resume as it is now.

  /** A coach's suggested wording for one line of a copy that is open to them now. */
  async suggestOnShare(grantId: string, coach: CoachAccount, input: NewSuggestion, requestKey: string): Promise<ShareComment> {
    const made = this.ctx.storage.transactionSync((): ShareComment => {
      const now = Date.now();
      const { view } = this.shares.copyForCoach(grantId, coach, now);
      if (typeof requestKey !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestKey)) throw new AppError("invalid", "invalid request key");
      const given: { target?: unknown; text?: unknown } = typeof input === "object" && input !== null ? input : {};
      const text = typeof given.text === "string" ? given.text.trim() : "";
      const target = given.target as NewSuggestion["target"] | undefined;
      // A retry of the request that made the suggestion gets it back. The comments' store checks
      // the account and the line; the wording has to be the same exactly.
      const prior = this.sql
        .exec<{ body: string }>(`SELECT body FROM share_comments WHERE request_key = ?`, `suggest_${view.grantId}_${requestKey}`)
        .toArray()[0];
      if (prior) {
        if (prior.body !== text) throw new AppError("conflict", "the request key was already used with different input");
        return this.shareComments.addAsCoach(grantId, coach, { target: target as NewShareComment["target"], body: text }, requestKey, now, "suggest");
      }
      if (text.length < 1 || text.length > MAX_LINE_CHARS || !isVisibleLine(text))
        throw new AppError("invalid", "Suggested wording is one line of up to 300 characters, all of which show on the page.");
      // The line's words are the copy's, never the request's.
      const quote = target?.kind === "line" ? targetText(view.snapshot, target) : null;
      if (!target || quote === null) throw new AppError("invalid", "That line isn't in this copy.");
      // As the copy would print it there: wording that only adds a list marker would leave the line
      // reading as it does, or, accepted, leave the resume as it was while saying it changed.
      if (unchangedWording(view.snapshot, target, text)) throw new AppError("invalid", "That's the wording the line already has.");
      const theirs = this.sql
        .exec<{ suggestion_state: string | null; quote: string; document_id: string | null }>(
          `SELECT suggestion_state, quote, document_id FROM share_comments
           WHERE grant_id = ? AND coach_user_id = ? AND author = 'coach' AND suggestion_state IS NOT NULL
             AND target_kind = 'line' AND resume_id = ? AND resume_version = ? AND target_id = ?`,
          view.grantId, coach.userId, target.resumeId, target.version, target.lineId,
        )
        .toArray();
      if (theirs.some((row) => coachStanding(row, boundCheck(this.sql, row.document_id)) === "waiting"))
        throw new AppError("conflict", "You already have a suggestion waiting on this line. Delete it to suggest another.");
      // Written as a comment is, so the comments' three limits count it, then marked as a suggestion.
      const made = this.shareComments.addAsCoach(grantId, coach, { target, body: text }, requestKey, now, "suggest");
      this.sql.exec(`UPDATE share_comments SET suggestion_state = 'open' WHERE id = ?`, made.id);
      // Only a new suggestion marks a notice. A retry returned above, with the row it made before.
      if (emailConfigured(this.env)) this.notices.note("suggestion", now);
      return { ...made, suggestion: { state: "waiting" } };
    });
    await this.scheduleNotices();
    return made;
  }

  /**
   * The owner accepts a suggestion: their own verified line edit, with the suggestion's exact
   * wording, on the resume the copy's line came from. It is refused before anything is reserved
   * when the check couldn't save its result. Accepting again, with any key, finds the check it
   * started. Everything up to the run's own rows is one transaction with nothing awaited, so two
   * at once can't both start one.
   */
  async acceptSuggestion(who: Who, id: string, requestKey: string): Promise<{ documentId: string; runId: string }> {
    this.requireOwner(who);
    const started = this.ctx.storage.transactionSync(() => {
      this.requireOwner(who);
      const row = this.suggestionRow(id);
      const resume = this.sql.exec<ResumeRow>(`SELECT * FROM resumes WHERE id = ?`, row.resume_id).toArray()[0];
      const base = resume?.state === "ready" && resume.body ? this.resumeVersion(resume) : undefined;
      const standing = ownerStanding(row, boundCheck(this.sql, row.document_id), lineAsShown(base?.render.body, row.target_id));
      if ((standing === "checking" || standing === "applied" || standing === "not_applied") && row.document_id)
        return { id: row.document_id, replay: true };
      if (standing !== "waiting" && standing !== "stale") throw new AppError("conflict", "You've already answered this suggestion.");
      if (standing === "stale" || !resume || !base)
        throw new AppError("conflict", "This line has changed since the copy was made, so this suggestion can't be applied.");
      const cannotCheck = () =>
        new AppError(
          "conflict",
          "A fact this resume uses has changed or is no longer in use, or the version is still being checked line by line, so this wording can't be checked. Tailor a new version or finish checking it, then accept again.",
        );
      // The checked path would refuse at its finish what isn't true now, after spending an output.
      // So the version has to pass the gate, cite only facts in use, sit under confirmed roles and
      // print only skills in use, and the new line has to merge as the finish will merge it.
      try {
        assertGroundedResume(base.render, base.facts, base.provenance, base.evidence, base.roleEvidence, withheldFacts(this.sql));
      } catch {
        throw cannotCheck();
      }
      const usable = this.usableFacts();
      const roles = this.confirmedRoles();
      const factIds = new Set(usable.map((fact) => fact.id));
      const roleIds = new Set(roles.map((role) => role.id));
      const body = base.render.body;
      const lines = [...(body.summary ? [body.summary] : []), ...body.sections.flatMap((section) => section.lines)];
      if (lines.some((line) => line.factIds.some((factId) => !factIds.has(factId))) ||
          body.sections.some((section) => !roleIds.has(section.roleId)) ||
          body.skills.some((skill) => !usable.some((fact) => fact.kind === "skill" && fact.text === skill)))
        throw cannotCheck();
      const next = structuredClone(body);
      const change = (line: ResumeLine): ResumeLine =>
        line.id === row.target_id ? rewritten(line, { text: row.body, factIds: line.factIds, status: "kept" }) : line;
      if (next.summary) next.summary = change(next.summary);
      for (const section of next.sections) section.lines = section.lines.map(change);
      try {
        mergeRefinementEvidence(base, next, usable, roles);
      } catch {
        throw cannotCheck();
      }
      // The digest names the suggestion alone. The web app keeps a key until a reply reaches it, and
      // sends nothing that tells one press from the next, so a key whose reply was lost can come back
      // after the resume has moved on. It is the same request, and gets the check it started, which
      // settles the key; with the version in the digest it would be refused on every press.
      const begun = this.beginDocument(
        who,
        resume.application_id,
        { kind: "refine", resumeId: resume.id, expectedVersion: resume.version, lineIds: [row.target_id], manualText: row.body },
        `suggestion_${row.id}_${requestKey}`,
        `suggestion:${row.id}`,
      );
      // A replayed key never rebinds the row: the check it names is the one that key started.
      if (!begun.replay) this.sql.exec(`UPDATE share_comments SET document_id = ? WHERE id = ?`, begun.id, row.id);
      return begun;
    });
    if (!started.replay) await this.dispatchRun(this.runs.get(started.id)!);
    return { documentId: started.id, runId: started.id };
  }

  /** The owner declines a suggestion. Declining again changes nothing; one being checked, or already checked, can't be. */
  async declineSuggestion(who: Who, id: string): Promise<void> {
    this.requireOwner(who);
    this.ctx.storage.transactionSync(() => {
      this.requireOwner(who);
      const row = this.suggestionRow(id);
      const standing = ownerStanding(row, boundCheck(this.sql, row.document_id), currentLine(this.sql, row.resume_id, row.target_id));
      if (standing === "declined") return;
      if (standing === "checking")
        throw new AppError("conflict", "This suggestion is being checked. Wait for the check to finish, then try again.");
      if (standing === "applied" || standing === "not_applied") throw new AppError("conflict", "You've already answered this suggestion.");
      this.sql.exec(`UPDATE share_comments SET suggestion_state = 'declined' WHERE id = ?`, row.id);
    });
  }

  /** A suggestion in this vault, by ID. Call it only for the owner. */
  private suggestionRow(id: string) {
    const row = typeof id === "string"
      ? this.sql
          .exec<{ id: string; resume_id: string | null; target_id: string; quote: string; body: string; suggestion_state: string | null; document_id: string | null }>(
            `SELECT id, resume_id, target_id, quote, body, suggestion_state, document_id FROM share_comments
             WHERE id = ? AND author = 'coach' AND target_kind = 'line' AND suggestion_state IS NOT NULL`,
            id,
          )
          .toArray()[0]
      : undefined;
    if (!row) throw new AppError("not_found", "That suggestion has been deleted. Reload to see the thread as it stands.");
    return row;
  }

  /**
   * Where a suggestion stands, for the comments' store to show. Its coach is told one of three
   * things, from the row and its check alone. Its owner is told more: the line as it is now, the
   * version the wording went into, why a check ended without a verdict, and a start not confirmed.
   */
  private suggestionFor(row: Record<string, SqlStorageValue>, side: "coach" | "owner"): ShareSuggestion {
    const suggested = { suggestion_state: typeof row.suggestion_state === "string" ? row.suggestion_state : null, quote: String(row.quote) };
    const documentId = typeof row.document_id === "string" ? row.document_id : null;
    const check = boundCheck(this.sql, documentId);
    if (side === "coach") return { state: coachStanding(suggested, check) };
    const lineNow = currentLine(this.sql, typeof row.resume_id === "string" ? row.resume_id : null, String(row.target_id));
    const state = ownerStanding(suggested, check, lineNow);
    const version = state === "applied" && documentId ? appliedVersion(this.sql, documentId) : undefined;
    return {
      state,
      ...(version !== undefined ? { appliedVersion: version } : {}),
      ...(state === "waiting" && check ? { lastCheck: check.error === "conflict" ? ("changed" as const) : ("unfinished" as const) } : {}),
      ...(state === "checking" && this.dispatchUncertain(documentId) ? { startUnconfirmed: true } : {}),
    };
  }

  // The rest are the coach's own list, in the coach's own vault.

  /** Refuses a copy the list has no room for. Asked before the copy's owner's vault is told of a take-up. */
  async requireCoachClientRoom(who: Who, grantId: string): Promise<void> {
    this.requireOwner(who);
    this.coachClients.requireRoom(grantId);
  }

  async addCoachClient(who: Who, client: Omit<CoachClientEntry, "addedAt">): Promise<void> {
    this.requireOwner(who);
    this.coachClients.add(client);
    // An entry is cleared by the alarm, so holding one sets it.
    const next = this.coachClients.nextAlarm();
    if (next !== null) await this.scheduleRunAlarm(next);
  }

  async listCoachClients(who: Who): Promise<CoachClientEntry[]> {
    this.requireOwner(who);
    return this.coachClients.list();
  }

  async coachClient(who: Who, grantId: string): Promise<CoachClientEntry | null> {
    this.requireOwner(who);
    return this.coachClients.get(grantId);
  }

  async removeCoachClient(who: Who, grantId: string): Promise<void> {
    this.requireOwner(who);
    this.coachClients.remove(grantId);
  }

  async updateApplication(
    who: Who,
    id: string,
    patch: {
      status?: import("../shared/api").ApplicationStatus;
      appliedAt?: string | null;
      notes?: string;
      title?: string | null;
      company?: string | null;
      url?: string | null;
      jdText?: string;
      expectedRevision?: number;
    },
  ): Promise<void> {
    this.requireOwner(who);
    const row = this.sql
      .exec<ApplicationRow>(`SELECT * FROM applications WHERE id = ?`, id)
      .toArray()[0];
    if (!row) throw new AppError("not_found", JOB_NOT_FOUND);
    if (
      patch.expectedRevision !== undefined &&
      row.revision !== patch.expectedRevision
    )
      throw new AppError(
        "conflict",
        "This job changed. Refresh the page, then try again.",
      );
    if (patch.url != null && !isWebUrl(patch.url))
      throw new AppError("invalid", "Enter the job's web address, starting with https://.");
    const named = patch.title !== undefined || patch.company !== undefined;
    const posting = patch.jdText !== undefined && patch.jdText !== row.jd_text ? patch.jdText : null;
    if (posting !== null) {
      // A run reads the posting once at its start and saves what it found afterwards. Changing
      // the text under it would leave the old posting's requirements beside the new text.
      const running = this.sql.exec(
        `SELECT 1 FROM resumes WHERE application_id = ? AND state = 'running' UNION ALL
         SELECT 1 FROM documents WHERE application_id = ? AND state = 'running' LIMIT 1`, id, id,
      ).toArray().length > 0;
      if (running) throw new AppError("conflict", "Work on this job is still in progress. Wait for it to finish, then change the job description.");
    }
    // What was read from an earlier posting says nothing about a new one.
    const stale = posting !== null && row.details_edited !== 1;
    const title = patch.title !== undefined ? patch.title : stale ? null : row.title;
    const company = patch.company !== undefined ? patch.company : stale ? null : row.company;
    // Clearing both names hands the job back to be read from its posting.
    const edited = (named || row.details_edited === 1) && (title !== null || company !== null);
    this.sql.exec(
      `UPDATE applications SET status = ?, applied_at = ?, notes = ?, title = ?, company = ?, url = ?,
         jd_text = ?, requirements = ?, details_edited = ?, revision = revision + 1 WHERE id = ?`,
      patch.status ?? row.status,
      patch.appliedAt === undefined ? row.applied_at : patch.appliedAt,
      patch.notes ?? row.notes,
      title,
      company,
      patch.url === undefined ? row.url : patch.url,
      posting ?? row.jd_text,
      posting !== null ? null : row.requirements,
      edited ? 1 : 0,
      id,
    );
  }

  async startDocument(
    who: Who,
    applicationId: string,
    options: NewDocument,
    requestKey: string,
  ): Promise<{ documentId: string; runId: string }> {
    const digest = await this.documentDigest(applicationId, options);
    const begun = this.beginDocument(who, applicationId, options, requestKey, digest);
    if (!begun.replay) await this.dispatchRun(this.runs.get(begun.id)!);
    return { documentId: begun.id, runId: begun.id };
  }

  /** What a request for a document is known by when the same request arrives again. */
  private async documentDigest(applicationId: string, options: NewDocument): Promise<string> {
    return base64url(
      await sha256(JSON.stringify([applicationId, options])),
    );
  }

  /**
   * Checks a request for a document and begins its run. It awaits nothing: every refusal and the
   * run's own rows happen in one turn, so no caller can pass between a check and the write, and a
   * caller may hold a transaction of its own around it. `replay` is true when this request had
   * already begun a run, which is then not dispatched again.
   */
  private beginDocument(who: Who, applicationId: string, options: NewDocument, requestKey: string, digest: string): { id: string; replay: boolean } {
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
    if (!app) throw new AppError("not_found", JOB_NOT_FOUND);
    const key = `document:${requestKey}`;
    const existing = this.runs.findRequest(key);
    if (existing) {
      if (existing.inputDigest !== digest)
        throw new AppError(
          "conflict",
          "request key already used with other input",
        );
      return { id: existing.id, replay: true };
    }
    if (
      this.runs
        .listPending()
        .some((r) =>
          GENERATION_RUN_KINDS.includes(r.kind),
        )
    )
      throw new AppError("conflict", "Another resume or document is still being made, and Resumatic works on one at a time. Wait for it to finish, then try again.");
    let base: ResumeVersion | undefined;
    if (options.kind === "refine") {
      if (!options.resumeId)
        throw new AppError("invalid", "choose a resume to refine");
      const resume = this.resumeRow(options.resumeId);
      if (resume.application_id !== applicationId || resume.state !== "ready")
        throw new AppError(
          "invalid",
          "This resume isn't ready for this job yet.",
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
        assertGroundedResume(base.render, base.facts, base.provenance, base.evidence, base.roleEvidence);
      // A fact marked sensitive is evidence for nothing, so it can't be chosen to check a line. A
      // checked version that already uses one is refined no further, by an instruction or by a line
      // edit: the new version would carry those lines on. Its owner removes them first.
      const withheld = withheldFacts(this.sql);
      if (options.manualFactIds?.some((factId) => withheld.ids.has(factId)))
        throw new AppError("invalid", "Choose facts you don't keep private.");
      if (base.provenance === "snapshot") {
        const used = sensitiveUse(base.render.body, base.facts, base.evidence, withheld);
        if (used.lineIds.length > 0 || used.skills.length > 0)
          throw new AppError("conflict", "This version uses a fact you keep private. Remove those lines or tailor a new version, then try again.");
      }
    }
    const skillDurationClaimIds = base?.evidence ? Object.values(base.evidence).filter((f) => f.skillDuration && base!.render.body.skills.includes(f.text)).map((f) => f.skillDuration!.claimId) : [];
    if (skillDurationClaimIds.length) this.requireSkillYears(who);
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
        ...(FREE_DOCUMENT_KINDS.includes(options.kind) ? {} : { quota: this.quotaBucket() }),
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
            ...(this.env.TAILOR_CONCEPTS_ENABLED === "true" ? { conceptEvidence: captureConceptEvidence(this.sql, this.usableFacts()) } : {}),
            ...(skillDurationClaimIds.length ? { skillDurationClaimIds } : {}),
          },
          [...this.usableFacts(), ...this.skillYears.selectedFacts(skillDurationClaimIds, withheldFacts(this.sql).ids)],
          this.confirmedRoles(),
          this.vectors(),
        );
      },
    );
    return { id, replay: false };
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
    // A finished run only repeats what it already published. One still at work stops here.
    if (run.state !== "succeeded") this.requireNothingWithheld(runId);
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
      ...(input.conceptEvidence !== undefined ? { conceptEvidence: input.conceptEvidence } : {}),
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
    if (this.snapshots.metadata(runId)?.conceptEvidence !== undefined) this.requireNothingWithheld(runId);
    this.workflowRun(runId, "document", runId);
    this.runs.commitStep(runId, step, () => {
      for (const field of ["plan", "draft", "result"] as const)
        if (patch[field] !== undefined)
          this.sql.exec(
            `UPDATE document_requests SET ${field} = ? WHERE run_id = ?`,
            JSON.stringify(patch[field]),
            runId,
          );
      if (patch.plan) {
        // A fit preview is often the first time a posting is read. Keep what was read, so the job
        // has its name and tailoring doesn't read the posting a second time. A name the person
        // typed stays theirs, and a posting already read is left as it was.
        const request = this.sql
          .exec<{ application_id: string; kind: string }>(`SELECT application_id, kind FROM document_requests WHERE run_id = ?`, runId)
          .toArray()[0];
        if (request?.kind === "fit")
          this.sql.exec(
            `UPDATE applications SET company = CASE WHEN details_edited = 1 THEN company ELSE ? END,
               title = CASE WHEN details_edited = 1 THEN title ELSE ? END, requirements = ?
             WHERE id = ? AND requirements IS NULL`,
            patch.plan.analysis.company,
            patch.plan.analysis.title,
            JSON.stringify(patch.plan.analysis.requirements),
            request.application_id,
          );
      }
    });
  }

  async finishDocument(runId: string, result: DocumentResult): Promise<void> {
    this.requireOpen();
    if (this.snapshots.metadata(runId)?.conceptEvidence !== undefined) this.requireNothingWithheld(runId);
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
        if (this.snapshots.metadata(runId)?.conceptEvidence !== undefined) this.requireNothingWithheld(runId);
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
            delete targets[0]!.finding;
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
        // A letter or preparation keeps the full record of each fact it was written from, as a
        // resume does, so its sentences can be checked again before it is shared. A run whose
        // captured facts are incomplete still finishes: the document just can't be shared.
        let evidence: Record<string, FactRecord> | undefined;
        if ((SHAREABLE_DOCUMENT_KINDS as readonly string[]).includes(options.kind)) {
          try {
            evidence = evidenceForFacts(capturedFacts);
          } catch {
            evidence = undefined;
          }
        }
        const plan = this.sql.exec<{ plan: string | null }>(
          `SELECT plan FROM document_requests WHERE run_id=?`, runId,
        ).one().plan;
        const conceptCoverage = plan ? parseOrNull<DocumentPlan>(plan)?.selection.concepts : undefined;
        this.sql.exec(
          `INSERT INTO document_versions (document_id, version, data, created_at) VALUES (?, 1, ?, ?)`,
          runId,
          JSON.stringify({ result, facts, profile: input.profile, ...(evidence ? { evidence } : {}),
            ...(conceptCoverage ? { conceptCoverage } : {}) }),
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
        !DOCUMENT_RUN_KINDS.includes(run.kind) ||
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

  /**
   * Printable words only, checked independently of the owner's inspection view. The snapshot
   * fingerprint binds a later export check to the exact saved version, including its evidence.
   * It is a freshness guard, not a claim of original-source provenance.
   */
  async documentExportData(who: Who, id: string, expected?: { version: number; snapshot: string }): Promise<{ document: SharedDocument; snapshot: string }> {
    this.requireOwner(who);
    const before = this.checkedDocumentExport(id);
    const snapshot = base64url(await sha256(JSON.stringify([before.document.kind, before.document.version, before.saved])));
    // Hashing yields: privacy, withdrawal, the version and the session may all have changed.
    this.requireOwner(who);
    const current = this.checkedDocumentExport(id);
    if (current.document.version !== before.document.version || current.document.kind !== before.document.kind || current.saved !== before.saved ||
        (expected !== undefined && (expected.version !== current.document.version || expected.snapshot !== snapshot)))
      throw new AppError("conflict", "This document changed while preparing the download. Try downloading it again.");
    return { document: current.document, snapshot };
  }

  private checkedDocumentExport(id: string): { document: SharedDocument; saved: string } {
    const row = this.sql.exec<{ kind: string; state: string; version: number; data: string | null }>(
      `SELECT d.kind, d.state, d.version, v.data FROM documents d
       LEFT JOIN document_versions v ON v.document_id = d.id AND v.version = d.version WHERE d.id = ?`, id,
    ).toArray()[0];
    if (!row) throw new AppError("not_found", "no such document");
    if (row.kind !== "letter" && row.kind !== "prep")
      throw new AppError("invalid", "only cover letters and interview preparation can be exported as documents");
    if (row.state !== "ready")
      throw new AppError("conflict", "This document isn't ready yet. Wait for it to finish, then try again.");
    const data = parseOrNull<DocumentVersion>(row.data);
    let document: SharedDocument;
    try { document = sharedDocument(id, row.version, row.kind, data, withheldFacts(this.sql)); }
    catch (error) {
      if (errorCode(error) !== "conflict") throw error;
      throw new AppError("conflict", "This document's saved evidence can't be checked. Write it again before downloading.");
    }
    // Withdrawing an experience item or its role also withdraws it from new downloads. Ordinary
    // edits do not rewrite the immutable evidence saved with this document.
    const usable = new Set(this.usableFacts().map((fact) => fact.id));
    const roles = new Set(this.confirmedRoles().map((role) => role.id));
    const units = data!.result!.units as { factIds: string[] }[]; // sharedDocument checked every unit.
    for (const id of new Set(units.flatMap((unit) => unit.factIds))) {
      const fact = data!.evidence![id]!;
      if (!usable.has(id) || (fact.roleId !== null && !roles.has(fact.roleId)))
        throw new AppError("conflict", "This document uses experience you no longer include. Write it again before downloading.");
    }
    return { document, saved: row.data! };
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
      ...(data?.conceptCoverage ? { conceptCoverage: data.conceptCoverage } : {}),
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

  /** Capture the same export in one turn, then stream it as an RPC response. */
  async exportJson(who: Who): Promise<Response> {
    const data = this.ctx.storage.transactionSync(() => this.exportSnapshot(who));
    return new Response(exportJsonStream(data), { headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="resumatic-export-${data.exportedAt.slice(0, 10)}.json"`,
      "cache-control": "private, no-store",
    } });
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

  /** Capture both archive metadata and JSON in one transaction, then stream them together. */
  async exportArchiveStream(who: Who): Promise<Response> {
    const { data, files } = this.ctx.storage.transactionSync(() => this.exportArchiveSnapshot(who));
    if (files.length > 128)
      throw new AppError("too_large", ARCHIVE_TOO_MANY_FILES);
    const manifestFiles = files.map((file, index) => {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(file.id))
        throw new AppError("unavailable", "a source identifier cannot be exported");
      const extension = file.origin === "ocr" ? "json" : file.filename.split(".").pop()?.toLowerCase();
      const safeExtension = extension && ["pdf", "docx", "zip", "json", "txt"].includes(extension) ? extension : "bin";
      const path = `sources/${file.id}.${safeExtension}`;
      if (data.sources[index]?.id !== file.id) throw new AppError("unavailable", "the source snapshot is incomplete");
      data.sources[index]!.file = path;
      return { id: file.id, key: file.key, path, origin: file.origin };
    });
    const encoder = new TextEncoder();
    let jsonBytes = 0;
    for (const chunk of exportJsonChunks(data)) {
      jsonBytes += encoder.encode(chunk).byteLength;
      if (jsonBytes > MAX_ARCHIVE_BYTES)
        throw new AppError("too_large", ARCHIVE_TOO_LARGE);
    }
    const manifest = encoder.encode(JSON.stringify({ exportedAt: data.exportedAt, jsonBytes, files: manifestFiles }));
    if (manifest.byteLength > 1024 * 1024) throw new AppError("too_large", "archive metadata is too large");
    const prefix = new Uint8Array(4 + manifest.byteLength);
    new DataView(prefix.buffer).setUint32(0, manifest.byteLength, false);
    prefix.set(manifest, 4);
    const reader = exportJsonStream(data).getReader();
    let prefixSent = false;
    return new Response(new ReadableStream({
      type: "bytes",
      async pull(controller) {
        if (!prefixSent) { prefixSent = true; controller.enqueue(prefix); return; }
        try {
          const next = await reader.read();
          if (next.done) controller.close(); else controller.enqueue(next.value);
        } catch (error) { controller.error(error); }
      },
      cancel: (reason) => reader.cancel(reason),
    }, { highWaterMark: 0 }), { headers: { "content-type": "application/octet-stream", "cache-control": "private, no-store" } });
  }

  private exportSnapshot(who: Who): VaultExport {
    this.requireOwner(who);
    return {
      format: 2,
      ...this.skillYears.export(),
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
      coachClients: this.coachClients.export(),
      shareComments: this.shareComments.export(who),
      connectedApps: this.mcpGrants
        .list(who)
        .map(({ oauthGrantId: _remote, ...grant }) => grant),
      billing: this.meta("entitlement")
        ? JSON.parse(this.meta("entitlement")!)
        : null,
      exportedAt: new Date().toISOString(),
      profile: this.readProfile(),
      preferences: this.preferences.read(),
      emailNotices: this.notices.export(),
      ...this.kits.export(),
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
      ...this.record.export(),
      applications: this.sql
        .exec<ApplicationRow>(`SELECT * FROM applications ORDER BY created_at`)
        .toArray()
        .map((a) => ({
          id: a.id,
          company: a.company,
          title: a.title,
          jobDescription: a.jd_text,
          url: a.url,
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
      if (run.kind === "match")
        throw new AppError(
          "conflict",
          "wait for the in-flight answer matching to settle before maintenance",
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
      let object: R2ObjectBody | null;
      try {
        object = await this.env.FILES.get(original);
      } catch {
        throw new AppError("unavailable", "a source file could not be read for copying");
      }
      try {
        this.requireMaintenanceAccess();
      } catch (error) {
        if (object) {
          try { await object.body.cancel(); } catch { /* Preserve the lifecycle error. */ }
        }
        throw error;
      }
      if (!object) throw new AppError("conflict", "a source file is missing");
      let bytes: ArrayBuffer;
      try {
        bytes = await object.arrayBuffer();
      } catch {
        throw new AppError("unavailable", "a source file could not be read for copying");
      }
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
      const put = (async () => {
        try {
          const result = await this.env.FILES.put(row.r2_key, bytes, {
            sha256: digest,
            httpMetadata: object.httpMetadata,
            customMetadata: { ...object.customMetadata, resumatic_cache_attempt: attemptId },
          });
          // A null or inconsistent response is not an acknowledgement of this
          // write. Keep its marker even if a later head finds an object.
          if (!result || result.key !== row.r2_key || result.size !== bytes.byteLength ||
              result.customMetadata?.resumatic_cache_attempt !== attemptId ||
              !result.checksums?.sha256 || base64url(result.checksums.sha256) !== base64url(digest))
            throw new Error("unexpected R2 acknowledgement");
        } catch {
          // Provider messages may contain object names or other private data.
          throw new AppError("unavailable", "the source copy outcome is unresolved");
        }
        // No await between this put's acknowledgement and its settlement;
        // recording it remains safe after the target has been quiesced.
        this.sql.exec(`DELETE FROM r2_cache_dispatches WHERE attempt_id=?`, attemptId);
      })();
      // Preserve the acknowledgement handler after a caller disconnects when
      // the runtime permits. A crash or unknown response still holds the fence.
      this.ctx.waitUntil(put.catch(() => {}));
      await put;
      this.requireMaintenanceAccess();
      let check: R2Object | null;
      try {
        check = await this.env.FILES.head(row.r2_key);
      } catch {
        throw new AppError("unavailable", "a source file could not be verified after copying");
      }
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
    // A client list that came with the content has entries to clear in their time, and a
    // replacement starts with no alarm of its own.
    const next = this.coachClients.nextAlarm();
    if (next !== null) await this.scheduleRunAlarm(next);
    // Email notices that came with the content, a retry among them, are sent from here on.
    const due = this.notices.nextDue();
    if (due !== null && emailConfigured(this.env)) await this.scheduleRunAlarm(Math.max(due, Date.now() + 1000));
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
  /** Read known billing identifiers without starting customer recovery. */
  knownBillingForDeletion(): { customer: string | null; checkoutIds: string[] } {
    if (!this.initialised || this.gone) return { customer: null, checkoutIds: [] };
    return { customer: this.meta("stripe_customer"), checkoutIds: this.billingCheckoutSessionsForDeletion() };
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
    // Saved the first time it is read, but made when the resume was: dated now, an old resume would
    // look newly made to the version list, the kit's choices and Today's recent events.
    this.snapshots.save(row.id, version, legacy, row.created_at);
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
    // A run that captured a fact marked sensitive since sends nothing more to a model.
    this.requireNothingWithheld(runId);
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
    const kinds = kind === "document" ? DOCUMENT_RUN_KINDS : [kind];
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

  /** Metadata-only deletion hint. This snapshot never authorizes erasure or fence removal. */
  deletionFenceSummary(userId: string) {
    if (!this.initialised || this.gone || this.destroying || !hasSchema(this.sql))
      return { status: "unavailable" as const };
    if (this.meta("user_id") !== userId) throw new AppError("forbidden", "not this user's vault");
    if (this.meta("state") !== "closing") throw new AppError("conflict", "vault is not closing");
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ids = (table: "workflow_dispatches" | "workflow_redispatches") => {
      const rows = this.sql.exec<{ run_id: SqlStorageValue }>(
        `SELECT run_id FROM ${table} ORDER BY run_id LIMIT 65`,
      ).toArray();
      if (rows.some((row) => typeof row.run_id !== "string" || !uuid.test(row.run_id))) return null;
      return { ids: rows.slice(0, 64).map((row) => row.run_id as string), truncated: rows.length > 64 };
    };
    const dispatches = ids("workflow_dispatches"), redispatches = ids("workflow_redispatches");
    if (!dispatches || !redispatches) return { status: "unavailable" as const };
    const count = (source: boolean) => {
      const n = this.sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM r2_cache_dispatches WHERE ${source ? "kind = 'source'" : "kind <> 'source'"} LIMIT 1001)`,
      ).one().n;
      return { count: Math.min(n, 1000), truncated: n > 1000 };
    };
    const billingFlag = (key: string): "absent" | "present" | "invalid" => {
      const raw = this.meta(key);
      if (raw === null) return "absent";
      if (!/^(?:0|[1-9]\d*)$/.test(raw)) return "invalid";
      const n = Number(raw);
      return !Number.isSafeInteger(n) ? "invalid" : n === 0 ? "absent" : "present";
    };
    return {
      status: "available" as const,
      workflow: { dispatches, redispatches },
      r2: { sourceWrites: count(true), otherWrites: count(false) },
      billing: {
        customerCreation: billingFlag("billing_customer_dispatches"),
        checkoutCreation: billingFlag("billing_checkout_dispatches"),
      },
    };
  }

  async retryRun(
    who: Who,
    id: string,
    key: string,
  ): Promise<{ runId: string; targetId: string }> {
    return this.retryRunInternal(who, id, key, null);
  }

  /** Distinct RPC name prevents an older Vault silently ignoring this option. */
  async retryRunCurrentExtractorV1(
    who: Who,
    id: string,
    key: string,
    expectedExtractor: string,
  ): Promise<{ runId: string; targetId: string }> {
    if (typeof expectedExtractor !== "string" || !expectedExtractor.startsWith("llm:") || expectedExtractor.length <= 4 || expectedExtractor.length > 200)
      throw new AppError("invalid", "invalid extractor expectation");
    return this.retryRunInternal(who, id, key, expectedExtractor);
  }

  private async retryRunInternal(
    who: Who,
    id: string,
    key: string,
    expectedExtractor: string | null,
  ): Promise<{ runId: string; targetId: string }> {
    this.requireOwner(who);
    const reselect = expectedExtractor !== null;
    const run = this.runs.get(id);
    if (!run || !["failed", "cancelled"].includes(run.state))
      throw new AppError("conflict", "only stopped work can be retried");
    if (reselect && (run.kind !== "distill" || run.state !== "failed"))
      throw new AppError("invalid", "extractor selection requires a failed upload");
    if (run.kind === "tailor") {
      const result = await this.tailor(
        who,
        this.resumeRow(run.targetId).application_id,
        key,
      );
      return { runId: result.runId, targetId: result.resumeId };
    }
    if (DOCUMENT_RUN_KINDS.includes(run.kind)) {
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
    const inputDigest = reselect ? `reselect:${id}:${expectedExtractor}` : id;
    const prior = this.runs.findRequest(requestKey);
    if (prior) {
      if (prior.inputDigest !== inputDigest)
        throw new AppError("conflict", "retry options changed");
      return { runId: prior.id, targetId: prior.targetId };
    }
    const source = this.sourceRow(run.targetId);
    if (source.run_id !== id)
      throw new AppError("conflict", "This file is already being read again.");
    if (reselect && this.sql.exec(
      `SELECT 1 FROM extraction_commits WHERE source_id=?
       UNION ALL SELECT 1 FROM roles WHERE source_id=?
       UNION ALL SELECT 1 FROM facts WHERE source_id=?
       UNION ALL SELECT 1 FROM evidence WHERE source_id=? LIMIT 1`,
      source.id, source.id, source.id, source.id,
    ).toArray().length)
      // Legacy extractions may predate extraction_commits; their rows still
      // bind the source to the old extractor and must not be replaced.
      throw new AppError("conflict", "This file has already been read.");
    const extractor = reselect ? this.extractionStrategy(source.origin, source.filename) : source.extractor;
    if (reselect && extractor !== expectedExtractor)
      throw new AppError("unavailable", "extraction configuration is not consistent");
    if (
      this.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM sources WHERE state='queued'`,
        )
        .one().n >= MAX_QUEUED_SOURCES
    )
      throw new AppError("conflict", "Wait for your other files to finish reading, then try again.");
    const next = crypto.randomUUID();
    this.runs.begin(
      {
        id: next,
        kind: "distill",
        targetId: source.id,
        requestKey,
        inputDigest,
        steps: ["convert", "extract", "embed"],
      },
      () => {
        this.sql.exec(
          `UPDATE sources SET state='queued',error=NULL,run_id=?,extractor=? WHERE id=?`,
          next,
          extractor,
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

  /** Versioned separately so mixed-version Vaults cannot run an ordinary retry. */
  async adminRetryCurrentExtractorV1(id: string, key: string, expectedExtractor: string) {
    this.requireOpen();
    return this.retryRunCurrentExtractorV1(
      {
        userId: this.meta("user_id")!,
        gen: Number(this.meta("session_gen")),
        epoch: this.meta("security_epoch") ?? "legacy",
      },
      id,
      key,
      expectedExtractor,
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
      if (run.kind === "distill")
        this.sql.exec(`UPDATE sources SET state='failed', error=? WHERE id=? AND run_id=? AND state='queued'`, "Reading couldn't be started. Try again.", run.targetId, id);
      else if (run.kind === "tailor")
        this.sql.exec(`UPDATE resumes SET state='failed', error=? WHERE id=? AND run_id=? AND state='running'`, "Tailoring couldn't be started. Try again.", run.targetId, id);
      else if (DOCUMENT_RUN_KINDS.includes(run.kind))
        this.sql.exec(`UPDATE documents SET state='failed', error=? WHERE id=? AND state='running'`, "This document couldn't be started. Try again.", run.targetId);
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
    else if (DOCUMENT_RUN_KINDS.includes(run.kind))
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
    } else if (DOCUMENT_RUN_KINDS.includes(run.kind)) {
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
    // The client list moves with its vault, row for row. A vault fenced for maintenance keeps
    // the list as a move counted it, and clearing waits until the fence is lifted.
    const fenced = isMaintenanceFenced(this.vaultId, this.env.RESTORE_FENCE_IDS);
    if (!fenced) this.coachClients.purge();
    this.mcpGrants.purgeExpired();
    this.sql.exec(
      `DELETE FROM refine_cache WHERE created_at <= ?`,
      Date.now() - REFINE_CACHE_TTL_MS,
    );
    // Keep a stalled R2 delete from preventing independent upload cleanup or
    // Workflow reconciliation. Acknowledgements are still checked against
    // the expired reservation, and unresolved writes keep their existing fence.
    let cleanupIndex = 0;
    const cleanupLanes = Array.from({ length: Math.min(4, uploadsToClean.length) }, async () => {
      while (canContinue()) {
        const intent = uploadsToClean[cleanupIndex++];
        if (!intent) return;
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
          console.error("upload cleanup pending", { code: "upload_cleanup_pending" });
        }
      }
    });
    // One stalled Workflow RPC must not keep every other cancellation and
    // reconciliation from making progress. Each lane rechecks the lifecycle
    // before taking another run; unresolved RPCs and their dispatch fences
    // remain unresolved, and the alarm remains armed before any I/O.
    const pendingRuns = this.runs.listPending();
    let pendingIndex = 0;
    const processPendingRun = async (run: RunRecord): Promise<void> => {
      if (!canContinue()) return;
      if (run.kind === "embed") {
        if (Date.now() - run.createdAt > 600_000)
          this.runs.fail(run.id, "embedding_interrupted");
        return;
      }
      // Asking the judge about a kit's questions runs inside the Vault too, with no Workflow.
      if (run.kind === "match") {
        if (Date.now() - run.createdAt > 600_000)
          this.runs.fail(run.id, "match_interrupted");
        return;
      }
      const binding =
        run.kind === "tailor"
          ? this.env.TAILOR
          : run.kind === "distill"
            ? this.env.DISTILL
            : run.kind === "reembed"
              ? this.env.REEMBED
              : this.env.DOCUMENTS;
      if (!binding) return;
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
              run.id,
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
          if (this.runs.get(run.id)?.state !== "starting") return;
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
    };
    const lanes = Array.from({ length: Math.min(4, pendingRuns.length) }, async () => {
      while (canContinue()) {
        const run = pendingRuns[pendingIndex++];
        if (!run) return;
        await processPendingRun(run);
      }
    });
    // Wait for every lane before returning or throwing, so a failed lane
    // cannot leave unobserved, still-running operations behind.
    const results = await Promise.allSettled([...cleanupLanes, ...lanes]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    if (this.closing || this.gone || !this.initialised || this.meta("state") !== "open") return;
    try {
      await this.sendDueNotices(fenced, canContinue);
    } catch {
      // A notice that couldn't be decided or sent keeps its row as it was left, and the
      // candidates below bring the alarm back for it.
    }
    if (!canContinue()) return;
    const noticeDue = emailConfigured(this.env) ? this.notices.nextDue() : null;
    const expiry = this.sql
      .exec<{ at: number | null }>(
        `SELECT MIN(expires_at) AS at FROM share_grants`,
      )
      .one().at;
    const clientDue = this.coachClients.nextAlarm();
    const candidates = [
      this.runs.listPending().length ? Date.now() + 60_000 : null,
      expiry,
      // A vault has one alarm. Whatever this one fired for, the client list's next entry is still
      // to be cleared at its own time. Under the fence an entry already due is looked at again in
      // a minute, not at once.
      clientDue !== null && fenced ? Math.max(clientDue, Date.now() + 60_000) : clientDue,
      // The same for a connected app's grant. Grants never move with a vault, so the fence does
      // not hold them back.
      this.mcpGrants.nextAlarm(),
      // An email notice's next look. Under the fence nothing is sent, so a due one waits a minute.
      noticeDue !== null && fenced ? Math.max(noticeDue, Date.now() + 60_000) : noticeDue,
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
      throw new AppError("conflict", "This file is no longer being read.");
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
    if (!row) throw new AppError("not_found", "This file can't be found. It may have been deleted.");
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
      throw new AppError("invalid", "That role was left out. Choose another role for this fact.");
  }

  /**
   * Confirmed facts whose role is confirmed, or that belong to no role, without any marked
   * sensitive. This is the only source of facts for anything generated, copied or shown to anyone
   * but the owner: a marked fact is never captured, so it reaches no search, writer, judge or
   * printed skill. A fact read from the same line as a marked one is kept, with its own words as
   * its only evidence, because that line is evidence for nothing while the mark stands.
   */
  private usableFacts(): FactRecord[] {
    const withheld = withheldFacts(this.sql);
    return this.sql
      .exec<FactRow>(
        `SELECT f.id, f.role_id, f.kind, f.text, f.level, f.level_revision, f.origin, f.state, f.source_id, f.revision, e.quote, e.start, e.end
         FROM facts f LEFT JOIN evidence e ON e.id = f.evidence_id LEFT JOIN roles r ON r.id = f.role_id
         WHERE f.state = 'confirmed' AND (f.role_id IS NULL OR r.state = 'confirmed') AND NOT EXISTS (SELECT 1 FROM skill_duration_claims d WHERE d.fact_id=f.id)`,
      )
      .toArray()
      .filter((row) => !withheld.ids.has(row.id))
      .map((row) => ({ ...factRecord(row), quote: usableQuote(row, withheld) }));
  }

  /** A run that captured a fact marked sensitive since, or the line one was read from, goes no further. */
  private requireNothingWithheld(runId: string): void {
    if (this.snapshots.holdsWithheld(runId))
      throw new AppError("conflict", "Your facts changed while this draft was being made. Create it again.");
    const entries = this.snapshots.metadata(runId)?.conceptEvidence;
    if (entries !== undefined) {
      this.snapshots.assertInputsCurrent(runId);
      if (!conceptEvidenceCurrent(this.sql, entries, this.usableFacts()))
        throw new AppError("conflict", "Your facts changed while this draft was being made. Create it again.");
    }
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

  private markResumeFailed(resumeId: string, error: string, expectedRunId: string | null): void {
    this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec<ResumeRow>(`SELECT * FROM resumes WHERE id = ?`, resumeId)
        .toArray()[0];
      if (!row || row.state !== "running" || row.run_id !== expectedRunId) return;
      const run = row.run_id ? this.runs.get(row.run_id) : null;
      // fail() leaves cancellation and terminal states alone, so the resume
      // must not be changed to failed when the ledger did not transition.
      if (run && (run.kind !== "tailor" || run.targetId !== resumeId || !["starting", "running"].includes(run.state))) return;
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
      const stopped = await runStopped(this.env.TAILOR, row.run_id);
      this.requireOpen();
      if (stopped) {
        if (this.hasUnsettledDispatch(row.run_id)) continue;
        this.markResumeFailed(
          row.id,
          "Tailoring stopped unexpectedly. Try again.",
          row.run_id,
        );
      }
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
