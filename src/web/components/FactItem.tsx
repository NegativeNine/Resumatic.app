import { useId, useRef, useState } from "react";
import {
  MAX_FACT_CHARS,
  LEVELS,
  type FactPatch,
  type FactView,
  type Level,
  type RoleView,
} from "../../shared/api";
import { cleanExtractedText } from "../../shared/clean";
import { api, ApiError } from "../api";
import { factWriteObserved } from "../fact-save";
import { FACT_KIND_LABEL, LEVEL_LABEL } from "../format";
import { useAction, type Reload } from "../hooks";
import { href } from "../router";
import { groupFacts, roleLabel, sourceLabel } from "../vault";
import { ReviewButtons, useReview } from "./ReviewButtons";
import { useQueueItem } from "./ReviewQueue";
import { PRIVATE_HINT, SensitiveButton, SensitiveWell, useSensitive } from "./SensitiveControl";
import { CopyControls } from "./CopyControls";
import { SourceEvidence } from "./SourceEvidence";
import { ActionError, Badge, CharCount, Quote, REVIEW_TICK, Tick, type TickState } from "./ui";

interface Props {
  facts: FactView[];
  /** rs-facts on its own, rs-role__facts under a role. */
  className?: string;
  /** Every role, so a fact can be moved to another one. */
  roles: RoleView[];
  filenames: ReadonlyMap<string, string>;
  reload: Reload;
  reviewLocked: boolean;
  onEditingChange: (id: string, active: boolean) => void;
  equivalentRoles?: ReadonlySet<string>;
}

export function FactList({ facts, className = "rs-facts", roles, filenames, reload, reviewLocked, onEditingChange, equivalentRoles }: Props) {
  return (
    <ul className={className}>
      {groupFacts(facts, equivalentRoles).map(([fact, ...duplicates]) => fact && (
        <FactItem
          key={fact.id}
          fact={fact}
          duplicates={duplicates}
          roles={roles}
          filenames={filenames}
          reload={reload}
          reviewLocked={reviewLocked}
          onEditingChange={onEditingChange}
        />
      ))}
    </ul>
  );
}

function FactItem({
  fact,
  duplicates,
  roles,
  filenames,
  reload,
  reviewLocked,
  onEditingChange,
}: { fact: FactView; duplicates: FactView[] } & Omit<Props, "facts" | "className">) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  const review = useReview(fact.id, reload, ref, fact.revision ?? 1, duplicates);
  const sensitive = useSensitive(fact, duplicates, reload);
  const textId = useId();
  const role = roles.find((item) => item.id === fact.roleId) ?? null;
  const roleRejected = role?.state === "rejected";

  function closeEditor() {
    setEditing(false);
    onEditingChange(`fact:${fact.id}`, false);
    ref.current?.focus();
  }

  function startEditing() {
    sensitive.close();
    onEditingChange(`fact:${fact.id}`, true);
    setEditing(true);
  }

  const busy = review.deciding !== null || reviewLocked || sensitive.pending !== null;
  // A fact left out is used for nothing already, so it shows its mark and offers no control.
  const canMark = fact.state !== "rejected";
  const active = useQueueItem(fact.id, {
    confirm: fact.state !== "confirmed" && !roleRejected && !busy ? () => void review.decide("confirm") : undefined,
    edit: fact.state !== "rejected" && !editing && !busy ? startEditing : undefined,
    reject: fact.state !== "rejected" && !busy ? () => void review.decide("reject") : undefined,
  });
  // An amber dot while it waits for the person, a green check once it is confirmed. A fact they
  // wrote says so in its Added by you mark.
  const tick: TickState =
    review.deciding === "confirm" ? "backed" : review.deciding === "reject" ? "left-out" : REVIEW_TICK[fact.state];
  const classes = ["rs-fact", fact.state === "rejected" ? "rs-fact--rejected" : "", active ? "is-active" : ""];

  return (
    <li className={classes.filter(Boolean).join(" ")} ref={ref} tabIndex={-1} data-queue-item={fact.id}>
      <Tick state={tick} />
      <div className="rs-fact__body">
      {editing ? (
        <FactEditor
          fact={fact}
          roles={roles}
          reload={reload}
          onClose={closeEditor}
        />
      ) : (
        <p className="rs-fact__text" id={textId}>
          {fact.origin === "extracted" ? cleanExtractedText(fact.text) : fact.text}
        </p>
      )}
      <FactMeta fact={fact} />
      <FactHints fact={fact} role={role} where="list" />
      <FactEvidence fact={fact} filenames={filenames} />
      <DuplicatesNote count={duplicates.length} />
      {!editing && <CopyControls items={[fact, ...duplicates]} filenames={filenames} reload={reload} disabled={busy} />}
      {duplicates.map((copy) => <FactEvidence key={copy.id} fact={copy} filenames={filenames} />)}
      {!editing && (
        <ReviewButtons
          state={fact.state}
          describedBy={textId}
          review={review}
          confirmDisabled={roleRejected}
          disabled={reviewLocked || sensitive.pending !== null}
          onEdit={fact.state === "rejected" ? undefined : startEditing}
          showKeys={active}
          extra={
            canMark ? (
              <SensitiveButton
                control={sensitive}
                marked={fact.sensitive === true}
                describedBy={textId}
                disabled={reviewLocked || review.deciding !== null}
              />
            ) : undefined
          }
        />
      )}
      {!editing && canMark && <SensitiveWell control={sensitive} disabled={reviewLocked || review.deciding !== null} />}
      <ActionError message={review.error} />
      <ActionError message={sensitive.error} />
      </div>
    </li>
  );
}

/** What kind of fact it is, and the marks that say how it stands: Added by you, Private, Read from an image, Check closely. */
export function FactMeta({ fact }: { fact: FactView }) {
  return (
    <p className="rs-fact__meta">
      <span>{FACT_KIND_LABEL[fact.kind]}</span>
      {fact.level && <span>Level: {LEVEL_LABEL[fact.level]}</span>}
      {fact.origin === "user" && <Badge tone="note">Added by you</Badge>}
      {fact.sensitive && <Badge tone="note">Private</Badge>}
      {fact.evidenceOrigin === "ocr" && <Badge tone="note">Read from an image</Badge>}
      {fact.reviewReasons?.length || (fact.confidence != null && fact.confidence < 0.8) ? (
        <Badge tone="needs-you">Check closely</Badge>
      ) : null}
    </p>
  );
}

/**
 * What a person should know before answering: an image's misreadings, what keeping it private
 * does, a level to confirm again, and a role that keeps the fact from use. In the list a left-out
 * role is put back from its own buttons; the question on To check points to where that is done.
 */
export function FactHints({ fact, role, where }: { fact: FactView; role: RoleView | null; where: "list" | "question" }) {
  const roleRejected = role?.state === "rejected";
  return (
    <>
      {fact.evidenceOrigin === "ocr" && (
        <p className="hint">
          Compare this fact with your original PDF. Image reading can misread
          words and numbers.
        </p>
      )}
      {fact.sensitive && fact.state !== "rejected" && <p className="hint">{PRIVATE_HINT}</p>}
      {fact.levelNeedsReview && (
        <p className="hint">The earlier ownership level{fact.previousLevel ? ` (${LEVEL_LABEL[fact.previousLevel]})` : ""} needs your confirmation before it is used.</p>
      )}
      {roleRejected &&
        (where === "question" ? (
          <p className="hint">
            This fact can’t be used while its role is left out. To use it, open <a href={href.factsAll}>All facts</a>,
            choose Left out and say “That’s right” to the role.
          </p>
        ) : (
          <p className="hint">This fact can’t be used while its role is left out. Say “That’s right” to the role to use it.</p>
        ))}
      {role?.state === "proposed" && fact.state === "confirmed" && (
        <p className="hint">This fact can’t be used until its role is confirmed.</p>
      )}
      {fact.reviewReasons?.includes("strategy_disagreement") && (
        <p className="hint">
          This passage was interpreted differently on a second reading. Check
          its wording and role before confirming.
        </p>
      )}
    </>
  );
}

/** Said under a fact shown with copies read from other files. */
export function DuplicatesNote({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <p className="meta">
      This fact also appears in {count} other {count === 1 ? "record" : "records"}. Your answer applies to every copy
      shown; Fix it changes this copy only.
    </p>
  );
}

/**
 * The words a fact came from: its quote and the file it is in, the answer it was written from, or
 * that the person wrote it. `showSource` offers the file's text around the quote; the question on
 * To check leaves it out for a copy in the file already open beside it.
 */
export function FactEvidence({
  fact,
  filenames,
  showSource = true,
}: {
  fact: FactView;
  filenames: ReadonlyMap<string, string>;
  showSource?: boolean;
}) {
  if (fact.interview)
    return (
      <>
        <p className="meta">Your answer to: {fact.interview.question}</p>
        <Quote
          text={fact.interview.quote}
          caption="Your original interview answer"
        />
      </>
    );
  if (!fact.quote) {
    return fact.origin === "user" ? (
      <p className="meta">
        You wrote this yourself, so no file backs it.
      </p>
    ) : null;
  }
  const from = sourceLabel(filenames, fact.sourceId);
  const caption =
    fact.origin === "user"
      ? `The original words from ${from}, before your change`
      : `From ${from}`;
  return (
    <>
      <Quote text={fact.quote} caption={caption} />
      {showSource && fact.sourceId && fact.span && (
        <SourceEvidence
          key={`${fact.sourceId}:${fact.span.join(":")}:${fact.quote}`}
          sourceId={fact.sourceId}
          quote={fact.quote}
          span={fact.span}
        />
      )}
    </>
  );
}

/** A fact's editor: its words, its role and its level, saved against the revision it opened at. */
export function FactEditor(props: {
  fact: FactView;
  roles: RoleView[];
  reload: Reload;
  onClose: () => void;
}) {
  const { fact, roles, reload, onClose } = props;
  // Keep the editor's base values fixed even when a background refresh arrives.
  const [original] = useState(fact);
  const [text, setText] = useState(fact.origin === "extracted" ? cleanExtractedText(fact.text) : fact.text);
  const [roleId, setRoleId] = useState(fact.roleId ?? "");
  const [level, setLevel] = useState<Level | "">(fact.level ?? "");
  const [levelTouched, setLevelTouched] = useState(false);
  const [baseRevision] = useState(original.revision ?? 1);
  const { run, pending, error } = useAction();
  const id = useId();
  const trimmed = text.trim();
  const choices = roles.filter(
    (r) => r.state !== "rejected" || r.id === original.roleId,
  );
  const patch: FactPatch = { expectedRevision: baseRevision };
  if (trimmed !== original.text) patch.text = trimmed;
  if ((roleId || null) !== original.roleId) patch.roleId = roleId || null;
  if (levelTouched) patch.level = level || null;
  const changed = patch.text !== undefined || patch.roleId !== undefined || patch.level !== undefined;

  async function save() {
    const ok = await run(async () => {
      try {
        await api.editFact(original.id, patch);
      } catch (error) {
        // A response can be lost after the write. Confirm a fresh snapshot at
        // exactly the next revision before treating an error as success.
        if (error instanceof ApiError && (error.status === 401 || error.status === 410)) throw error;
        let current: FactView | undefined;
        try {
          current = (await api.reviewView()).facts.find((item) => item.id === original.id);
        } catch (readError) {
          if (readError instanceof ApiError && (readError.status === 401 || readError.status === 410)) throw readError;
          throw error;
        }
        if (!factWriteObserved(current, original, patch)) throw error;
      }
      await reload();
    });
    if (ok) onClose();
  }

  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        // Escape cancels the edit; the caller returns focus to the fact or the question.
        if (e.key === "Escape" && !pending) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <label htmlFor={id}>Fact</label>
      <textarea
        id={id}
        rows={3}
        value={text}
        disabled={pending}
        onChange={(e) => setText(e.target.value)}
        aria-describedby={original.sensitive ? `${id}-note ${id}-sensitive ${id}-count` : `${id}-note ${id}-count`}
        autoFocus
      />
      <CharCount
        id={`${id}-count`}
        length={trimmed.length}
        max={MAX_FACT_CHARS}
      />
      <label htmlFor={`${id}-role`}>Role</label>
      <select
        id={`${id}-role`}
        value={roleId}
        disabled={pending}
        onChange={(e) => setRoleId(e.target.value)}
      >
        <option value="">No role</option>
        {choices.map((r) => (
          <option key={r.id} value={r.id}>
            {roleLabel(r)}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-level`}>Ownership level (optional)</label>
      <select id={`${id}-level`} value={level} disabled={pending} onChange={(e) => {
        setLevel(e.target.value as Level | "");
        setLevelTouched(true);
      }}>
        <option value="">Not specified</option>
        {LEVELS.map((value) => <option key={value} value={value}>{LEVEL_LABEL[value]}</option>)}
      </select>
      {trimmed !== original.text && level && (
        <label>
          <input type="checkbox" checked={levelTouched} disabled={pending} onChange={(e) => setLevelTouched(e.target.checked)} />{" "}
          Use this level for the updated wording
        </label>
      )}
      <p className="hint" id={`${id}-note`}>
        An edited or moved fact is marked Added by you: resumes use your wording
        and role, and the original quote stays beside it for reference. Changing
        the wording clears its prior level unless you choose a level again. Only write what’s true.
      </p>
      {original.sensitive && (
        <p className="hint" id={`${id}-sensitive`}>
          This fact stays private after you save. To use a different wording, add it as a new fact and keep this
          one private.
        </p>
      )}
      <div className="actions">
        <button
          type="submit"
          className="primary small"
          disabled={
            pending || !trimmed || trimmed.length > MAX_FACT_CHARS || !changed
          }
        >
          {pending ? "Saving…" : "Save fact"}
        </button>
        <button
          type="button"
          className="small"
          onClick={onClose}
          disabled={pending}
        >
          Cancel
        </button>
      </div>
      <ActionError message={error} />
    </form>
  );
}
