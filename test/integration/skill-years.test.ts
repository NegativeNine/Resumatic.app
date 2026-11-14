import { unzipSync, strFromU8 } from "fflate";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import type { FactView } from "../../src/shared/api";
import type { SkillDurationClaim, SkillDurationPreview, SkillIntervalInput, SkillYearsView } from "../../src/shared/skill-years";
import type { FactRecord } from "../../src/shared/types";
import { vault } from "../../src/shared/stubs";
import { fakeModels, signIn, waitForResume, eventually, type User } from "./support";

const settings = env as unknown as { SKILL_YEARS_ENABLED?: string };
const original = settings.SKILL_YEARS_ENABLED;
let providerInputs:string[]=[];
beforeEach(() => {providerInputs=[];setModels(() => fakeModels({inputs:providerInputs}));});
afterEach(() => { setModels(null); settings.SKILL_YEARS_ENABLED = original; });
const path = "/api/v2/skill-years";
function vid(user: User): string {
  const payload = user.cookie.slice("__Host-session=".length).split(".")[0]!;
  return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))).vid;
}
function mutate(user: User, method: string, url: string, input: unknown, key = crypto.randomUUID()) {
  return user.fetch(url, { method, headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(input) });
}
async function create(user: User) {
  const added = await user.send("POST", "/api/facts", { roleId: null, kind: "skill", text: "Go", level: null });
  expect(added.status).toBe(201);
  const { factId } = await added.json() as { factId: string };
  const input: SkillIntervalInput = { subject: { kind: "fact", id: factId }, start: "2020", end: "2024", ongoing: false, private: false };
  const saved = await mutate(user,"POST",`${path}/intervals`,input);
  expect(saved.status,await saved.clone().text()).toBe(201);
  const { id } = await saved.json() as { id: string };
  const previewResponse = await user.send("POST",`${path}/preview`,input.subject);
  expect(previewResponse.status,await previewResponse.clone().text()).toBe(200);
  const preview = await previewResponse.json() as SkillDurationPreview;
  const confirmation = await mutate(user,"POST",`${path}/claims`,{ subject: input.subject, asOf: preview.asOf, inputHash: preview.inputHash });
  expect(confirmation.status,await confirmation.clone().text()).toBe(201);
  return { factId,input,intervalId:id,preview,claim:await confirmation.json() as SkillDurationClaim };
}

describe("owner-confirmed skill periods", () => {
  it("is absent by default and refuses disabled and foreign-owner changes", async () => {
    expect(original).toBeUndefined(); const user = await signIn();
    expect((await user.fetch(path)).status).toBe(404);
    expect((await user.json("/api/me")).capabilities.skillYears).toBe(false);
    settings.SKILL_YEARS_ENABLED = "true";
    const item = await create(user), other = await signIn();
    expect((await mutate(other,"POST",`${path}/intervals/${item.intervalId}/withdraw`,{ expectedRevision:1 })).status).toBe(409);
    expect((await mutate(other,"POST",`${path}/claims`,{ subject:item.input.subject,asOf:item.preview.asOf,inputHash:item.preview.inputHash })).status).toBe(409);
    expect((await user.json<SkillYearsView>(path)).claims[0]!.current).toBe(true);
    expect((await user.fetch(`${path}/intervals`, { method:"POST",headers:{"content-type":"application/json",origin:"https://foreign.example"},body:JSON.stringify(item.input) })).status).toBe(403);
  });

  it("isolates backing rows from generic facts, counts, edits, matching, sharing, and embedding", async () => {
    settings.SKILL_YEARS_ENABLED = "true"; const user = await signIn(); const item = await create(user);
    const facts = (await user.json<{facts:FactView[]}>("/api/facts")).facts;
    expect(facts.map((fact) => fact.id)).toEqual([item.factId]);
    expect((await user.json("/api/v2/today")).standing.confirmed).toBe(1);
    expect((await user.send("PATCH",`/api/facts/${item.claim.factId}`,{text:"Go — 100 years"})).status).toBe(409);
    expect((await user.send("POST","/api/review",{confirm:[],reject:[item.claim.factId]})).status).toBe(409);
    expect((await user.send("POST","/api/facts/sensitive",{ids:[item.claim.factId],sensitive:true})).status).toBe(409);
    const exported = await user.json<{facts:FactView[];skillDurationClaims:unknown[];skillUseIntervals:unknown[]}>("/api/export");
    expect(exported.facts).toHaveLength(1); expect(exported.skillDurationClaims).toHaveLength(1); expect(exported.skillUseIntervals).toHaveLength(1);
    const archive=await user.fetch("/api/export/archive");expect(archive.status).toBe(200);
    const entries=unzipSync(new Uint8Array(await archive.arrayBuffer()));
    const json=Object.values(entries).map((entry)=>strFromU8(entry)).find((value)=>value.includes('"skillDurationClaims"'))!;
    expect(JSON.parse(json).skillDurationClaims).toHaveLength(1);
    await runInDurableObject(vault(env,vid(user)),async(instance,state) => {
      const internal = instance as unknown as {usableFacts():FactRecord[];reembeddings:{begin(id:string,model:string,dimensions:number):void;nextBatch(id:string):{id:string}[]}};
      expect(internal.usableFacts().map((fact)=>fact.id)).toEqual([item.factId]);
      internal.reembeddings.begin("check","fake",2);
      expect(internal.reembeddings.nextBatch("check").map((fact)=>fact.id)).toEqual([item.factId]);
      await expect(instance.editFact({userId:"other",gen:1},item.claim.factId,{text:"Different"})).rejects.toThrow();
      expect(state.storage.sql.exec<{n:number}>(`SELECT COUNT(*) AS n FROM record_links WHERE from_id=? OR to_id=?`,item.claim.factId,item.claim.factId).one().n).toBe(0);
    });
    await runInDurableObject(vault(env,vid(user)),async(instance,state)=>{
      await instance.close();await instance.destroy();
      expect(state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE name LIKE 'skill_%'`).toArray()).toEqual([]);
    });
  });

  it.each(["withdraw", "private"] as const)("prints only explicitly selected exact totals, and blocks later outward use after %s", async (change) => {
    settings.SKILL_YEARS_ENABLED = "true"; const user = await signIn(); const item = await create(user);
    const roleRes = await user.send("POST","/api/roles",{kind:"job",org:"Acme",title:"Engineer",startDate:"2020",endDate:"2024"});
    const {roleId} = await roleRes.json() as {roleId:string};
    expect((await user.send("POST","/api/facts",{roleId,kind:"accomplishment",text:"Built a Go service that processes 2 million events per day",level:null})).status).toBe(201);
    const appRes = await user.send("POST","/api/applications",{jdText:"We need an engineer using Go to build reliable systems with a team."});
    expect(appRes.status).toBe(201); const {applicationId} = await appRes.json() as {applicationId:string};
    const start = await mutate(user,"POST",`/api/v2/applications/${applicationId}/resumes`,{skillDurationClaimIds:[item.claim.id]});
    expect(start.status,await start.clone().text()).toBe(202); const {resumeId} = await start.json() as {resumeId:string};
    const resume = await waitForResume(user,resumeId);
    expect(resume.state,JSON.stringify(resume)).toBe("ready"); expect(resume.body.skills).toContain(item.claim.text);
    expect(providerInputs.join("\n")).not.toContain(item.claim.inputHash);
    expect(providerInputs.join("\n")).not.toContain(item.claim.id);
    expect(providerInputs.join("\n")).not.toContain("skillDuration");
    const generic = await user.send("POST",`/api/applications/${applicationId}/resumes`);
    expect(generic.status).toBe(202); const plainId = (await generic.json() as {resumeId:string}).resumeId;
    expect((await waitForResume(user,plainId)).body.skills).not.toContain(item.claim.text);
    expect((await user.send("POST","/api/shares",{factIds:[item.claim.factId],resumes:[]})).status).toBe(422);
    const shared = await user.send("POST","/api/shares",{factIds:[],resumes:[{id:resumeId,version:1}]});
    expect(shared.status,await shared.clone().text()).toBe(201);
    const sharedGrant=(await shared.json() as {grant:{id:string;epoch:string}}).grant;
    await runInDurableObject(vault(env,vid(user)),async(instance)=>{ const view=await instance.readShare({grantId:sharedGrant.id,epoch:sharedGrant.epoch}); expect(JSON.stringify(view)).not.toContain("input_hash"); expect(JSON.stringify(view)).not.toContain("skillDuration"); });
    const mcp = await runInDurableObject(vault(env,vid(user)),async(instance,state)=>{
      const who={userId:state.storage.sql.exec<{value:string}>(`SELECT value FROM meta WHERE key='user_id'`).one().value,gen:1};
      const grant=await instance.createMcpGrant(who,{id:crypto.randomUUID(),clientId:"client",clientName:"Test reader",scopes:["vault:read"],expiresAt:Date.now()+3600000});
      const claims={uid:who.userId,vid:vid(user),gen:grant.gen,epoch:grant.epoch,grantId:grant.id,clientId:grant.clientId,scopes:grant.scopes,expiresAt:grant.expiresAt};
      await instance.bindMcpGrant(claims,"remote");
      expect((await instance.mcpFacts(claims,{})).some((f)=>f.id===item.claim.factId)).toBe(false);
      const resume=await instance.mcpResume(claims,resumeId);expect(resume.body.skills).toContain(item.claim.text);
      expect(JSON.stringify(resume)).not.toContain("skillDuration");expect(JSON.stringify(resume)).not.toContain("inputHash");
      return claims;
    });
    const exportedBefore = await user.fetch(`/api/resumes/${resumeId}/preview`);
    expect(exportedBefore.status,await exportedBefore.clone().text()).toBe(200);
    if(change==="withdraw") expect((await mutate(user,"POST",`${path}/intervals/${item.intervalId}/withdraw`,{expectedRevision:1})).status).toBe(204);
    else expect((await user.send("POST","/api/facts/sensitive",{ids:[item.factId],sensitive:true})).status).toBe(204);
    expect((await user.json<SkillYearsView>(path)).claims[0]!.current).toBe(change!=="withdraw");
    await runInDurableObject(vault(env,vid(user)),async(instance)=>{ await expect(instance.readShare({grantId:sharedGrant.id,epoch:sharedGrant.epoch})).rejects.toThrow(); });
    expect(!!(await user.json(`/api/resumes/${resumeId}`)).needsGroundingReview).toBe(change==="withdraw");
    for(const format of ["preview","pdf","docx"]) expect((await user.fetch(`/api/resumes/${resumeId}/${format}`)).status).toBe(409);
    await runInDurableObject(vault(env,vid(user)),async(instance)=>{await expect(instance.mcpResume(mcp,resumeId)).rejects.toThrow();});
    expect((await mutate(user,"POST",`/api/v2/applications/${applicationId}/resumes`,{skillDurationClaimIds:[item.claim.id]})).status).toBe(409);
    if(change==="withdraw") {
      const removed=await user.send("POST",`/api/resumes/${resumeId}/remove-skill`,{skillIndex:resume.body.skills.indexOf(item.claim.text),expectedVersion:1});
      expect(removed.status,await removed.clone().text()).toBe(200);
      expect((await user.fetch(`/api/resumes/${resumeId}/preview`)).status).toBe(200);
      expect((await user.json(`/api/resumes/${resumeId}`)).body.skills).not.toContain(item.claim.text);
      await runInDurableObject(vault(env,vid(user)),async(instance)=>{await expect(instance.readShare({grantId:sharedGrant.id,epoch:sharedGrant.epoch})).rejects.toThrow();});
    }
    if(change==="private") {
      expect((await user.send("POST","/api/facts/sensitive",{ids:[item.factId],sensitive:false})).status).toBe(204);
      expect((await user.fetch(`/api/resumes/${resumeId}/preview`)).status).toBe(200);
      await runInDurableObject(vault(env,vid(user)),async(instance)=>{expect((await instance.mcpResume(mcp,resumeId)).body.skills).toContain(item.claim.text);});
    }
  });

  it("retains only already printed selected claims when refining and leaves generic letters without them",async()=>{
    settings.SKILL_YEARS_ENABLED="true";
    setModels(()=>{
      const base=fakeModels({inputs:providerInputs});
      return {...base,async complete(route,messages,schema,options){
        const text=messages.filter((m)=>m.role==="user").at(-1)?.content??"";
        if(route==="write" && text.startsWith("{")) {
          providerInputs.push(text);
          const parsed=JSON.parse(text) as {lines?:{lineId:string;text:string}[];facts?:{id:string;roleId:string|null;text:string}[]};
          if(parsed.lines)return schema.parse({edits:parsed.lines.map((line)=>({lineId:line.lineId,text:"Built a Go service"}))});
          const fact=parsed.facts?.find((f)=>f.text.startsWith("Built a Go service"));
          return schema.parse({units:fact?[{roleId:fact.roleId,text:fact.text,factIds:[fact.id],group:0}]:[]});
        }
        return base.complete(route,messages,schema,options);
      }};
    });
    const user=await signIn(),item=await create(user);
    const role=await user.send("POST","/api/roles",{kind:"job",org:"Acme",title:"Engineer",startDate:"2020",endDate:"2024"});const{roleId}=await role.json() as {roleId:string};
    await user.send("POST","/api/facts",{roleId,kind:"accomplishment",text:"Built a Go service that processes 2 million events per day",level:null});
    const app=await user.send("POST","/api/applications",{jdText:"We need an engineer using Go to build reliable software."});const{applicationId}=await app.json() as {applicationId:string};
    const started=await mutate(user,"POST",`/api/v2/applications/${applicationId}/resumes`,{skillDurationClaimIds:[item.claim.id]});const{resumeId}=await started.json() as {resumeId:string};
    const resume=await waitForResume(user,resumeId);expect(resume.state).toBe("ready");
    async function document(options:unknown){
      const started=await user.send("POST",`/api/applications/${applicationId}/documents`,options);expect(started.status,await started.clone().text()).toBe(202);
      const{documentId,runId}=await started.json() as {documentId:string;runId:string};
      const doc=await eventually(async()=>{const doc=await user.json(`/api/documents/${documentId}`);return doc.state!=="running"?doc:null;},"document completion");expect(doc.state,doc.error).toBe("ready");return runId;
    }
    const letter=await document({kind:"letter"});
    await runInDurableObject(vault(env,vid(user)),(_instance,state)=>{expect(state.storage.sql.exec(`SELECT item_id FROM generation_input_items WHERE run_id=? AND item_id=?`,letter,item.claim.factId).toArray()).toEqual([]);});
    const refine=await document({kind:"refine",resumeId,expectedVersion:1,lineIds:[resume.body.sections[0].lines[0].id],instruction:"Keep the wording"});
    expect(providerInputs.join("\n")).not.toContain(item.claim.inputHash);
    expect(providerInputs.join("\n")).not.toContain(item.claim.id);
    expect(providerInputs.join("\n")).not.toContain("skillDuration");
    const refined=await user.json(`/api/resumes/${resumeId}`);expect(refined.version).toBe(2);expect(refined.body.skills).toContain(item.claim.text);
    await runInDurableObject(vault(env,vid(user)),(_instance,state)=>{const saved=state.storage.sql.exec<{data:string}>(`SELECT data FROM generation_input_items WHERE run_id=? AND item_id=?`,refine,item.claim.factId).one();expect(JSON.parse(saved.data).skillDuration.claimId).toBe(item.claim.id);});
  });

  it.each(["private","withdraw"] as const)("fences new model reservations when %s changes after snapshot capture", async (change) => {
    settings.SKILL_YEARS_ENABLED = "true";
    const stub = env.VAULT.get(env.VAULT.newUniqueId()); const who={userId:`duration-${change}`,gen:1}; await stub.init(who.userId);
    await runInDurableObject(stub,async(instance,state)=>{
      const local=(instance as unknown as {env:Env}).env; const before=local.TAILOR; local.SKILL_YEARS_ENABLED="true"; local.TAILOR={async create(){return {};}} as unknown as Workflow;
      try {
        state.storage.sql.exec(`INSERT INTO facts(id,kind,text,origin,state,updated_at) VALUES ('go','skill','Go','user','confirmed',1)`);
        const input:SkillIntervalInput={subject:{kind:"fact",id:"go"},start:"2020",end:"2024",ongoing:false,private:false};
        const {id}=instance.saveSkillInterval(who,input,"period"); const preview=await instance.previewSkillDuration(who,input.subject); const claim=await instance.confirmSkillDuration(who,input.subject,preview.asOf,preview.inputHash,"claim");
        const {applicationId}=await instance.addApplication(who,"We need an engineer using Go to build reliable software.");
        const {runId}=await instance.tailorWithSkillClaims(who,applicationId,[claim.id],"generation");
        const facts=state.storage.sql.exec<{data:string}>(`SELECT data FROM generation_input_items WHERE run_id=? AND kind='fact'`,runId).toArray().map((r)=>JSON.parse(r.data) as FactRecord);
        expect(facts.find((f)=>f.id===claim.factId)?.skillDuration?.claimId).toBe(claim.id);
        if(change==="private") await instance.markSensitive(who,{ids:["go"],sensitive:true}); else instance.withdrawSkillInterval(who,id,1,"withdraw");
        await expect(instance.reserveModelAttempt(runId,"analyze",{attemptId:"never",model:"fake",input:{},kind:"analyze"} as never,1,100)).rejects.toThrow("changed");
        expect(state.storage.sql.exec(`SELECT id FROM model_attempts WHERE id='never'`).toArray()).toEqual([]);
      } finally {local.TAILOR=before;}
    });
  });
});
