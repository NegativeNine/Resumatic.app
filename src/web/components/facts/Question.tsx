import { useEffect, useRef, useState, type RefObject } from "react";
import type { FactView, RoleView } from "../../../shared/api";
import { cleanExtractedText } from "../../../shared/clean";
import { formatDateRange, ROLE_KIND_LABEL } from "../../format";
import type { Reload } from "../../hooks";
import { sourceLabel, type ReviewQuestion } from "../../vault";
import { DuplicatesNote, FactEditor, FactEvidence, FactHints, FactMeta } from "../FactItem";
import { ReviewButtons, useReview } from "../ReviewButtons";
import { RoleForm } from "../RoleForm";
import { RoleRejectWell } from "../RoleGroup";
import { useSensitive } from "../SensitiveControl";
import { SourceEvidence } from "../SourceEvidence";
import { ActionError, Quote } from "../ui";
import { CopyControls } from "../CopyControls";
import { MoreChoices } from "./MoreChoices";

// The one item To check asks about: a fact or a role, its words large, every quote it rests on, and
// the answers. It is built from the list's own parts (the review buttons, useReview, useSensitive,
// the editors and the question before a role is left out), so the rules for asking first and for
// what may be confirmed are the list's rules.

type FactQuestionData = Extract<ReviewQuestion, { kind: "fact" }>;
type RoleQuestionData = Extract<ReviewQuestion, { kind: "role" }>;

interface ItemProps {
  filenames: ReadonlyMap<string, string>;
  /** Every role, so a fact can be moved to another one. */
  roles: RoleView[];
  reload: Reload;
  /** The question's section, which takes focus after an answer and when an editor closes. */
  section: RefObject<HTMLElement | null>;
  /** The ID the item's words carry, which the buttons and the section are described by. */
  textId: string;
  onEditingChange: (active: boolean) => void;
  /** Whether an answer or a change to keeping it private is on its way. */
  onBusyChange: (busy: boolean) => void;
}

/** A fact's words as shown: an extracted fact is cleaned of the file's markup. */
export const factText = (fact: FactView) => (fact.origin === "extracted" ? cleanExtractedText(fact.text) : fact.text);

/** A role as one line: "Senior Backend Engineer at Northwind Logistics". */
export const roleText = (role: RoleView) => (role.title ? `${role.title} at ${role.org}` : role.org);

/** The item's words as Up next and the question show them. */
export const questionText = (question: ReviewQuestion) => (question.kind === "fact" ? factText(question.fact) : roleText(question.role));

/** Reports busy and editing to the page, and lets go of both when the item goes. */
function useReport(busy: boolean, editing: boolean, onBusyChange: (busy: boolean) => void, onEditingChange: (active: boolean) => void) {
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
  const wasEditing = useRef(editing);
  wasEditing.current = editing;
  const release = useRef({ onBusyChange, onEditingChange });
  release.current = { onBusyChange, onEditingChange };
  useEffect(
    () => () => {
      release.current.onBusyChange(false);
      if (wasEditing.current) release.current.onEditingChange(false);
    },
    [],
  );
}

export function FactQuestion({ question, filenames, roles, reload, section, textId, onEditingChange, onBusyChange }: ItemProps & { question: FactQuestionData }) {
  const { fact, duplicates } = question;
  const [editing, setEditing] = useState(false);
  const review = useReview(fact.id, reload, section, fact.revision ?? 1, duplicates);
  const sensitive = useSensitive(fact, duplicates, reload);
  // The role the fact names, or the one it is shown under. While it is left out, the fact can be
  // fixed or left out but not confirmed: the Vault refuses that, and To check doesn't offer it.
  const role = roles.find((item) => item.id === fact.roleId) ?? question.role;
  const roleRejected = role?.state === "rejected";
  useReport(review.deciding !== null || sensitive.pending !== null, editing, onBusyChange, onEditingChange);

  function startEditing() {
    sensitive.close();
    onEditingChange(true);
    setEditing(true);
  }

  function closeEditor() {
    setEditing(false);
    onEditingChange(false);
    section.current?.focus();
  }

  return (
    <div className="facts-ask__item">
      {editing ? (
        <FactEditor fact={fact} roles={roles} reload={reload} onClose={closeEditor} />
      ) : (
        <p className="facts-ask__text" id={textId}>
          {factText(fact)}
        </p>
      )}
      <FactMeta fact={fact} />
      <FactHints fact={fact} role={role} where="question" />
      <FactEvidence fact={fact} filenames={filenames} showSource={false} />
      <DuplicatesNote count={duplicates.length} />
      {!editing && <CopyControls items={[fact, ...duplicates]} filenames={filenames} reload={reload} disabled={review.deciding !== null || sensitive.pending !== null} />}
      {duplicates.map((copy) => (
        <FactEvidence key={copy.id} fact={copy} filenames={filenames} showSource={copy.sourceId !== fact.sourceId} />
      ))}
      {!editing && (
        <ReviewButtons
          state={fact.state}
          describedBy={textId}
          review={review}
          onEdit={startEditing}
          confirmDisabled={roleRejected}
          disabled={sensitive.pending !== null}
          showKeys
          large
        />
      )}
      {!editing && (
        <MoreChoices control={sensitive} marked={fact.sensitive === true} describedBy={textId} disabled={review.deciding !== null} />
      )}
      <ActionError message={review.error} />
      <ActionError message={sensitive.error} />
    </div>
  );
}

export function RoleQuestion({ question, filenames, reload, section, textId, onEditingChange, onBusyChange }: ItemProps & { question: RoleQuestionData }) {
  const { role, duplicates, proposedUnder } = question;
  const [editing, setEditing] = useState(false);
  const [askingReject, setAskingReject] = useState(false);
  const item = useRef<HTMLDivElement>(null);
  const review = useReview(role.id, reload, section, role.revision ?? 1, duplicates);
  useReport(review.deciding !== null, editing, onBusyChange, onEditingChange);
  // Leaving out a role also leaves out every fact still to check under it, so it asks first.
  const askFirst = proposedUnder > 0;
  const range = formatDateRange(role.startDate, role.endDate, role.unknownEndStartDate);

  function startEditing() {
    setAskingReject(false);
    onEditingChange(true);
    setEditing(true);
  }

  function closeEditor() {
    setEditing(false);
    onEditingChange(false);
    section.current?.focus();
  }

  function cancelReject() {
    setAskingReject(false);
    item.current?.querySelector<HTMLButtonElement>("[data-review-action='reject']")?.focus();
  }

  function reject() {
    setAskingReject(false);
    void review.decide("reject");
  }

  return (
    <div className="facts-ask__item" ref={item}>
      {editing ? (
        <RoleForm role={role} reload={reload} onClose={closeEditor} />
      ) : (
        <p className="facts-ask__text" id={textId}>
          {roleText(role)}
        </p>
      )}
      <p className="rs-fact__meta">
        <span>{ROLE_KIND_LABEL[role.kind]}</span>
        {range && <span>{range}</span>}
      </p>
      {role.quote && <Quote text={role.quote} caption={`From ${sourceLabel(filenames, role.sourceId)}`} />}
      {duplicates.length > 0 && (
        <p className="meta">
          This role also appears in {duplicates.length} other {duplicates.length === 1 ? "record" : "records"}. Your
          answer applies to every copy shown; Fix it changes this copy only.
        </p>
      )}
      {duplicates.map(
        (copy) =>
          copy.quote && (
            <div key={copy.id}>
              <Quote text={copy.quote} caption={`From ${sourceLabel(filenames, copy.sourceId)}`} />
              {copy.sourceId !== role.sourceId && copy.sourceId && copy.span && (
                <SourceEvidence sourceId={copy.sourceId} quote={copy.quote} span={copy.span} />
              )}
            </div>
          ),
      )}
      {!editing && <CopyControls items={[role, ...duplicates]} filenames={filenames} reload={reload} disabled={review.deciding !== null} />}
      {!editing && (
        <ReviewButtons
          state={role.state}
          describedBy={textId}
          review={review}
          onEdit={startEditing}
          onReject={askFirst ? () => setAskingReject(true) : undefined}
          rejectExpanded={askingReject}
          showKeys
          large
        />
      )}
      {askingReject && !editing && (
        <RoleRejectWell
          org={role.org}
          proposedUnder={proposedUnder}
          rejecting={proposedUnder + 1 + duplicates.length}
          disabled={review.deciding !== null}
          onYes={reject}
          onCancel={cancelReject}
        />
      )}
      <ActionError message={review.error} />
    </div>
  );
}
