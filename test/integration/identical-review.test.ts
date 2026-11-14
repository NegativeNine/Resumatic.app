import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setModels } from "../../src/ai/models";
import type { CopyLinkView, FactView, RoleView, SourceView } from "../../src/shared/api";
import { groupByRole, groupFacts, reviewQuestions } from "../../src/shared/review-groups";
import { RESUME, fakeModels, signIn, waitForSource, type User } from "./support";

const settings = env as unknown as { IDENTICAL_REVIEW_ENABLED?: string };
const before = settings.IDENTICAL_REVIEW_ENABLED;
beforeEach(() => setModels(() => fakeModels()));
afterEach(() => { settings.IDENTICAL_REVIEW_ENABLED = before; setModels(null); });
type View = { facts: FactView[]; roles: RoleView[]; sources: SourceView[] };
const view = (user: User) => user.json<View>("/api/v2/vault");
const group = (user: User) => user.send("POST", "/api/v2/record/identical", {});
async function upload(user: User, extra = "") {
  const res = await user.upload(`resume${extra.length}.pdf`, RESUME + extra);
  expect(res.status, await res.clone().text()).toBe(201);
  await waitForSource(user, (await res.json() as { sourceId: string }).sourceId);
}
function decide(user: User, link: CopyLinkView, decision: "confirmed" | "rejected", revisions = {}) {
  return user.send("POST", `/api/v2/record/links/${link.id}`, { decision, fromRevision: link.fromRevision, toRevision: link.toRevision, expectedDecisionVersion: link.decisionVersion, ...revisions });
}

describe("owner review of deterministic identical copies", () => {
  it("is off by default and refuses a decision while disabled", async () => {
    expect(before).toBeUndefined();
    const user = await signIn(); await upload(user);
    expect((await view(user)).facts.every((f) => f.copyReview === undefined)).toBe(true);
    expect((await user.send("POST", "/api/v2/record/links/unknown", { decision: "rejected", fromRevision: 1, toRevision: 1 })).status).toBe(503);
  });

  it("shows each quote, separates persistently, and lets the owner rejoin identical copies", async () => {
    settings.IDENTICAL_REVIEW_ENABLED = "true";
    const user = await signIn(); await upload(user); await upload(user, "\nVolunteer mentor");
    const beforeGrouping = await view(user);
    expect(beforeGrouping.facts.every((f) => f.copyReview?.rootId === f.id)).toBe(true);
    await user.json("/api/v2/today");
    expect((await user.json<{ recordLinks: unknown[] }>("/api/export")).recordLinks).toEqual([]);
    expect((await group(user)).status).toBe(204);
    const first = await view(user);
    const pair = first.facts.find((f) => f.copyReview?.links.length);
    expect(pair).toBeDefined();
    const link = pair!.copyReview!.links[0]!;
    const rows = first.facts.filter((f) => f.id === link.from || f.id === link.to);
    expect(new Set(rows.map((r) => r.sourceId)).size).toBe(2);
    expect(rows.every((r) => r.quote && r.span)).toBe(true);
    expect(rows[0]!.copyReview!.rootId).toBe(rows[1]!.copyReview!.rootId);
    expect((await decide(user, link, "rejected")).status).toBe(204);
    const separated = await view(user);
    await group(user);
    const roots = separated.facts.filter((f) => rows.some((r) => r.id === f.id)).map((f) => f.copyReview!.rootId);
    expect(new Set(roots).size).toBe(2);
    expect((await view(user)).facts.map((f) => [f.id, f.text, f.quote, f.span, f.state])).toEqual(first.facts.map((f) => [f.id, f.text, f.quote, f.span, f.state]));
    await upload(user, "\nAnother distinct footer"); await group(user);
    expect((await view(user)).facts.find((f) => f.id === link.from)!.copyReview!.rootId).toBe(link.from);
    const current = (await view(user)).facts.find((f) => f.id === link.from)!.copyReview!.separations.find((l) => l.id === link.id)!;
    expect((await decide(user, current, "confirmed")).status).toBe(204);
    expect((await view(user)).facts.find((f) => f.id === link.from)!.copyReview!.rootId).toBe(link.to);
  });

  it("refuses another owner's link and stale revisions", async () => {
    settings.IDENTICAL_REVIEW_ENABLED = "true";
    const user = await signIn(); await upload(user); await upload(user, "\nSecond upload");
    await group(user);
    const link = (await view(user)).facts.find((f) => f.copyReview?.links.length)!.copyReview!.links[0]!;
    expect((await decide(await signIn(), link, "rejected")).status).toBe(404);
    expect((await decide(user, link, "rejected", { fromRevision: link.fromRevision + 1 })).status).toBe(409);
    expect((await view(user)).facts.find((f) => f.id === link.from)!.copyReview!.rootId).toBe(link.to);
  });

  it("refuses delayed decisions even when neither copy's wording changed", async () => {
    settings.IDENTICAL_REVIEW_ENABLED = "true";
    const user = await signIn(); await upload(user); await upload(user, "\nSecond upload"); await group(user);
    const old = (await view(user)).facts.find((f) => f.copyReview?.links.length)!.copyReview!.links[0]!;
    expect((await decide(user, old, "rejected")).status).toBe(204);
    expect((await decide(user, old, "confirmed")).status).toBe(409);
    const separated = (await view(user)).facts.find((f) => f.id === old.from)!.copyReview!.separations[0]!;
    expect(separated.decisionVersion).toBeGreaterThan(old.decisionVersion);
    expect((await decide(user, separated, "confirmed")).status).toBe(204);
    expect((await decide(user, separated, "rejected")).status).toBe(409);
    expect((await view(user)).facts.find((f) => f.id === old.from)!.copyReview!.rootId).toBe(old.to);
  });

  it("does not rejoin an old comparison after its wording is edited", async () => {
    settings.IDENTICAL_REVIEW_ENABLED = "true";
    const user = await signIn(); await upload(user); await upload(user, "\nSecond upload"); await group(user);
    const first = await view(user); const link = first.facts.find((f) => f.copyReview?.links.length)!.copyReview!.links[0]!;
    expect((await decide(user, link, "rejected")).status).toBe(204);
    const changed = await user.send("PATCH", `/api/facts/${link.from}`, { text: "Maintained a different service", expectedRevision: link.fromRevision });
    expect(changed.status, await changed.clone().text()).toBe(204);
    expect((await decide(user, link, "confirmed")).status).toBe(404);
    await group(user);
    expect((await view(user)).facts.find((f) => f.id === link.from)!.copyReview!.rootId).toBe(link.from);
  });

  it("keeps roles as separate review questions when the canonical role is retitled", async () => {
    settings.IDENTICAL_REVIEW_ENABLED = "true";
    const user = await signIn(); await upload(user); await upload(user, "\nSecond upload"); await group(user);
    const first = await view(user);
    const link = first.roles.find((role) => role.kind === "job" && role.copyReview?.links.length)!.copyReview!.links[0]!;
    const root = first.roles.find((role) => role.id === link.to)!;
    const copy = first.roles.find((role) => role.id === link.from)!;
    const changedTitle = `${root.title} II`;
    const changed = await user.send("PATCH", `/api/roles/${root.id}`, { title: changedTitle, expectedRevision: root.revision });
    expect(changed.status, await changed.clone().text()).toBe(204);
    const next = await view(user);
    // The source-evidence relationship stays as history; current review questions stay exact.
    expect(next.roles.find((role) => role.id === copy.id)!.copyReview!.rootId).toBe(root.id);
    const questions = reviewQuestions(next).filter((question) => question.kind === "role" && [root.id, copy.id].includes(question.role.id));
    expect(questions).toHaveLength(2);
    expect(questions.map((question) => question.duplicates)).toEqual([[], []]);
    const shown = groupByRole(next, "proposed").filter((group) => group.role && [root.id, copy.id].includes(group.role.id));
    expect(shown.map((group) => group.role!.title).sort()).toEqual([copy.title, changedTitle].sort());
    for (const entry of shown) expect(entry.facts.every((fact) => fact.roleId === entry.role!.id)).toBe(true);
    // A decision derived from the edited role's question must not change the old role's copy.
    expect((await user.send("POST", "/api/review", { reject: [root.id], confirm: [] })).status).toBe(204);
    expect((await view(user)).roles.find((role) => role.id === copy.id)!.state).toBe("proposed");
  });

  it("keeps private and different-state copies as separate questions", async () => {
    settings.IDENTICAL_REVIEW_ENABLED = "true";
    const user = await signIn(); await upload(user); await upload(user, "\nSecond upload");
    expect((await group(user)).status).toBe(204);
    const first = await view(user); const f = first.facts.find((f) => f.copyReview?.links.length)!;
    const link = f.copyReview!.links[0]!;
    await user.send("POST", "/api/review", { confirm: [link.from], reject: [] });
    const next = await view(user);
    const a = next.facts.find((r) => r.id === link.from)!; const b = next.facts.find((r) => r.id === link.to)!;
    expect(a.state).toBe("confirmed"); expect(b.state).toBe("proposed");
    expect(groupFacts([a, b], new Set(next.roles.map((r) => r.id)))).toHaveLength(2);
    expect(groupFacts([{ ...a, sensitive: true }, { ...b, state: a.state }], new Set(next.roles.map((r) => r.id)))).toHaveLength(2);
    expect(groupByRole(next, "proposed").flatMap((g) => g.facts).some((f) => f.id === b.id)).toBe(true);
  });
});
