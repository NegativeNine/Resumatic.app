import { AppError } from "../shared/errors";
import { checkClaim, type Evidence } from "../grounding/claims";
import { authoritativeFact } from "../grounding/verdict";
import type { Profile, ResumeBody, ResumeReport } from "../shared/api";
import type {
  Analysis,
  FactRecord,
  RenderData,
  RoleRecord,
} from "../shared/types";
import { packVector, topMatches, unpackVector } from "./search";
import { isWithheld, sensitiveUse, usableQuote, withheldFacts, type Withheld } from "./sensitive";
import { validSkillDurationProof } from "../shared/skill-years";
import { SkillYearsStore } from "./skill-years";

export interface InputMetadata {
  skillDurationClaimIds?: string[];
  embeddingModel?: string;
  applicationId: string;
  jdText: string;
  analysis: Analysis | null;
  profile: Profile;
}

export interface ResumeVersion {
  render: RenderData;
  report: ResumeReport | null;
  facts: Record<string, { text: string; quote: string | null }>;
  /** Full immutable generation evidence. Missing on versions created before this field existed. */
  evidence?: Record<string, FactRecord>;
  /** Immutable confirmed Vault roles used to compose the section headings. */
  roleEvidence?: Record<string, RoleRecord>;
  /** Independent exact-line checks performed while remediating a legacy version. */
  legacyReceipts?: Record<string, { text: string; roleId: string | null; factIds: string[]; facts: FactRecord[]; roles: RoleRecord[] }>;
  /** Identifies an idempotently finalized legacy version. */
  legacyFinalizedFrom?: number;
  /** Identifies an explicit transition from a blocked snapshot to review. */
  reviewStartedFrom?: number;
  /** Identifies an idempotently removed line in a review version. */
  legacyRemoved?: { fromVersion: number; lineId: string };
  /** Identifies an idempotently removed section in a review version. */
  legacySectionRemoved?: { fromVersion: number; sectionIndex: number };
  /** Identifies an idempotently removed skill in a review version. */
  legacySkillRemoved?: { fromVersion: number; skillIndex: number };
  /** Identifies an idempotently removed line in a checked version. */
  lineRemoved?: { fromVersion: number; lineId: string };
  /** Identifies an idempotently removed skill in a checked version. */
  skillRemoved?: { fromVersion: number; skillIndex: number };
  provenance: "snapshot" | "legacy";
}

/** Metadata is usable for rebinding only when every verification-relevant field was captured. */
export function completeEvidence(value: FactRecord | undefined): value is FactRecord {
  return !!value && typeof value.id === "string" && value.id.length > 0 &&
    Number.isSafeInteger(value.revision) && (value.revision ?? 0) > 0 &&
    (value.origin === "extracted" || value.origin === "user") &&
    (value.roleId === null || (typeof value.roleId === "string" && value.roleId.length > 0)) &&
    ["accomplishment", "skill", "credential"].includes(value.kind) &&
    typeof value.text === "string" && value.text.trim().length > 0 &&
    (value.level === null || ["contributed", "implemented", "led", "owned", "founded"].includes(value.level)) &&
    (value.levelExplicit === undefined || typeof value.levelExplicit === "boolean") &&
    (value.skillDuration === undefined || (value.kind === "skill" && value.origin === "user" && value.roleId === null && value.quote === null && validSkillDurationProof(value.skillDuration,value.text))) &&
    (value.quote === null || typeof value.quote === "string") &&
    (value.origin !== "extracted" || (typeof value.quote === "string" && !!value.quote.trim()));
}

/** Preserve the full captured inputs, not a reconstruction from mutable current rows. */
export function evidenceForFacts(facts: FactRecord[]): Record<string, FactRecord> {
  const ids = new Set<string>();
  return Object.fromEntries(facts.map((fact) => {
    if (!completeEvidence(fact) || ids.has(fact.id))
      throw new AppError("conflict", "Where a fact came from is incomplete. Tailor the resume again.");
    ids.add(fact.id);
    return [fact.id, { ...fact }];
  }));
}

/** Capture headings from confirmed Vault rows, never from a generated body. */
export function evidenceForRoles(roles: RoleRecord[]): Record<string, RoleRecord> {
  const ids = new Set<string>();
  return Object.fromEntries(roles.map((role) => {
    if (!role || typeof role.id !== "string" || !role.id || ids.has(role.id) ||
        !Number.isSafeInteger(role.revision) || (role.revision ?? 0) < 1 ||
        !["job", "education", "project", "volunteer"].includes(role.kind) ||
        typeof role.org !== "string" ||
        (role.title !== null && typeof role.title !== "string") ||
        (role.startDate !== null && typeof role.startDate !== "string") ||
        (role.endDate !== null && typeof role.endDate !== "string") ||
        (role.unknownEndStartDate != null && typeof role.unknownEndStartDate !== "string"))
      throw new AppError("conflict", "Where a role came from is incomplete. Tailor the resume again.");
    ids.add(role.id);
    return [role.id, { ...role }];
  }));
}

/** Evidence without full metadata cannot prove that an older claim used the same inputs. */
export function sameEvidence(a: FactRecord | undefined, b: FactRecord | undefined): boolean {
  return completeEvidence(a) && completeEvidence(b) &&
    a.id === b.id && a.revision === b.revision && a.origin === b.origin &&
    a.roleId === b.roleId && a.kind === b.kind && a.text === b.text &&
    a.level === b.level && a.levelExplicit === b.levelExplicit && a.quote === b.quote && JSON.stringify(a.skillDuration) === JSON.stringify(b.skillDuration);
}

/**
 * A historical version is printable only if its stored evidence remains attached. Given the facts
 * withheld now, it is also refused while a line cites one or was checked against the line one was
 * read from, or a printed skill has only marked facts behind it.
 */
export function assertGroundedResume(
  render: RenderData,
  facts: ResumeVersion["facts"] | undefined,
  provenance: ResumeVersion["provenance"] | undefined,
  evidence?: ResumeVersion["evidence"],
  roleEvidence?: ResumeVersion["roleEvidence"],
  withheld?: Withheld,
): void {
  const unavailable = () => new AppError("conflict", "this resume version contains unverified content; review it before exporting or sharing");
  if (provenance !== "snapshot" || !facts || typeof facts !== "object" || Array.isArray(facts) ||
      !render?.body || !Array.isArray(render.body.sections) || !Array.isArray(render.body.skills)) throw unavailable();
  if (render.body.sections.some((section) => !section || !Array.isArray(section.lines))) throw unavailable();
  const seenRoles = new Set<string>();
  for (const section of render.body.sections) {
    if (typeof section.roleId !== "string" || !section.roleId || seenRoles.has(section.roleId) ||
        !roleEvidence || !Object.hasOwn(roleEvidence, section.roleId)) throw unavailable();
    seenRoles.add(section.roleId);
    const role = roleEvidence[section.roleId];
    try {
      if (!role || role.id !== section.roleId ||
          !Object.hasOwn(evidenceForRoles([role]), section.roleId) ||
          role.kind !== section.kind || role.org !== section.org || role.title !== section.title ||
          role.startDate !== section.startDate || role.endDate !== section.endDate ||
          (role.unknownEndStartDate ?? null) !== (section.unknownEndStartDate ?? null)) throw unavailable();
    } catch { throw unavailable(); }
  }
  const lines = [
    ...(render.body.summary ? [{ line: render.body.summary, roleId: null }] : []),
    ...render.body.sections.flatMap((section) => section.lines.map((line) => ({ line, roleId: section.roleId }))),
  ];
  const seenLines = new Set<string>();
  for (const { line, roleId } of lines) {
    if (!line || !["kept", "repaired", "replaced"].includes(line.status) ||
        typeof line.id !== "string" || !line.id || seenLines.has(line.id) ||
        typeof line.text !== "string" || !line.text.trim() ||
        !Array.isArray(line.factIds) || line.factIds.length === 0 ||
        line.factIds.some((id) => typeof id !== "string" || !Object.hasOwn(facts, id) ||
          typeof facts[id]?.text !== "string" || !facts[id]!.text.trim())) throw unavailable();
    seenLines.add(line.id);
    // A historic snapshot may have used a stale ownership level to verify a
    // line. Recheck scope from its stored evidence; only a complete immutable
    // record can establish that a user explicitly selected a level.
    const cited: Evidence[] = [];
    for (const id of line.factIds) {
      const stored = facts[id]!;
      if (stored.quote !== null && typeof stored.quote !== "string") throw unavailable();
      const full = evidence && Object.hasOwn(evidence, id) ? evidence[id] : undefined;
      // A section citation needs its immutable role binding, not just matching
      // text, or a fact can be silently moved under another employer.
      if (roleId !== null && !full) throw unavailable();
      if (full) {
        if (!completeEvidence(full) || full.id !== id || full.text !== stored.text || full.quote !== stored.quote ||
            (roleId !== null && full.roleId !== roleId)) throw unavailable();
        const safe = authoritativeFact(full);
        if (full.skillDuration && (line.factIds.length !== 1 || line.text !== full.text)) throw unavailable();
        cited.push({ text: safe.text, quote: safe.quote, level: safe.level });
      } else {
        // Earlier snapshots did not record origin. A retained quote may have
        // preceded a user's correction, so it cannot establish the revised claim.
        cited.push({ text: stored.text, quote: null, level: null });
      }
    }
    // Reapply current deterministic checks, including numbers and names, to
    // historical versions. These checks supplement the original model judge.
    if (!checkClaim(line.text, cited).ok) throw unavailable();
  }
  // Printed skills do not carry fact IDs. Require a matching full immutable
  // skill record; matching text alone cannot establish its kind or provenance.
  for (const skill of render.body.skills) {
    if (typeof skill !== "string" || !skill.trim() || !evidence ||
        !Object.entries(facts).some(([id, stored]) => {
          if (!stored || stored.text !== skill || !Object.hasOwn(evidence, id)) return false;
          const full = evidence[id];
          return completeEvidence(full) && full.id === id && full.kind === "skill" &&
            full.text === stored.text && full.quote === stored.quote;
        })) throw unavailable();
  }
  if (withheld?.invalidDerived?.size) {
    const used = new Set([
      ...(render.body.summary?.factIds ?? []),
      ...render.body.sections.flatMap((section) => section.lines.flatMap((line) => line.factIds)),
      ...Object.entries(evidence ?? {}).filter(([,fact]) => fact.kind === "skill" && render.body.skills.includes(fact.text)).map(([id]) => id),
    ]);
    if ([...used].some((id) => withheld.invalidDerived!.has(id))) throw unavailable();
  }
  // The version is sound, and still its owner's to read. What it took from a fact marked since
  // goes no further until those lines, those skills or the mark are removed.
  if (withheld) {
    const used = sensitiveUse(render.body, facts, evidence, withheld);
    if (used.lineIds.length > 0 || used.skills.length > 0)
      throw new AppError("conflict", "This version uses a fact you keep private. Remove those lines or tailor a new version, then try again.");
  }
}

/** Content stays in the Vault. Workflow state carries only the run ID. */
export class SnapshotStore {
  constructor(private readonly sql: SqlStorage) {}

  /** An absent or malformed incarnation cannot authenticate a captured row. */
  private incarnation(kind: "fact" | "role", id: string): number | null {
    const row = this.sql.exec<{ value: number }>(
      `SELECT i.value FROM entity_incarnations i JOIN entity_incarnation_clock c ON c.slot=1
       WHERE i.kind=? AND i.item_id=? AND typeof(c.value)='integer' AND c.value BETWEEN 0 AND 9007199254740991 AND i.value<=c.value`,
      kind, id,
    ).toArray()[0];
    return row && Number.isSafeInteger(row.value) && row.value >= 0 ? row.value : null;
  }

  private requireNoIncarnationWrite(): void {
    if (this.sql.exec(`SELECT slot FROM entity_incarnation_guard LIMIT 1`).toArray().length)
      throw new AppError("conflict", "Some of your experience still needs checking. Make the document again.");
  }

  capture(
    runId: string,
    metadata: InputMetadata,
    facts: FactRecord[],
    roles: RoleRecord[],
    vectors: ReadonlyMap<string, Float32Array>,
  ): void {
    if (this.metadata(runId)) return;
    this.requireNoIncarnationWrite();
    this.sql.exec(
      `INSERT INTO generation_inputs (run_id, metadata) VALUES (?, ?)`,
      runId,
      JSON.stringify(metadata),
    );
    for (const fact of facts) {
      const incarnation = this.incarnation("fact", fact.id);
      if (incarnation === null) throw new AppError("conflict", "Some of your experience still needs checking. Make the document again.");
      this.sql.exec(
        `INSERT INTO generation_input_items (run_id, kind, item_id, data, vector, incarnation) VALUES (?, 'fact', ?, ?, ?, ?)`,
        runId,
        fact.id,
        JSON.stringify(fact),
        vectors.has(fact.id)
          ? packVector(Array.from(vectors.get(fact.id)!))
          : null,
        incarnation,
      );
    }
    for (const role of roles) {
      const incarnation = this.incarnation("role", role.id);
      if (incarnation === null) throw new AppError("conflict", "Some of your experience still needs checking. Make the document again.");
      this.sql.exec(
        `INSERT INTO generation_input_items (run_id, kind, item_id, data, incarnation) VALUES (?, 'role', ?, ?, ?)`,
        runId,
        role.id,
        JSON.stringify(role),
        incarnation,
      );
    }
  }

  metadata(runId: string): InputMetadata | null {
    const row = this.sql
      .exec<{ metadata: string }>(
        `SELECT metadata FROM generation_inputs WHERE run_id = ?`,
        runId,
      )
      .toArray()[0];
    return row ? (JSON.parse(row.metadata) as InputMetadata) : null;
  }

  items<T>(runId: string, kind: "fact" | "role"): T[] {
    return this.sql
      .exec<{ data: string }>(
        `SELECT data FROM generation_input_items WHERE run_id = ? AND kind = ? ORDER BY item_id`,
        runId,
        kind,
      )
      .toArray()
      .map((r) => JSON.parse(r.data) as T);
  }

  search(runId: string, queries: number[][], k: number) {
    const vectors = new Map(
      this.sql
        .exec<{ item_id: string; vector: ArrayBuffer }>(
          `SELECT item_id, vector FROM generation_input_items WHERE run_id = ? AND kind = 'fact' AND vector IS NOT NULL`,
          runId,
        )
        .toArray()
        .map((r) => [r.item_id, unpackVector(r.vector)] as const),
    );
    return topMatches(queries, vectors, k);
  }

  /**
   * True when this run captured a fact that is marked sensitive now, or captured a fact with the
   * line a marked fact was read from as its quote. Either way the run holds words its owner has
   * withheld since, cited or not, and goes no further.
   */
  holdsWithheld(runId: string): boolean {
    return this.capturedWithheld(runId, withheldFacts(this.sql));
  }

  private capturedWithheld(runId: string, withheld: Withheld): boolean {
    if (withheld.ids.size === 0 && !withheld.invalidDerived?.size) return false;
    for (const row of this.sql
      .exec<{ item_id: string; data: string }>(`SELECT item_id, data FROM generation_input_items WHERE run_id = ? AND kind = 'fact'`, runId)
      .toArray()) {
      if (withheld.ids.has(row.item_id) || withheld.invalidDerived?.has(row.item_id)) return true;
      let captured: { text?: unknown; quote?: unknown } | null;
      try {
        captured = JSON.parse(row.data) as { text?: unknown; quote?: unknown } | null;
      } catch {
        // A captured row that can't be read has no quote to compare. assertCurrent refuses any line that cites it.
        continue;
      }
      if (captured && typeof captured === "object" && typeof captured.text === "string" && typeof captured.quote === "string" &&
          isWithheld(row.item_id, { text: captured.text, quote: captured.quote }, withheld)) return true;
    }
    return false;
  }

  /**
   * True when this run captured exactly the facts in `ids`, each still at the incarnation it was
   * captured at, so nothing it measured has been edited, rejected, replaced or added to since. A run
   * with no captured inputs (one that moved with its vault), a captured row without a valid
   * incarnation, or an incarnation write in progress never matches.
   */
  factsUnchanged(runId: string, ids: ReadonlySet<string>): boolean {
    if (!this.metadata(runId)) return false;
    if (this.sql.exec(`SELECT slot FROM entity_incarnation_guard LIMIT 1`).toArray().length) return false;
    // As `incarnation()` reads it: a live value past a valid clock authenticates nothing.
    const rows = this.sql
      .exec<{ item_id: string; captured: number | null; live: number | null }>(
        `SELECT g.item_id, g.incarnation AS captured, i.value AS live FROM generation_input_items g
         LEFT JOIN entity_incarnations i ON i.kind = 'fact' AND i.item_id = g.item_id AND i.value <=
           (SELECT c.value FROM entity_incarnation_clock c WHERE c.slot = 1 AND typeof(c.value) = 'integer' AND c.value BETWEEN 0 AND 9007199254740991)
         WHERE g.run_id = ? AND g.kind = 'fact'`,
        runId,
      )
      .toArray();
    return rows.length === ids.size && rows.every((row) =>
      ids.has(row.item_id) && typeof row.captured === "number" && Number.isSafeInteger(row.captured) &&
      row.captured >= 0 && row.captured === row.live);
  }

  assertCurrent(runId: string, body: ResumeBody): void {
    this.requireNoIncarnationWrite();
    const invalidFact = () => new AppError(
      "conflict",
      "Your facts changed while this draft was being made. Create it again.",
    );
    // Before the draft is looked at: a run that captured a fact marked since publishes nothing.
    const withheld = withheldFacts(this.sql);
    if (this.capturedWithheld(runId, withheld)) throw invalidFact();
    const invalidRole = () => new AppError(
      "conflict",
      "A role changed while this draft was being made. Make it again.",
    );
    const ids = new Set([
      ...(body.summary ? body.summary.factIds : []),
      ...body.sections.flatMap((s) => s.lines.flatMap((l) => l.factIds)),
    ]);
    const facts = new Map<string, FactRecord>();
    const factIncarnations = new Map<string, number | null>();
    for (const row of this.sql.exec<{ item_id: string; data: string; incarnation: number | null }>(
      `SELECT item_id, data, incarnation FROM generation_input_items WHERE run_id = ? AND kind = 'fact'`, runId,
    )) {
      let fact: FactRecord;
      try {
        fact = JSON.parse(row.data) as FactRecord;
        if (!fact || typeof fact !== "object" || Array.isArray(fact) || fact.id !== row.item_id)
          throw invalidFact();
      } catch {
        if (ids.has(row.item_id)) throw invalidFact();
        continue;
      }
      facts.set(row.item_id, fact);
      factIncarnations.set(row.item_id, row.incarnation);
    }
    const durations = new SkillYearsStore(this.sql,(fn) => fn());
    const durationFactIds = durations.backingIds();
    const factMatches = (id: string): boolean => {
      const old = facts.get(id);
      if (!old) return false;
      const capturedIncarnation = factIncarnations.get(id);
      if (capturedIncarnation === null || capturedIncarnation === undefined || !Number.isSafeInteger(capturedIncarnation) ||
          capturedIncarnation < 0 || this.incarnation("fact", id) !== capturedIncarnation) return false;
      const current = this.sql
        .exec<{ id: string; revision: number; state: string; role_id: string | null; kind: string; text: string;
          origin: string; level: string | null; level_revision: number | null; quote: string | null }>(
          `SELECT f.id, f.revision, f.state, f.role_id, f.kind, f.text, f.origin, f.level, f.level_revision, e.quote
           FROM facts f LEFT JOIN evidence e ON e.id = f.evidence_id WHERE f.id = ?`,
          id,
        )
        .toArray()[0];
      if (!current || current.state !== "confirmed") return false;
      const now: FactRecord = {
        id: current.id, revision: current.revision, roleId: current.role_id,
        kind: current.kind as FactRecord["kind"], text: current.text, origin: current.origin as FactRecord["origin"],
        level: (current.origin === "user" && current.level_revision !== current.revision ? null : current.level) as FactRecord["level"],
        ...(current.origin === "user" ? { levelExplicit: current.level !== null && current.level_revision === current.revision } : {}),
        // As the run would capture it now: a fact read from a marked fact's line has its own words
        // for a quote, so a run that captured it that way still matches.
        quote: usableQuote(current, withheld),
      };
      if (durationFactIds.has(id)) {
        if (!old.skillDuration || !this.metadata(runId)?.skillDurationClaimIds?.includes(old.skillDuration.claimId)) return false;
        try { now.skillDuration = durations.proofForFact(id,withheld.ids) ?? undefined; } catch { return false; }
      } else if (old.skillDuration) return false;
      // Older user snapshots without a level flag did not claim an explicit
      // level when their captured effective level was null.
      const captured = old.origin === "user" && old.level === null && old.levelExplicit === undefined
        ? { ...old, levelExplicit: false } : old;
      return sameEvidence(captured, now);
    };
    const roleRows = new Map(this.sql.exec<{ item_id: string; data: string; incarnation: number | null }>(
      `SELECT item_id, data, incarnation FROM generation_input_items WHERE run_id = ? AND kind = 'role'`, runId,
    ).toArray().map((row) => [row.item_id, row]));
    const roleChecks = new Map<string, boolean>();
    const roleMatches = (id: string): boolean => {
      const cached = roleChecks.get(id);
      if (cached !== undefined) return cached;
      const row = roleRows.get(id);
      if (!row || row.incarnation === null || !Number.isSafeInteger(row.incarnation) ||
          row.incarnation < 0 || this.incarnation("role", id) !== row.incarnation) return false;
      let captured: RoleRecord;
      try {
        captured = JSON.parse(row.data) as RoleRecord;
        if (!captured || captured.id !== id) return false;
        evidenceForRoles([captured]);
      } catch { return false; }
      const current = this.sql
        .exec<{ revision: number; state: string; kind: string; org: string; title: string | null;
          start_date: string | null; end_date: string | null; unknown_end_start_date: string | null }>(
          `SELECT revision, state, kind, org, title, start_date, end_date, unknown_end_start_date FROM roles WHERE id = ?`,
          id,
        )
        .toArray()[0];
      const valid = !!current && current.state === "confirmed" && current.revision === captured.revision &&
        current.kind === captured.kind && current.org === captured.org && current.title === captured.title &&
        current.start_date === captured.startDate && current.end_date === captured.endDate &&
        current.unknown_end_start_date === (captured.unknownEndStartDate ?? null);
      roleChecks.set(id, valid);
      return valid;
    };
    const roleIds = new Set(body.sections.map((s) => s.roleId));
    for (const id of ids) {
      if (!factMatches(id)) throw invalidFact();
      const roleId = facts.get(id)?.roleId;
      if (roleId) roleIds.add(roleId);
    }
    for (const id of roleIds) if (!roleMatches(id)) throw invalidRole();
    // A skill has no output fact ID. One still-confirmed matching captured
    // skill (including its role, if any) suffices; line citations above remain
    // tied to their exact fact IDs.
    for (const skill of body.skills) {
      const supported = [...facts.values()].some((fact) =>
        fact.kind === "skill" && fact.text === skill && factMatches(fact.id) &&
        (!fact.roleId || roleMatches(fact.roleId)),
      );
      if (!supported) throw invalidFact();
    }
  }

  /** Saves a version once. `createdAt` is when it was made, which is now unless it is older than its saving. */
  save(resumeId: string, version: number, data: ResumeVersion, createdAt = Date.now()): void {
    const existing = this.read(resumeId, version);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(data))
        throw new AppError("conflict", "document versions are immutable");
      return;
    }
    this.sql.exec(
      `INSERT INTO resume_versions (resume_id, version, data, created_at) VALUES (?, ?, ?, ?)`,
      resumeId,
      version,
      JSON.stringify(data),
      createdAt,
    );
  }

  read(resumeId: string, version: number): ResumeVersion | null {
    const row = this.sql
      .exec<{ data: string }>(
        `SELECT data FROM resume_versions WHERE resume_id = ? AND version = ?`,
        resumeId,
        version,
      )
      .toArray()[0];
    return row ? (JSON.parse(row.data) as ResumeVersion) : null;
  }

  versions(resumeId: string) {
    return this.sql
      .exec<{ version: number; created_at: number }>(
        `SELECT version, created_at FROM resume_versions WHERE resume_id = ? ORDER BY version DESC`,
        resumeId,
      )
      .toArray()
      .map((r) => ({ version: r.version, createdAt: r.created_at }));
  }
}
