import { useId, useState } from "react";
import { ROLE_KINDS, type RoleKind, type RoleView } from "../../shared/api";
import { api } from "../api";
import { ROLE_KIND_LABEL } from "../format";
import { useAction, type Reload } from "../hooks";
import { ActionError, Field } from "./ui";

interface Props {
  /** The role to edit; without one, the form adds a new role. */
  role?: RoleView;
  reload: Reload;
  onClose: () => void;
  /** Called with the new role's ID after an add. */
  onAdded?: (roleId: string) => void;
}

export function RoleForm({ role, reload, onClose, onAdded }: Props) {
  const [kind, setKind] = useState<RoleKind>(role?.kind ?? "job");
  const [org, setOrg] = useState(role?.org ?? "");
  const [title, setTitle] = useState(role?.title ?? "");
  const [start, setStart] = useState(role?.startDate ?? "");
  const [end, setEnd] = useState(role?.endDate ?? "");
  const [baseRevision] = useState(role?.revision ?? 1);
  const { run, pending, error } = useAction();
  const id = useId();

  async function save() {
    const fields = {
      kind,
      org: org.trim(),
      title: title.trim() || null,
      startDate: start.trim() || null,
      endDate: end.trim() || null,
    };
    let added: string | null = null;
    const ok = await run(async () => {
      if (role)
        await api.updateRole(role.id, {
          ...fields,
          expectedRevision: baseRevision,
        });
      else added = (await api.addRole(fields)).roleId;
      await reload();
    });
    if (!ok) return;
    if (added) onAdded?.(added);
    onClose();
  }

  return (
    <form
      className={role ? "inline-form" : "card inline-form add-fact-form"}
      aria-label={role ? `Edit ${role.org}` : "Add a role"}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {!role && (
        <p className="meta">
          Add a job, degree, project or volunteer role your uploads missed. It's
          your own claim, so it has no source quote, and it's confirmed straight
          away.
        </p>
      )}
      <div className="field-grid">
        <Field id={`${id}-org`} label="Organization">
          <input
            id={`${id}-org`}
            type="text"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            required
            autoFocus
          />
        </Field>
        <Field id={`${id}-title`} label="Title (optional)">
          <input
            id={`${id}-title`}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field id={`${id}-kind`} label="Kind">
          <select
            id={`${id}-kind`}
            value={kind}
            onChange={(e) => setKind(e.target.value as RoleKind)}
          >
            {ROLE_KINDS.map((k) => (
              <option key={k} value={k}>
                {ROLE_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${id}-start`} label="Start date">
          <input
            id={`${id}-start`}
            type="text"
            value={start}
            placeholder="2021-03"
            onChange={(e) => setStart(e.target.value)}
            aria-describedby={`${id}-dates`}
          />
        </Field>
        <Field id={`${id}-end`} label="End date">
          <input
            id={`${id}-end`}
            type="text"
            value={end}
            placeholder="Empty if current"
            onChange={(e) => setEnd(e.target.value)}
            aria-describedby={`${id}-dates`}
          />
        </Field>
      </div>
      <p className="hint" id={`${id}-dates`}>
        Use year and month, such as 2021-03. Leave the end date empty if you're
        still there.
      </p>
      <div className="actions">
        <button
          type="submit"
          className="primary small"
          disabled={pending || !org.trim()}
        >
          {pending ? "Saving…" : role ? "Save role" : "Add role"}
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
