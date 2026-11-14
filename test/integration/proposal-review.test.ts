import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import type { FactView, RoleView } from "../../src/shared/api";
import type { ProposalDecision, RecordProposals } from "../../src/shared/proposal-review";
import type { ConceptTag, FactSplit, Stamp } from "../../src/shared/record";
import { vault } from "../../src/shared/stubs";
import { RecordStore } from "../../src/vault/record";
import { fromBase64url } from "../../src/worker/crypto";
import { RESUME, fakeModels, signIn, waitForSource, type User } from "./support";

const settings = env as unknown as { RECORD_PROPOSAL_REVIEW_ENABLED?: string };
const original = settings.RECORD_PROPOSAL_REVIEW_ENABLED;
const stamp: Stamp = { proposedBy: "model", model: "@cf/test/judge", method: "test-proposal/1", taxonomyVersion: "test-taxonomy-1", confidence: 0.95, shadow: false };
beforeEach(() => setModels(() => fakeModels()));
afterEach(() => { setModels(null); settings.RECORD_PROPOSAL_REVIEW_ENABLED = original; });
function inVault<T>(user: User, work: (record: RecordStore, sql: SqlStorage) => T): Promise<T> {
  const session = JSON.parse(new TextDecoder().decode(fromBase64url(user.cookie.slice("__Host-session=".length).split(".")[0]!))) as { vid: string };
  return runInDurableObject(vault(env, session.vid), (_instance, state) => work(new RecordStore(state.storage.sql, (fn) => state.storage.transactionSync(fn)), state.storage.sql));
}
async function seeded() {
  const user = await signIn();
  const response = await user.upload("resume.pdf", RESUME);
  await waitForSource(user, (await response.json() as { sourceId: string }).sourceId);
  const { facts } = await user.json<{ facts: FactView[] }>("/api/facts");
  const { roles } = await user.json<{ roles: RoleView[] }>("/api/roles");
  const fact = facts.find((f) => f.text.startsWith("Led the migration"))!;
  const role = roles.find((r) => r.id === fact.roleId)!;
  const saved = await inVault(user, (record) => {
    const split = record.proposeSplit({ factId: fact.id, line: fact.text,
      parts: [{ kind: "clause", ranges: [[0, fact.text.length]] }], stamp });
    const tag = record.proposeTag({ subject: { kind: "fact", id: fact.id }, conceptId: "onet:tool:kubernetes", conceptKind: "tool", label: "Kubernetes", stamp });
    const partTag = record.proposeTag({ subject: { kind: "part", id: split.partIds[0]! }, conceptId: "onet:tool:kubernetes", conceptKind: "tool", label: "Kubernetes on a part", stamp });
    const roleTag = record.proposeTag({ subject: { kind: "role", id: role.id }, conceptId: "onet:occ:15-1252.00", conceptKind: "occupation", label: "Software Developers", stamp });
    const shadow = record.proposeTag({ subject: { kind: "fact", id: fact.id }, conceptId: "onet:tool:python", conceptKind: "tool", label: "SHADOW MUST NOT SHOW", stamp: { ...stamp, shadow: true } });
    const shadowSplit = record.proposeSplit({ factId: fact.id, line: fact.text, parts: [{ kind: "clause", ranges: [[0, fact.text.length]] }], stamp: { ...stamp, shadow: true } });
    return { splitId: split.splitId, tagId: tag.tagId, partTagId: partTag.tagId, roleTagId: roleTag.tagId, shadowTagId: shadow.tagId, shadowSplitId: shadowSplit.splitId };
  });
  return { user, fact, role, ...saved };
}
const read = (user: User) => user.json<RecordProposals>("/api/v2/record/proposals");
function decide(user: User, kind: "split" | "tag", proposal: FactSplit | ConceptTag, revision: number, decision: "confirmed" | "rejected") {
  return user.send("POST", `/api/v2/record/proposals/${kind}/${proposal.id}`, {
    decision, expectedSubjectRevision: revision, expectedState: proposal.state, expectedDecidedAt: proposal.decidedAt,
  } satisfies ProposalDecision);
}

describe("gated owner review of existing split and tag proposals", () => {
  it("is off by default and exposes no proposal capability or API", async () => {
    expect(original).toBeUndefined(); const { user } = await seeded();
    expect((await user.fetch("/api/v2/record/proposals")).status).toBe(503);
    const view = await user.json<{ facts: FactView[] }>("/api/v2/vault");
    expect(view.facts.some((f) => f.proposalReviewEnabled)).toBe(false);
  });
  it("shows original words, parts and taxonomy labels but never shadow rows; reads create nothing", async () => {
    settings.RECORD_PROPOSAL_REVIEW_ENABLED = "true";
    const { user, fact, role } = await seeded();
    const before = await inVault(user, (record) => record.export());
    const shown = await read(user);
    expect(shown.facts[0]!.fact).toEqual(fact);
    expect(shown.facts[0]!.split!.parts[0]!.text).toBe(fact.text);
    expect(shown.facts[0]!.tags[0]!.label).toBe("Kubernetes");
    expect(shown.facts[0]!.partTags[0]!.tags[0]!.label).toBe("Kubernetes on a part");
    expect(shown.roles[0]!.role).toEqual(role);
    expect(shown.roles[0]!.tags[0]!.label).toBe("Software Developers");
    expect(JSON.stringify(shown)).not.toContain("SHADOW");
    expect(await inVault(user, (record) => record.export())).toEqual(before);
  });
  it("confirms and rejects splits and tags while preserving original facts and evidence", async () => {
    settings.RECORD_PROPOSAL_REVIEW_ENABLED = "true";
    const { user, fact } = await seeded();
    let shown = await read(user); let row = shown.facts[0]!;
    expect((await decide(user, "tag", shown.roles[0]!.tags[0]!, shown.roles[0]!.role.revision!, "confirmed")).status).toBe(204);
    expect((await decide(user, "split", row.split!, fact.revision!, "confirmed")).status).toBe(204);
    expect((await decide(user, "tag", row.tags[0]!, fact.revision!, "confirmed")).status).toBe(204);
    expect((await decide(user, "tag", row.partTags[0]!.tags[0]!, fact.revision!, "confirmed")).status).toBe(204);
    shown = await read(user); row = shown.facts[0]!;
    expect(row.split!.state).toBe("confirmed"); expect(row.tags[0]!.state).toBe("confirmed");
    expect((await decide(user, "tag", row.tags[0]!, fact.revision!, "rejected")).status).toBe(204);
    expect((await decide(user, "split", row.split!, fact.revision!, "rejected")).status).toBe(204);
    row = (await read(user)).facts[0]!;
    expect(row.split).toBeNull(); expect(row.partTags).toEqual([]); expect(row.tags[0]!.state).toBe("rejected");
    expect(row.fact).toEqual(fact);
    expect(row.rejectedSplits.map((history) => history.id)).toEqual([shown.facts[0]!.split!.id]);
    const previous = row.rejectedSplits[0]!;
    expect((await decide(user, "split", previous, fact.revision!, "confirmed")).status).toBe(204);
    row = (await read(user)).facts[0]!;
    expect(row.split!.id).toBe(previous.id); expect(row.rejectedSplits).toEqual([]);
    expect(row.partTags).toEqual([]); expect(row.fact).toEqual(fact);

  });
  it("keeps rejected-only facts in owner history, excludes shadow history and refuses a competing active split", async () => {
    settings.RECORD_PROPOSAL_REVIEW_ENABLED = "true";
    const { user, fact, shadowSplitId } = await seeded();
    const originalSplit = (await read(user)).facts[0]!.split!;
    expect((await decide(user, "split", originalSplit, fact.revision!, "rejected")).status).toBe(204);
    await inVault(user, (_record, sql) => {
      sql.exec(`DELETE FROM record_tags`);
      sql.exec(`UPDATE fact_splits SET state = 'rejected' WHERE id = ?`, shadowSplitId);
    });
    const onlyHistory = (await read(user)).facts;
    expect(onlyHistory).toHaveLength(1); expect(onlyHistory[0]!.split).toBeNull();
    expect(onlyHistory[0]!.rejectedSplits.map((split) => split.id)).toEqual([originalSplit.id]);
    const previous = onlyHistory[0]!.rejectedSplits[0]!;
    const replacement = await inVault(user, (record) => record.proposeSplit({ factId: fact.id, line: fact.text,
      parts: [{ kind: "clause", ranges: [[0, fact.text.length]] }, { kind: "mention", ranges: [[fact.text.indexOf("Kubernetes"), fact.text.indexOf("Kubernetes") + "Kubernetes".length]] }], stamp }));
    expect((await decide(user, "split", previous, fact.revision!, "confirmed")).status).toBe(409);
    const concurrent = (await read(user)).facts[0]!;
    expect(concurrent.split!.id).toBe(replacement.splitId); expect(concurrent.rejectedSplits.map((split) => split.id)).toContain(previous.id);
    expect((await decide(user, "split", concurrent.split!, fact.revision!, "rejected")).status).toBe(204);
    expect((await decide(user, "split", previous, fact.revision!, "confirmed")).status).toBe(204);
    const restored = (await read(user)).facts[0]!;
    expect(restored.split!.id).toBe(previous.id); expect(restored.partTags).toEqual([]);
  });

  it("refuses shadow IDs, another owner's IDs, stale subject revisions and concurrent decisions", async () => {
    settings.RECORD_PROPOSAL_REVIEW_ENABLED = "true";
    const { user, fact, shadowTagId, shadowSplitId } = await seeded();
    const row = (await read(user)).facts[0]!; const split = row.split!;
    expect((await decide(await signIn(), "split", split, fact.revision!, "confirmed")).status).toBe(404);
    expect((await decide(user, "split", { ...split, id: shadowSplitId }, fact.revision!, "confirmed")).status).toBe(404);
    expect((await decide(user, "tag", { ...row.tags[0]!, id: shadowTagId }, fact.revision!, "confirmed")).status).toBe(404);
    expect((await decide(user, "split", split, fact.revision! + 1, "confirmed")).status).toBe(409);
    expect((await decide(user, "split", split, fact.revision!, "confirmed")).status).toBe(204);
    expect((await decide(user, "split", split, fact.revision!, "rejected")).status).toBe(409);
    expect((await read(user)).facts[0]!.split!.state).toBe("confirmed");
    const oldConfirmed = (await read(user)).facts[0]!.split!;
    await inVault(user, (record) => { record.decideSplit(split.id, "rejected"); record.decideSplit(split.id, "confirmed"); });
    expect((await decide(user, "split", oldConfirmed, fact.revision!, "rejected")).status).toBe(409);

  });
});
