import { checkLine } from "../../src/grounding/verdict";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { VaultOperations } from "../../src/vault/operations";
import { createSchema, SCHEMA_VERSION } from "../../src/vault/schema";
import { SkillYearsStore, durationRestrictions } from "../../src/vault/skill-years";
import { intervalProblem, skillDurationBounds, skillDurationText, type SkillIntervalInput } from "../../src/shared/skill-years";

const NOW = Date.UTC(2026,10,14), AT = "2026-11";
const period: SkillIntervalInput = { subject: { kind: "fact",id: "go" },start: "2020",end: "2024",ongoing: false,private: false };
function setup(seed = true) {
  const db = new DatabaseSync(":memory:");
  const sql = { exec(statement: string,...args: (string | number | null)[]) {
    const rows = db.prepare(statement).all(...args);
    return { toArray: () => rows,one: () => { if (rows.length !== 1) throw new Error("one row required"); return rows[0]; },[Symbol.iterator]: () => rows[Symbol.iterator]() };
  } } as unknown as SqlStorage;
  let depth = 0;
  const transaction = <T>(fn: () => T): T => {
    const save = `skill_${depth++}`; db.exec(`SAVEPOINT ${save}`);
    try { const out = fn(); db.exec(`RELEASE ${save}`); return out; }
    catch (error) { db.exec(`ROLLBACK TO ${save}`); db.exec(`RELEASE ${save}`); throw error; }
    finally { depth--; }
  };
  createSchema(sql,transaction);
  if (seed) db.exec(`INSERT INTO facts (id,kind,text,origin,state,updated_at) VALUES ('go','skill','Go','user','confirmed',1)`);
  return { db,sql,transaction,store: new SkillYearsStore(sql,transaction) };
}

describe("owner skill periods", () => {
  it("unions overlaps and duplicate intervals without converting uncertain years into exact dates", () => {
    const bounds = skillDurationBounds([period,period,{ ...period,start: "2021",end: "2023" }],AT)!;
    expect(bounds).toEqual({ lowerMonths: 36,upperMonths: 60,precision: "year" });
    expect(skillDurationText("Go",bounds,AT)).toBe("Go — at least 3 years of use, confirmed as of 2026-11");
    expect(skillDurationBounds([period,{ ...period,start: "2010",end: "2014" }],AT)).toMatchObject({ lowerMonths: 72,upperMonths: 120 });
  });
  it("preserves month and mixed precision, clips ongoing use before the incomplete current month", () => {
    expect(skillDurationBounds([{ ...period,start: "2020-01",end: "2021-01" }],AT)).toEqual({ lowerMonths: 11,upperMonths: 13,precision: "month" });
    expect(skillDurationBounds([{ ...period,end: null,ongoing: true }],AT)).toEqual({ lowerMonths: 70,upperMonths: 82,precision: "year" });
    expect(skillDurationBounds([period,{ ...period,start: "2021-01",end: "2022-01" }],AT)?.precision).toBe("year");
    expect(skillDurationBounds([],AT)).toBeNull();
    expect(skillDurationText("Go",{ lowerMonths: 0,upperMonths: 12,precision: "year" },AT)).toBeNull();
  });
  it("refuses future, inverted, malformed or implicitly ongoing periods", () => {
    for (const patch of [{ start: "2027" },{ end: "2019" },{ start: "2020-13" },{ end: null },{ ongoing: true },{ start: "1899" }])
      expect(intervalProblem({ ...period,...patch },AT),JSON.stringify(patch)).not.toBeNull();
    expect(intervalProblem(period,AT)).toBeNull();
  });
  it("pins immutable claims to exact owner-confirmed inputs, keeps request retries idempotent and rejects stale edits", async () => {
    const { store,db } = setup(), marked = new Set<string>();
    const id = store.save(period,"period",marked,undefined,NOW);
    expect(store.save(period,"period",marked,undefined,NOW)).toBe(id);
    expect(() => store.save({ ...period,start: "2021" },"period",marked,undefined,NOW)).toThrow("another change");
    const preview = await store.preview(period.subject,marked,NOW);
    const claim = await store.confirm(period.subject,AT,preview.inputHash,"confirm",() => marked,NOW);
    expect(claim).toMatchObject({ current: true,private: false,text: preview.text });
    expect((await store.confirm(period.subject,AT,preview.inputHash,"confirm",() => marked,NOW)).id).toBe(claim.id);
    expect(store.selectedFacts([claim.id],marked)[0]).toMatchObject({ kind: "skill",quote: null,skillDuration: { claimId: claim.id,inputHash: preview.inputHash } });
    expect(() => db.prepare(`UPDATE skill_duration_claims SET text='5 years' WHERE id=?`).run(claim.id)).toThrow("immutable");
    expect(() => store.save(period,"stale",marked,{ id,expectedRevision: 2 },NOW)).toThrow("Refresh");
    store.save({ ...period,start: "2021" },"edit",marked,{ id,expectedRevision: 1 },NOW);
    expect(store.claim(claim.id,marked)?.current).toBe(false);
    expect(() => store.selectedFacts([claim.id],marked)).toThrow("Refresh");
  });
  it("does not accept a preview after input or identity changes during hashing", async () => {
    const { store,db } = setup(), marked = new Set<string>();
    const id = store.save(period,"period",marked,undefined,NOW), preview = await store.preview(period.subject,marked,NOW);
    store.withdraw(id,1,"withdraw",NOW);
    await expect(store.confirm(period.subject,AT,preview.inputHash,"old-confirm",() => marked,NOW)).rejects.toThrow();
    store.save(period,"restore",marked,{ id,expectedRevision: 2 },NOW);
    const latest = await store.preview(period.subject,marked,NOW);
    const pending = store.confirm(period.subject,AT,latest.inputHash,"racing-confirm",() => marked,NOW);
    db.prepare(`UPDATE facts SET text='Rust',revision=revision+1 WHERE id='go'`).run();
    await expect(pending).rejects.toThrow("Refresh");
  });
  it("fences privacy and same-revision input mutations without inventing another skill's duration", async () => {
    const { store,sql,db } = setup(), marked = new Set<string>();
    const id = store.save(period,"period",marked,undefined,NOW), preview = await store.preview(period.subject,marked,NOW);
    const claim = await store.confirm(period.subject,AT,preview.inputHash,"confirm",() => marked,NOW);
    marked.add("go");
    expect(durationRestrictions(sql,marked).privateIds.has(claim.factId)).toBe(true);
    expect(() => store.selectedFacts([claim.id],marked)).toThrow("Refresh");
    marked.clear(); expect(store.claim(claim.id,marked)?.current).toBe(true);
    db.prepare(`UPDATE skill_use_intervals SET end_date='2025' WHERE id=?`).run(id);
    expect(durationRestrictions(sql,marked).invalid.has(claim.factId)).toBe(true);
    db.exec(`DELETE FROM facts WHERE id='go'`);
    expect(store.claim(claim.id,marked)?.current).toBe(false);
  });
});

it("never revives a period's identity after source edit/revert, evidence replacement, or record recreation", async () => {
  for (const change of ["revert","replace","evidence","revision","source","revision-id"] as const) {
    const {store,db} = setup(), marked = new Set<string>();
    db.exec(`INSERT INTO sources(id,filename,r2_key,state,created_at) VALUES('s','resume','s','ready',1);
      INSERT INTO source_revisions(id,source_id,markdown,created_at) VALUES('rev','s','Go',1);
      INSERT INTO evidence(id,source_id,quote,source_revision_id,start,end) VALUES('e','s','Go','rev',0,2);
      UPDATE facts SET evidence_id='e' WHERE id='go'`);
    store.save(period,"period",marked,undefined,NOW);
    const preview = await store.preview(period.subject,marked,NOW), claim = await store.confirm(period.subject,AT,preview.inputHash,"claim",()=>marked,NOW);
    if(change === "revert") db.exec(`UPDATE facts SET text='Rust' WHERE id='go'; UPDATE facts SET text='Go' WHERE id='go'`);
    if(change === "replace") db.exec(`DELETE FROM facts WHERE id='go'; INSERT INTO facts(id,kind,text,origin,state,evidence_id,updated_at) VALUES('go','skill','Go','user','confirmed','e',1)`);
    if(change === "evidence") db.exec(`PRAGMA foreign_keys=OFF; DELETE FROM evidence WHERE id='e'; INSERT INTO evidence(id,source_id,quote,source_revision_id,start,end) VALUES('e','s','Go','rev',0,2)`);
    if(change === "revision") db.exec(`UPDATE source_revisions SET markdown='Different' WHERE id='rev'; UPDATE source_revisions SET markdown='Go' WHERE id='rev'`);
    if(change === "source") db.exec(`UPDATE facts SET source_id='s' WHERE id='go'; UPDATE facts SET source_id=NULL WHERE id='go'`);
    if(change === "revision-id") db.exec(`UPDATE source_revisions SET id='other-rev' WHERE id='rev'; UPDATE source_revisions SET id='rev' WHERE id='other-rev'`);
    expect(store.claim(claim.id,marked)?.current,change).toBe(false);
  }
});

it("uses confirmed exact fact or part concepts only, without hierarchy or role-duration inference", async () => {
  const {store,db} = setup(), marked = new Set<string>();
  db.exec(`INSERT INTO facts(id,kind,text,origin,state,updated_at) VALUES('work','responsibility','Used Go and Rust','user','confirmed',1);
    INSERT INTO fact_splits(id,fact_id,state,shadow,proposed_by,method,created_at) VALUES('split','work','confirmed',0,'owner','slice',1);
    INSERT INTO fact_parts(id,split_id,position,kind,ranges) VALUES('part','split',0,'clause','[[0,7]]');
    INSERT INTO record_tags(id,subject_kind,subject_id,concept_id,concept_kind,label,relation,state,shadow,proposed_by,method,taxonomy_version,created_at)
      VALUES('tag','part','part','esco:go','skill','Go','shows','confirmed',0,'owner','lookup','test',1)`);
  const ref={kind:"tag" as const,id:"tag"};
  expect(store.resolve(ref,marked)).toMatchObject({label:"Go",key:"concept:test:esco:go"});
  store.save({...period,subject:ref},"period",marked,undefined,NOW);
  const preview=await store.preview(ref,marked,NOW), claim=await store.confirm(ref,AT,preview.inputHash,"claim",()=>marked,NOW);
  expect(claim.current).toBe(true);
  db.exec(`UPDATE fact_parts SET kind='mention' WHERE id='part'`);
  expect(store.resolve(ref,marked)).toBeNull();
  db.exec(`UPDATE fact_parts SET kind='clause',ranges='[[1,7]]' WHERE id='part'`);
  expect(store.resolve(ref,marked)).toBeNull();
  db.exec(`UPDATE fact_parts SET ranges='[]' WHERE id='part'`);
  expect(store.resolve(ref,marked)).toBeNull();
  db.exec(`UPDATE fact_parts SET ranges='[[0,7]]' WHERE id='part'`);
  expect(store.claim(claim.id,marked)?.current).toBe(false);
  db.exec(`UPDATE fact_splits SET state='rejected' WHERE id='split'`);
  expect(store.resolve(ref,marked)).toBeNull(); expect(store.claim(claim.id,marked)?.current).toBe(false);
  db.exec(`UPDATE fact_splits SET state='confirmed',shadow=1 WHERE id='split'`);
  expect(store.resolve(ref,marked)).toBeNull();
  expect(store.resolve({kind:"fact",id:"work"},marked)).toBeNull();
  expect(store.subjects(marked).map((s)=>s.ref.id)).toEqual(["go"]);
});

it("transfers immutable totals and owner intervals with their identities, and refuses missing imported identities", async () => {
  const source=setup(), marked=new Set<string>(); source.store.save(period,"period",marked,undefined,NOW);
  const preview=await source.store.preview(period.subject,marked,NOW), claim=await source.store.confirm(period.subject,AT,preview.inputHash,"claim",()=>marked,NOW);
  const ops=(db:ReturnType<typeof setup>,id:string)=>new VaultOperations(db.sql,db.transaction,{vaultId:id,userId:"owner",schemaVersion:SCHEMA_VERSION,requireMaintenanceFence(){}});
  const exporting=ops(source,"source"), manifest=await exporting.beginExport("move");
  for(const corrupt of [false,true]) {
    const target=setup(false), importing=ops(target,`target-${corrupt}`); importing.beginImport(manifest);
    for(const table of manifest.tables) { let after=0; for(;;) {const page=await exporting.exportPage(manifest.operationId,table.name,after); await importing.importPage(page); if(page.done)break;after=page.lastRowid;} }
    // Source identities replace generated-target identities by never manufacturing target ones.
    expect(target.store.claim(claim.id,marked)).toEqual(claim);
    if(corrupt) {
      target.db.exec(`DELETE FROM skill_record_identities WHERE kind='fact' AND item_id='go'`);
      expect(()=>importing.finishImport("move","fresh",()=>{})).toThrow("identities are incomplete");
      expect(target.store.claim(claim.id,marked)?.current).toBe(false);
    } else {
      expect(importing.finishImport("move","fresh",()=>{}).state).toBe("ready");
      expect(target.store.selectedFacts([claim.id],marked)[0]!.text).toBe(claim.text);
    }
  }
});

it("keeps a derived number bound to its exact skill, wording, as-of date, and sole citation",async()=>{
  const {store}=setup(),marked=new Set<string>();store.save(period,"period",marked,undefined,NOW);
  const preview=await store.preview(period.subject,marked,NOW),claim=await store.confirm(period.subject,AT,preview.inputHash,"claim",()=>marked,NOW);
  const fact=store.selectedFacts([claim.id],marked)[0]!,other={...fact,id:"rust",text:"Rust",skillDuration:undefined};
  const facts=new Map([[fact.id,fact],[other.id,other]]),selected=new Set(facts.keys());
  const line={roleId:null,factIds:[fact.id],text:fact.text};
  expect(checkLine(line,facts,selected).ok).toBe(true);
  for(const next of [{...line,text:line.text.replace("Go","Rust")},{...line,text:line.text.replace("3 years","4 years")},{...line,text:line.text.replace("2026-11","2026-12")},{...line,factIds:[fact.id,other.id]}])
    expect(checkLine(next,facts,selected).ok).toBe(false);
});
