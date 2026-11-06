import { useId, useRef, useState } from "react";
import {
  MAX_FACT_CHARS,
  LEVELS,
  type FactPatch,
  type FactView,
  type Level,
  type RoleView,
} from "../../shared/api";
import { api } from "../api";
import { FACT_KIND_LABEL, LEVEL_LABEL } from "../format";
import { useAction, type Reload } from "../hooks";
import { roleLabel, sourceLabel } from "../vault";
import { ReviewButtons, useReview } from "./ReviewButtons";
import { SourceEvidence } from "./SourceEvidence";
import { ActionError, Badge, CharCount, Quote } from "./ui";

interface Props {
  facts: FactView[];
  /** Every role, so a fact can be moved to another one. */
  roles: RoleView[];
  filenames: ReadonlyMap<string, string>;
  reload: Reload;
}

export function FactList({ facts, roles, filenames, reload }: Props) {
  return (
    <ul className="plain-list facts">
      {facts.map((fact) => (
        <FactItem
          key={fact.id}
          fact={fact}
          roles={roles}
          filenames={filenames}
          reload={reload}
        />
      ))}
    </ul>
  );
}

function FactItem({
  fact,
  roles,
  filenames,
  reload,
}: { fact: FactView } & Omit<Props, "facts">) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  const review = useReview(fact.id, reload, ref, fact.revision ?? 1);
  const textId = useId();
  const role = roles.find((item) => item.id === fact.roleId);
  const roleRejected = role?.state === "rejected";

  function closeEditor() {
    setEditing(false);
    ref.current?.focus();
  }

  return (
    <li className="fact" ref={ref} tabIndex={-1}>
      {editing ? (
        <FactEditor
          fact={fact}
          roles={roles}
          reload={reload}
          onClose={closeEditor}
        />
      ) : (
        <p className="fact-text" id={textId}>
          {fact.text}
        </p>
      )}
      <p className="meta">
        {FACT_KIND_LABEL[fact.kind]}
        {fact.level && ` · Level: ${LEVEL_LABEL[fact.level]}`}
        {fact.origin === "user" && (
          <>
            {" · "}
            <Badge tone="mine">Your own claim</Badge>
          </>
        )}
        {fact.evidenceOrigin === "ocr" && (
          <>
            {" "}
            · <Badge tone="queued">Read from an image</Badge>
          </>
        )}
        {fact.reviewReasons?.length ||
        (fact.confidence != null && fact.confidence < 0.8) ? (
          <>
            {" "}
            · <Badge tone="proposed">Check closely</Badge>
          </>
        ) : null}
      </p>
      {fact.evidenceOrigin === "ocr" && (
        <p className="hint">
          Compare this fact with your original PDF. Image reading can misread
          words and numbers.
        </p>
      )}
      {fact.levelNeedsReview && (
        <p className="hint">The earlier ownership level{fact.previousLevel ? ` (${LEVEL_LABEL[fact.previousLevel]})` : ""} needs your confirmation before it is used.</p>
      )}
      {roleRejected && (
        <p className="hint">This fact can't be used while its role is rejected. Confirm the role to use it.</p>
      )}
      {role?.state === "proposed" && fact.state === "confirmed" && (
        <p className="hint">This fact can't be used until its role is confirmed.</p>
      )}
      {fact.reviewReasons?.includes("strategy_disagreement") && (
        <p className="hint">
          This passage was interpreted differently on a second reading. Check
          its wording and role before confirming.
        </p>
      )}
      <FactEvidence fact={fact} filenames={filenames} />
      {!editing && (
        <ReviewButtons
          state={fact.state}
          describedBy={textId}
          review={review}
          confirmDisabled={roleRejected}
          onEdit={
            fact.state === "rejected" ? undefined : () => setEditing(true)
          }
        />
      )}
      <ActionError message={review.error} />
    </li>
  );
}

function FactEvidence({
  fact,
  filenames,
}: {
  fact: FactView;
  filenames: ReadonlyMap<string, string>;
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
        You added this yourself, so it has no source quote.
      </p>
    ) : null;
  }
  const from = sourceLabel(filenames, fact.sourceId);
  const caption =
    fact.origin === "user"
      ? `The original quote from ${from}, before your edit`
      : `From ${from}`;
  return (
    <>
      <Quote text={fact.quote} caption={caption} />
      {fact.sourceId && fact.span && (
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

function FactEditor(props: {
  fact: FactView;
  roles: RoleView[];
  reload: Reload;
  onClose: () => void;
}) {
  const { fact, roles, reload, onClose } = props;
  const [text, setText] = useState(fact.text);
  const [roleId, setRoleId] = useState(fact.roleId ?? "");
  const [level, setLevel] = useState<Level | "">(fact.level ?? "");
  const [levelTouched, setLevelTouched] = useState(false);
  const [baseRevision] = useState(fact.revision ?? 1);
  const { run, pending, error } = useAction();
  const id = useId();
  const trimmed = text.trim();
  const choices = roles.filter(
    (r) => r.state !== "rejected" || r.id === fact.roleId,
  );
  const patch: FactPatch = { expectedRevision: baseRevision };
  if (trimmed !== fact.text) patch.text = trimmed;
  if ((roleId || null) !== fact.roleId) patch.roleId = roleId || null;
  if (levelTouched) patch.level = level || null;
  const changed = patch.text !== undefined || patch.roleId !== undefined || patch.level !== undefined;

  async function save() {
    const ok = await run(async () => {
      await api.editFact(fact.id, patch);
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
    >
      <label htmlFor={id}>Fact</label>
      <textarea
        id={id}
        rows={3}
        value={text}
        disabled={pending}
        onChange={(e) => setText(e.target.value)}
        aria-describedby={`${id}-note ${id}-count`}
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
      {trimmed !== fact.text && level && (
        <label>
          <input type="checkbox" checked={levelTouched} disabled={pending} onChange={(e) => setLevelTouched(e.target.checked)} />{" "}
          Use this level for the updated wording
        </label>
      )}
      <p className="hint" id={`${id}-note`}>
        An edited or moved fact becomes your own claim: resumes use your wording
        and role, and the original quote stays beside it for reference. Changing
        the wording clears its prior level unless you choose a level again. Only write what's true.
      </p>
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
