import { useId, useState } from "react";
import { ROLE_KINDS, type RoleKind, type RoleView } from "../../shared/api";
import { api, ApiError } from "../api";
import { roleWriteObserved } from "../role-save";
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
  // Keep the submitted revision and date interpretation fixed while editing.
  const [original] = useState(role);
  const { me } = useSession();
  const allowUnknownEnd = me.capabilities?.roleDateUnknownEnd === true;
  const datesLocked = Boolean(original?.unknownEndStartDate && !allowUnknownEnd);
  const [kind, setKind] = useState<RoleKind>(original?.kind ?? "job");
  const [org, setOrg] = useState(original?.org ?? "");
  const [title, setTitle] = useState(original?.title ?? "");
  const [start, setStart] = useState(original?.unknownEndStartDate ?? original?.startDate ?? "");
  const [end, setEnd] = useState(original?.endDate ?? "");
  const [unknownEnd, setUnknownEnd] = useState(Boolean(original?.unknownEndStartDate));
  const [baseRevision] = useState(original?.revision ?? 1);
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
      if (original) {
        const update = allowUnknownEnd ? api.updateRoleV2 : api.updateRole;
        const patch = {
          ...fields,
          expectedRevision: baseRevision,
        };
        try {
          await update(original.id, patch);
        } catch (error) {
          if (error instanceof ApiError && (error.status === 401 || error.status === 410)) throw error;
          let current: RoleView | undefined;
          try { current = (await api.reviewView()).roles.find((item) => item.id === original.id); }
          catch (readError) {
            if (readError instanceof ApiError && (readError.status === 401 || readError.status === 410)) throw readError;
            throw error;
          }
          if (!roleWriteObserved(current, original, patch)) throw error;
        }
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
      onKeyDown={(e) => {
        // Escape cancels, as it does in a fact's editor; the caller returns focus.
        if (e.key === "Escape" && !pending) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {!role && (
        <p className="meta">
          Add a job, degree, project or volunteer role your files missed. It’s
          marked Added by you, so no file backs it, and it’s confirmed straight
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
            ? "Use year and month, such as 2021-03. Leave the end date empty if you’re still there; select unknown when you don’t know it."
            : "Use year and month, such as 2021-03. Leave the end date empty if you’re still there."}
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
