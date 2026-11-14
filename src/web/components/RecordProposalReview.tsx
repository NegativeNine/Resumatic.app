import { useId } from "react";
import type { ConceptTag, FactSplit, Judgement } from "../../shared/record";
import { api } from "../api";
import { useAction, useResource } from "../hooks";
import { SourceEvidence } from "./SourceEvidence";
import { FactEvidence } from "./FactItem";
import { ActionError, Badge, EmptyState, ErrorNote, Loading } from "./ui";

/** Mounted only when the owner's vault advertises the gated review capability. */
export function RecordProposalReview({ enabled, filenames }: { enabled: boolean; filenames: ReadonlyMap<string, string> }) {
  return enabled ? <Proposals filenames={filenames} /> : null;
}

function Proposals({ filenames }: { filenames: ReadonlyMap<string, string> }) {
  const proposals = useResource(api.recordProposals);
  return <section className="rs-panel app-stack" aria-labelledby="record-proposals-heading">
    <h2 id="record-proposals-heading">Parts and tags to review</h2>
    <p>Check each suggestion against your original line. Your line and source evidence stay as they are.</p>
    {proposals.error && <ErrorNote message={proposals.error} onRetry={proposals.reload} />}
    {!proposals.data && !proposals.error && <Loading>Loading your suggestions…</Loading>}
    {proposals.data && !proposals.data.facts.length && !proposals.data.roles.length &&
      <EmptyState>No parts or tags are available for review.</EmptyState>}
    {proposals.data?.facts.map(({ fact, split, tags, partTags }) => <article key={fact.id} className="app-stack" aria-label={`Suggestions for ${fact.text}`}>
      <h3>Your line</h3>
      <p>{fact.text}</p>
      <FactEvidence fact={fact} filenames={filenames} />
      {split && <SplitReview split={split} revision={fact.revision ?? 1} reload={proposals.reload} />}
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
  </section>;
}

function SplitReview({ split, revision, reload }: { split: FactSplit; revision: number; reload: () => Promise<unknown> }) {
  const headingId = useId();
  return <div className="app-stack">
    <h4 id={headingId}>Parts of this line</h4>
    <ol>{split.parts.map((part) => <li key={part.id}>
      <p>{part.text}</p>
      <span className="rs-meta">{part.kind === "result" ? "Result" : part.kind === "mention" ? "Mention" : "Claim"}
        {part.resultOf ? ` of part ${split.parts.findIndex((candidate) => candidate.id === part.resultOf) + 1}` : ""}
      </span>
    </li>)}</ol>
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
      <button aria-describedby={describedBy} disabled={action.pending || judgement.state === "confirmed"} onClick={() => void decide("confirmed")}>{kind === "split" ? "Use these parts" : "Confirm tag"}</button>
      <button aria-describedby={describedBy} disabled={action.pending || judgement.state === "rejected"} onClick={() => void decide("rejected")}>{kind === "split" ? "Keep line whole" : "Reject tag"}</button>
    </div>
    <ActionError message={action.error} />
  </div>;
}
