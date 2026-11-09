import type { ReactNode } from "react";
import { formatDate, formatDateRange } from "../format";
import type { SharedLine, SharedResume, SharedView } from "../../shared/sharing";
import { Lockup } from "./Lockup";
import { Badge, Glyph } from "./ui";

/** The frame around a shared copy: the lockup, then the page. The reader has no account here. */
export function ShareFrame({ children }: { children: ReactNode }) {
  return (
    <div className="app-share">
      <header className="app-share__bar">
        <Lockup className="app-share__lockup" />
        <span className="rs-meta">Shared copy, read only</span>
      </header>
      <main className="app-share__main" id="main">
        {children}
      </main>
    </div>
  );
}

const RESUME_CHECK: Readonly<Record<SharedResume["verification"], { tone: string; text: string }>> = {
  verified: { tone: "ready", text: "Every line checked against confirmed facts" },
  "user-authored": { tone: "mine", text: "Written by the owner" },
  mixed: { tone: "proposed", text: "Some lines haven\u2019t been checked" },
  unverified: { tone: "proposed", text: "Lines haven\u2019t been checked" },
};

/** Kept separate so the same read-only snapshot can be tested without a browser session. */
export function ShareSnapshotContent({ view }: { view: SharedView }) {
  const { facts, resumes } = view.snapshot;
  return (
    <ShareFrame>
      <h1>Shared career snapshot</h1>
      <p className="rs-lede">
        A fixed copy, chosen by its owner on {formatDate(view.snapshot.createdAt)}. This link works until{" "}
        {formatDate(view.expiresAt)}.
      </p>
      {facts.length > 0 && (
        <section className="rs-panel app-share__facts" aria-labelledby="share-facts">
          <h2 id="share-facts">Confirmed facts</h2>
          <ul className="plain-list">
            {facts.map((fact) => (
              <li key={fact.id}>
                <p>{fact.text}</p>
                <p className="rs-meta">
                  {fact.role ? [fact.role.title, fact.role.org].filter(Boolean).join(", ") : "General experience"}
                  {fact.origin === "user" ? ". Added by the owner in their own words." : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {resumes.map((resume) => (
        <SharedResumeSheet resume={resume} key={`${resume.id}:${resume.version}`} />
      ))}
    </ShareFrame>
  );
}

function SharedResumeSheet({ resume }: { resume: SharedResume }) {
  const check = RESUME_CHECK[resume.verification];
  const contact = [resume.profile.email, resume.profile.phone, resume.profile.location].filter(Boolean);
  const line = (value: SharedLine) => (
    <>
      {value.text}
      {value.verification !== "verified" && (
        <small className="app-share__flag">
          {" "}
          ({value.verification === "user-authored" ? "written by the owner" : "not checked"})
        </small>
      )}
    </>
  );
  return (
    <section className="app-share__resume" aria-label={`${resume.profile.name || "Resume"}, version ${resume.version}`}>
      <div className="app-share__resume-head">
        <h2>
          {resume.profile.name || "Resume"}, version {resume.version}
        </h2>
        <Badge tone={check.tone}>
          {resume.verification === "verified" && <Glyph name="check" />}
          {check.text}
        </Badge>
      </div>
      <div className="rs-sheet-frame">
        <article className="rs-sheet">
          {resume.profile.name && <h1>{resume.profile.name}</h1>}
          {contact.length > 0 && <p className="rs-sheet__contact">{contact.join(" · ")}</p>}
          {resume.summary && <p className="rs-sheet__summary">{line(resume.summary)}</p>}
          {resume.sections.length > 0 && (
            <section>
              <h2>Experience</h2>
              {resume.sections.map((section, index) => {
                const dates = formatDateRange(section.startDate, section.endDate, section.unknownEndStartDate);
                return (
                  <div className="rs-sheet__role" key={`${section.id}:${index}`}>
                    <div className="rs-sheet__role-head">
                      <h3>{[section.title, section.org].filter(Boolean).join(", ")}</h3>
                      {dates && <span className="rs-sheet__dates">{dates}</span>}
                    </div>
                    {section.lines.length > 0 && (
                      <ul>
                        {section.lines.map((value) => (
                          <li key={value.id}>{line(value)}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </section>
          )}
          {resume.skills.length > 0 && (
            <section>
              <h2>Skills</h2>
              <p>{resume.skills.join(" · ")}</p>
            </section>
          )}
        </article>
      </div>
    </section>
  );
}
