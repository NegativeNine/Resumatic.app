import { DurableObject } from "cloudflare:workers";
import { models } from "../ai/models";
import type {
  ApplicationView,
  FactKind,
  FactView,
  Level,
  Me,
  NewFact,
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
import { MAX_LINE_CHARS } from "../shared/api";
import { AppError } from "../shared/errors";
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
import { createSchema, hasSchema, migrate } from "./schema";
import { packVector, toUnit, topMatches, unpackVector } from "./search";

/** A running Tailor row older than this is checked against the Workflow before it blocks a new run. */
const STALE_RUN_MS = 30 * 60 * 1000;
const DEFAULT_TAILOR_LIMIT = 20;
/** Uploads being read at once, and uploads kept per vault: each upload costs model calls. */
const MAX_QUEUED_SOURCES = 3;
const MAX_SOURCES = 50;

type SourceRow = {
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
  id: string;
  kind: string;
  org: string;
  title: string | null;
  start_date: string | null;
  end_date: string | null;
  state: string;
  source_id: string | null;
  quote: string | null;
};
type FactRow = {
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
  exportedAt: string;
  profile: Profile;
  /** `file` is the download path of the original upload. */
  sources: { id: string; filename: string; state: string; createdAt: number; markdown: string | null; file: string }[];
  roles: RoleView[];
  facts: FactView[];
  applications: { id: string; company: string | null; title: string | null; jobDescription: string; createdAt: number }[];
  resumes: { id: string; applicationId: string; state: string; createdAt: number; body: ResumeBody | null; report: ResumeReport | null }[];
}

export function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

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
  private vectorCache: Map<string, Float32Array> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      // Only init() creates the schema, so a destroyed vault stays empty when it wakes.
      if (hasSchema(this.sql)) {
        migrate(this.sql);
        this.initialised = true;
      }
    });
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private get vaultId(): string {
    return this.ctx.id.toString();
  }

  // ---------------------------------------------------------------- lifecycle (Directory)

  async init(userId: string): Promise<void> {
    if (this.gone) throw new AppError("gone", "this vault was destroyed");
    if (!this.initialised) {
      createSchema(this.sql);
      this.initialised = true;
    }
    const owner = this.meta("user_id");
    if (owner && owner !== userId) throw new AppError("conflict", "vault belongs to another user");
    if (owner) return;
    this.ctx.storage.transactionSync(() => {
      this.setMeta("user_id", userId);
      this.setMeta("session_gen", "1");
      this.setMeta("state", "open");
      this.setMeta("quota_month", monthOf(Date.now()));
      this.setMeta("quota_used", "0");
      this.sql.exec(`INSERT OR IGNORE INTO profile (id) VALUES (1)`);
    });
  }

  /** Refuses new work and lists the runs to stop. Safe to repeat, and safe on an empty vault. */
  async close(): Promise<{ distill: string[]; tailor: string[] }> {
    if (this.gone || !this.initialised) return { distill: [], tailor: [] };
    this.setMeta("state", "closing");
    const distill = this.sql
      .exec<{ run_id: string }>(`SELECT run_id FROM sources WHERE state = 'queued' AND run_id IS NOT NULL`)
      .toArray()
      .map((r) => r.run_id);
    const tailor = this.sql
      .exec<{ run_id: string }>(`SELECT run_id FROM resumes WHERE state = 'running' AND run_id IS NOT NULL`)
      .toArray()
      .map((r) => r.run_id);
    return { distill, tailor };
  }

  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.gone = true;
    this.initialised = false;
    this.vectorCache = null;
  }

  // ---------------------------------------------------------------- sessions

  async openSession(userId: string): Promise<{ gen: number }> {
    this.requireOpen();
    if (this.meta("user_id") !== userId) throw new AppError("forbidden", "not this user's vault");
    return { gen: Number(this.meta("session_gen")) };
  }

  async checkSession(who: Who): Promise<void> {
    this.requireOwner(who);
  }

  async signOutEverywhere(who: Who): Promise<void> {
    this.requireOwner(who);
    this.setMeta("session_gen", String(Number(this.meta("session_gen")) + 1));
  }

  // ---------------------------------------------------------------- profile

  async me(who: Who): Promise<Me> {
    this.requireOwner(who);
    return { userId: who.userId, profile: this.readProfile(), quota: this.quota() };
  }

  async getProfile(who: Who): Promise<Profile> {
    this.requireOwner(who);
    return this.readProfile();
  }

  async updateProfile(who: Who, patch: Partial<Profile>): Promise<Profile> {
    this.requireOwner(who);
    const next = { ...this.readProfile(), ...patch };
    this.sql.exec(
      `UPDATE profile SET name = ?, email = ?, phone = ?, location = ?, links = ? WHERE id = 1`,
      next.name,
      next.email,
      next.phone,
      next.location,
      JSON.stringify(next.links),
    );
    return this.readProfile();
  }

  // ---------------------------------------------------------------- sources (user)

  async addSource(who: Who, s: { filename: string; r2Key: string }): Promise<{ sourceId: string }> {
    this.requireOwner(who);
    const counts = this.sql
      .exec<{ total: number; queued: number }>(
        `SELECT COUNT(*) AS total, COALESCE(SUM(state = 'queued'), 0) AS queued FROM sources`,
      )
      .one();
    if (counts.queued >= MAX_QUEUED_SOURCES) throw new AppError("conflict", "wait for your other uploads to finish reading");
    if (counts.total >= MAX_SOURCES) throw new AppError("quota", `you can keep at most ${MAX_SOURCES} uploads`);
    const id = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO sources (id, filename, r2_key, state, run_id, created_at) VALUES (?, ?, ?, 'queued', ?, ?)`,
      id,
      s.filename,
      s.r2Key,
      id,
      Date.now(),
    );
    try {
      await this.env.DISTILL.create({ id, params: { vaultId: this.vaultId, sourceId: id } });
    } catch {
      this.sql.exec(`DELETE FROM sources WHERE id = ?`, id);
      throw new AppError("unavailable", "could not start reading the file; try again");
    }
    return { sourceId: id };
  }

  async listSources(who: Who): Promise<SourceView[]> {
    this.requireOwner(who);
    return this.sql
      .exec<{ id: string; filename: string; state: string; error: string | null; created_at: number; proposed: number }>(
        `SELECT s.id, s.filename, s.state, s.error, s.created_at,
           (SELECT COUNT(*) FROM facts f WHERE f.source_id = s.id AND f.state = 'proposed') AS proposed
         FROM sources s ORDER BY s.created_at DESC`,
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        filename: r.filename,
        state: r.state as SourceState,
        error: r.error,
        createdAt: r.created_at,
        proposed: r.proposed,
      }));
  }

  /** Where the user's original upload is stored, for downloading it again. */
  async sourceFile(who: Who, sourceId: string): Promise<{ r2Key: string; filename: string }> {
    this.requireOwner(who);
    const row = this.sourceRow(sourceId);
    return { r2Key: row.r2_key, filename: row.filename };
  }

  // ---------------------------------------------------------------- sources (Distill)

  async sourceInfo(sourceId: string): Promise<{ r2Key: string; filename: string }> {
    this.requireOpen();
    const row = this.sourceRow(sourceId);
    return { r2Key: row.r2_key, filename: row.filename };
  }

  async sourceText(sourceId: string): Promise<string> {
    this.requireOpen();
    const row = this.sourceRow(sourceId);
    if (row.markdown === null) throw new AppError("invalid", "source has not been converted yet");
    return row.markdown;
  }

  async saveSource(
    sourceId: string,
    patch: { markdown?: string; state?: SourceState; error?: string | null },
  ): Promise<void> {
    this.requireOpen();
    this.sourceRow(sourceId);
    if (patch.markdown !== undefined) this.sql.exec(`UPDATE sources SET markdown = ? WHERE id = ?`, patch.markdown, sourceId);
    if (patch.state !== undefined) this.sql.exec(`UPDATE sources SET state = ? WHERE id = ?`, patch.state, sourceId);
    if (patch.error !== undefined) this.sql.exec(`UPDATE sources SET error = ? WHERE id = ?`, patch.error, sourceId);
  }

  /** Saves proposed roles and facts. A retried step replaces its own earlier proposals. */
  async saveExtraction(sourceId: string, x: Extraction): Promise<{ roles: number; facts: number }> {
    this.requireOpen();
    this.sourceRow(sourceId);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM facts WHERE source_id = ? AND state = 'proposed' AND origin = 'extracted'`, sourceId);
      this.sql.exec(`DELETE FROM roles WHERE source_id = ? AND state = 'proposed'`, sourceId);
      this.sql.exec(
        `DELETE FROM evidence WHERE source_id = ?
           AND id NOT IN (SELECT evidence_id FROM facts WHERE evidence_id IS NOT NULL)
           AND id NOT IN (SELECT evidence_id FROM roles WHERE evidence_id IS NOT NULL)`,
        sourceId,
      );
      const evidence = new Map<string, string>();
      const evidenceFor = (quote: string): string => {
        const known = evidence.get(quote);
        if (known) return known;
        const id = crypto.randomUUID();
        this.sql.exec(`INSERT INTO evidence (id, source_id, quote) VALUES (?, ?, ?)`, id, sourceId, quote);
        evidence.set(quote, id);
        return id;
      };
      const roleIds = new Map<string, string>();
      for (const r of x.roles) {
        const id = crypto.randomUUID();
        this.sql.exec(
          `INSERT INTO roles (id, kind, org, title, start_date, end_date, evidence_id, source_id, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed')`,
          id,
          r.kind,
          r.org,
          r.title,
          r.startDate,
          r.endDate,
          evidenceFor(r.quote),
          sourceId,
        );
        roleIds.set(r.key, id);
      }
      for (const f of x.facts) {
        this.sql.exec(
          `INSERT INTO facts (id, role_id, kind, text, level, evidence_id, source_id, origin, state, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'extracted', 'proposed', ?)`,
          crypto.randomUUID(),
          f.roleKey ? (roleIds.get(f.roleKey) ?? null) : null,
          f.kind,
          f.text,
          f.level,
          evidenceFor(f.quote),
          sourceId,
          now,
        );
      }
    });
    this.vectorCache = null;
    return { roles: x.roles.length, facts: x.facts.length };
  }

  async unembeddedFacts(sourceId: string): Promise<{ id: string; text: string }[]> {
    this.requireOpen();
    return this.sql
      .exec<{ id: string; text: string }>(`SELECT id, text FROM facts WHERE source_id = ? AND vector IS NULL`, sourceId)
      .toArray();
  }

  async saveVectors(vectors: { factId: string; vector: number[] }[]): Promise<void> {
    this.requireOpen();
    this.ctx.storage.transactionSync(() => {
      for (const v of vectors) this.sql.exec(`UPDATE facts SET vector = ? WHERE id = ?`, packVector(v.vector), v.factId);
    });
    this.vectorCache = null;
  }

  // ---------------------------------------------------------------- roles and facts (user)

  async listRoles(who: Who): Promise<RoleView[]> {
    this.requireOwner(who);
    return this.sql
      .exec<RoleRow>(
        `SELECT r.id, r.kind, r.org, r.title, r.start_date, r.end_date, r.state, r.source_id, e.quote
         FROM roles r LEFT JOIN evidence e ON e.id = r.evidence_id
         ORDER BY COALESCE(r.end_date, '9999') DESC, r.start_date DESC`,
      )
      .toArray()
      .map(roleView);
  }

  async editRole(who: Who, id: string, patch: RolePatch): Promise<void> {
    this.requireOwner(who);
    const role = this.sql.exec(`SELECT id FROM roles WHERE id = ?`, id).toArray()[0];
    if (!role) throw new AppError("not_found", "no such role");
    const fields: [string, string | null][] = [];
    if (patch.kind !== undefined) fields.push(["kind", patch.kind]);
    if (patch.org !== undefined) fields.push(["org", patch.org]);
    if (patch.title !== undefined) fields.push(["title", patch.title]);
    if (patch.startDate !== undefined) fields.push(["start_date", patch.startDate]);
    if (patch.endDate !== undefined) fields.push(["end_date", patch.endDate]);
    for (const [column, value] of fields) this.sql.exec(`UPDATE roles SET ${column} = ? WHERE id = ?`, value, id);
  }

  async listFacts(who: Who, state?: ReviewState): Promise<FactView[]> {
    this.requireOwner(who);
    const where = state ? `WHERE f.state = ?` : ``;
    const params = state ? [state] : [];
    return this.sql
      .exec<FactRow>(
        `SELECT f.id, f.role_id, f.kind, f.text, f.level, f.origin, f.state, f.source_id, e.quote
         FROM facts f LEFT JOIN evidence e ON e.id = f.evidence_id ${where}
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
      for (const id of r.confirm) {
        this.sql.exec(`UPDATE roles SET state = 'confirmed' WHERE id = ?`, id);
        this.sql.exec(`UPDATE facts SET state = 'confirmed', updated_at = ? WHERE id = ?`, Date.now(), id);
        this.sql.exec(
          `UPDATE roles SET state = 'confirmed' WHERE id = (SELECT role_id FROM facts WHERE id = ?) AND state = 'proposed'`,
          id,
        );
      }
      for (const id of r.reject) {
        this.sql.exec(`UPDATE roles SET state = 'rejected' WHERE id = ?`, id);
        this.sql.exec(`UPDATE facts SET state = 'rejected' WHERE role_id = ? AND state = 'proposed'`, id);
        this.sql.exec(`UPDATE facts SET state = 'rejected', updated_at = ? WHERE id = ?`, Date.now(), id);
      }
    });
    this.vectorCache = null;
  }

  /** A fact the user types is their own claim, so it is confirmed at once. */
  async addFact(who: Who, f: NewFact): Promise<{ factId: string }> {
    this.requireOwner(who);
    if (f.roleId) this.requireUsableRole(f.roleId);
    const vector = await this.embedOne(f.text);
    this.requireOwner(who);
    const id = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO facts (id, role_id, kind, text, level, origin, state, vector, updated_at)
       VALUES (?, ?, ?, ?, ?, 'user', 'confirmed', ?, ?)`,
      id,
      f.roleId,
      f.kind,
      f.text,
      f.level,
      packVector(vector),
      Date.now(),
    );
    this.vectorCache = null;
    return { factId: id };
  }

  /** An edited fact becomes the user's own claim; its original quote stays beside it. */
  async editFact(who: Who, id: string, text: string): Promise<void> {
    this.requireOwner(who);
    if (!this.sql.exec(`SELECT id FROM facts WHERE id = ?`, id).toArray()[0]) throw new AppError("not_found", "no such fact");
    const vector = await this.embedOne(text);
    this.requireOwner(who);
    this.sql.exec(
      `UPDATE facts SET text = ?, origin = 'user', vector = ?, updated_at = ? WHERE id = ?`,
      text,
      packVector(vector),
      Date.now(),
      id,
    );
    this.vectorCache = null;
  }

  // ---------------------------------------------------------------- applications and tailoring (user)

  async addApplication(who: Who, jdText: string): Promise<{ applicationId: string }> {
    this.requireOwner(who);
    const id = crypto.randomUUID();
    this.sql.exec(`INSERT INTO applications (id, jd_text, created_at) VALUES (?, ?, ?)`, id, jdText, Date.now());
    return { applicationId: id };
  }

  async listApplications(who: Who): Promise<ApplicationView[]> {
    this.requireOwner(who);
    const resumes = this.sql
      .exec<{ id: string; application_id: string; state: string; created_at: number }>(
        `SELECT id, application_id, state, created_at FROM resumes ORDER BY created_at DESC`,
      )
      .toArray();
    return this.sql
      .exec<ApplicationRow>(`SELECT id, company, title, jd_text, requirements, created_at FROM applications ORDER BY created_at DESC`)
      .toArray()
      .map((a) => ({
        id: a.id,
        company: a.company,
        title: a.title,
        excerpt: excerptOf(a.jd_text),
        createdAt: a.created_at,
        resumes: resumes
          .filter((r) => r.application_id === a.id)
          .map((r) => ({ id: r.id, state: r.state as ResumeState, createdAt: r.created_at })),
      }));
  }

  /**
   * Starts a Tailor run. The quota is counted and the running row written before the first
   * await, so two starts cannot both pass the one-run rule; a failed start is refunded.
   */
  async tailor(who: Who, applicationId: string): Promise<{ resumeId: string }> {
    this.requireOwner(who);
    if (!this.sql.exec(`SELECT id FROM applications WHERE id = ?`, applicationId).toArray()[0]) {
      throw new AppError("not_found", "no such application");
    }
    await this.reconcileStaleRuns();
    this.requireOwner(who);
    if (this.sql.exec(`SELECT id FROM resumes WHERE state = 'running'`).toArray().length > 0) {
      throw new AppError("conflict", "a resume is already being tailored; wait for it to finish");
    }
    const quota = this.quota();
    if (quota.used >= quota.limit) {
      throw new AppError("quota", `you have used all ${quota.limit} tailored resumes for this month; more on ${resetDay(quota.month)}`);
    }
    const id = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      this.setMeta("quota_month", quota.month);
      this.setMeta("quota_used", String(quota.used + 1));
      this.sql.exec(
        `INSERT INTO resumes (id, application_id, state, quota_month, run_id, created_at) VALUES (?, ?, 'running', ?, ?, ?)`,
        id,
        applicationId,
        quota.month,
        id,
        Date.now(),
      );
    });
    try {
      await this.env.TAILOR.create({ id, params: { vaultId: this.vaultId, resumeId: id } });
    } catch {
      this.markResumeFailed(id, "Could not start tailoring. Try again.");
      throw new AppError("unavailable", "could not start tailoring; try again");
    }
    return { resumeId: id };
  }

  async getResume(who: Who, id: string): Promise<ResumeView> {
    this.requireOwner(who);
    const row = this.resumeRow(id);
    const ready = row.state === "ready";
    const body = ready && row.body ? (JSON.parse(row.body) as ResumeBody) : null;
    const facts: ResumeView["facts"] = {};
    if (body) {
      const ids = new Set<string>();
      for (const line of [...(body.summary ? [body.summary] : []), ...body.sections.flatMap((s) => s.lines)]) {
        for (const factId of line.factIds) ids.add(factId);
      }
      for (const f of this.factsById([...ids])) facts[f.id] = { text: f.text, quote: f.quote };
    }
    return {
      id: row.id,
      applicationId: row.application_id,
      state: row.state as ResumeState,
      step: row.step,
      error: row.error,
      version: row.version,
      createdAt: row.created_at,
      body,
      report: ready && row.report ? (JSON.parse(row.report) as ResumeReport) : null,
      facts,
    };
  }

  /** A user edit is the user's own claim; the PDF cache key changes with the version. */
  async editLine(who: Who, resumeId: string, lineId: string, text: string): Promise<void> {
    this.requireOwner(who);
    const row = this.resumeRow(resumeId);
    if (row.state !== "ready" || !row.body) throw new AppError("conflict", "the resume is not ready yet");
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_LINE_CHARS) throw new AppError("invalid", `a line must be 1 to ${MAX_LINE_CHARS} characters`);
    const body = JSON.parse(row.body) as ResumeBody;
    const line = [...(body.summary ? [body.summary] : []), ...body.sections.flatMap((s) => s.lines)].find((l) => l.id === lineId);
    if (!line) throw new AppError("not_found", "no such line");
    line.text = trimmed;
    line.status = "edited";
    this.sql.exec(`UPDATE resumes SET body = ?, version = version + 1 WHERE id = ?`, JSON.stringify(body), resumeId);
  }

  async renderData(who: Who, resumeId: string): Promise<RenderData> {
    this.requireOwner(who);
    const row = this.resumeRow(resumeId);
    if (row.state !== "ready" || !row.body) throw new AppError("conflict", "the resume is not ready yet");
    const app = this.sql
      .exec<{ company: string | null; title: string | null }>(`SELECT company, title FROM applications WHERE id = ?`, row.application_id)
      .toArray()[0];
    return {
      profile: this.readProfile(),
      body: JSON.parse(row.body) as ResumeBody,
      version: row.version,
      company: app?.company ?? null,
      title: app?.title ?? null,
    };
  }

  // ---------------------------------------------------------------- tailoring (Tailor Workflow)

  async tailorInput(resumeId: string): Promise<TailorInput> {
    this.requireOpen();
    const row = this.resumeRow(resumeId);
    const app = this.sql
      .exec<ApplicationRow>(`SELECT * FROM applications WHERE id = ?`, row.application_id)
      .toArray()[0];
    if (!app) throw new AppError("not_found", "no such application");
    return {
      applicationId: app.id,
      jdText: app.jd_text,
      analysis: app.requirements
        ? { company: app.company, title: app.title, requirements: JSON.parse(app.requirements) as string[] }
        : null,
      selection: parseOrNull<Selection>(row.selection),
      draft: parseOrNull<Draft>(row.draft),
      verified: parseOrNull<VerifiedDraft>(row.verified),
      facts: this.usableFacts(),
      roles: this.confirmedRoles(),
    };
  }

  async saveAnalysis(applicationId: string, a: Analysis): Promise<void> {
    this.requireOpen();
    this.sql.exec(
      `UPDATE applications SET company = ?, title = ?, requirements = ? WHERE id = ?`,
      a.company,
      a.title,
      JSON.stringify(a.requirements),
      applicationId,
    );
  }

  /** For each query vector, the k closest usable confirmed facts. */
  async searchFacts(queries: number[][], k: number): Promise<Candidate[]> {
    this.requireOpen();
    return topMatches(queries, this.vectors(), k);
  }

  async saveStep(resumeId: string, step: string, patch: ResumePatch): Promise<void> {
    this.requireOpen();
    this.resumeRow(resumeId);
    const updates: [string, string][] = [["step", step]];
    if (patch.selection) updates.push(["selection", JSON.stringify(patch.selection)]);
    if (patch.draft) updates.push(["draft", JSON.stringify(patch.draft)]);
    if (patch.verified) updates.push(["verified", JSON.stringify(patch.verified)]);
    if (patch.body) updates.push(["body", JSON.stringify(patch.body)]);
    if (patch.report) updates.push(["report", JSON.stringify(patch.report)]);
    if (patch.state) updates.push(["state", patch.state]);
    this.ctx.storage.transactionSync(() => {
      for (const [column, value] of updates) this.sql.exec(`UPDATE resumes SET ${column} = ? WHERE id = ?`, value, resumeId);
    });
  }

  async failResume(resumeId: string, error: string): Promise<void> {
    if (this.gone || !this.initialised) return;
    this.markResumeFailed(resumeId, error);
  }

  // ---------------------------------------------------------------- export

  async exportAll(who: Who): Promise<VaultExport> {
    this.requireOwner(who);
    return {
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
          file: `/api/sources/${s.id}/file`,
        })),
      roles: await this.listRoles(who),
      facts: await this.listFacts(who),
      applications: this.sql
        .exec<ApplicationRow>(`SELECT * FROM applications ORDER BY created_at`)
        .toArray()
        .map((a) => ({ id: a.id, company: a.company, title: a.title, jobDescription: a.jd_text, createdAt: a.created_at })),
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

  // ---------------------------------------------------------------- helpers

  private requireOpen(): void {
    if (this.gone || !this.initialised) throw new AppError("gone", "this vault no longer exists");
    if (this.meta("state") !== "open") throw new AppError("gone", "this account is being deleted");
  }

  private requireOwner(who: Who): void {
    this.requireOpen();
    if (who.userId !== this.meta("user_id")) throw new AppError("forbidden", "not this user's vault");
    if (who.gen !== Number(this.meta("session_gen"))) throw new AppError("unauthenticated", "this session was signed out");
  }

  private meta(key: string): string | null {
    if (!this.initialised) return null;
    const row = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0];
    return row ? row.value : null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private quota(): Quota {
    const month = monthOf(Date.now());
    const used = this.meta("quota_month") === month ? Number(this.meta("quota_used") ?? 0) : 0;
    const limit = Number(this.env.TAILOR_MONTHLY_LIMIT) || DEFAULT_TAILOR_LIMIT;
    return { used, limit, month };
  }

  private readProfile(): Profile {
    const row = this.sql
      .exec<{ name: string; email: string; phone: string; location: string; links: string }>(
        `SELECT name, email, phone, location, links FROM profile WHERE id = 1`,
      )
      .toArray()[0];
    if (!row) return { name: "", email: "", phone: "", location: "", links: [] };
    return { name: row.name, email: row.email, phone: row.phone, location: row.location, links: JSON.parse(row.links) as string[] };
  }

  private sourceRow(id: string): SourceRow {
    const row = this.sql.exec<SourceRow>(`SELECT * FROM sources WHERE id = ?`, id).toArray()[0];
    if (!row) throw new AppError("not_found", "no such source");
    return row;
  }

  private resumeRow(id: string): ResumeRow {
    const row = this.sql.exec<ResumeRow>(`SELECT * FROM resumes WHERE id = ?`, id).toArray()[0];
    if (!row) throw new AppError("not_found", "no such resume");
    return row;
  }

  /** A fact without a vector could never be selected, so a failed embedding fails the edit. */
  private async embedOne(text: string): Promise<number[]> {
    let vector: number[] | undefined;
    try {
      [vector] = await models(this.env).embed([text]);
    } catch {
      throw new AppError("unavailable", "could not save that fact right now; try again");
    }
    if (!vector?.length) throw new AppError("unavailable", "could not save that fact right now; try again");
    return vector;
  }

  private requireUsableRole(roleId: string): void {
    const role = this.sql.exec<{ state: string }>(`SELECT state FROM roles WHERE id = ?`, roleId).toArray()[0];
    if (!role) throw new AppError("not_found", "no such role");
    if (role.state === "rejected") throw new AppError("invalid", "that role was rejected");
  }

  private factsById(ids: string[]): FactRecord[] {
    if (ids.length === 0) return [];
    return this.sql
      .exec<FactRow>(
        `SELECT f.id, f.role_id, f.kind, f.text, f.level, f.origin, f.state, f.source_id, e.quote
         FROM facts f LEFT JOIN evidence e ON e.id = f.evidence_id
         WHERE f.id IN (${ids.map(() => "?").join(",")})`,
        ...ids,
      )
      .toArray()
      .map(factRecord);
  }

  /** Confirmed facts whose role is confirmed, or that belong to no role. */
  private usableFacts(): FactRecord[] {
    return this.sql
      .exec<FactRow>(
        `SELECT f.id, f.role_id, f.kind, f.text, f.level, f.origin, f.state, f.source_id, e.quote
         FROM facts f LEFT JOIN evidence e ON e.id = f.evidence_id LEFT JOIN roles r ON r.id = f.role_id
         WHERE f.state = 'confirmed' AND (f.role_id IS NULL OR r.state = 'confirmed')`,
      )
      .toArray()
      .map(factRecord);
  }

  private confirmedRoles(): RoleRecord[] {
    return this.sql
      .exec<RoleRow>(
        `SELECT id, kind, org, title, start_date, end_date, state, source_id, NULL AS quote FROM roles WHERE state = 'confirmed'`,
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        kind: r.kind as RoleKind,
        org: r.org,
        title: r.title,
        startDate: r.start_date,
        endDate: r.end_date,
      }));
  }

  private vectors(): Map<string, Float32Array> {
    if (this.vectorCache) return this.vectorCache;
    const usable = new Set(this.usableFacts().map((f) => f.id));
    const cache = new Map<string, Float32Array>();
    for (const row of this.sql
      .exec<{ id: string; vector: ArrayBuffer }>(`SELECT id, vector FROM facts WHERE state = 'confirmed' AND vector IS NOT NULL`)
      .toArray()) {
      if (usable.has(row.id)) cache.set(row.id, toUnit(unpackVector(row.vector)));
    }
    this.vectorCache = cache;
    return cache;
  }

  private markResumeFailed(resumeId: string, error: string): void {
    const row = this.sql.exec<ResumeRow>(`SELECT * FROM resumes WHERE id = ?`, resumeId).toArray()[0];
    if (!row || row.state !== "running") return;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE resumes SET state = 'failed', error = ? WHERE id = ?`, error, resumeId);
      if (row.quota_month && row.quota_month === this.meta("quota_month")) {
        this.setMeta("quota_used", String(Math.max(0, Number(this.meta("quota_used") ?? 0) - 1)));
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
      let stopped = true;
      try {
        if (row.run_id) {
          const status = await (await this.env.TAILOR.get(row.run_id)).status();
          stopped = status.status === "errored" || status.status === "terminated" || status.status === "complete";
        }
      } catch {
        stopped = true;
      }
      if (stopped) this.markResumeFailed(row.id, "Tailoring stopped unexpectedly. Try again.");
    }
  }
}

/** The start of a job description, for naming the job before Tailor has read it. */
function excerptOf(jdText: string): string {
  const flat = jdText.replace(/\s+/g, " ").trim();
  return flat.length > 100 ? `${flat.slice(0, 100).replace(/\s+\S*$/, "")}…` : flat;
}

function parseOrNull<T>(json: string | null): T | null {
  return json ? (JSON.parse(json) as T) : null;
}

function roleView(r: RoleRow): RoleView {
  return {
    id: r.id,
    kind: r.kind as RoleKind,
    org: r.org,
    title: r.title,
    startDate: r.start_date,
    endDate: r.end_date,
    state: r.state as ReviewState,
    quote: r.quote,
    sourceId: r.source_id,
  };
}

function factView(f: FactRow): FactView {
  return {
    id: f.id,
    roleId: f.role_id,
    kind: f.kind as FactKind,
    text: f.text,
    level: f.level as Level | null,
    origin: f.origin as FactView["origin"],
    state: f.state as ReviewState,
    quote: f.quote,
    sourceId: f.source_id,
  };
}

function factRecord(f: FactRow): FactRecord {
  return { id: f.id, roleId: f.role_id, kind: f.kind as FactKind, text: f.text, level: f.level as Level | null, quote: f.quote };
}
