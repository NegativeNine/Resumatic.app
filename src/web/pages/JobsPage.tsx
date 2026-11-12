import { useId, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  APPLICATION_STATUSES,
  MAX_JD_CHARS,
  MAX_URL_CHARS,
  MIN_JD_CHARS,
  isWebUrl,
  type ApplicationRef,
  type ApplicationStatus,
  type ApplicationView,
  type ResumeState,
} from "../../shared/api";
import type { PostingRead } from "../../shared/postings";
import { api } from "../api";
import { APPLICATION_LABELS } from "../components/jobs/JobTracking";
import {
  ActionError,
  Badge,
  CharCount,
  ErrorNote,
  Field,
  Glyph,
  Loading,
  Message,
  PageHeader,
  RUN_MARK,
  type GlyphName,
} from "../components/ui";
import { formatDate, RESUME_STATE_LABEL } from "../format";
import { useAction, useResource, type Reload } from "../hooks";
import { QuotaMeter } from "../components/QuotaMeter";
import { href } from "../router";
import { useSession } from "../session";
import { quotaMessage, useTailor } from "../tailor";
import { useToday } from "../today";
import "../styles/rooms/jobs.css";

/** A finished resume's mark carries a glyph, so its state never rests on color. */
const STATE_GLYPH: Partial<Record<ResumeState, GlyphName>> = {
  ready: "check",
  failed: "alert",
};

const isTailoring = (data: { applications: ApplicationView[] }) =>
  data.applications.some((a) => a.resumes.some((r) => r.state === "running"));

/**
 * Your jobs: adding one, and every job as a row that opens its own page, as a list or a board by
 * status. Jobs are listed newest first. Fit is never shown here, and never sorts, filters or hides
 * a job.
 */
export function JobsPage() {
  const list = useResource(api.applications, isTailoring);
  const { quota } = useSession().me;
  const applications = [...(list.data?.applications ?? [])].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
  const [status, setStatus] = useState<ApplicationStatus | "all">("all");
  const [view, setView] = useState<"list" | "board">("list");
  const filterId = useId();
  const statusOf = (application: ApplicationView) => application.status ?? "saved";
  const visible =
    status === "all"
      ? applications
      : applications.filter((application) => statusOf(application) === status);
  const visibleIds = new Set(visible.map((application) => application.id));
  const columns = APPLICATION_STATUSES.filter(
    (value) => status === "all" || status === value || visible.some((application) => statusOf(application) === value),
  );
  // Column headings and empty slots are list items too: a list may only hold list items, and a
  // heading inside one still reads as a heading.
  // Keep one keyed parent for rows in both views, so changing the view or the filter keeps them.
  const content: ReactNode[] = [];
  if (view === "board") for (const [index, value] of columns.entries()) {
    const count = visible.filter((application) => statusOf(application) === value).length;
    content.push(<li className="application-column-heading" key={`column:${value}`} style={{ gridColumn: index + 1, gridRow: 1 }}>
      <h3 id={`${filterId}-column-${value}`}>{APPLICATION_LABELS[value]}</h3>
      <span className="app-column-count" aria-hidden="true">{count}</span>
    </li>);
    // The empty slot sits in the cards' row, so every column's first card starts level.
    if (count === 0) content.push(<li className="app-column-empty" key={`empty:${value}`} style={{ gridColumn: index + 1, gridRow: 2 }}>
      <p className="meta">No jobs.</p>
    </li>);
  }
  for (const application of applications) {
    const appStatus = statusOf(application);
    content.push(<JobCard
      key={`application:${application.id}`}
      application={application}
      compact={view === "board"}
      hidden={!visibleIds.has(application.id)}
      columnLabel={view === "board" && visibleIds.has(application.id) ? `${filterId}-column-${appStatus}` : undefined}
      style={view === "board" && visibleIds.has(application.id) ? { gridColumn: columns.indexOf(appStatus) + 1 } : undefined}
    />);
  }

  return (
    <>
      <PageHeader title="Jobs">
        Paste a job description, then tailor a resume to it. Every line comes
        from facts you’ve confirmed under{" "}
        <a href={href.factsAll}>Facts</a>.
      </PageHeader>
      {/* On small screens the quota leaves the header for the top of Jobs. */}
      <QuotaMeter className="app-quota-small" />
      {quota.used >= quota.limit && (
        <p className="notice">{quotaMessage(quota)}</p>
      )}

      <div className="app-jobs" data-view={view}>
      <section className="section app-jobs__add" aria-labelledby="job-heading">
        <h2 id="job-heading">Add a job</h2>
        <JobForm onSaved={list.reload} />
      </section>

      <section className="section app-jobs__list" aria-labelledby="applications-heading">
        <h2 id="applications-heading">Your jobs</h2>
        {applications.length > 0 && (
          <div className="row-between">
            <div className="application-filter">
              <label htmlFor={filterId}>Status</label>
              <select
                id={filterId}
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as ApplicationStatus | "all")
                }
              >
                <option value="all">
                  All jobs ({applications.length})
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
            <div className="rs-filter app-view-toggle" role="group" aria-label="Job view">
              <button
                type="button"
                className="rs-filter__opt"
                aria-pressed={view === "list"}
                onClick={() => setView("list")}
              >
                List
              </button>
              <button
                type="button"
                className="rs-filter__opt"
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
          <Loading>Loading your jobs…</Loading>
        )}
        {list.data &&
          (applications.length === 0 ? (
            <p className="empty">
              No jobs yet. Paste a job description above to start your first
              one.
            </p>
          ) : (
            <>
              {visible.length === 0 && <p className="empty">No jobs have this status yet.</p>}
              <div hidden={visible.length === 0} className={view === "board" ? "application-board-scroller" : undefined} role={view === "board" ? "region" : undefined}
                aria-label={view === "board" ? "Jobs by status" : undefined} tabIndex={view === "board" ? 0 : undefined}>
                <ul className={`plain-list${view === "board" ? " application-board" : " app-job-rows"}`}
                  style={view === "board" ? { "--application-columns": columns.length } as CSSProperties : undefined}>
                  {content}
                </ul>
              </div>
            </>
          ))}
      </section>
      </div>
    </>
  );
}

/** Why a link gave no job description, and what to do instead. */
const UNREAD: Readonly<Record<Exclude<PostingRead, { posting: object }>["reason"], string>> = {
  unreachable: "That page couldn’t be reached. Some job sites block automated reading. Paste the job description instead.",
  not_a_page: "That link isn’t a web page. Paste the job description instead.",
  no_posting:
    "No job description was found on that page. Some sites only show it in a browser. Paste its text instead.",
};

function JobForm({ onSaved }: { onSaved: Reload }) {
  const [text, setText] = useState("");
  const [link, setLink] = useState("");
  /** The job just saved, for the link to its page. */
  const [saved, setSaved] = useState<string | null>(null);
  /** The saved job with this same job description, once the person has been asked about it. */
  const [duplicate, setDuplicate] = useState<ApplicationRef | null>(null);
  /** The job description last sent to be saved. A retry of it isn't a second copy, so it isn't checked again. */
  const attempted = useRef<string | null>(null);
  const { run, pending, error } = useAction();
  const reader = useAction();
  /** What the last read of a link came to: the job description it found, or why it found none. */
  const [read, setRead] = useState<{ url: string; result: PostingRead } | null>(null);
  const canRead = useSession().me.capabilities?.postingReader === true;
  const id = useId();
  const length = text.trim().length;
  const tooLong = length > MAX_JD_CHARS;
  const url = link.trim();
  const badLink = url !== "" && !isWebUrl(url);
  const busy = pending || reader.pending;
  /** The page's own name for the job goes with it only while the link is the one that was read. */
  const found = read?.url === url ? read.result.posting : null;
  /** Text is already there, so reading the link would replace it. The person clears it first. */
  const wouldReplace = length > 0 && url !== "" && !badLink && !found;

  async function readLink() {
    setSaved(null);
    setRead(null);
    await reader.run(
      async () => {
        const result = await api.readPosting(url);
        setRead({ url, result });
        if (result.posting) {
          setText(result.posting.text);
          setDuplicate(null);
        }
      },
      {
        invalid: "Use the job’s public web address, starting with https://.",
        unavailable: "Reading a job from its link isn’t available right now. Paste the job description instead.",
      },
    );
  }

  async function save(anyway = false) {
    setSaved(null);
    const posting = text.trim();
    let added: string | null = null;
    await run(async () => {
      if (!anyway && attempted.current !== posting) {
        const found = (await api.duplicateApplication(posting)).duplicate;
        if (found) {
          setDuplicate(found);
          return;
        }
      }
      setDuplicate(null);
      attempted.current = posting;
      added = (await api.addApplication(posting, url || undefined, found ? { title: found.title, company: found.company } : undefined)).applicationId;
      await onSaved();
    });
    if (added) {
      attempted.current = null;
      setText("");
      setLink("");
      setRead(null);
      setSaved(added);
    }
  }

  return (
    <form
      className="card"
      aria-busy={busy}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label htmlFor={id}>Job description</label>
      <p className="hint" id={`${id}-hint`}>
        {canRead
          ? "Paste the whole job description, including what it asks for. Or add its link below and read it from there."
          : "Paste the whole job description, including what it asks for."}
      </p>
      <textarea
        id={id}
        rows={10}
        value={text}
        readOnly={busy}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(null);
          setDuplicate(null);
        }}
        aria-describedby={`${id}-hint ${id}-count`}
        aria-invalid={tooLong}
      />
      <CharCount id={`${id}-count`} length={length} max={MAX_JD_CHARS} />
      <Field
        id={`${id}-link`}
        label="Link to the job"
        optional
        error={badLink ? "Enter a web address that starts with https://" : undefined}
      >
        <input
          id={`${id}-link`}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_URL_CHARS}
          value={link}
          readOnly={busy}
          placeholder="https://"
          onChange={(e) => setLink(e.target.value)}
          aria-invalid={badLink}
          aria-describedby={badLink ? `${id}-link-error` : undefined}
        />
      </Field>
      {canRead && (
        <div className="app-read-link">
          <button
            type="button"
            className="rs-btn rs-btn--sm"
            disabled={busy || url === "" || badLink || length > 0}
            onClick={() => void readLink()}
            aria-describedby={wouldReplace ? `${id}-read-hint` : undefined}
          >
            {reader.pending ? "Reading…" : "Read the job from this link"}
          </button>
          {wouldReplace && (
            <p className="rs-hint" id={`${id}-read-hint`}>
              Clear the job description to read it from the link instead.
            </p>
          )}
          {read?.url === url &&
            (found ? (
              <Message tone="success">
                Read from {found.host}. Check the text above against the page before saving.
                {found.truncated ? " The job description was longer than Resumatic keeps, so the end is cut off." : ""}
              </Message>
            ) : (
              <Message tone="info">{UNREAD[read.result.posting === null ? read.result.reason : "no_posting"]}</Message>
            ))}
          <ActionError message={reader.error} />
        </div>
      )}
      {duplicate && (
        <div className="rs-msg rs-msg--info app-msg-block" role="status">
          <Glyph name="info" />
          <p className="rs-msg__text">
            You’ve already saved this job{duplicate.title || duplicate.company
              ? ` as ${[duplicate.title, duplicate.company].filter(Boolean).join(" at ")}`
              : ""}, on {formatDate(duplicate.createdAt)}. <a href={href.job(duplicate.id)}>Open it</a>
          </p>
          <button type="button" className="rs-btn rs-btn--sm" disabled={busy} onClick={() => void save(true)}>
            Save it again
          </button>
        </div>
      )}
      <div className="form-foot app-job-form__foot">
        <button
          type="submit"
          className="primary"
          disabled={busy || length < MIN_JD_CHARS || tooLong || badLink}
        >
          {pending ? "Saving…" : "Save job"}
        </button>
      </div>
      {saved && (
        <p className="success" role="status">
          Saved. <a href={href.job(saved)}>Open the job</a>
        </p>
      )}
      <ActionError message={error} />
    </form>
  );
}

/** A job's name in its row: its title, else the start of its job description. */
function rowName({ title, excerpt }: ApplicationView): string {
  return title ?? (excerpt || "Untitled job");
}

/** How many of a kit's questions wait for the person, in words. */
const questionsToAnswer = (n: number) => (n === 1 ? "1 question to answer" : `${n} questions to answer`);

/**
 * One job in Your jobs: its name, which opens its page, its company, its status as the person's own
 * neutral mark, when it was added, where its latest resume stands, a way to tailor another, and a
 * mark when its kit has questions waiting. The kit's count is Today's, the same sum the room counts.
 */
function JobCard({
  application,
  compact = false,
  hidden,
  columnLabel,
  style,
}: {
  application: ApplicationView;
  compact?: boolean;
  hidden: boolean;
  columnLabel?: string;
  style?: CSSProperties;
}) {
  const { tailor, pending, error } = useTailor();
  const { today } = useToday();
  const headingId = useId();
  const latest = [...application.resumes].sort((a, b) => b.createdAt - a.createdAt)[0];
  const unnamed = !application.title && !application.company;
  const Heading = compact ? "h4" : "h3";
  // Today lists at most MAX_TODAY_LIST kits. A job past that cap shows no mark here, though the
  // room's count still includes it; its page says what its kit waits for.
  const kit = today?.waiting.find((item) => item.kind === "kit" && item.applicationId === application.id);
  const waiting = kit?.kind === "kit" ? kit.unanswered + kit.sensitive : 0;

  return (
    <li className="card application rs-job app-job-row" hidden={hidden} style={style}
      aria-labelledby={columnLabel ? `${columnLabel} ${headingId}` : headingId}>
      <div className="row-between">
        <div className="app-job-head">
          <Heading id={headingId}>
            <a href={href.job(application.id)}>{rowName(application)}</a>
          </Heading>
          <p className="rs-meta app-meta-row app-job-meta">
            {application.company && <span>{application.company}</span>}
            <Badge tone="status">{APPLICATION_LABELS[application.status ?? "saved"]}</Badge>
            <span>Added {formatDate(application.createdAt)}</span>
            {latest && (
              <a className="app-job-resume" href={href.jobResume(application.id, latest.id)}>
                <span className="rs-visually-hidden">Latest resume:</span>{" "}
                <Badge tone={RUN_MARK[latest.state]}>
                  {STATE_GLYPH[latest.state] && <Glyph name={STATE_GLYPH[latest.state]!} />}
                  {latest.state === "running" && latest.cancellationPending
                    ? "Cancellation pending"
                    : latest.state === "running" && latest.dispatchUncertain
                    ? "Start unconfirmed"
                    : RESUME_STATE_LABEL[latest.state]}
                </Badge>
              </a>
            )}
            {waiting > 0 && (
              <a className="app-job-kit" href={href.job(application.id, "application")}>
                <Badge tone="needs-you">{questionsToAnswer(waiting)}</Badge>
              </a>
            )}
            {unnamed && <span>It’s named from its job description when a resume is tailored, or name it under Edit details.</span>}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void tailor(application.id)}
          disabled={pending}
          aria-describedby={headingId}
        >
          {pending ? "Starting…" : "Tailor a resume"}
        </button>
      </div>
      <ActionError message={error} />
    </li>
  );
}
