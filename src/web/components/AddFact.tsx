import { useId, useRef, useState } from "react";
import { FACT_KINDS, LEVELS, MAX_FACT_CHARS, type FactKind, type Level, type RoleView } from "../../shared/api";
import { api } from "../api";
import { FACT_KIND_LABEL, LEVEL_LABEL } from "../format";
import { useAction, type Action } from "../hooks";
import { roleLabel } from "../vault";
import { ActionError, CharCount, Field } from "./ui";

interface Props {
  roles: RoleView[];
  onAdded: (factId: string) => Promise<void>;
}

export function AddFact({ roles, onAdded }: Props) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const formId = useId();
  const action = useAction();

  function close() {
    setOpen(false);
    toggle.current?.focus();
  }

  return (
    <div className="add-fact">
      <button ref={toggle} type="button" aria-expanded={open} aria-controls={formId} disabled={action.pending} onClick={() => setOpen(!open)}>
        Add a fact yourself
      </button>
      {open && <AddFactForm id={formId} roles={roles} onAdded={onAdded} onClose={close} action={action} />}
    </div>
  );
}

function AddFactForm({ id, roles, onAdded, onClose, action }: Props & { id: string; onClose: () => void; action: Action }) {
  const [roleId, setRoleId] = useState("");
  const [kind, setKind] = useState<FactKind>("accomplishment");
  const [level, setLevel] = useState<Level | "">("");
  const [text, setText] = useState("");
  const [added, setAdded] = useState(false);
  const { run, pending, error } = action;
  const trimmed = text.trim();
  const choices = roles.filter((r) => r.state !== "rejected");

  async function add() {
    setAdded(false);
    const ok = await run(async () => {
      const { factId } = await api.addFact({ roleId: roleId || null, kind, text: trimmed, level: level || null });
      setText("");
      await onAdded(factId);
    });
    if (ok) setAdded(true);
  }

  return (
    <form
      id={id}
      className="card inline-form add-fact-form"
      aria-label="Add a fact"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <p className="meta">
        Add something true that your files missed. A fact you add is marked Added by you, so no file backs it.
      </p>
      <div className="field-grid">
        <Field id={`${id}-role`} label="Role">
          <select id={`${id}-role`} value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={pending} autoFocus>
            <option value="">No role (a general skill or credential)</option>
            {choices.map((r) => (
              <option key={r.id} value={r.id}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${id}-kind`} label="Kind">
          <select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as FactKind)} disabled={pending}>
            {FACT_KINDS.map((k) => (
              <option key={k} value={k}>
                {FACT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${id}-level`} label="Level (optional)" hint="How much of the work was yours.">
          <select
            id={`${id}-level`}
            value={level}
            disabled={pending}
            onChange={(e) => setLevel(e.target.value as Level | "")}
            aria-describedby={`${id}-level-hint`}
          >
            <option value="">Not specified</option>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {LEVEL_LABEL[l]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field id={`${id}-text`} label="Fact">
        <textarea
          id={`${id}-text`}
          rows={3}
          value={text}
          disabled={pending}
          placeholder="Write it as you’d want it on a resume."
          onChange={(e) => {
            setText(e.target.value);
            setAdded(false);
          }}
          aria-describedby={`${id}-count`}
        />
      </Field>
      <CharCount id={`${id}-count`} length={trimmed.length} max={MAX_FACT_CHARS} />
      <div className="actions">
        <button type="submit" className="primary" disabled={pending || !trimmed || trimmed.length > MAX_FACT_CHARS}>
          {pending ? "Adding…" : "Add fact"}
        </button>
        <button type="button" onClick={onClose} disabled={pending}>
          Close
        </button>
      </div>
      {added && (
        <p className="success" role="status">
          Fact added.
        </p>
      )}
      <ActionError message={error} />
    </form>
  );
}
