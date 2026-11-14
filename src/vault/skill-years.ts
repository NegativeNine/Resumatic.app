import { partText, partsProblem, rangesProblem, type Range } from "../shared/record";
import { AppError } from "../shared/errors";
import { contentDigest } from "../shared/operations";
import {
  intervalProblem, MAX_SKILL_INTERVALS, SKILL_YEARS_CHANGED, SKILL_YEARS_METHOD,
  skillDurationBounds, skillDurationText, utcMonth, validSkillLabel,
  type SkillDurationClaim, type SkillDurationProof, type SkillInterval, type SkillIntervalInput,
  type SkillSubject, type SkillSubjectRef, type SkillYearsView,
} from "../shared/skill-years";
import type { FactRecord } from "../shared/types";

export const SKILL_YEARS_MIGRATIONS: readonly string[] = [
  `CREATE TABLE skill_record_identities (kind TEXT NOT NULL CHECK(kind IN ('fact','role','split','part','tag')), item_id TEXT NOT NULL, token TEXT NOT NULL CHECK(length(token)=32), PRIMARY KEY(kind,item_id))`,
  ...([['facts','fact',['revision','state','role_id','kind','text','origin','level','level_revision','evidence_id','source_id']],
      ['roles','role',['revision','state','kind','org','title','start_date','end_date','unknown_end_start_date','evidence_id','source_id']],
      ['fact_splits','split',['fact_id','state','shadow','proposed_by','model','method','taxonomy_version','confidence','created_at','decided_by','decided_at']],
      ['fact_parts','part',['split_id','position','kind','ranges','result_of']],
      ['record_tags','tag',['subject_kind','subject_id','concept_id','concept_kind','label','relation','state','shadow','proposed_by','model','method','taxonomy_version','confidence','created_at','decided_by','decided_at']]] as const).flatMap(([table, kind, fields]) => [
    `INSERT INTO skill_record_identities(kind,item_id,token) SELECT '${kind}',id,lower(hex(randomblob(16))) FROM ${table}`,
    // A fenced target receives the source identities after its facts. It must not manufacture
    // substitute identities while importing; missing imported tokens fail closed.
    `CREATE TRIGGER skill_identity_${kind}_insert AFTER INSERT ON ${table}
      WHEN NOT EXISTS(SELECT 1 FROM vault_operations WHERE kind='import' AND state='importing') BEGIN
        INSERT INTO skill_record_identities(kind,item_id,token) VALUES('${kind}',NEW.id,lower(hex(randomblob(16)))); END`,
    `CREATE TRIGGER skill_identity_${kind}_delete AFTER DELETE ON ${table} BEGIN
        DELETE FROM skill_record_identities WHERE kind='${kind}' AND item_id=OLD.id; END`,
    `CREATE TRIGGER skill_identity_${kind}_update AFTER UPDATE OF ${fields.join(',')} ON ${table}
      WHEN ${fields.map((field) => `OLD.${field} IS NOT NEW.${field}`).join(' OR ')} BEGIN
        UPDATE skill_record_identities SET token=lower(hex(randomblob(16))) WHERE kind='${kind}' AND item_id=NEW.id; END`,
  ]),
  ...(['INSERT','UPDATE','DELETE'] as const).map((action) => {
    const row = action === 'DELETE' ? 'OLD' : 'NEW';
    return `CREATE TRIGGER skill_identity_evidence_${action.toLowerCase()} AFTER ${action} ON evidence BEGIN
      UPDATE skill_record_identities SET token=lower(hex(randomblob(16))) WHERE
        (kind='fact' AND item_id IN (SELECT id FROM facts WHERE evidence_id=${row}.id)) OR
        (kind='role' AND item_id IN (SELECT id FROM roles WHERE evidence_id=${row}.id)); END`;
  }),
  ...(['UPDATE','DELETE'] as const).map((action) => {
    return `CREATE TRIGGER skill_identity_revision_${action.toLowerCase()} AFTER ${action} ON source_revisions BEGIN
      UPDATE skill_record_identities SET token=lower(hex(randomblob(16))) WHERE
        (kind='fact' AND item_id IN (SELECT f.id FROM facts f JOIN evidence e ON e.id=f.evidence_id WHERE e.source_revision_id IN (${action === 'UPDATE' ? 'OLD.id,NEW.id' : 'OLD.id'}))) OR
        (kind='role' AND item_id IN (SELECT r.id FROM roles r JOIN evidence e ON e.id=r.evidence_id WHERE e.source_revision_id IN (${action === 'UPDATE' ? 'OLD.id,NEW.id' : 'OLD.id'}))); END`;
  }),
  `CREATE TABLE skill_use_intervals (id TEXT PRIMARY KEY, subject TEXT NOT NULL, skill_key TEXT NOT NULL,
    start_date TEXT NOT NULL, end_date TEXT, ongoing INTEGER NOT NULL CHECK (ongoing IN (0,1)),
    private INTEGER NOT NULL CHECK (private IN (0,1)), state TEXT NOT NULL CHECK (state IN ('confirmed','withdrawn')),
    revision INTEGER NOT NULL CHECK (revision > 0), created_at INTEGER NOT NULL)`,
  `CREATE INDEX skill_periods_by_skill ON skill_use_intervals (skill_key)`,
  `CREATE TABLE skill_duration_claims (id TEXT PRIMARY KEY, fact_id TEXT NOT NULL UNIQUE,
    skill_key TEXT NOT NULL, label TEXT NOT NULL, text TEXT NOT NULL, as_of TEXT NOT NULL,
    inputs TEXT NOT NULL, input_hash TEXT NOT NULL, lower_months INTEGER NOT NULL,
    upper_months INTEGER NOT NULL, precision TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TRIGGER skill_duration_claim_immutable BEFORE UPDATE ON skill_duration_claims BEGIN
    SELECT RAISE(ABORT, 'skill duration claims are immutable'); END`,
  `CREATE TABLE skill_year_requests (request_key TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL)`,
];
type IntervalRow = { id: string; subject: string; skill_key: string; start_date: string; end_date: string | null; ongoing: number; private: number; state: string; revision: number; created_at: number };
type ClaimRow = { id: string; fact_id: string; skill_key: string; label: string; text: string; as_of: string; inputs: string; input_hash: string; lower_months: number; upper_months: number; precision: string; created_at: number };
type Fact = { id: string; identity: string | null; role_identity: string | null; revision: number; state: string; role_id: string | null; kind: string; text: string; role_state: string | null; role_revision: number | null; origin: string; level: string | null; evidence_id: string | null; source_id: string | null };
const identity = (subject: SkillSubject) => ({ ref: subject.ref, key: subject.key, label: subject.label, anchor: subject.anchor });
const changed = () => new AppError("conflict", SKILL_YEARS_CHANGED);

export class SkillYearsStore {
  constructor(private readonly sql: SqlStorage, private readonly transaction: <T>(fn: () => T) => T) {}

  private fact(id: string): Fact | undefined {
    return this.sql.exec<Fact>(`SELECT f.id,f.revision,f.state,f.role_id,f.kind,f.text,f.origin,f.level,f.evidence_id,f.source_id,r.state AS role_state,r.revision AS role_revision,fi.token AS identity,ri.token AS role_identity
      FROM facts f LEFT JOIN roles r ON r.id=f.role_id LEFT JOIN skill_record_identities fi ON fi.kind='fact' AND fi.item_id=f.id LEFT JOIN skill_record_identities ri ON ri.kind='role' AND ri.item_id=r.id WHERE f.id=?`, id).toArray()[0];
  }
  private claimsTable: boolean | undefined;
  private hasClaimsTable(): boolean {
    return this.claimsTable ??= this.sql.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='skill_duration_claims'`).toArray().length > 0;
  }
  isBackingFact(id: string): boolean {
    return this.hasClaimsTable() && this.sql.exec(`SELECT id FROM skill_duration_claims WHERE fact_id=?`, id).toArray().length > 0;
  }
  backingIds(): Set<string> {
    return new Set(this.hasClaimsTable() ? this.sql.exec<{ fact_id: string }>(`SELECT fact_id FROM skill_duration_claims`).toArray().map((r) => r.fact_id) : []);
  }

  resolve(ref: SkillSubjectRef, privateIds: ReadonlySet<string>): SkillSubject | null {
    if (!ref || !["fact", "tag"].includes(ref.kind) || typeof ref.id !== "string") return null;
    let tagIdentity: string | null = null;
    let splitParts: Record<string, string | number | null>[] | undefined;
    let fact: Fact | undefined, tag: Record<string, string | number | null> | undefined, part: Record<string, string | number | null> | undefined;
    if (ref.kind === "fact") fact = this.fact(ref.id);
    else {
      tag = this.sql.exec<Record<string, string | number | null>>(`SELECT * FROM record_tags WHERE id=? AND state='confirmed' AND shadow=0
        AND subject_kind IN ('fact','part') AND concept_kind IN ('skill','knowledge','skill-group','tool','tool-category')`, ref.id).toArray()[0];
      if (!tag) return null;
      tagIdentity = this.sql.exec<{ token: string }>(`SELECT token FROM skill_record_identities WHERE kind='tag' AND item_id=?`, ref.id).toArray()[0]?.token ?? null;
      if (!tagIdentity) return null;
      if (tag.subject_kind === "part") {
        part = this.sql.exec<Record<string, string | number | null>>(`SELECT p.*,s.fact_id,s.state AS split_state,s.shadow AS split_shadow,s.method AS split_method,s.model AS split_model,s.created_at AS split_created_at,s.decided_at AS split_decided_at,pi.token AS part_identity,si.token AS split_identity
          FROM fact_parts p JOIN fact_splits s ON s.id=p.split_id LEFT JOIN skill_record_identities pi ON pi.kind='part' AND pi.item_id=p.id LEFT JOIN skill_record_identities si ON si.kind='split' AND si.item_id=s.id WHERE p.id=? AND s.state='confirmed' AND s.shadow=0`, String(tag.subject_id)).toArray()[0];
        if (!part || !part.part_identity || !part.split_identity) return null;
      }
      fact = this.fact(String(part ? part.fact_id : tag.subject_id));
    }
    if (!fact || !fact.identity || (fact.role_id !== null && !fact.role_identity) || fact.state !== "confirmed" || (fact.role_id !== null && fact.role_state !== "confirmed") ||
        (ref.kind === "fact" && fact.kind !== "skill") || this.isBackingFact(fact.id)) return null;
    if (part) {
      if (!["clause", "result"].includes(String(part.kind))) return null;
      let ranges: unknown;
      try { ranges = JSON.parse(String(part.ranges)); } catch { return null; }
      if (rangesProblem(fact.text, ranges) || !partText(fact.text, ranges as Range[]).trim()) return null;
      splitParts = this.sql.exec<Record<string, string | number | null>>(`SELECT p.*,i.token AS identity FROM fact_parts p LEFT JOIN skill_record_identities i ON i.kind='part' AND i.item_id=p.id WHERE p.split_id=? ORDER BY p.position`, String(part.split_id)).toArray();
      try {
        if (splitParts.some((p,index) => !p.identity || p.position !== index) || partsProblem(fact.text, splitParts.map((p) => ({ kind: p.kind, ranges: JSON.parse(String(p.ranges)), resultOf: p.result_of })))) return null;
      } catch { return null; }
    }
    const label = tag ? String(tag.label) : fact.text;
    if (!validSkillLabel(label)) return null;
    return { ref, key: tag ? `concept:${tag.taxonomy_version}:${tag.concept_id}` : `fact:${fact.id}`, label,
      anchor: JSON.stringify({ fact, ...(tag ? { tag, tagIdentity } : {}), ...(part ? { part, splitParts } : {}) }), private: privateIds.has(fact.id) };
  }

  subjects(privateIds: ReadonlySet<string>): SkillSubject[] {
    const refs: SkillSubjectRef[] = this.sql.exec<{ id: string }>(`SELECT id FROM facts WHERE kind='skill' AND state='confirmed' ORDER BY rowid LIMIT 2000`).toArray().map((r) => ({ kind: "fact", id: r.id }));
    refs.push(...this.sql.exec<{ id: string }>(`SELECT id FROM record_tags WHERE state='confirmed' AND shadow=0 AND subject_kind IN ('fact','part')
      AND concept_kind IN ('skill','knowledge','skill-group','tool','tool-category') ORDER BY created_at,id LIMIT 2000`).toArray().map((r) => ({ kind: "tag" as const, id: r.id })));
    return refs.flatMap((ref) => { const found = this.resolve(ref, privateIds); return found ? [found] : []; });
  }
  intervals(): SkillInterval[] {
    return this.sql.exec<IntervalRow>(`SELECT * FROM skill_use_intervals ORDER BY created_at,id`).toArray().map((r) => ({
      id: r.id, subject: JSON.parse(r.subject) as SkillSubject, start: r.start_date, end: r.end_date,
      ongoing: r.ongoing === 1, private: r.private === 1, revision: r.revision,
      state: r.state as SkillInterval["state"], createdAt: r.created_at,
    }));
  }
  private replay(key: string, digest: string): string | null {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(key)) throw new AppError("invalid", "A request identity is required.");
    const row = this.sql.exec<{ digest: string; result: string }>(`SELECT digest,result FROM skill_year_requests WHERE request_key=?`, key).toArray()[0];
    if (!row) return null;
    if (row.digest !== digest) throw new AppError("conflict", "That request was already used for another change.");
    return row.result;
  }
  private receipt(key: string, digest: string, result: string, now: number): void {
    if (this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM skill_year_requests`).one().n >= 5000) throw new AppError("too_large", "Too many skill-period changes.");
    this.sql.exec(`INSERT INTO skill_year_requests (request_key,digest,result,created_at) VALUES (?,?,?,?)`, key,digest,result,now);
  }
  save(input: SkillIntervalInput, requestKey: string, privateIds: ReadonlySet<string>, edit?: { id: string; expectedRevision: number }, now = Date.now()): string {
    const digest = JSON.stringify(["period",input,edit ?? null]);
    return this.transaction(() => {
      const replay = this.replay(requestKey,digest); if (replay) return replay;
      const problem = intervalProblem(input,utcMonth(now));
      if (problem || typeof input.private !== "boolean") throw new AppError("invalid", problem ?? "Choose whether this period is private.");
      const subject = this.resolve(input.subject,privateIds);
      if (!subject) throw new AppError("conflict", "Choose a current confirmed skill or concept.");
      const id = edit?.id ?? crypto.randomUUID();
      if (edit) {
        const old = this.intervals().find((r) => r.id === id);
        if (!old || old.revision !== edit.expectedRevision || !Number.isSafeInteger(edit.expectedRevision) || edit.expectedRevision < 1 || edit.expectedRevision >= Number.MAX_SAFE_INTEGER) throw changed();
        this.sql.exec(`UPDATE skill_use_intervals SET subject=?,skill_key=?,start_date=?,end_date=?,ongoing=?,private=?,state='confirmed',revision=revision+1 WHERE id=?`,
          JSON.stringify(subject),subject.key,input.start,input.end,input.ongoing ? 1 : 0,input.private ? 1 : 0,id);
      } else {
        if (this.intervals().length >= MAX_SKILL_INTERVALS) throw new AppError("too_large", "This record already has as many skill periods as it can hold.");
        this.sql.exec(`INSERT INTO skill_use_intervals (id,subject,skill_key,start_date,end_date,ongoing,private,state,revision,created_at)
          VALUES (?,?,?,?,?,?,?,'confirmed',1,?)`,id,JSON.stringify(subject),subject.key,input.start,input.end,input.ongoing ? 1 : 0,input.private ? 1 : 0,now);
      }
      this.receipt(requestKey,digest,id,now); return id;
    });
  }
  withdraw(id: string, expectedRevision: number, requestKey: string, now = Date.now()): void {
    const digest = JSON.stringify(["withdraw",id,expectedRevision]);
    this.transaction(() => {
      if (this.replay(requestKey,digest)) return;
      const row = this.intervals().find((r) => r.id === id);
      if (!row || row.revision !== expectedRevision || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw changed();
      this.sql.exec(`UPDATE skill_use_intervals SET state='withdrawn',revision=revision+1 WHERE id=?`,id);
      this.receipt(requestKey,digest,id,now);
    });
  }
  private inputs(subject: SkillSubjectRef, asOf: string, privateIds: ReadonlySet<string>, now: number) {
    const selected = this.resolve(subject,privateIds);
    if (!selected || asOf !== utcMonth(now)) throw changed();
    const intervals = this.intervals().filter((r) => r.state === "confirmed" && r.subject.key === selected.key);
    if (!intervals.length || intervals.some((r) => {
      const live = this.resolve(r.subject.ref,privateIds);
      return !live || JSON.stringify(identity(live)) !== JSON.stringify(identity(r.subject));
    })) throw changed();
    const bounds = skillDurationBounds(intervals,asOf);
    const text = bounds && skillDurationText(selected.label,bounds,asOf);
    if (!bounds || !text) throw new AppError("invalid", "These dates do not establish a complete period of skill use yet. Refine the dates before confirming a total.");
    const value = { method: SKILL_YEARS_METHOD, skillKey: selected.key, label: selected.label, asOf, bounds, text,
      intervals: intervals.map((r) => ({ ...r, subject: identity(r.subject) })) };
    return { value, serialized: JSON.stringify(value), private: intervals.some((r) => r.private || this.resolve(r.subject.ref,privateIds)?.private) };
  }
  async preview(subject: SkillSubjectRef, privateIds: ReadonlySet<string>, now = Date.now()) {
    const input = this.inputs(subject,utcMonth(now),privateIds,now);
    return { asOf: utcMonth(now), bounds: input.value.bounds, text: input.value.text, inputHash: await contentDigest(input.value), private: input.private };
  }
  async confirm(subject: SkillSubjectRef, asOf: string, expectedInputHash: string, requestKey: string, guard: () => ReadonlySet<string>, now = Date.now()): Promise<SkillDurationClaim> {
    const digest = JSON.stringify(["claim",subject,asOf,expectedInputHash]);
    const prior = this.replay(requestKey,digest);
    if (prior) return this.claim(prior,guard())!;
    const before = this.inputs(subject,asOf,guard(),now);
    const hash = await contentDigest(before.value);
    return this.transaction(() => {
      const privateIds = guard();
      const replay = this.replay(requestKey,digest); if (replay) return this.claim(replay,privateIds)!;
      if (hash !== expectedInputHash || this.inputs(subject,asOf,privateIds,now).serialized !== before.serialized) throw changed();
      if (this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM skill_duration_claims`).one().n >= 256) throw new AppError("too_large", "This record already holds as many confirmed skill totals as it can keep.");
      const id = crypto.randomUUID(), factId = crypto.randomUUID();
      this.sql.exec(`INSERT INTO facts (id,role_id,kind,text,level,origin,state,updated_at) VALUES (?,NULL,'skill',?,NULL,'user','confirmed',?)`,factId,before.value.text,now);
      this.sql.exec(`INSERT INTO skill_duration_claims (id,fact_id,skill_key,label,text,as_of,inputs,input_hash,lower_months,upper_months,precision,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,id,factId,before.value.skillKey,before.value.label,before.value.text,asOf,before.serialized,hash,before.value.bounds.lowerMonths,before.value.bounds.upperMonths,before.value.bounds.precision,now);
      this.receipt(requestKey,digest,id,now);
      return this.claim(id,privateIds)!;
    });
  }
  claim(id: string, privateIds: ReadonlySet<string>): SkillDurationClaim | null {
    const row = this.sql.exec<ClaimRow>(`SELECT * FROM skill_duration_claims WHERE id=?`,id).toArray()[0];
    return row ? this.claimView(row,privateIds) : null;
  }
  private claimView(row: ClaimRow, privateIds: ReadonlySet<string>, current = this.intervals(), resolve = (ref: SkillSubjectRef) => this.resolve(ref,privateIds)): SkillDurationClaim {
    const input = JSON.parse(row.inputs) as { method: string; skillKey: string; label: string; text: string; asOf: string; bounds: SkillDurationClaim["bounds"]; intervals: SkillInterval[] };
    const calculated = skillDurationBounds(input.intervals, row.as_of);
    let valid = input.method === SKILL_YEARS_METHOD && input.skillKey === row.skill_key && input.label === row.label &&
      input.text === row.text && input.asOf === row.as_of && !!calculated &&
      JSON.stringify(calculated) === JSON.stringify(input.bounds) && calculated.lowerMonths === row.lower_months &&
      calculated.upperMonths === row.upper_months && calculated.precision === row.precision &&
      skillDurationText(row.label, calculated, row.as_of) === row.text;
    let isPrivate = privateIds.has(row.fact_id);
    if (current.filter((r) => r.state === "confirmed" && r.subject.key === row.skill_key).length !== input.intervals.length) valid = false;
    for (const old of input.intervals) {
      const live = current.find((r) => r.id === old.id), subject = resolve(old.subject.ref);
      if (!live || live.state !== "confirmed" || live.revision !== old.revision ||
          live.start !== old.start || live.end !== old.end || live.ongoing !== old.ongoing || live.private !== old.private ||
          !subject || JSON.stringify(identity(subject)) !== JSON.stringify(old.subject)) valid = false;
      if (old.private || subject?.private) isPrivate = true;
    }
    const fact = this.fact(row.fact_id);
    valid &&= !!fact && fact.state === "confirmed" && fact.kind === "skill" && fact.text === row.text && fact.origin === "user" && fact.role_id === null && fact.level === null && fact.evidence_id === null && fact.source_id === null;
    return { id: row.id, factId: row.fact_id, skillKey: row.skill_key,label: row.label,text: row.text,asOf: row.as_of,
      bounds: { lowerMonths: row.lower_months,upperMonths: row.upper_months,precision: row.precision as "year" | "month" },inputHash: row.input_hash,confirmedAt: row.created_at,current: valid,private: isPrivate };
  }
  claims(privateIds: ReadonlySet<string>): SkillDurationClaim[] {
    const current = this.intervals(), subjects = new Map<string, SkillSubject | null>();
    const resolve = (ref: SkillSubjectRef) => {
      const key = JSON.stringify(ref);
      if (!subjects.has(key)) subjects.set(key,this.resolve(ref,privateIds));
      return subjects.get(key)!;
    };
    return this.sql.exec<ClaimRow>(`SELECT * FROM skill_duration_claims ORDER BY created_at,id`).toArray().map((r) => this.claimView(r,privateIds,current,resolve));
  }
  view(privateIds: ReadonlySet<string>, now = Date.now()): SkillYearsView { return { subjects: this.subjects(privateIds),intervals: this.intervals(),claims: this.claims(privateIds),asOf: utcMonth(now) }; }
  selectedFacts(ids: string[], privateIds: ReadonlySet<string>): FactRecord[] {
    const skills = new Set<string>();
    return ids.map((id) => {
      const claim = this.claim(id,privateIds);
      if (!claim?.current || claim.private) throw changed();
      if (skills.has(claim.skillKey)) throw new AppError("invalid", "Choose one confirmed total for each skill.");
      skills.add(claim.skillKey);
      const fact = this.fact(claim.factId)!;
      return { id: fact.id,revision: fact.revision,kind: "skill",roleId: null,origin: "user",level: null,levelExplicit: false,quote: null,text: claim.text,
        skillDuration: { claimId: claim.id,inputHash: claim.inputHash,method: SKILL_YEARS_METHOD,text: claim.text,asOf: claim.asOf } };
    });
  }
  proofForFact(factId: string, privateIds: ReadonlySet<string>): SkillDurationProof | null {
    const row = this.sql.exec<{ id: string }>(`SELECT id FROM skill_duration_claims WHERE fact_id=?`,factId).toArray()[0];
    return row ? this.selectedFacts([row.id],privateIds)[0]!.skillDuration! : null;
  }
  export() { return { skillRecordIdentities: this.sql.exec<Record<string, string | number | null>>(`SELECT * FROM skill_record_identities`).toArray(), skillUseIntervals: this.sql.exec<Record<string, string | number | null>>(`SELECT * FROM skill_use_intervals`).toArray(),skillDurationClaims: this.sql.exec<Record<string, string | number | null>>(`SELECT * FROM skill_duration_claims`).toArray(),skillYearRequests: this.sql.exec<Record<string, string | number | null>>(`SELECT * FROM skill_year_requests`).toArray() }; }
}

/** Dynamic invalidation reaches in-flight generation and every current publication boundary. */
export function durationRestrictions(sql: SqlStorage, marked: ReadonlySet<string>): { privateIds: Set<string>; invalid: Set<string> } {
  const privateIds = new Set<string>(), invalid = new Set<string>();
  // Some historical test/legacy databases predate the feature. A captured derived proof still
  // requires its backing row in SnapshotStore; absence never creates a permission.
  if (!sql.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='skill_duration_claims'`).toArray().length) return { privateIds,invalid };
  const store = new SkillYearsStore(sql,(fn) => fn());
  for (const claim of store.claims(marked)) {
    if (claim.private) privateIds.add(claim.factId);
    if (!claim.current) invalid.add(claim.factId);
  }
  return { privateIds,invalid };
}
