import { useId, useRef, useState } from "react";
import type { FactView, ReviewState, RoleView } from "../../shared/api";
import { count, formatDateRange, ROLE_KIND_LABEL, STATE_LABEL } from "../format";
import type { Reload } from "../hooks";
import { sourceLabel } from "../vault";
import { FactList } from "./FactItem";
import { ReviewButtons, useReview } from "./ReviewButtons";
import { useQueueItem } from "./ReviewQueue";
import { RoleForm } from "./RoleForm";
import { SourceEvidence } from "./SourceEvidence";
import { ActionError, Badge, Quote, Tick, type TickState } from "./ui";

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
  /** Facts still proposed under this role and its copies, across every filter: rejecting the role rejects them too. */
  proposedUnder: number;
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
  proposedUnder,
}: Props) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const review = useReview(role.id, reload, ref, role.revision ?? 1, duplicates);
  const headingId = useId();
  const [askingReject, setAskingReject] = useState(false);
  const details = [
    role.title,
    ROLE_KIND_LABEL[role.kind],
    formatDateRange(role.startDate, role.endDate, role.unknownEndStartDate),
  ].filter(Boolean);
  const rejecting = proposedUnder + 1 + duplicates.length;
  const canEdit = role.state !== "rejected" && !reviewLocked;

  function startEditing() {
    onEditingChange(`role:${role.id}`, true);
    setEditing(true);
  }

  // Rejecting a role also rejects every fact still proposed under it, so it asks first.
  const askFirst = role.state !== "rejected" && proposedUnder > 0;

  function cancelReject() {
    setAskingReject(false);
    ref.current?.querySelector<HTMLButtonElement>("[data-review-action='reject']")?.focus();
  }

  function reject() {
    setAskingReject(false);
    void review.decide("reject");
  }

  const busy = review.deciding !== null || reviewLocked;
  const active = useQueueItem(role.id, {
    confirm: role.state !== "confirmed" && !busy ? () => void review.decide("confirm") : undefined,
    edit: canEdit && !editing && !busy ? startEditing : undefined,
    reject: role.state !== "rejected" && !busy ? () => (askFirst ? setAskingReject(true) : void review.decide("reject")) : undefined,
  });
  const tick: TickState =
    review.deciding === "confirm" ? "confirmed" : review.deciding === "reject" ? "rejected" : role.state;

  function closeEditor() {
    setEditing(false);
    onEditingChange(`role:${role.id}`, false);
    ref.current?.focus();
  }

  return (
    <section
      className={active ? "rs-role is-active" : "rs-role"}
      ref={ref}
      tabIndex={-1}
      aria-labelledby={headingId}
      data-review-group=""
      data-queue-item={role.id}
    >
      <div className="rs-role__head">
        <Tick state={tick} />
        <div>
          <h3 className="rs-role__title" id={headingId}>
            {role.org}
          </h3>
          {details.length > 0 && (
            <p className="rs-role__detail">
              {details.map((detail) => (
                <span key={detail}>{detail}</span>
              ))}
            </p>
          )}
        </div>
        <Badge tone={role.state}>{STATE_LABEL[role.state]} role</Badge>
        <div className="rs-role__more">
          {role.quote && (
            <Quote text={role.quote} size="sm" caption={`From ${sourceLabel(filenames, role.sourceId)}`} />
          )}
          {role.quote && role.sourceId && role.span && (
            <SourceEvidence
              key={`${role.sourceId}:${role.span.join(":")}:${role.quote}`}
              sourceId={role.sourceId}
              quote={role.quote}
              span={role.span}
            />
          )}
          {duplicates.length > 0 && (
            <p className="rs-meta">
              This role also appears in {duplicates.length} other {duplicates.length === 1 ? "record" : "records"}.
              Review applies to all shown copies; editing changes this copy only.
            </p>
          )}
          {duplicates.map(
            (copy) =>
              copy.quote && (
                <div key={copy.id}>
                  <Quote text={copy.quote} size="sm" caption={`From ${sourceLabel(filenames, copy.sourceId)}`} />
                  {copy.sourceId && copy.span && (
                    <SourceEvidence sourceId={copy.sourceId} quote={copy.quote} span={copy.span} />
                  )}
                </div>
              ),
          )}
          {editing ? (
            <RoleForm role={role} reload={reload} onClose={closeEditor} />
          ) : (
            <ReviewButtons
              state={role.state}
              noun="role"
              describedBy={headingId}
              review={review}
              disabled={reviewLocked}
              onEdit={role.state === "rejected" ? undefined : startEditing}
              onReject={askFirst ? () => setAskingReject(true) : undefined}
              rejectExpanded={askingReject}
              showKeys={active}
            />
          )}
          {askingReject && !editing && (
            <div className="rs-well" role="group" aria-label={`Reject ${role.org}`}>
              <p className="rs-p app-well-text">
                Reject {role.org} and its {count(proposedUnder, "proposed fact")}? Rejected items are kept here and
                never used.
              </p>
              <div className="rs-actions app-well-actions">
                <button type="button" className="rs-btn rs-btn--primary rs-btn--sm" autoFocus disabled={busy} onClick={reject}>
                  Yes, reject {rejecting}
                </button>
                <button type="button" className="rs-btn rs-btn--sm" onClick={cancelReject}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          <ActionError message={review.error} />
        </div>
      </div>
      {facts.length > 0 ? (
        <FactList
          className="rs-role__facts"
          facts={facts}
          roles={roles}
          filenames={filenames}
          reload={reload}
          reviewLocked={reviewLocked}
          onEditingChange={onEditingChange}
          equivalentRoles={new Set([role.id, ...duplicates.map((copy) => copy.id)])}
        />
      ) : (
        <p className="rs-role__empty">No {STATE_LABEL[filter].toLowerCase()} facts under this role.</p>
      )}
    </section>
  );
}
