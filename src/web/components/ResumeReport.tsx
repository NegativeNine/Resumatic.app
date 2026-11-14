import { SkillDurationChoices } from "./SkillYears";
import { useId, useState } from "react";
import { FACT_KINDS, MAX_FACT_CHARS, type FactKind } from "../../shared/api";
import { api } from "../api";
import { FACT_KIND_LABEL } from "../format";
import { useAction } from "../hooks";
import { href } from "../router";
import { useTailor } from "../tailor";
import { ActionError, CharCount, Success } from "./ui";

/**
 * Not in your record (GapList): what the job asks for that this version's confirmed facts didn't
 * cover when its lines were last checked. A line check works it out again and finishing an older
 * version's review empties it, so it speaks of the version, not of when the draft was made.
 */
export function GapsCard({ gaps, applicationId, readOnly = false }: { gaps: string[]; applicationId?: string; readOnly?: boolean }) {
  const [answering, setAnswering] = useState<number | null>(null);
  return (
    <section className="rs-panel" aria-labelledby="gaps-heading">
      <h2 id="gaps-heading" className="rs-h3" tabIndex={-1}>
        Not in your record
      </h2>
      <p className="rs-meta app-gaps-note">
        What this job asks for that your confirmed facts didn’t cover when this version’s lines were last checked. Facts
        you’ve added since aren’t counted here.
      </p>
      {gaps.length === 0 ? (
        <p className="rs-meta app-gaps-note">
          Nothing is listed as missing for this version. That isn’t a check against the whole job description, so read
          the two side by side.
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
            Resumatic never fills in what’s missing by itself. If you have this experience, add it as a fact, then
            tailor a new version. You can also <a href={href.factsAll}>add it under Facts › All facts</a>.
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
  const [claimIds, setClaimIds] = useState<string[]>([]);
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
        <SkillDurationChoices selected={claimIds} onChange={setClaimIds} disabled={tailor.pending} />
        <div className="rs-actions">
          <button type="button" className="rs-btn rs-btn--sm" disabled={tailor.pending} onClick={() => void tailor.tailor(applicationId, claimIds)}>
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
