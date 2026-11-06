import { useId, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  APPLICATION_STATUSES,
  MAX_JD_CHARS,
  type ApplicationStatus,
  type ApplicationView,
} from "../../shared/api";
import { api } from "../api";
import {
  APPLICATION_LABELS,
  ApplicationWorkspace,
} from "../components/ApplicationWorkspace";
import {
  ActionError,
  Badge,
  CharCount,
  ErrorNote,
  Loading,
  PageHeader,
} from "../components/ui";
import { formatDate, formatDateTime, RESUME_STATE_LABEL } from "../format";
import { useAction, useResource, type Reload } from "../hooks";
import { href } from "../router";
import { useSession } from "../session";
import { quotaMessage, useTailor } from "../tailor";

const isTailoring = (data: { applications: ApplicationView[] }) =>
  data.applications.some((a) => a.resumes.some((r) => r.state === "running"));

export function ApplicationsPage() {
  const list = useResource(api.applications, isTailoring);
  const { quota } = useSession().me;
  const applications = [...(list.data?.applications ?? [])].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
  const [status, setStatus] = useState<ApplicationStatus | "all">("all");
  const [view, setView] = useState<"list" | "board">("list");
  const [openWorkspaces, setOpenWorkspaces] = useState<ReadonlySet<string>>(() => new Set());
  const filterId = useId();
  const statusOf = (application: ApplicationView) => application.status ?? "saved";
  const visible =
    status === "all"
      ? applications
      : applications.filter(
          (application) => statusOf(application) === status || openWorkspaces.has(application.id),
        );
  const visibleIds = new Set(visible.map((application) => application.id));
  const extraWorkspace = status !== "all" && visible.some((application) => statusOf(application) !== status);
  const columns = APPLICATION_STATUSES.filter(
    (value) => status === "all" || status === value || visible.some((application) => statusOf(application) === value),
  );
  function toggleWorkspace(id: string) {
    setOpenWorkspaces((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  // Keep one keyed parent for cards in both views. Moving a card to a new
  // board column or changing the filter must not unmount an open workspace.
  const content: ReactNode[] = [];
  if (view === "board") for (const [index, value] of columns.entries()) {
    content.push(<li className="application-column-heading" role="presentation" key={`column:${value}`} style={{ gridColumn: index + 1, gridRow: 1 }}>
      <h3 id={`${filterId}-column-${value}`}>{APPLICATION_LABELS[value]}</h3>
      {!visible.some((application) => statusOf(application) === value) && <p className="meta">No applications.</p>}
    </li>);
  }
  for (const application of applications) {
    const appStatus = statusOf(application);
    content.push(<ApplicationCard
      key={`application:${application.id}`}
      application={application}
      onSaved={list.reload}
      compact={view === "board"}
      hidden={!visibleIds.has(application.id)}
      open={openWorkspaces.has(application.id)}
      onToggleWorkspace={() => toggleWorkspace(application.id)}
      columnLabel={view === "board" && visibleIds.has(application.id) ? `${filterId}-column-${appStatus}` : undefined}
      style={view === "board" && visibleIds.has(application.id) ? { gridColumn: columns.indexOf(appStatus) + 1 } : undefined}
    />);
  }

  return (
    <>
      <PageHeader title="Applications">
        Paste a job description, then tailor a resume to it. Every line comes
        from facts you've confirmed under{" "}
        <a href={href.sources}>Sources & facts</a>.
      </PageHeader>
      {quota.used >= quota.limit && (
        <p className="notice">{quotaMessage(quota)}</p>
      )}

      <section className="section" aria-labelledby="job-heading">
        <h2 id="job-heading">Add a job</h2>
        <JobForm onSaved={list.reload} />
      </section>

      <section className="section" aria-labelledby="applications-heading">
        <h2 id="applications-heading">Your applications</h2>
        {applications.length > 0 && (
          <div className="row-between">
            <div className="application-filter">
              <label htmlFor={filterId}>Application status</label>
              <select
                id={filterId}
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as ApplicationStatus | "all")
                }
              >
                <option value="all">
                  All applications ({applications.length})
                </option>
                {APPLICATION_STATUSES.map((value) => (
                  <option value={value} key={value}>
                    {APPLICATION_LABELS[value]} (
                    {
                      applications.filter(
                        (a) => (a.status ?? "saved") === value,
                      ).length
                    }
                    )
                  </option>
                ))}
              </select>
            </div>
            <div className="actions" role="group" aria-label="Application view">
              <button
                type="button"
                className="small"
                aria-pressed={view === "list"}
                onClick={() => setView("list")}
              >
                List
              </button>
              <button
                type="button"
                className="small"
                aria-pressed={view === "board"}
                onClick={() => setView("board")}
              >
                Board
              </button>
            </div>
          </div>
        )}
        {list.error && <ErrorNote message={list.error} onRetry={list.reload} />}
        {!list.data && !list.error && (
          <Loading>Loading your applications…</Loading>
        )}
        {extraWorkspace && <p className="hint" role="status">Open workspaces remain visible even when their status does not match the filter.</p>}
        {list.data &&
          (applications.length === 0 ? (
            <p className="empty">
              No applications yet. Paste a job description above to start your
              first one.
            </p>
          ) : (
            <>
              {visible.length === 0 && <p className="empty">No applications have this status yet.</p>}
              <div hidden={visible.length === 0} className={view === "board" ? "application-board-scroller" : undefined} role={view === "board" ? "region" : undefined}
                aria-label={view === "board" ? "Applications by status" : undefined} tabIndex={view === "board" ? 0 : undefined}>
                <ul className={`plain-list${view === "board" ? " application-board" : ""}`}
                  style={view === "board" ? { "--application-columns": columns.length } as CSSProperties : undefined}>
                  {content}
                </ul>
              </div>
            </>
          ))}
      </section>
    </>
  );
}

function JobForm({ onSaved }: { onSaved: Reload }) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  const { run, pending, error } = useAction();
  const id = useId();
  const length = text.trim().length;
  const tooLong = length > MAX_JD_CHARS;

  async function save() {
    setSaved(false);
    const ok = await run(async () => {
      await api.addApplication(text.trim());
      await onSaved();
    });
    if (ok) {
      setText("");
      setSaved(true);
    }
  }

  return (
    <form
      className="card"
      aria-busy={pending}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label htmlFor={id}>Job description</label>
      <p className="hint" id={`${id}-hint`}>
        Paste the whole posting, including the requirements.
      </p>
      <textarea
        id={id}
        rows={10}
        value={text}
        readOnly={pending}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        aria-describedby={`${id}-hint ${id}-count`}
        aria-invalid={tooLong}
      />
      <div className="row-between form-foot">
        <CharCount id={`${id}-count`} length={length} max={MAX_JD_CHARS} />
        <button
          type="submit"
          className="primary"
          disabled={pending || length < 40 || tooLong}
        >
          {pending ? "Saving…" : "Save job"}
        </button>
      </div>
      {saved && (
        <p className="success" role="status">
          Saved. Tailor a resume to it from the list below.
        </p>
      )}
      <ActionError message={error} />
    </form>
  );
}

function jobName({ title, company, excerpt }: ApplicationView): string {
  if (title && company) return `${title} at ${company}`;
  return title ?? company ?? (excerpt || "Untitled job");
}

function ApplicationCard({
  application,
  onSaved,
  compact = false,
  hidden,
  open,
  onToggleWorkspace,
  columnLabel,
  style,
}: {
  application: ApplicationView;
  onSaved: Reload;
  compact?: boolean;
  hidden: boolean;
  open: boolean;
  onToggleWorkspace: () => void;
  columnLabel?: string;
  style?: CSSProperties;
}) {
  const { tailor, pending, error } = useTailor();
  const headingId = useId();
  const resumes = [...application.resumes].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
  const unnamed = !application.title && !application.company;
  const Heading = compact ? "h4" : "h3";

  return (
    <li className="card application" hidden={hidden} style={style}
      aria-labelledby={columnLabel ? `${columnLabel} ${headingId}` : headingId}>
      <div className="row-between">
        <div>
          <Heading id={headingId}>{jobName(application)}</Heading>
          <p className="meta">
            Added {formatDate(application.createdAt)}
            {unnamed &&
              " · The title and company appear once a resume has been tailored"}
          </p>
          <Badge tone="mine">
            {APPLICATION_LABELS[application.status ?? "saved"]}
          </Badge>
        </div>
        <button
          type="button"
          className="primary"
          onClick={() => void tailor(application.id)}
          disabled={pending}
          aria-describedby={headingId}
        >
          {pending ? "Starting…" : "Tailor a resume"}
        </button>
      </div>
      <ActionError message={error} />
      {resumes.length === 0 ? (
        <p className="meta resume-list-empty">No resumes yet.</p>
      ) : (
        <ul className="plain-list resume-list">
          {resumes.map((resume) => (
            <li key={resume.id}>
              <a href={href.resume(resume.id)}>
                Resume tailored {formatDateTime(resume.createdAt)}
              </a>
              <Badge tone={resume.state}>
                {resume.state === "running" && resume.cancellationPending
                  ? "Cancellation pending"
                  : resume.state === "running" && resume.dispatchUncertain
                  ? "Start unconfirmed"
                  : RESUME_STATE_LABEL[resume.state]}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button
          type="button"
          className="small"
          aria-expanded={open}
          aria-controls={`${headingId}-workspace`}
          onClick={onToggleWorkspace}
        >
          {open ? "Close workspace" : "Track & prepare"}
        </button>
      </div>
      {open && (
        <div id={`${headingId}-workspace`}>
          <ApplicationWorkspace application={application} onSaved={onSaved} />
        </div>
      )}
    </li>
  );
}
