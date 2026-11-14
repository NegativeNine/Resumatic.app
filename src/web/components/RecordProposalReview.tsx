import { useId } from "react";
import type { SemanticOfferReview } from "../../shared/proposal-review";
import type { ConceptTag, FactSplit, Judgement } from "../../shared/record";
import { api } from "../api";
import { useAction, useResource } from "../hooks";
import { SourceEvidence } from "./SourceEvidence";
import { FactEvidence, FactMeta } from "./FactItem";
import { ActionError, Badge, EmptyState, ErrorNote, Loading } from "./ui";

/** Mounted only when the owner's vault advertises the gated review capability. */
export function RecordProposalReview({ enabled, filenames }: { enabled: boolean; filenames: ReadonlyMap<string, string> }) {
  return enabled ? <Proposals filenames={filenames} /> : null;
}

function Proposals({ filenames }: { filenames: ReadonlyMap<string, string> }) {
  const proposals = useResource(api.recordProposals);
  return <section className="rs-panel app-stack" aria-labelledby="record-proposals-heading">
    <h2 id="record-proposals-heading">Parts, tags and links to review</h2>
    <p>Check each suggestion against your original line. Your line and source evidence stay as they are.</p>
    {proposals.error && <ErrorNote message={proposals.error} onRetry={proposals.reload} />}
    {!proposals.data && !proposals.error && <Loading>Loading your suggestions…</Loading>}
    {proposals.data && !proposals.data.facts.length && !proposals.data.roles.length && !(proposals.data.offers?.length ?? 0) &&
      <EmptyState>No parts, tags or links are available for review.</EmptyState>}
    {proposals.data?.facts.map(({ fact, split, rejectedSplits, tags, partTags }) => <article key={fact.id} className="app-stack" aria-label={`Suggestions for ${fact.text}`}>
      <h3>Your line</h3>
      <p>{fact.text}</p>
      <FactEvidence fact={fact} filenames={filenames} />
      {split && <SplitReview split={split} revision={fact.revision ?? 1} reload={proposals.reload} hasPartTags={partTags.length > 0} />}
      {!!rejectedSplits?.length && <details>
        <summary>Previously rejected parts ({rejectedSplits.length})</summary>
        <p className="rs-meta">You can use a previous division again. Tags removed when it was rejected stay removed.</p>
        {rejectedSplits.map((previous) => <SplitReview key={previous.id} split={previous} revision={fact.revision ?? 1} reload={proposals.reload} />)}
      </details>}
      <Tags tags={tags} revision={fact.revision ?? 1} reload={proposals.reload} />
      {partTags.map(({ part, tags: named }) => <div key={part.id} className="app-stack">
        <p>Tags for this part: <q>{part.text}</q></p>
        <Tags tags={named} revision={fact.revision ?? 1} reload={proposals.reload} />
      </div>)}
    </article>)}
    {proposals.data?.roles.map(({ role, tags }) => <article key={role.id} className="app-stack" aria-label={`Suggestions for ${role.title ?? role.org}`}>
      <h3>{role.title ? `${role.title} at ${role.org}` : role.org}</h3>
      {role.quote && <blockquote>{role.quote}</blockquote>}
      {role.quote && role.sourceId && role.span && <SourceEvidence sourceId={role.sourceId} quote={role.quote} span={role.span} />}
      <Tags tags={tags} revision={role.revision ?? 1} reload={proposals.reload} />
    </article>)}
    {proposals.data?.offers?.map((offer) => <OfferReview key={offer.link.id} offer={offer} filenames={filenames} reload={proposals.reload} />)}
  </section>;
}

function OfferReview({ offer, filenames, reload }: { offer: SemanticOfferReview; filenames: ReadonlyMap<string, string>; reload: () => Promise<unknown> }) {
  const headingId = useId();
  const action = useAction();
  const { link } = offer;
  const same = link.relation === "same";
  async function decide(decision: "confirmed" | "rejected") {
    await action.run(async () => {
      await api.decideSemanticOffer(link.id, { decision,
        expectedFromRevision: offer.from.revision ?? 1, expectedToRevision: offer.to.revision ?? 1,
        expectedFromRoleRevision: offer.fromRole?.revision ?? null, expectedToRoleRevision: offer.toRole?.revision ?? null,
        expectedState: link.state, expectedDecidedAt: link.decidedAt });
      await reload();
    });
  }
  return <article className="app-stack" aria-labelledby={headingId}>
    <h3 id={headingId}>{same ? "Do these say the same thing?" : "Does the first line include the second?"}</h3>
    <p>{same ? "Accepting makes the second line stand for both facts. Each original line and source quote stays; no wording is blended."
      : "Accepting links the first line as a fuller version of the second. Both facts stay separate, and neither is automatically chosen for a resume."}</p>
    <div className="rs-field-grid">
      {[{ fact: offer.from, role: offer.fromRole, title: "First line" }, { fact: offer.to, role: offer.toRole, title: "Second line" }].map(({ fact, role, title }) => <section className="app-stack" key={fact.id} aria-label={title}>
        <h4>{title}</h4>
        <p>{fact.text}</p>
        <FactMeta fact={fact} />
        <p className="rs-meta">{role ? `Role: ${role.title ? `${role.title} at ` : ""}${role.org}` : "Not tied to a role"}</p>
        <FactEvidence fact={fact} filenames={filenames} />
      </section>)}
    </div>
    <p className="rs-meta">{link.state === "confirmed" ? "Confirmed by you" : link.state === "rejected" ? "Rejected by you" : "Waiting for your review"}</p>
    <div className="app-inline">
      <button aria-describedby={headingId} disabled={action.pending || link.state === "confirmed"} onClick={() => void decide("confirmed")}>{same ? "Treat as one fact" : "Link as fuller version"}</button>
      <button aria-describedby={headingId} disabled={action.pending || link.state === "rejected"} onClick={() => void decide("rejected")}>{link.state === "confirmed" ? same ? "Undo this merge" : "Remove fuller link" : "Reject link"}</button>
    </div>
    <ActionError message={action.error} />
  </article>;
}

function SplitReview({ split, revision, reload, hasPartTags = false }: { split: FactSplit; revision: number; reload: () => Promise<unknown>; hasPartTags?: boolean }) {
  const headingId = useId();
  return <div className="app-stack">
    <h4 id={headingId}>{split.state === "rejected" ? "Parts you rejected" : "Parts of this line"}</h4>
    <ol>{split.parts.map((part) => <li key={part.id}>
      <p>{part.text}</p>
      <span className="rs-meta">{part.kind === "result" ? "Result" : part.kind === "mention" ? "Mention" : "Claim"}
        {part.resultOf ? ` of part ${split.parts.findIndex((candidate) => candidate.id === part.resultOf) + 1}` : ""}
      </span>
    </li>)}</ol>
    {hasPartTags && <p className="rs-meta">Keeping the line whole also removes the tags on these parts. Restoring the parts keeps those tags removed.</p>}
    <Decision kind="split" judgement={split} revision={revision} reload={reload} describedBy={headingId} />
  </div>;
}

function Tags({ tags, revision, reload }: { tags: ConceptTag[]; revision: number; reload: () => Promise<unknown> }) {
  if (!tags.length) return null;
  return <ul className="app-list">{tags.map((tag) => <TagReview key={tag.id} tag={tag} revision={revision} reload={reload} />)}</ul>;
}

function TagReview({ tag, revision, reload }: { tag: ConceptTag; revision: number; reload: () => Promise<unknown> }) {
  const labelId = useId();
  return <li className="app-stack">
    <p id={labelId}><strong>{tag.label}</strong> <Badge tone="note">{tag.relation === "uses" ? "Tool" : tag.relation === "does" ? "Activity" : tag.relation === "occupation" ? "Occupation" : "Skill or knowledge"}</Badge></p>
    <Decision kind="tag" judgement={tag} revision={revision} reload={reload} describedBy={labelId} />
  </li>;
}

function Decision({ kind, judgement, revision, reload, describedBy }: { kind: "split" | "tag"; judgement: Judgement; revision: number; reload: () => Promise<unknown>; describedBy: string }) {
  const action = useAction();
  async function decide(decision: "confirmed" | "rejected") {
    await action.run(async () => {
      await api.decideRecordProposal(kind, judgement.id, { decision, expectedSubjectRevision: revision,
        expectedState: judgement.state, expectedDecidedAt: judgement.decidedAt });
      await reload();
    });
  }
  return <div className="app-stack">
    <p className="rs-meta">{judgement.state === "confirmed" ? "Confirmed by you" : judgement.state === "rejected" ? "Rejected by you" : "Waiting for your review"}</p>
    <div className="app-inline">
      <button aria-describedby={describedBy} disabled={action.pending || judgement.state === "confirmed"} onClick={() => void decide("confirmed")}>{kind === "split" ? judgement.state === "rejected" ? "Use these parts again" : "Use these parts" : "Confirm tag"}</button>
      <button aria-describedby={describedBy} disabled={action.pending || judgement.state === "rejected"} onClick={() => void decide("rejected")}>{kind === "split" ? "Keep line whole" : "Reject tag"}</button>
    </div>
    <ActionError message={action.error} />
  </div>;
}
