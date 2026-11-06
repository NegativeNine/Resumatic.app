import { formatDateRange } from "../format";
import type { SharedLine, SharedView } from "../../shared/sharing";

/** Kept separate so the same read-only snapshot can be tested without a browser session. */
export function ShareSnapshotContent({ view }: { view: SharedView }) {
  const line = (value: SharedLine) => (
    <li key={value.id}>
      {value.text}
      {value.verification !== "verified" && (
        <small>
          {" "}
          ·{" "}
          {value.verification === "user-authored"
            ? "User-authored"
            : "Unverified"}
        </small>
      )}
    </li>
  );
  return (
    <main className="page">
      <h1>Shared career snapshot</h1>
      <p>
        Selected by the owner on{" "}
        {new Date(view.snapshot.createdAt).toLocaleDateString()}. Available
        until {new Date(view.expiresAt).toLocaleDateString()}.
      </p>
      {view.snapshot.facts.length > 0 && (
        <section>
          <h2>Confirmed facts</h2>
          <ul>
            {view.snapshot.facts.map((fact) => (
              <li key={fact.id}>
                {fact.text}
                {fact.role && (
                  <small>
                    {" "}
                    · {fact.role.org}
                    {fact.role.title ? ` — ${fact.role.title}` : ""}
                  </small>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {view.snapshot.resumes.map((resume) => (
        <article key={`${resume.id}:${resume.version}`}>
          <h2>
            {resume.profile.name || "Resume"} · Version {resume.version}
          </h2>
          <p>
            {[
              resume.profile.email,
              resume.profile.phone,
              resume.profile.location,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p>
            {resume.verification === "verified"
              ? "Verified from confirmed facts"
              : resume.verification === "user-authored"
                ? "User-authored content"
                : "Includes content without a verified status"}
          </p>
          {resume.summary && <ul>{line(resume.summary)}</ul>}
          {resume.sections.map((section, index) => (
            <section key={`${section.id}:${index}`}>
              <h3>
                {section.title ? `${section.title} · ` : ""}
                {section.org}
              </h3>
              {formatDateRange(section.startDate, section.endDate, section.unknownEndStartDate) && (
                <p>{formatDateRange(section.startDate, section.endDate, section.unknownEndStartDate)}</p>
              )}
              <ul>{section.lines.map(line)}</ul>
            </section>
          ))}
          {resume.skills.length > 0 && (
            <p>Skills: {resume.skills.join(", ")}</p>
          )}
        </article>
      ))}
    </main>
  );
}
