import { useId, useState } from "react";
import { ROLE_KINDS, type RoleKind, type RoleView } from "../../shared/api";
import { api } from "../api";
import { ROLE_KIND_LABEL } from "../format";
import { useAction, type Reload } from "../hooks";
import { ActionError, Field } from "./ui";

export function RoleForm({ role, reload, onClose }: { role: RoleView; reload: Reload; onClose: () => void }) {
  const [kind, setKind] = useState<RoleKind>(role.kind);
  const [org, setOrg] = useState(role.org);
  const [title, setTitle] = useState(role.title ?? "");
  const [start, setStart] = useState(role.startDate ?? "");
  const [end, setEnd] = useState(role.endDate ?? "");
  const { run, pending, error } = useAction();
  const id = useId();

  async function save() {
    const ok = await run(async () => {
      await api.updateRole(role.id, {
        kind,
        org: org.trim(),
        title: title.trim() || null,
        startDate: start.trim() || null,
        endDate: end.trim() || null,
      });
      await reload();
    });
    if (ok) onClose();
  }

  return (
    <form
      className="inline-form"
      aria-label={`Edit ${role.org}`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="field-grid">
        <Field id={`${id}-org`} label="Organization">
          <input id={`${id}-org`} type="text" value={org} onChange={(e) => setOrg(e.target.value)} required autoFocus />
        </Field>
        <Field id={`${id}-title`} label="Title (optional)">
          <input id={`${id}-title`} type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field id={`${id}-kind`} label="Kind">
          <select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as RoleKind)}>
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
        Use year and month, such as 2021-03. Leave the end date empty if you're still there.
      </p>
      <div className="actions">
        <button type="submit" className="primary small" disabled={pending || !org.trim()}>
          {pending ? "Saving…" : "Save role"}
        </button>
        <button type="button" className="small" onClick={onClose} disabled={pending}>
          Cancel
        </button>
      </div>
      <ActionError message={error} />
    </form>
  );
}
