import { useId, useRef, useState } from "react";
import { MAX_LINE_CHARS, type ResumeLine, type ResumeView } from "../../shared/api";
import { api } from "../api";
import { count, LINE_STATUS_HINT, LINE_STATUS_LABEL } from "../format";
import { useAction, type Reload } from "../hooks";
import { ActionError, Badge, CharCount, Quote } from "./ui";

type CitedFact = { id: string; text: string; quote: string | null };

interface Props {
  resumeId: string;
  line: ResumeLine;
  facts: ResumeView["facts"];
  expanded: boolean;
  onToggle: (lineId: string) => void;
  reload: Reload;
}

/** One resume line, with its status and, on request, the facts and quotes it cites. */
export function LineItem({ resumeId, line, facts, expanded, onToggle, reload }: Props) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  const id = useId();
  const cited: CitedFact[] = line.factIds.flatMap((factId) => (facts[factId] ? [{ id: factId, ...facts[factId] }] : []));

  function closeEditor() {
    setEditing(false);
    ref.current?.focus();
  }

  return (
    <li className="line" ref={ref} tabIndex={-1}>
      {editing ? (
        <LineEditor resumeId={resumeId} line={line} reload={reload} onClose={closeEditor} />
      ) : (
        <p className="line-text" id={`${id}-text`}>
          {line.text}
        </p>
      )}
      <div className="line-tools">
        <Badge tone={line.status} title={LINE_STATUS_HINT[line.status]}>
          {LINE_STATUS_LABEL[line.status]}
        </Badge>
        <button
          type="button"
          className="link-button"
          aria-expanded={expanded}
          aria-controls={`${id}-evidence`}
          aria-describedby={editing ? undefined : `${id}-text`}
          onClick={() => onToggle(line.id)}
        >
          {expanded ? "Hide evidence" : `Show evidence (${count(cited.length, "fact")})`}
        </button>
        {!editing && (
          <button type="button" className="link-button" aria-describedby={`${id}-text`} onClick={() => setEditing(true)}>
            Edit line
          </button>
        )}
      </div>
      <div className="evidence" id={`${id}-evidence`} hidden={!expanded}>
        <Evidence facts={cited} />
      </div>
    </li>
  );
}

function Evidence({ facts }: { facts: CitedFact[] }) {
  if (facts.length === 0) return <p className="meta">This line doesn't cite any facts.</p>;
  return (
    <ul className="plain-list">
      {facts.map((fact) => (
        <li key={fact.id} className="evidence-item">
          <p className="evidence-label">Fact</p>
          <p>{fact.text}</p>
          {fact.quote ? (
            <Quote text={fact.quote} caption="The words it came from" />
          ) : (
            <p className="meta">Your own claim, with no source quote.</p>
          )}
        </li>
      ))}
    </ul>
  );
}

function LineEditor({ resumeId, line, reload, onClose }: { resumeId: string; line: ResumeLine; reload: Reload; onClose: () => void }) {
  const [text, setText] = useState(line.text);
  const { run, pending, error } = useAction();
  const id = useId();
  const trimmed = text.trim();

  async function save() {
    const ok = await run(async () => {
      await api.editLine(resumeId, line.id, trimmed);
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
      <label htmlFor={id}>Line</label>
      <textarea
        id={id}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-describedby={`${id}-note ${id}-count`}
        autoFocus
      />
      <CharCount id={`${id}-count`} length={trimmed.length} max={MAX_LINE_CHARS} />
      <p className="hint" id={`${id}-note`}>
        Your wording replaces the checked line, and the line is marked Edited. Keep it true to the facts it cites.
      </p>
      <div className="actions">
        <button
          type="submit"
          className="primary small"
          disabled={pending || !trimmed || trimmed.length > MAX_LINE_CHARS || trimmed === line.text}
        >
          {pending ? "Saving…" : "Save line"}
        </button>
        <button type="button" className="small" onClick={onClose} disabled={pending}>
          Cancel
        </button>
      </div>
      <ActionError message={error} />
    </form>
  );
}
