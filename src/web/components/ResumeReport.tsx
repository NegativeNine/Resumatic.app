import { useId, useState } from "react";
import { FACT_KINDS, MAX_FACT_CHARS, type FactKind, type ResumeReport } from "../../shared/api";
import { api } from "../api";
import { FACT_KIND_LABEL, LINE_STATUS_HINT, LINE_STATUS_LABEL } from "../format";
import { useAction } from "../hooks";
import { href } from "../router";
import { useTailor } from "../tailor";
import { ActionError, Badge, CharCount, LINE_MARK, Success } from "./ui";

/** How each line was checked (CheckReport): a strip of counts above the sheet, and what the marks mean. */
export function ReportCard({ report }: { report: ResumeReport }) {
  const stats = [
    ["kept", LINE_STATUS_LABEL.kept, report.kept, LINE_MARK.kept],
    ["repaired", LINE_STATUS_LABEL.repaired, report.repaired, LINE_MARK.repaired],
    ["replaced", LINE_STATUS_LABEL.replaced, report.replaced, LINE_MARK.replaced],
    ["dropped", "Left out", report.dropped, "note"],
  ] as const;

  return (
    <section className="rs-panel app-check-strip" aria-labelledby="report-heading">
      <div className="app-check-strip__head">
        <h2 id="report-heading" className="rs-h3">
          How each line was checked
        </h2>
        {report.gaps.length > 0 && (
          <a className="rs-link" href="#gaps-heading">
            {report.gaps.length.toLocaleString()} that may be missing, found when this draft was made
          </a>
        )}
      </div>
      <dl className="rs-report__stats rs-report__stats--wide">
        {stats.map(([status, label, value, tone]) => (
          <div key={status} className={`rs-report__stat rs-report__stat--${tone}`}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <details className="app-legend">
        <summary>What the marks mean</summary>
        <ul className="rs-legend">
          <li>
            <Badge tone={LINE_MARK.kept}>{LINE_STATUS_LABEL.kept}</Badge> <span>is backed by your record as written.</span>
          </li>
          <li>
            <Badge tone={LINE_MARK.repaired}>{LINE_STATUS_LABEL.repaired}</Badge> <span>was rewritten once to match its facts.</span>
          </li>
          <li>
            <Badge tone={LINE_MARK.replaced}>{LINE_STATUS_LABEL.replaced}</Badge> <span>{LINE_STATUS_HINT.replaced}.</span>
          </li>
          <li>
            <Badge tone="note">Left out</Badge> <span>was left out, because nothing in your record backs it.</span>
          </li>
          <li>
            <Badge tone={LINE_MARK.edited}>{LINE_STATUS_LABEL.edited}</Badge> <span>was changed by you.</span>
          </li>
        </ul>
      </details>
    </section>
  );
}

/** What may be missing: the job's requirements no confirmed fact covered when this draft was made (GapList). */
export function GapsCard({ gaps, applicationId, readOnly = false }: { gaps: string[]; applicationId?: string; readOnly?: boolean }) {
  const [answering, setAnswering] = useState<number | null>(null);
  return (
    <section className="rs-panel" aria-labelledby="gaps-heading">
      <h2 id="gaps-heading" className="rs-h3" tabIndex={-1}>
        What may be missing, as found when this draft was made
      </h2>
      {gaps.length === 0 ? (
        <p className="rs-meta app-gaps-note">
          The initial matching found nothing that may be missing. Check the resume against the job description;
          matching doesn’t guarantee every requirement appears in the resume.
        </p>
      ) : (
        <>
          <ul className="rs-gaps">
            {gaps.map((gap, i) => (
              <li key={i} className="rs-gap">
                <p className="rs-gap__req">{gap}</p>
                {!readOnly && applicationId && (
                <div className="rs-gap__actions">
                  <button
                    type="button"
                    className="rs-btn rs-btn--sm"
                    aria-expanded={answering === i}
                    aria-label={`Add a fact for ${gap}`}
                    onClick={() => setAnswering(answering === i ? null : i)}
                  >
                    Add a fact
                  </button>
                </div>
                )}
                {answering === i && applicationId && (
                  <GapAnswer requirement={gap} applicationId={applicationId} onClose={() => setAnswering(null)} />
                )}
              </li>
            ))}
          </ul>
          <p className="rs-meta app-gaps-note">
            These may be missing from the confirmed facts used when this draft was made; this is not a coverage check on
            the current resume. Resumatic never fills in what’s missing by itself. If you have this experience, add it as
            a fact, then tailor a new version. You can also <a href={href.facts}>add it under Facts</a>.
          </p>
        </>
      )}
    </section>
  );
}

/** Affirmations that say nothing on their own, so they can't become a fact. */
const BARE_ANSWER = /^(?:y|yes|yeah|yep|yup|no|nope|sure|of course|i have|i did|definitely|correct)[.!]?$/i;

/** True when an answer reads as a claim: at least three words, not a bare yes or no. */
export function isWrittenAnswer(text: string): boolean {
  const trimmed = text.trim();
  return !BARE_ANSWER.test(trimmed) && trimmed.split(/\s+/).filter(Boolean).length >= 3;
}

/** Adding what's missing: the person's own words, saved as a fact marked Added by you (Close a gap). */
function GapAnswer({ requirement, applicationId, onClose }: { requirement: string; applicationId: string; onClose: () => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const [kind, setKind] = useState<FactKind>("accomplishment");
  const [added, setAdded] = useState(false);
  const { run, pending, error } = useAction();
  const tailor = useTailor();
  const trimmed = text.trim();
  const written = isWrittenAnswer(trimmed);

  async function save() {
    const ok = await run(async () => {
      await api.addFact({ roleId: null, kind, text: trimmed, level: null });
    });
    if (ok) setAdded(true);
  }

  if (added) {
    return (
      <div className="rs-well app-gap-answer">
        <Success>Fact added.</Success>
        <p className="rs-meta">It’s marked Added by you, and the next version can use it.</p>
        <div className="rs-actions">
          <button type="button" className="rs-btn rs-btn--primary rs-btn--sm" disabled={tailor.pending} onClick={() => void tailor.tailor(applicationId)}>
            {tailor.pending ? "Starting…" : "Tailor a new version"}
          </button>
          <button type="button" className="rs-btn rs-btn--sm" onClick={onClose}>
            Close
          </button>
        </div>
        <ActionError message={tailor.error} />
      </div>
    );
  }

  return (
    <form
      className="rs-well app-gap-answer"
      aria-label={`Add a fact for ${requirement}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (written) void save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !pending) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="rs-field">
        <label className="rs-label" htmlFor={`${id}-text`}>
          {requirement}: describe what you did, in your own words
        </label>
        <textarea
          id={`${id}-text`}
          className="rs-textarea"
          rows={3}
          value={text}
          autoFocus
          aria-describedby={`${id}-hint ${id}-count`}
          onChange={(e) => setText(e.target.value)}
        />
        <p className="rs-hint" id={`${id}-hint`}>
          A yes on its own can’t go on a resume. Write the claim the way you’d want it to read.
        </p>
        <CharCount id={`${id}-count`} length={trimmed.length} max={MAX_FACT_CHARS} />
      </div>
      <div className="rs-field">
        <label className="rs-label" htmlFor={`${id}-kind`}>
          Kind
        </label>
        <select id={`${id}-kind`} className="rs-select" value={kind} onChange={(e) => setKind(e.target.value as FactKind)}>
          {FACT_KINDS.map((k) => (
            <option key={k} value={k}>
              {FACT_KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
      <div className="rs-actions">
        <button type="submit" className="rs-btn rs-btn--primary rs-btn--sm" disabled={pending || !written || trimmed.length > MAX_FACT_CHARS}>
          {pending ? "Adding…" : "Add fact"}
        </button>
        <button type="button" className="rs-btn rs-btn--sm" onClick={onClose} disabled={pending}>
          Cancel
        </button>
      </div>
      <ActionError message={error} />
    </form>
  );
}
