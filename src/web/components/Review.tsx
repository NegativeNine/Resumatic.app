import { useMemo, useState } from "react";
import type { FactView, ReviewState } from "../../shared/api";
import { STATE_LABEL } from "../format";
import type { Reload } from "../hooks";
import { href } from "../router";
import { countByState, groupByRole, isReading, type Vault } from "../vault";
import { AddFact } from "./AddFact";
import { FactList } from "./FactItem";
import { REVIEW_HEADING_ID } from "./ReviewButtons";
import { RoleGroup } from "./RoleGroup";

const FILTERS: readonly ReviewState[] = ["proposed", "confirmed", "rejected"];

export function Review({ vault, reload }: { vault: Vault; reload: () => Promise<Vault | undefined> }) {
  const [filter, setFilter] = useState<ReviewState>("proposed");
  const filenames = useMemo(() => new Map(vault.sources.map((s) => [s.id, s.filename] as const)), [vault.sources]);
  const counts = countByState(vault);
  const groups = groupByRole(vault, filter);

  async function showAdded(factId: string) {
    const next = await reload();
    const fact = next?.facts.find((f) => f.id === factId);
    if (fact) setFilter(fact.state);
  }

  return (
    <section className="section" aria-labelledby={REVIEW_HEADING_ID}>
      <h2 id={REVIEW_HEADING_ID} tabIndex={-1}>
        Review roles and facts
      </h2>
      <p className="section-intro">
        Check each one against the words it came from. Confirm what's true, edit what's nearly right, and reject the
        rest.
      </p>
      <AddFact roles={vault.roles} onAdded={showAdded} />
      <fieldset className="segmented">
        <legend className="visually-hidden">Show</legend>
        {FILTERS.map((state) => (
          <label key={state}>
            <input type="radio" name="review-filter" checked={filter === state} onChange={() => setFilter(state)} />
            <span className="option">
              {STATE_LABEL[state]} <span className="count">{counts[state]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {groups.length === 0 ? (
        <EmptyReview filter={filter} vault={vault} />
      ) : (
        groups.map((group) =>
          group.role ? (
            <RoleGroup
              key={group.role.id}
              role={group.role}
              facts={group.facts}
              filter={filter}
              filenames={filenames}
              reload={reload}
            />
          ) : (
            <LooseFacts key="loose" facts={group.facts} filenames={filenames} reload={reload} />
          ),
        )
      )}
    </section>
  );
}

function LooseFacts(props: { facts: FactView[]; filenames: ReadonlyMap<string, string>; reload: Reload }) {
  return (
    <section className="card group" tabIndex={-1} aria-labelledby="loose-facts-heading">
      <h3 id="loose-facts-heading">Not tied to a role</h3>
      <p className="meta">Skills, credentials and other facts that stand on their own.</p>
      <FactList {...props} />
    </section>
  );
}

function EmptyReview({ filter, vault }: { filter: ReviewState; vault: Vault }) {
  if (filter === "confirmed") {
    return <p className="empty">No confirmed facts yet. Confirm the proposed facts that are true, and your resumes will use them.</p>;
  }
  if (filter === "rejected") {
    return <p className="empty">Nothing rejected. Anything you reject is kept here and never used.</p>;
  }
  if (isReading(vault)) {
    return <p className="empty">Resumatic is reading your upload. Its roles and facts will appear here for review.</p>;
  }
  if (vault.roles.length === 0 && vault.facts.length === 0) {
    return <p className="empty">Nothing to review yet. Upload a resume or CV above, or add a fact yourself.</p>;
  }
  return (
    <p className="empty">
      You're all caught up: nothing is waiting for review. Next, <a href={href.applications}>add a job</a> and tailor
      a resume to it.
    </p>
  );
}
