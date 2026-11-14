import type { DocumentView } from "../../../shared/documents";
import { formatDateTime } from "../../format";
import { Glyph, Tick } from "../ui";
import { ConceptCoveragePanel } from "../ConceptCoverage";

// How a job's description stands against the person's confirmed facts, shown only after they, or an
// app they connected, asked. It is worded as what the record covers, never as a score or a verdict,
// and it never hides a job. Nothing here is written by a model: the requirements are read from the
// job description, which is the employer's text and shown as plain text, and the facts are the
// person's own.

/**
 * One fit check: when it was made, against the job description as it was then; how many of the
 * job's asks the record covers; each ask with the facts that cover it, or that it isn't in the
 * record; and that Resumatic never fills in what's missing.
 */
export function FitPreview({ doc }: { doc: DocumentView }) {
  const requirements = doc.result?.fit?.requirements ?? [];
  const covered = requirements.filter((requirement) => requirement.factIds.some((id) => doc.facts[id] !== undefined)).length;
  const when = <p className="rs-meta">Checked {formatDateTime(doc.createdAt)}, against the job description as it was then.</p>;
  if (doc.conceptCoverage) return <div className="document-content">{when}<ConceptCoveragePanel coverage={doc.conceptCoverage} facts={doc.facts} /></div>;
  if (requirements.length === 0)
    return (
      <div className="document-content">
        {when}
        <p className="rs-meta">Nothing this job asks for could be read from its description. Check that the whole description was pasted.</p>
      </div>
    );
  return (
    <div className="document-content">
      {when}
      <p className="app-fit__summary">
        Your record covers {covered} of the {requirements.length === 1 ? "1 thing" : `${requirements.length} things`} this job asks for.
      </p>
      <ul className="plain-list app-fit">
        {requirements.map((requirement, index) => {
          const facts = requirement.factIds.map((id) => doc.facts[id]).filter((fact) => fact !== undefined);
          return (
            <li key={`${index}-${requirement.text}`}>
              <Tick state={facts.length > 0 ? "backed" : "todo"} />
              <div>
                <p className="app-fit__req">
                  {requirement.text}
                  {facts.length === 0 && <span className="rs-meta"> Not in your record</span>}
                </p>
                {facts.map((fact, i) => (
                  <p className="rs-meta app-fit__fact" key={i}>
                    <Glyph name="quote" />
                    {fact.text}
                  </p>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="rs-meta">
        Something not in your record may still be true of you. Resumatic never fills it in. If you have the experience,
        add it as a fact, or answer the experience questions below.
      </p>
    </div>
  );
}
