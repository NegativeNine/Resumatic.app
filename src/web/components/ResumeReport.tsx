import type { ResumeReport } from "../../shared/api";
import { LINE_STATUS_HINT, LINE_STATUS_LABEL } from "../format";
import { href } from "../router";
import { Badge } from "./ui";

export function ReportCard({ report }: { report: ResumeReport }) {
  const stats = [
    ["Kept", report.kept],
    ["Repaired", report.repaired],
    [LINE_STATUS_LABEL.replaced, report.replaced],
    ["Dropped", report.dropped],
  ] as const;

  return (
    <section className="card" aria-labelledby="report-heading">
      <h2 id="report-heading">How each line was checked</h2>
      <dl className="stats">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <ul className="plain-list legend">
        <li>
          <Badge tone="kept">Kept</Badge> passed every check as written.
        </li>
        <li>
          <Badge tone="repaired">Repaired</Badge> was fixed once so that it matches its facts.
        </li>
        <li>
          <Badge tone="replaced">{LINE_STATUS_LABEL.replaced}</Badge> {LINE_STATUS_HINT.replaced}.
        </li>
        <li>
          <Badge tone="dropped">Dropped</Badge> was left out, because no fact could back it.
        </li>
        <li>
          <Badge tone="edited">Edited</Badge> was changed by you.
        </li>
      </ul>
    </section>
  );
}

export function GapsCard({ gaps }: { gaps: string[] }) {
  return (
    <section className="card gaps" aria-labelledby="gaps-heading">
      <h2 id="gaps-heading">Possible gaps identified when this draft was created</h2>
      {gaps.length === 0 ? (
        <p>The initial matching found no potential gaps. Check the resume against the job description; matching does not guarantee every requirement appears in the resume.</p>
      ) : (
        <>
          <ul>
            {gaps.map((gap, i) => (
              <li key={i}>{gap}</li>
            ))}
          </ul>
          <p className="hint">
            These are possible gaps in the confirmed facts used when this draft was made, not a coverage check on the current resume. If you do have this
            experience, <a href={href.facts}>add it under Facts</a>, then tailor a new version.
          </p>
        </>
      )}
    </section>
  );
}
