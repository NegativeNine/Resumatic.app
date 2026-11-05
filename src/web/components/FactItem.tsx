import { useId, useRef, useState } from "react";
import { MAX_FACT_CHARS, type FactView } from "../../shared/api";
import { api } from "../api";
import { FACT_KIND_LABEL, LEVEL_LABEL } from "../format";
import { useAction, type Reload } from "../hooks";
import { sourceLabel } from "../vault";
import { ReviewButtons, useReview } from "./ReviewButtons";
import { ActionError, Badge, CharCount, Quote } from "./ui";

interface Props {
  facts: FactView[];
  filenames: ReadonlyMap<string, string>;
  reload: Reload;
}

export function FactList({ facts, filenames, reload }: Props) {
  return (
    <ul className="plain-list facts">
      {facts.map((fact) => (
        <FactItem key={fact.id} fact={fact} filenames={filenames} reload={reload} />
      ))}
    </ul>
  );
}

function FactItem({ fact, filenames, reload }: { fact: FactView } & Omit<Props, "facts">) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  const review = useReview(fact.id, reload, ref);
  const textId = useId();

  function closeEditor() {
    setEditing(false);
    ref.current?.focus();
  }

  return (
    <li className="fact" ref={ref} tabIndex={-1}>
      {editing ? (
        <FactEditor fact={fact} reload={reload} onClose={closeEditor} />
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
      </p>
      <FactEvidence fact={fact} filenames={filenames} />
      {!editing && (
        <ReviewButtons
          state={fact.state}
          describedBy={textId}
          review={review}
          onEdit={fact.state === "rejected" ? undefined : () => setEditing(true)}
        />
      )}
      <ActionError message={review.error} />
    </li>
  );
}

function FactEvidence({ fact, filenames }: { fact: FactView; filenames: ReadonlyMap<string, string> }) {
  if (!fact.quote) {
    return fact.origin === "user" ? <p className="meta">You added this yourself, so it has no source quote.</p> : null;
  }
  const from = sourceLabel(filenames, fact.sourceId);
  const caption = fact.origin === "user" ? `The original quote from ${from}, before your edit` : `From ${from}`;
  return <Quote text={fact.quote} caption={caption} />;
}

function FactEditor({ fact, reload, onClose }: { fact: FactView; reload: Reload; onClose: () => void }) {
  const [text, setText] = useState(fact.text);
  const { run, pending, error } = useAction();
  const id = useId();
  const trimmed = text.trim();

  async function save() {
    const ok = await run(async () => {
      await api.editFact(fact.id, trimmed);
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
        onChange={(e) => setText(e.target.value)}
        aria-describedby={`${id}-note ${id}-count`}
        autoFocus
      />
      <CharCount id={`${id}-count`} length={trimmed.length} max={MAX_FACT_CHARS} />
      <p className="hint" id={`${id}-note`}>
        An edited fact becomes your own claim: resumes use your wording, and the original quote stays beside it for
        reference. Only write what's true.
      </p>
      <div className="actions">
        <button
          type="submit"
          className="primary small"
          disabled={pending || !trimmed || trimmed.length > MAX_FACT_CHARS || trimmed === fact.text}
        >
          {pending ? "Saving…" : "Save fact"}
        </button>
        <button type="button" className="small" onClick={onClose} disabled={pending}>
          Cancel
        </button>
      </div>
      <ActionError message={error} />
    </form>
  );
}
