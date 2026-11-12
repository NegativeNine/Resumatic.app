import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FactView, ReviewState, RoleView } from "../../shared/api";
import { STATE_LABEL } from "../format";
import { useAction, type Reload } from "../hooks";
import { href } from "../router";
import { countByState, groupByRole, type Vault } from "../vault";
import { AddFact } from "./AddFact";
import { FactList } from "./FactItem";
import { REVIEW_HEADING_ID } from "./ReviewButtons";
import { RoleForm } from "./RoleForm";
import { RoleGroup } from "./RoleGroup";
import { ReviewQueue } from "./ReviewQueue";
import { EmptyState } from "./ui";

// Facts › All facts: what the person has confirmed, by role, and what they left out. What is still
// to check is asked on To check, one question at a time.

const FILTERS: readonly ReviewState[] = ["confirmed", "rejected"];

const HEADING: Partial<Record<ReviewState, string>> = {
  confirmed: "Confirmed, by role",
  rejected: "Left out, by role",
};

export function Review({ vault, reload }: { vault: Vault; reload: () => Promise<Vault | undefined> }) {
  const [filter, setFilter] = useState<ReviewState>("confirmed");
  const [held, setHeld] = useState<Vault | null>(null);
  const latest = useRef(vault);
  latest.current = vault;
  const editors = useRef(new Set<string>());
  const deferredFilter = useRef<ReviewState | null>(null);
  // A refresh can move or remove an item, unmounting its editor and losing its
  // draft. Keep the displayed list stable until every open editor closes.
  const editingChanged = useCallback((id: string, active: boolean) => {
    if (active) {
      if (editors.current.size === 0) setHeld(latest.current);
      editors.current.add(id);
    } else {
      editors.current.delete(id);
      if (editors.current.size === 0) {
        setHeld(null);
        if (deferredFilter.current) {
          setFilter(deferredFilter.current);
          deferredFilter.current = null;
        }
      }
    }
  }, []);
  function showFilter(state: ReviewState) {
    if (editors.current.size) deferredFilter.current = state;
    else setFilter(state);
  }
  const displayed = held ?? vault;
  const filenames = useMemo(() => new Map(displayed.sources.map((s) => [s.id, s.filename] as const)), [displayed.sources]);
  const counts = countByState(displayed);
  const groups = groupByRole(displayed, filter);
  /** Facts still to check under a role or its copies, whatever the filter shows. */
  const proposedUnder = (roleIds: string[]) =>
    displayed.facts.filter((f) => f.state === "proposed" && f.roleId !== null && roleIds.includes(f.roleId)).length;

  async function showAdded(factId: string) {
    const next = await reload();
    const fact = next?.facts.find((f) => f.id === factId);
    // A manual fact starts confirmed. If a refresh fails or a newer refresh
    // supersedes this one, still show the tab where it was created. The
    // refresh error remains visible and can be retried. A state this list
    // doesn't show leaves the filter as it is.
    const state = fact?.state ?? "confirmed";
    showFilter(FILTERS.includes(state) ? state : filter);
  }

  return (
    <section className="section" aria-labelledby={REVIEW_HEADING_ID}>
      <h2 id={REVIEW_HEADING_ID} tabIndex={-1}>
        {HEADING[filter]}
      </h2>
      <div className="add-row">
        <AddFact roles={vault.roles} onAdded={showAdded} />
        <AddRole reload={reload} onAdded={() => showFilter("confirmed")} />
      </div>
      {held && <p role="status" className="hint">This list is paused while you edit. New changes appear when you close the editor. Your draft will be lost if you leave or reload this page.</p>}
      <fieldset className="rs-filter app-review-filter" disabled={!!held}>
        <legend>Show</legend>
        {FILTERS.map((state) => (
          <label key={state}>
            <input type="radio" name="review-filter" checked={filter === state} onChange={() => setFilter(state)} />
            <span className="rs-filter__opt">
              {STATE_LABEL[state]} <span className="rs-filter__count">{counts[state]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="rs-meta facts-attest">
        Want someone who worked with you to back a fact? <a href={href.attest}>Ask a colleague</a>.
      </p>
      {groups.length === 0 ? (
        <EmptyReview filter={filter} />
      ) : (
        <ReviewQueue>
        {groups.map((group) =>
          group.role ? (
            <RoleGroup
              key={group.role.id}
              role={group.role}
              duplicates={group.duplicates ?? []}
              roles={displayed.roles}
              facts={group.facts}
              filter={filter}
              filenames={filenames}
              reload={reload}
              reviewLocked={!!held}
              onEditingChange={editingChanged}
              proposedUnder={proposedUnder([group.role.id, ...(group.duplicates ?? []).map((copy) => copy.id)])}
            />
          ) : (
            <LooseFacts key="loose" facts={group.facts} roles={displayed.roles} filenames={filenames} reload={reload} reviewLocked={!!held} onEditingChange={editingChanged} />
          ),
        )}
        </ReviewQueue>
      )}
    </section>
  );
}

function AddRole({ reload, onAdded }: { reload: Reload; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const action = useAction();

  useEffect(() => {
    if (!open && !action.pending && returnFocus.current) {
      returnFocus.current = false;
      toggle.current?.focus();
    }
  }, [open, action.pending]);

  function close() {
    returnFocus.current = true;
    setOpen(false);
  }

  return (
    <div className="add-fact">
      <button ref={toggle} type="button" aria-expanded={open} disabled={action.pending} onClick={() => setOpen(!open)}>
        Add a role
      </button>
      {open && <RoleForm reload={reload} onClose={close} onAdded={onAdded} action={action} />}
    </div>
  );
}

function LooseFacts(props: { facts: FactView[]; roles: RoleView[]; filenames: ReadonlyMap<string, string>; reload: Reload; reviewLocked: boolean; onEditingChange: (id: string, active: boolean) => void }) {
  return (
    <section className="rs-role" tabIndex={-1} aria-labelledby="loose-facts-heading" data-review-group="">
      <div className="rs-role__head">
        <span aria-hidden="true" />
        <div>
          <h3 className="rs-role__title" id="loose-facts-heading">
            Not tied to a role
          </h3>
          <p className="rs-role__detail">Skills, credentials and other facts that stand on their own.</p>
        </div>
      </div>
      <FactList className="rs-role__facts" {...props} />
    </section>
  );
}

function EmptyReview({ filter }: { filter: ReviewState }) {
  if (filter === "rejected") {
    return <EmptyState title="Nothing left out">Anything you leave out is kept here and never used.</EmptyState>;
  }
  return (
    <EmptyState title="No confirmed facts yet">
      Say “That’s right” to the facts that are true, and your resumes will use them.
    </EmptyState>
  );
}
