import type { FactView, ResumeLine, RoleView } from "../shared/api";
import { AppError } from "../shared/errors";
import {
  MAX_SHARE_LABEL_CHARS,
  type ShareGrant,
  type SharedJob,
  type SharedLine,
  type SharedResume,
  type SharedRole,
  type SharedView,
  type ShareSnapshot,
} from "../shared/sharing";
import type { RenderData, Who } from "../shared/types";
import { assertGroundedResume, type ResumeVersion } from "./snapshots";

export const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_SHARE_FACTS = 100;
export const MAX_SHARE_RESUMES = 20;
export const MAX_SHARE_BYTES = 1024 * 1024;
export const SHARE_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS share_grants (
    id TEXT PRIMARY KEY, epoch TEXT NOT NULL, created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, revoked_at INTEGER, fact_count INTEGER NOT NULL,
    resume_count INTEGER NOT NULL, snapshot TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS share_expiry ON share_grants(expires_at)`,
];

/** How often, at most, a copy's last-opened time is written. */
export const SHARE_READ_INTERVAL_MS = 60_000;

/** A label for the owner's own list, and when the copy was last opened. */
export const SHARE_DETAIL_MIGRATIONS: readonly string[] = [
  `ALTER TABLE share_grants ADD COLUMN label TEXT`,
  `ALTER TABLE share_grants ADD COLUMN last_read_at INTEGER`,
];

/** What a version 2 copy adds to the selection: none of it changes what the facts or resumes say. */
export interface ShareDetails {
  label?: string | null;
  /** The owner's name for the top of the copy, or null to leave it off. */
  owner?: { name: string } | null;
  /** Each shared resume's job, by resume ID. */
  jobs?: Readonly<Record<string, SharedJob>>;
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
    throw new AppError("invalid", "select at least one fact or resume");
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
});

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
    const core = snapshotSelection(selection, now);
    // The name and the jobs are added around the checked selection, so what a fact or a resume
    // says is still exactly what read() rebuilds and compares.
    const owner = details.owner?.name.trim() ? { name: details.owner.name.trim().slice(0, 200) } : null;
    const snapshot: ShareSnapshot = {
      schemaVersion: 2,
      createdAt: core.createdAt,
      owner,
      facts: core.facts,
      resumes: core.resumes.map((resume) => {
        const job = details.jobs?.[resume.id];
        return { ...resume, job: job ? { title: job.title, company: job.company } : null };
      }),
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
      label,
      lastReadAt: null,
    };
    this.sql.exec(
      `INSERT INTO share_grants (id, epoch, created_at, expires_at, revoked_at, fact_count, resume_count, snapshot, label) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      grant.id,
      grant.epoch,
      now,
      expiresAt,
      grant.factCount,
      grant.resumeCount,
      JSON.stringify(snapshot),
      label,
    );
    return grant;
  }

  list(who: Who, now = Date.now()): ShareGrant[] {
    this.auth.authorizeOwner(who);
    return this.sql
      .exec<GrantRow>(
        `SELECT id, epoch, created_at, expires_at, revoked_at, fact_count, resume_count, label, last_read_at FROM share_grants ORDER BY created_at DESC LIMIT 200`,
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
      if ((snapshot.schemaVersion !== 1 && snapshot.schemaVersion !== 2) || !Array.isArray(snapshot.resumes) || !Array.isArray(snapshot.facts)) throw new Error();
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
      if (snapshot.schemaVersion === 2) {
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
