import type { ResumeReport } from "../../shared/api";
import { href } from "../router";
import { Badge } from "./ui";

export function ReportCard({ report }: { report: ResumeReport }) {
  const stats = [
    ["Kept", report.kept],
    ["Repaired", report.repaired],
    ["Replaced", report.replaced],
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
          <Badge tone="replaced">Replaced</Badge> was swapped for the wording of a fact it cites.
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
      <h2 id="gaps-heading">Requirements none of your confirmed facts cover</h2>
      {gaps.length === 0 ? (
        <p>None. Every requirement Resumatic found in the job description is covered by a confirmed fact.</p>
      ) : (
        <>
          <ul>
            {gaps.map((gap, i) => (
              <li key={i}>{gap}</li>
            ))}
          </ul>
          <p className="hint">
            Resumatic never fills a gap by itself. The way to close one is to add a true fact: if you do have this
            experience, <a href={href.sources}>add it under Sources & facts</a>, then tailor a new version.
          </p>
        </>
      )}
    </section>
  );
}
