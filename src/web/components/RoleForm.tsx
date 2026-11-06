import { useId, useState } from "react";
import { ROLE_KINDS, type RoleKind, type RoleView } from "../../shared/api";
import { api } from "../api";
import { ROLE_KIND_LABEL } from "../format";
import { useAction, type Action, type Reload } from "../hooks";
import { useSession } from "../session";
import { ActionError, Field } from "./ui";

interface Props {
  /** The role to edit; without one, the form adds a new role. */
  role?: RoleView;
  reload: Reload;
  onClose: () => void;
  /** Called with the new role's ID after an add. */
  onAdded?: (roleId: string) => void;
  action?: Action;
}

export function RoleForm({ role, reload, onClose, onAdded, action }: Props) {
  const { me } = useSession();
  const allowUnknownEnd = me.capabilities?.roleDateUnknownEnd === true;
  const datesLocked = Boolean(role?.unknownEndStartDate && !allowUnknownEnd);
  const [kind, setKind] = useState<RoleKind>(role?.kind ?? "job");
  const [org, setOrg] = useState(role?.org ?? "");
  const [title, setTitle] = useState(role?.title ?? "");
  const [start, setStart] = useState(role?.unknownEndStartDate ?? role?.startDate ?? "");
  const [end, setEnd] = useState(role?.endDate ?? "");
  const [unknownEnd, setUnknownEnd] = useState(Boolean(role?.unknownEndStartDate));
  const [baseRevision] = useState(role?.revision ?? 1);
  const localAction = useAction();
  const { run, pending, error, setError } = action ?? localAction;
  const id = useId();

  async function save() {
    if (allowUnknownEnd && unknownEnd && !start.trim()) {
      setError("Enter the start date when the end date is unknown.");
      return;
    }
    const dateFields = datesLocked ? {} : allowUnknownEnd
      ? {
          startDate: unknownEnd ? null : start.trim() || null,
          endDate: unknownEnd ? null : end.trim() || null,
          unknownEndStartDate: unknownEnd ? start.trim() : null,
        }
      : { startDate: start.trim() || null, endDate: end.trim() || null };
    const fields = {
      kind,
      org: org.trim(),
      title: title.trim() || null,
      ...dateFields,
    };
    let added: string | null = null;
    const ok = await run(async () => {
      if (role) {
        const update = allowUnknownEnd ? api.updateRoleV2 : api.updateRole;
        await update(role.id, {
          ...fields,
          expectedRevision: baseRevision,
        });
      } else {
        const add = allowUnknownEnd ? api.addRoleV2 : api.addRole;
        // New-role date fields are always present; only existing unavailable
        // unknown-end dates lock their inputs and omit them from a patch.
        added = (await add(fields as Parameters<typeof api.addRole>[0])).roleId;
      }
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
            disabled={pending}
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
            disabled={pending}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field id={`${id}-kind`} label="Kind">
          <select
            id={`${id}-kind`}
            value={kind}
            disabled={pending}
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
            disabled={pending || datesLocked}
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
            disabled={pending || datesLocked || (allowUnknownEnd && unknownEnd)}
            aria-describedby={`${id}-dates`}
          />
        </Field>
      </div>
      {allowUnknownEnd && (
        <label>
          <input type="checkbox" checked={unknownEnd} disabled={pending} onChange={(e) => setUnknownEnd(e.target.checked)} />
          End date is unknown
        </label>
      )}
      <p className="hint" id={`${id}-dates`}>
        {datesLocked
          ? "The saved start date is preserved; date editing is temporarily unavailable."
          : allowUnknownEnd
            ? "Use year and month, such as 2021-03. Leave the end date empty if you're still there; select unknown when you don't know it."
            : "Use year and month, such as 2021-03. Leave the end date empty if you're still there."}
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
