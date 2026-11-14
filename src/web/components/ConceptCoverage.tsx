import type { ConceptSelection } from "../../shared/concept-tailoring";

/** Owner-only explanation of checked source facts; never a statement that experience is absent. */
export function ConceptCoveragePanel({ coverage, facts }: { coverage: ConceptSelection; facts: Record<string, { text: string }> }) {
  return <section className="rs-panel" aria-label="How your facts match">
    <h2 className="rs-h3">How your facts match</h2>
    <p className="rs-meta">Checked against your confirmed facts when this version was made. An unanswered requirement does not mean you lack the experience.</p>
    <ul className="plain-list">
      {coverage.coverage.map((item, index) => <li key={`${index}-${item.requirement}`}>
        <p>{item.requirement}</p>
        <p className="rs-meta">{item.status === "supported" ? "Supported by your facts" : item.status === "unknown" ? "Not established by this check" : "No supporting fact found in this check"}</p>
        {item.factIds.flatMap((id) => facts[id] ? [<blockquote key={id}>{facts[id]!.text}</blockquote>] : [])}
        {item.concepts.some((concept) => concept.factIds.length > 0) && <p className="rs-meta">Matched experience: {item.concepts.filter((concept) => concept.factIds.length > 0).map((concept) => concept.label).join(", ")}</p>}
      </li>)}
    </ul>
  </section>;
}
