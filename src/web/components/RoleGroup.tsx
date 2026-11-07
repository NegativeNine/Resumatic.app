import { useId, useRef, useState } from "react";
import type { FactView, ReviewState, RoleView } from "../../shared/api";
import { formatDateRange, ROLE_KIND_LABEL, STATE_LABEL } from "../format";
import type { Reload } from "../hooks";
import { sourceLabel } from "../vault";
import { FactList } from "./FactItem";
import { ReviewButtons, useReview } from "./ReviewButtons";
import { RoleForm } from "./RoleForm";
import { SourceEvidence } from "./SourceEvidence";
import { ActionError, Badge, Quote } from "./ui";

interface Props {
  role: RoleView;
  duplicates: RoleView[];
  /** Every role, so a fact can be moved to another one. */
  roles: RoleView[];
  facts: FactView[];
  filter: ReviewState;
  filenames: ReadonlyMap<string, string>;
  reload: Reload;
  reviewLocked: boolean;
  onEditingChange: (id: string, active: boolean) => void;
}

export function RoleGroup({
  role,
  duplicates,
  roles,
  facts,
  filter,
  filenames,
  reload,
  reviewLocked,
  onEditingChange,
}: Props) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const review = useReview(role.id, reload, ref, role.revision ?? 1, duplicates);
  const headingId = useId();
  const details = [
    role.title,
    ROLE_KIND_LABEL[role.kind],
    formatDateRange(role.startDate, role.endDate, role.unknownEndStartDate),
  ]
    .filter(Boolean)
    .join(" · ");

  function closeEditor() {
    setEditing(false);
    onEditingChange(`role:${role.id}`, false);
    ref.current?.focus();
  }

  return (
    <section
      className="card group"
      ref={ref}
      tabIndex={-1}
      aria-labelledby={headingId}
    >
      <div className="row-between">
        <div>
          <h3 id={headingId}>{role.org}</h3>
          <p className="meta">{details}</p>
        </div>
        <Badge tone={role.state}>{STATE_LABEL[role.state]} role</Badge>
      </div>
      {role.quote && (
        <Quote
          text={role.quote}
          caption={`From ${sourceLabel(filenames, role.sourceId)}`}
        />
      )}
      {role.quote && role.sourceId && role.span && (
        <SourceEvidence
          key={`${role.sourceId}:${role.span.join(":")}:${role.quote}`}
          sourceId={role.sourceId}
          quote={role.quote}
          span={role.span}
        />
      )}
      {duplicates.length > 0 && <p className="meta">This role also appears in {duplicates.length} other {duplicates.length === 1 ? "record" : "records"}. Review applies to all shown copies; editing changes this copy only.</p>}
      {duplicates.map((copy) => copy.quote && (
        <div key={copy.id}>
          <Quote text={copy.quote} caption={`From ${sourceLabel(filenames, copy.sourceId)}`} />
          {copy.sourceId && copy.span && <SourceEvidence sourceId={copy.sourceId} quote={copy.quote} span={copy.span} />}
        </div>
      ))}
      {editing ? (
        <RoleForm role={role} reload={reload} onClose={closeEditor} />
      ) : (
        <ReviewButtons
          state={role.state}
          noun="role"
          describedBy={headingId}
          review={review}
          disabled={reviewLocked}
          onEdit={
            role.state === "rejected" ? undefined : () => { onEditingChange(`role:${role.id}`, true); setEditing(true); }
          }
        />
      )}
      <ActionError message={review.error} />
      {facts.length > 0 ? (
        <FactList
          facts={facts}
          roles={roles}
          filenames={filenames}
          reload={reload}
          reviewLocked={reviewLocked}
          onEditingChange={onEditingChange}
          equivalentRoles={new Set([role.id, ...duplicates.map((copy) => copy.id)])}
        />
      ) : (
        <p className="meta group-empty">
          No {STATE_LABEL[filter].toLowerCase()} facts under this role.
        </p>
      )}
    </section>
  );
}
