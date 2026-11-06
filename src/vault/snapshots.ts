import { AppError } from "../shared/errors";
import type { Profile, ResumeBody, ResumeReport } from "../shared/api";
import type {
  Analysis,
  FactRecord,
  RenderData,
  RoleRecord,
} from "../shared/types";
import { packVector, topMatches, unpackVector } from "./search";

export interface InputMetadata {
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
  provenance: "snapshot" | "legacy";
}

/** A historical version is printable only if its stored evidence remains attached. */
export function assertGroundedResume(
  render: RenderData,
  facts: ResumeVersion["facts"] | undefined,
  provenance: ResumeVersion["provenance"] | undefined,
): void {
  const unavailable = () => new AppError("conflict", "this resume version contains unverified content; review it before exporting or sharing");
  if (provenance !== "snapshot" || !facts || typeof facts !== "object" || Array.isArray(facts) ||
      !render?.body || !Array.isArray(render.body.sections) || !Array.isArray(render.body.skills)) throw unavailable();
  if (render.body.sections.some((section) => !section || !Array.isArray(section.lines))) throw unavailable();
  const lines = [
    ...(render.body.summary ? [render.body.summary] : []),
    ...render.body.sections.flatMap((section) => section.lines),
  ];
  for (const line of lines) {
    if (!line || !["kept", "repaired", "replaced"].includes(line.status) ||
        !Array.isArray(line.factIds) || line.factIds.length === 0 ||
        line.factIds.some((id) => typeof id !== "string" || !Object.hasOwn(facts, id) ||
          typeof facts[id]?.text !== "string" || !facts[id]!.text.trim())) throw unavailable();
  }
  const texts = new Set(Object.values(facts).map((fact) => fact?.text).filter((text): text is string => typeof text === "string" && !!text.trim()));
  if (render.body.skills.some((skill) => typeof skill !== "string" || !texts.has(skill))) throw unavailable();
}

/** Content stays in the Vault. Workflow state carries only the run ID. */
export class SnapshotStore {
  constructor(private readonly sql: SqlStorage) {}

  capture(
    runId: string,
    metadata: InputMetadata,
    facts: FactRecord[],
    roles: RoleRecord[],
    vectors: ReadonlyMap<string, Float32Array>,
  ): void {
    if (this.metadata(runId)) return;
    this.sql.exec(
      `INSERT INTO generation_inputs (run_id, metadata) VALUES (?, ?)`,
      runId,
      JSON.stringify(metadata),
    );
    for (const fact of facts)
      this.sql.exec(
        `INSERT INTO generation_input_items (run_id, kind, item_id, data, vector) VALUES (?, 'fact', ?, ?, ?)`,
        runId,
        fact.id,
        JSON.stringify(fact),
        vectors.has(fact.id)
          ? packVector(Array.from(vectors.get(fact.id)!))
          : null,
      );
    for (const role of roles)
      this.sql.exec(
        `INSERT INTO generation_input_items (run_id, kind, item_id, data) VALUES (?, 'role', ?, ?)`,
        runId,
        role.id,
        JSON.stringify(role),
      );
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

  assertCurrent(runId: string, body: ResumeBody): void {
    const facts = new Map(
      this.items<FactRecord>(runId, "fact").map((f) => [f.id, f]),
    );
    const ids = new Set([
      ...(body.summary ? body.summary.factIds : []),
      ...body.sections.flatMap((s) => s.lines.flatMap((l) => l.factIds)),
    ]);
    // Skills print directly from confirmed facts and need the same revocation check.
    for (const f of facts.values())
      if (f.kind === "skill" && body.skills.includes(f.text)) ids.add(f.id);
    for (const id of ids) {
      const old = facts.get(id);
      const current = this.sql
        .exec<{ revision: number; state: string }>(
          `SELECT revision, state FROM facts WHERE id = ?`,
          id,
        )
        .toArray()[0];
      if (
        !old ||
        !current ||
        current.state !== "confirmed" ||
        current.revision !== (old.revision ?? 1)
      ) {
        throw new AppError(
          "conflict",
          "experience changed while this draft was being made; generate it again",
        );
      }
    }
    const roleIds = new Set(body.sections.map((s) => s.roleId));
    for (const id of ids) {
      const roleId = facts.get(id)?.roleId;
      if (roleId) roleIds.add(roleId);
    }
    const roles = new Map(
      this.items<RoleRecord>(runId, "role").map((r) => [r.id, r]),
    );
    for (const id of roleIds) {
      const current = this.sql
        .exec<{ revision: number; state: string }>(
          `SELECT revision, state FROM roles WHERE id = ?`,
          id,
        )
        .toArray()[0];
      if (
        !current ||
        current.state !== "confirmed" ||
        current.revision !== (roles.get(id)?.revision ?? 1)
      ) {
        throw new AppError(
          "conflict",
          "a role changed while this draft was being made; generate it again",
        );
      }
    }
  }

  save(resumeId: string, version: number, data: ResumeVersion): void {
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
      Date.now(),
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
