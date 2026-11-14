import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import type { FactView } from "../../src/shared/api";
import type { RecordProposals, SemanticOfferDecision, SemanticOfferReview } from "../../src/shared/proposal-review";
import type { Stamp } from "../../src/shared/record";
import { vault } from "../../src/shared/stubs";
import { RecordStore } from "../../src/vault/record";
import { fromBase64url } from "../../src/worker/crypto";
import { RESUME, fakeModels, signIn, waitForSource, type User } from "./support";
const settings = env as unknown as { RECORD_PROPOSAL_REVIEW_ENABLED?: string };
const original = settings.RECORD_PROPOSAL_REVIEW_ENABLED;
const model: Stamp = { proposedBy: "model", model: "@cf/test/judge", method: "entailment/3", taxonomyVersion: null, confidence: 0.95, shadow: false };
const rule: Stamp = { ...model, proposedBy: "rule", model: null, method: "identical-wording/3", confidence: null };
beforeEach(() => setModels(() => fakeModels()));
afterEach(() => { setModels(null); settings.RECORD_PROPOSAL_REVIEW_ENABLED = original; });
function inVault<T>(user: User, work: (record: RecordStore) => T): Promise<T> {
  const session = JSON.parse(new TextDecoder().decode(fromBase64url(user.cookie.slice("__Host-session=".length).split(".")[0]!))) as { vid: string };
  return runInDurableObject(vault(env, session.vid), (_instance, state) => work(new RecordStore(state.storage.sql, (fn) => state.storage.transactionSync(fn), () => 0)));
}
async function upload(user: User, extra = "") {
  const res = await user.upload(`resume${extra.length}.pdf`, RESUME + extra);
  const id = (await res.json() as { sourceId: string }).sourceId; await waitForSource(user, id); return id;
}
async function seeded(relation: "same" | "fuller" = "same") {
  const user = await signIn(); const first = await upload(user); const later = await upload(user, "\nAnother footer");
  let facts = (await user.json<{ facts: FactView[] }>("/api/facts")).facts;
  const to = facts.find((f) => f.sourceId === first && f.text.startsWith("Led the migration"))!;
  const from = facts.find((f) => f.sourceId === later && f.text === to.text)!;
  expect((await user.send("PATCH", `/api/facts/${from.id}`, { text: to.text.replace("Led", "Directed") + (relation === "fuller" ? "; coordinated the launch" : ""), expectedRevision: from.revision })).status).toBe(204);
  facts = (await user.json<{ facts: FactView[] }>("/api/facts")).facts;
  const oldSkill = facts.find((f) => f.sourceId === first && f.kind === "skill" && f.roleId === null)!;
  const newSkill = facts.find((f) => f.sourceId === later && f.kind === "skill" && f.roleId === null && f.text === oldSkill.text)!;
  const saved = await inVault(user, (record) => {
    const roleLink = record.proposeLink({ kind: "role", from: from.roleId!, to: to.roleId!, relation: "same", stamp: { ...rule, method: "identical-role/3" }, confirm: true });
    const offer = record.proposeLink({ kind: "fact", from: from.id, to: to.id, relation, stamp: model });
    const shadow = record.proposeLink({ kind: "fact", from: from.id, to: to.id, relation, stamp: { ...model, shadow: true } });
    const copy = record.proposeLink({ kind: "fact", from: newSkill.id, to: oldSkill.id, relation: "same", stamp: rule, confirm: true });
    return { id: offer.linkId, shadowId: shadow.linkId, copyId: copy.linkId, roleLinkId: roleLink.linkId };
  });
  return { user, from: facts.find((f) => f.id === from.id)!, to, facts, ...saved };
}
const read = (user: User) => user.json<RecordProposals>("/api/v2/record/proposals");
function decide(user: User, offer: SemanticOfferReview, decision: "confirmed" | "rejected", patch: Partial<SemanticOfferDecision> = {}) {
  return user.send("POST", `/api/v2/record/offers/${offer.link.id}`, { decision,
    expectedFromRevision: offer.from.revision!, expectedToRevision: offer.to.revision!,
    expectedFromRoleRevision: offer.fromRole?.revision ?? null, expectedToRoleRevision: offer.toRole?.revision ?? null,
    expectedState: offer.link.state, expectedDecidedAt: offer.link.decidedAt, ...patch } satisfies SemanticOfferDecision);
}
describe("owner review of model-origin semantic offers", () => {
  it("stays gated and only shows non-shadow model fact links with both lines and source evidence", async () => {
    const seededRow = await seeded(); const { user, id, shadowId, copyId } = seededRow;
    expect((await user.send("POST", `/api/v2/record/offers/${id}`, {})).status).toBe(503);
    settings.RECORD_PROPOSAL_REVIEW_ENABLED = "true";
    const before = await inVault(user, (record) => record.export());
    const shown = await read(user);
    expect(shown.offers).toHaveLength(1); const offer = shown.offers[0]!;
    expect(offer.link.id).toBe(id); expect(offer.from.text).toBe(seededRow.from.text); expect(offer.to.text).toBe(seededRow.to.text);
    expect(offer.from.quote).toBe(seededRow.from.quote); expect(offer.to.quote).toBe(seededRow.to.quote);
    expect(offer.fromRole?.id).toBe(offer.from.roleId); expect(offer.toRole?.id).toBe(offer.to.roleId);
    expect(JSON.stringify(shown)).not.toContain(shadowId); expect(JSON.stringify(shown)).not.toContain(copyId);
    expect(await inVault(user, (record) => record.export())).toEqual(before);
  });
  it("confirms and reverses a same-fact offer without blending or changing original rows or evidence", async () => {
    settings.RECORD_PROPOSAL_REVIEW_ENABLED = "true";
    const { user, id, from, to, facts } = await seeded(); let offer = (await read(user)).offers[0]!;
    expect((await decide(user, offer, "confirmed")).status).toBe(204);
    expect(await inVault(user, (record) => record.root("fact", from.id))).toBe(to.id);
    expect((await user.json<{ facts: FactView[] }>("/api/facts")).facts).toEqual(facts);
    const evidence = await inVault(user, (record) => record.evidenceOf(to.id));
    expect(evidence.map((row) => row.quote).sort()).toEqual([from.quote, to.quote].sort());
    offer = (await read(user)).offers.find((row) => row.link.id === id)!;
    expect((await decide(user, offer, "rejected")).status).toBe(204);
    expect(await inVault(user, (record) => record.root("fact", from.id))).toBe(from.id);
  });
  it("keeps both fuller-version facts separate and leaves all wording and evidence intact", async () => {
    settings.RECORD_PROPOSAL_REVIEW_ENABLED = "true";
    const { user, from, to, facts } = await seeded("fuller"); const offer = (await read(user)).offers[0]!;
    expect((await decide(user, offer, "confirmed")).status).toBe(204);
    expect(await inVault(user, (record) => [record.root("fact", from.id), record.root("fact", to.id)])).toEqual([from.id, to.id]);
    expect((await user.json<{ facts: FactView[] }>("/api/facts")).facts).toEqual(facts);
  });
  it("refuses another owner's offer, shadow/rule links, stale facts/role context and ABA decisions", async () => {
    settings.RECORD_PROPOSAL_REVIEW_ENABLED = "true";
    const { user, id, shadowId, copyId, roleLinkId } = await seeded(); let offer = (await read(user)).offers[0]!;
    expect((await decide(await signIn(), offer, "confirmed")).status).toBe(404);
    for (const bad of [shadowId, copyId, roleLinkId]) expect((await decide(user, { ...offer, link: { ...offer.link, id: bad } }, "confirmed")).status).toBe(404);
    expect((await decide(user, offer, "confirmed", { expectedFromRevision: offer.from.revision! + 1 })).status).toBe(409);
    expect((await decide(user, offer, "confirmed", { expectedToRevision: offer.to.revision! + 1 })).status).toBe(409);
    expect((await decide(user, offer, "confirmed", { expectedFromRoleRevision: offer.fromRole!.revision! + 1 })).status).toBe(409);
    expect((await decide(user, offer, "confirmed")).status).toBe(204);
    offer = (await read(user)).offers[0]!;
    await inVault(user, (record) => { record.decideLink(id, "rejected"); record.decideLink(id, "confirmed"); });
    expect((await decide(user, offer, "rejected")).status).toBe(409);
    expect((await read(user)).offers[0]!.link.state).toBe("confirmed");
  });
});
