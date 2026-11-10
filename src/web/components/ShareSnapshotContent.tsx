import type { ReactNode } from "react";
import { formatDate } from "../format";
import { presentResumeBullet } from "../../shared/resume-presentation";
import { formatRoleDates } from "../../shared/sheet";
import type { SharedJob, SharedLine, SharedResume, SharedView } from "../../shared/sharing";
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
  const owner = view.snapshot.owner?.name || null;
  return (
    <ShareFrame>
      <h1>Shared career snapshot</h1>
      <p className="rs-lede">
        {owner ? (
          <>
            From <strong>{owner}</strong>. A fixed copy, chosen on {formatDate(view.snapshot.createdAt)}.
          </>
        ) : (
          <>A fixed copy, chosen by its owner on {formatDate(view.snapshot.createdAt)}.</>
        )}{" "}
        This link works until {formatDate(view.expiresAt)}.
      </p>
      <p className="rs-meta app-share__opened">
        {owner ?? "Its owner"} can see when this copy was last opened, but not who opened it.{" "}
        {/* An address from the site's root: on this page a bare fragment would be read as a share link. */}
        <a className="rs-link" href="/#/privacy">
          Privacy notice
        </a>
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

function SharedResumeSheet({ resume }: { resume: SharedResume & { job?: SharedJob | null } }) {
  const check = RESUME_CHECK[resume.verification];
  // The job as its owner had it named when the copy was made. An unnamed job says nothing.
  const job = [resume.job?.title, resume.job?.company].filter(Boolean).join(" at ");
  const label = `${resume.profile.name || "Resume"}, version ${resume.version}`;
  // The same order and grouping as the sheet model (src/shared/sheet.ts), so the copy reads as the PDF does:
  // contact details with links, every role that isn't education under Experience, then Education.
  const contact = [resume.profile.email, resume.profile.phone, resume.profile.location, ...resume.profile.links].filter(Boolean);
  const groups = [
    { heading: "Experience", roles: resume.sections.filter((section) => section.kind !== "education") },
    { heading: "Education", roles: resume.sections.filter((section) => section.kind === "education") },
  ].filter((group) => group.roles.length > 0);
  const line = (value: SharedLine, bullet = false) => (
    <>
      {bullet ? presentResumeBullet(value.text) : value.text}
      {value.verification !== "verified" && (
        <small className="app-share__flag">
          {" "}
          ({value.verification === "user-authored" ? "written by the owner" : "not checked"})
        </small>
      )}
    </>
  );
  return (
    <section className="app-share__resume" aria-label={job ? `${label}, tailored for ${job}` : label}>
      <div className="app-share__resume-head">
        <div>
          <h2>{label}</h2>
          {job && <p className="rs-meta app-share__job">Tailored for {job}</p>}
        </div>
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
          {groups.map((group) => (
            <section key={group.heading}>
              <h2>{group.heading}</h2>
              {group.roles.map((section, index) => {
                const dates = formatRoleDates(section.startDate, section.endDate, section.unknownEndStartDate);
                return (
                  <div className="rs-sheet__role" key={`${section.id}:${index}`}>
                    <div className="rs-sheet__role-head">
                      <h3>{[section.title, section.org].filter(Boolean).join(", ")}</h3>
                      {dates && <span className="rs-sheet__dates">{dates}</span>}
                    </div>
                    {section.lines.length > 0 && (
                      <ul>
                        {section.lines.map((value) => (
                          <li key={value.id}>{line(value, true)}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </section>
          ))}
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
