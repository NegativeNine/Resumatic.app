import type { FactView, ResumeLine, RoleView } from "../shared/api";
import { AppError } from "../shared/errors";
import {
  MAX_SHARE_LABEL_CHARS,
  SHARE_READ_INTERVAL_MS,
  SHARE_TTL_MS,
  type CoachClient,
  type ShareGrant,
  type SharedJob,
  type SharedLine,
  type SharedResume,
  type SharedRole,
  type SharedView,
  type ShareSnapshot,
} from "../shared/sharing";
import type { RenderData, Who } from "../shared/types";
import { sharedDocument, type DocumentVersion } from "./document-shares";
import { assertGroundedResume, type ResumeVersion } from "./snapshots";

export { SHARE_READ_INTERVAL_MS, SHARE_TTL_MS };
export const MAX_SHARE_FACTS = 100;
export const MAX_SHARE_RESUMES = 20;
export const MAX_SHARE_DOCUMENTS = 20;
export const MAX_SHARE_BYTES = 1024 * 1024;
export const SHARE_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS share_grants (
    id TEXT PRIMARY KEY, epoch TEXT NOT NULL, created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, revoked_at INTEGER, fact_count INTEGER NOT NULL,
    resume_count INTEGER NOT NULL, snapshot TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS share_expiry ON share_grants(expires_at)`,
];

/** A label for the owner's own list, and when the copy was last opened. */
export const SHARE_DETAIL_MIGRATIONS: readonly string[] = [
  `ALTER TABLE share_grants ADD COLUMN label TEXT`,
  `ALTER TABLE share_grants ADD COLUMN last_read_at INTEGER`,
];

/** The coach a link names, and the account that took it up. */
export const SHARE_COACH_MIGRATIONS: readonly string[] = [
  `ALTER TABLE share_grants ADD COLUMN coach_email TEXT`,
  `ALTER TABLE share_grants ADD COLUMN coach_user_id TEXT`,
  `ALTER TABLE share_grants ADD COLUMN coach_name TEXT`,
  `ALTER TABLE share_grants ADD COLUMN coach_joined_at INTEGER`,
];

/** A signed-in account as a copy's owner's vault is told of it: who, and the address they signed in with. */
export interface CoachAccount {
  userId: string;
  email: string;
  name?: string | null;
}

/** How many cover letters and interview preparations a copy holds. */
export const SHARE_DOCUMENT_MIGRATIONS: readonly string[] = [
  `ALTER TABLE share_grants ADD COLUMN document_count INTEGER NOT NULL DEFAULT 0`,
];

/** What a version 2 copy adds to the selection: none of it changes what the facts or resumes say. */
export interface ShareDetails {
  label?: string | null;
  /** The owner's name for the top of the copy, or null to leave it off. */
  owner?: { name: string } | null;
  /** Each shared resume's job, by resume ID. */
  jobs?: Readonly<Record<string, SharedJob>>;
  /** Each shared document's job, by document ID. */
  documentJobs?: Readonly<Record<string, SharedJob>>;
  /** The sign-in address of the one account that may act as this copy's coach. */
  coachEmail?: string | null;
}

export interface ShareSelection {
  facts: FactView[];
  roles: RoleView[];
  resumes: {
    id: string;
    render: RenderData;
    provenance?: "snapshot" | "legacy";
    facts?: ResumeVersion["facts"];
    evidence?: ResumeVersion["evidence"];
    roleEvidence?: ResumeVersion["roleEvidence"];
  }[];
  /** Finished cover letters and interview preparation, each with its saved version as stored. */
  documents?: { id: string; kind: string; version: number; data: DocumentVersion | null }[];
}

function roleSnapshot(
  role: Pick<
    RoleView,
    "id" | "kind" | "org" | "title" | "startDate" | "endDate" | "unknownEndStartDate"
  >,
): SharedRole {
  return {
    id: role.id,
    kind: role.kind,
    org: role.org,
    title: role.title,
    startDate: role.startDate,
    endDate: role.endDate,
    ...(role.unknownEndStartDate ? { unknownEndStartDate: role.unknownEndStartDate } : {}),
  };
}

/** Only server-loaded selections enter here. An explicit field list excludes evidence and private notes. */
export function snapshotSelection(
  selection: ShareSelection,
  now = Date.now(),
): ShareSnapshot {
  if (!selection.facts.length && !selection.resumes.length)
    throw new AppError("invalid", "select at least one fact, resume or document");
  if (
    selection.facts.length > MAX_SHARE_FACTS ||
    selection.resumes.length > MAX_SHARE_RESUMES
  )
    throw new AppError("too_large", "too many items selected for sharing");
  if (
    new Set(selection.facts.map((f) => f.id)).size !== selection.facts.length ||
    new Set(selection.resumes.map((r) => `${r.id}:${r.render.version}`))
      .size !== selection.resumes.length
  )
    throw new AppError("invalid", "duplicate share selection");
  const roles = new Map(selection.roles.map((r) => [r.id, r]));
  const facts = selection.facts.map((fact) => {
    if (fact.state !== "confirmed")
      throw new AppError("invalid", "only confirmed facts can be shared");
    const role = fact.roleId ? roles.get(fact.roleId) : null;
    if (fact.roleId && (!role || role.state !== "confirmed"))
      throw new AppError(
        "invalid",
        "confirm the selected facts' roles before sharing",
      );
    return {
      id: fact.id,
      text: fact.text,
      kind: fact.kind,
      level: fact.level,
      origin: fact.origin,
      role: role ? roleSnapshot(role) : null,
    };
  });
  const resumes: SharedResume[] = selection.resumes.map(
    ({ id, render, provenance, facts, evidence, roleEvidence }) => {
      if (
        !Number.isSafeInteger(render.version) ||
        render.version < 1 ||
        !render.body
      )
        throw new AppError(
          "invalid",
          "only finished resume versions can be shared",
        );
      assertGroundedResume(render, facts, provenance, evidence, roleEvidence);
      const line = (value: ResumeLine): SharedLine => ({
        id: value.id,
        text: value.text,
        verification: "verified",
      });
      const summary = render.body.summary ? line(render.body.summary) : null;
      const sections = render.body.sections.map((section) => ({
        ...roleSnapshot({
          id: section.roleId,
          kind: section.kind,
          org: section.org,
          title: section.title,
          startDate: section.startDate,
          endDate: section.endDate,
          ...(section.unknownEndStartDate ? { unknownEndStartDate: section.unknownEndStartDate } : {}),
        }),
        lines: section.lines.map(line),
      }));
      const statuses = [summary, ...sections.flatMap((s) => s.lines)]
        .filter((s): s is SharedLine => s !== null)
        .map((l) => l.verification);
      const verification =
        statuses.length === 0
          ? "unverified"
          : statuses.every((s) => s === "verified")
            ? "verified"
            : statuses.every((s) => s === "user-authored")
              ? "user-authored"
              : statuses.some((s) => s === "user-authored")
                ? "mixed"
                : "unverified";
      return {
        id,
        version: render.version,
        profile: {
          name: render.profile.name,
          email: render.profile.email,
          phone: render.profile.phone,
          location: render.profile.location,
          links: [...render.profile.links],
        },
        summary,
        sections,
        skills: [...render.body.skills],
        verification,
      };
    },
  );
  const snapshot: ShareSnapshot = {
    schemaVersion: 1,
    createdAt: now,
    facts,
    resumes,
  };
  if (
    new TextEncoder().encode(JSON.stringify(snapshot)).byteLength >
    MAX_SHARE_BYTES
  )
    throw new AppError("too_large", "share snapshot is too large");
  return snapshot;
}

function validJob(job: unknown): boolean {
  if (job === null) return true;
  if (typeof job !== "object" || job === undefined) return false;
  const { title, company, ...rest } = job as Record<string, unknown>;
  const name = (value: unknown) => value === null || (typeof value === "string" && value.length <= 200);
  return Object.keys(rest).length === 0 && name(title) && name(company);
}

interface GrantRow extends Record<string, SqlStorageValue> {
  id: string;
  epoch: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  fact_count: number;
  resume_count: number;
  snapshot: string | null;
  label: string | null;
  last_read_at: number | null;
  document_count: number | null;
  coach_email: string | null;
  coach_user_id: string | null;
  coach_name: string | null;
  coach_joined_at: number | null;
}
const grantView = (row: GrantRow): ShareGrant => ({
  id: row.id,
  epoch: row.epoch,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  factCount: row.fact_count,
  resumeCount: row.resume_count,
  label: row.label ?? null,
  lastReadAt: row.last_read_at ?? null,
  documentCount: row.document_count ?? 0,
  coach: row.coach_email
    ? { email: row.coach_email, name: row.coach_name ?? null, joinedAt: row.coach_user_id ? (row.coach_joined_at ?? null) : null }
    : null,
});

/** An address as a grant stores and compares it, or null. The session's address is normalised the same way. */
function coachAddress(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const email = value.trim().toLowerCase();
  if (!email) return null;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new AppError("invalid", "enter the coach's email address");
  return email;
}

export class ShareStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly auth: {
      authorizeOwner(who: Who): void;
      requireOpen(): void;
      currentEpoch(): string;
    },
  ) {}

  create(
    who: Who,
    selection: ShareSelection,
    expiresAt = Date.now() + SHARE_TTL_MS,
    now = Date.now(),
    details: ShareDetails = {},
  ): ShareGrant {
    this.auth.authorizeOwner(who);
    const label = details.label?.trim() || null;
    if (label !== null && (label.length > MAX_SHARE_LABEL_CHARS || /[\u0000-\u001f\u007f]/.test(label)))
      throw new AppError("invalid", "keep the label to one short line");
    const coachEmail = coachAddress(details.coachEmail);
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + SHARE_TTL_MS
    )
      throw new AppError("invalid", "share expiry must be within seven days");
    const count =
      this.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM share_grants WHERE revoked_at IS NULL AND expires_at > ?`,
          now,
        )
        .toArray()[0]?.count ?? 0;
    if (count >= 100)
      throw new AppError(
        "quota",
        "revoke an existing share before creating another",
      );
    const chosen = selection.documents ?? [];
    if (chosen.length > MAX_SHARE_DOCUMENTS)
      throw new AppError("too_large", "too many items selected for sharing");
    if (new Set(chosen.map((document) => document.id)).size !== chosen.length)
      throw new AppError("invalid", "duplicate share selection");
    // Each document passes the same gate when the copy is made as it will each time the copy is read.
    const documents = chosen.map((document) => sharedDocument(document.id, document.version, document.kind, document.data));
    // A copy can be documents alone. The facts and resumes are checked as they always were.
    const core: ShareSnapshot = selection.facts.length || selection.resumes.length || !documents.length
      ? snapshotSelection(selection, now)
      : { schemaVersion: 1, createdAt: now, facts: [], resumes: [] };
    // The name and the jobs are added around the checked selection, so what a fact, a resume or a
    // document says is still exactly what read() rebuilds and compares.
    const owner = details.owner?.name.trim() ? { name: details.owner.name.trim().slice(0, 200) } : null;
    const named = (job: SharedJob | undefined) => (job ? { title: job.title, company: job.company } : null);
    const snapshot: ShareSnapshot = {
      schemaVersion: documents.length ? 3 : 2,
      createdAt: core.createdAt,
      owner,
      facts: core.facts,
      resumes: core.resumes.map((resume) => ({ ...resume, job: named(details.jobs?.[resume.id]) })),
      ...(documents.length
        ? { documents: documents.map((document) => ({ ...document, job: named(details.documentJobs?.[document.id]) })) }
        : {}),
    };
    if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_SHARE_BYTES)
      throw new AppError("too_large", "share snapshot is too large");
    const grant: ShareGrant = {
      id: crypto.randomUUID(),
      epoch: this.auth.currentEpoch(),
      createdAt: now,
      expiresAt,
      revokedAt: null,
      factCount: snapshot.facts.length,
      resumeCount: snapshot.resumes.length,
      documentCount: documents.length,
      label,
      lastReadAt: null,
      coach: coachEmail ? { email: coachEmail, name: null, joinedAt: null } : null,
    };
    this.sql.exec(
      `INSERT INTO share_grants (id, epoch, created_at, expires_at, revoked_at, fact_count, resume_count, snapshot, label, document_count, coach_email) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      grant.id,
      grant.epoch,
      now,
      expiresAt,
      grant.factCount,
      grant.resumeCount,
      JSON.stringify(snapshot),
      label,
      documents.length,
      coachEmail,
    );
    return grant;
  }

  list(who: Who, now = Date.now()): ShareGrant[] {
    this.auth.authorizeOwner(who);
    return this.sql
      .exec<GrantRow>(
        `SELECT id, epoch, created_at, expires_at, revoked_at, fact_count, resume_count, label, last_read_at, document_count, coach_email, coach_user_id, coach_name, coach_joined_at FROM share_grants ORDER BY created_at DESC LIMIT 200`,
      )
      .toArray()
      .map((row) => {
        const grant = grantView(row);
        if (row.revoked_at !== null || row.expires_at <= now) return grant;
        try {
          this.read({ grantId: row.id, epoch: row.epoch }, now);
          return { ...grant, available: true };
        } catch {
          // Preserve the snapshot and expose no content or internal error details.
          return { ...grant, available: false };
        }
      });
  }

  export(who: Who): (ShareGrant & { snapshot: ShareSnapshot | null })[] {
    this.auth.authorizeOwner(who);
    return this.sql
      .exec<GrantRow>(`SELECT * FROM share_grants ORDER BY created_at DESC`)
      .toArray()
      .map((row) => ({
        ...grantView(row),
        snapshot: row.snapshot
          ? (JSON.parse(row.snapshot) as ShareSnapshot)
          : null,
      }));
  }

  revoke(who: Who, id: string, now = Date.now()): void {
    this.auth.authorizeOwner(who);
    // Remove the copied content immediately; retain only grant metadata until expiration cleanup.
    this.sql.exec(
      `UPDATE share_grants SET revoked_at = COALESCE(revoked_at, ?), snapshot = NULL WHERE id = ?`,
      now,
      id,
    );
  }

  read(
    claims: { grantId: string; epoch: string },
    now = Date.now(),
  ): SharedView {
    this.auth.requireOpen();
    const row = this.sql
      .exec<GrantRow>(`SELECT * FROM share_grants WHERE id = ?`, claims.grantId)
      .toArray()[0];
    if (
      !row ||
      row.revoked_at !== null ||
      row.expires_at <= now ||
      row.epoch !== claims.epoch ||
      row.epoch !== this.auth.currentEpoch() ||
      !row.snapshot
    )
      throw new AppError("gone", "this share link is unavailable or expired");
    let snapshot: ShareSnapshot;
    try {
      snapshot = JSON.parse(row.snapshot) as ShareSnapshot;
      if (![1, 2, 3].includes(snapshot.schemaVersion) || !Array.isArray(snapshot.resumes) || !Array.isArray(snapshot.facts)) throw new Error();
      // Only a version 3 copy holds documents, and it always holds at least one.
      const documents = snapshot.documents;
      if (snapshot.schemaVersion === 3
        ? !Array.isArray(documents) || documents.length === 0 || documents.length > MAX_SHARE_DOCUMENTS
        : documents !== undefined) throw new Error();
      // Prior grants are immutable copies without citations. Reconstruct each
      // shared resume from its immutable version and require an exact match;
      // this also prevents detached historical edits from reaching a coach.
      for (const shared of snapshot.resumes) {
        const saved = this.sql.exec<{ data: string }>(
          `SELECT data FROM resume_versions WHERE resume_id = ? AND version = ?`, shared.id, shared.version,
        ).toArray()[0];
        if (!saved) throw new Error();
        const version = JSON.parse(saved.data) as ResumeVersion;
        const expected = snapshotSelection({ facts: [], roles: [], resumes: [{ id: shared.id, ...version }] }, snapshot.createdAt).resumes[0];
        // A version 2 copy names the resume's job beside it. The job is the owner's label, not
        // part of what the resume says, so it is set aside before the comparison.
        const { job, ...core } = shared;
        if (snapshot.schemaVersion === 1 ? job !== undefined : !validJob(job)) throw new Error();
        if (JSON.stringify(expected) !== JSON.stringify(core)) throw new Error();
      }
      // Each shared document is rebuilt from its saved version through the same gate as when the
      // copy was made, and has to come out exactly as it was stored.
      for (const shared of documents ?? []) {
        const saved = this.sql.exec<{ kind: string; data: string }>(
          `SELECT d.kind, v.data FROM documents d JOIN document_versions v ON v.document_id = d.id AND v.version = ? WHERE d.id = ? AND d.state = 'ready'`,
          shared.version, shared.id,
        ).toArray()[0];
        if (!saved) throw new Error();
        const expected = sharedDocument(shared.id, shared.version, saved.kind, JSON.parse(saved.data) as DocumentVersion);
        const { job, ...core } = shared;
        if (!validJob(job)) throw new Error();
        if (JSON.stringify(expected) !== JSON.stringify(core)) throw new Error();
      }
      if (snapshot.schemaVersion !== 1) {
        const owner = snapshot.owner;
        if (owner !== null && (typeof owner?.name !== "string" || !owner.name || owner.name.length > 200)) throw new Error();
      }
    } catch {
      throw new AppError("gone", "this share link is unavailable or expired");
    }
    return {
      grantId: row.id,
      expiresAt: row.expires_at,
      snapshot,
    };
  }

  /** The grant, if it is this one and can be read now. Says the same thing whatever is wrong. */
  private open(claims: { grantId: string; epoch: string }, now: number): GrantRow {
    const row = this.sql
      .exec<GrantRow>(`SELECT * FROM share_grants WHERE id = ? AND epoch = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1`, claims.grantId, claims.epoch, now)
      .toArray()[0];
    // A copy from before the account's sessions were last ended is closed to everyone, as it is to its link.
    if (!row || row.snapshot === null || row.epoch !== this.auth.currentEpoch()) throw new AppError("gone", "this share link is unavailable or expired");
    return row;
  }

  /**
   * How an account stands to the coach a copy names: "none" when it names nobody, "named" when no
   * account is given, "other" for a different address, "you" for the named coach who hasn't taken
   * it up, and "joined" once they have.
   */
  reviewer(claims: { grantId: string; epoch: string }, account: CoachAccount | null, now = Date.now()): "none" | "named" | "other" | "you" | "joined" {
    this.auth.requireOpen();
    const row = this.open(claims, now);
    if (!row.coach_email) return "none";
    if (!account) return "named";
    if (account.email !== row.coach_email) return "other";
    return row.coach_user_id === account.userId ? "joined" : "you";
  }

  /**
   * Ties the copy to the account its owner named. Only the account that signed in with that address
   * can do it, and only while holding the link. Returns what that account's client list shows.
   */
  join(claims: { grantId: string; epoch: string }, coach: CoachAccount, now = Date.now()): { ownerName: string | null; expiresAt: number } {
    this.auth.requireOpen();
    const row = this.open(claims, now);
    if (!row.coach_email || row.coach_email !== coach.email)
      throw new AppError("forbidden", "this copy names a different address as its coach");
    const name = coach.name?.replace(/\s+/g, " ").trim().slice(0, 200) || null;
    this.sql.exec(
      `UPDATE share_grants SET coach_joined_at = CASE WHEN coach_user_id = ? THEN COALESCE(coach_joined_at, ?) ELSE ? END, coach_user_id = ?, coach_name = ? WHERE id = ?`,
      coach.userId, now, now, coach.userId, name, row.id,
    );
    return { ownerName: this.ownerName(row), expiresAt: row.expires_at };
  }

  private ownerName(row: GrantRow): string | null {
    try {
      const name = (JSON.parse(row.snapshot ?? "null") as ShareSnapshot | null)?.owner?.name;
      return typeof name === "string" && name ? name : null;
    } catch {
      return null;
    }
  }

  /** The grant as the account that took it up may see it now, or null. Never says why not. */
  private joined(grantId: string, coach: CoachAccount, now: number): GrantRow | null {
    const row = this.sql
      .exec<GrantRow>(`SELECT * FROM share_grants WHERE id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1`, grantId, now)
      .toArray()[0];
    if (!row || row.snapshot === null || row.epoch !== this.auth.currentEpoch()) return null;
    if (!row.coach_email || row.coach_email !== coach.email || row.coach_user_id !== coach.userId) return null;
    return row;
  }

  /**
   * Lets the account that took a copy up open it again without the link. It is the same access
   * the link gives, to the one account the owner named, for as long as the link itself would work.
   */
  openForCoach(grantId: string, coach: CoachAccount, now = Date.now()): { epoch: string; expiresAt: number } {
    this.auth.requireOpen();
    const row = this.joined(grantId, coach, now);
    if (!row) throw new AppError("gone", "this share link is unavailable or expired");
    // The copy has to be one that can be delivered, as when a link is exchanged.
    this.read({ grantId: row.id, epoch: row.epoch }, now);
    return { epoch: row.epoch, expiresAt: row.expires_at };
  }

  /** What a coach's client list shows for one copy. An ended or unknown one is simply not active. */
  coachStatus(grantId: string, coach: CoachAccount, now = Date.now()): Pick<CoachClient, "active" | "ownerName" | "expiresAt" | "factCount" | "resumeCount" | "documentCount"> | null {
    this.auth.requireOpen();
    const row = this.joined(grantId, coach, now);
    if (!row) return null;
    return {
      active: true,
      ownerName: this.ownerName(row),
      expiresAt: row.expires_at,
      factCount: row.fact_count,
      resumeCount: row.resume_count,
      documentCount: row.document_count ?? 0,
    };
  }

  /**
   * Notes that the reader opened the copy, for the owner's list. Internal reads don't count. The
   * time is kept to the minute the list shows, so reloading a copy doesn't write on every request.
   */
  recordRead(grantId: string, now = Date.now()): void {
    this.sql.exec(
      `UPDATE share_grants SET last_read_at = ? WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND (last_read_at IS NULL OR last_read_at <= ?)`,
      now,
      grantId,
      now,
      now - SHARE_READ_INTERVAL_MS,
    );
  }

  /** Call from the Vault alarm; access expiry is enforced even if alarm cleanup is delayed. */
  purgeExpired(now = Date.now()): void {
    this.sql.exec(`DELETE FROM share_grants WHERE expires_at <= ?`, now);
  }
}
