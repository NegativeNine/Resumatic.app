import type { ReactNode } from "react";
import { formatDate } from "../format";
import { presentResumeBullet } from "../../shared/resume-presentation";
import { formatRoleDates } from "../../shared/sheet";
import type { SharedDocument, SharedJob, SharedLine, SharedResume, SharedView, ShareTarget } from "../../shared/sharing";
import { Lockup } from "./Lockup";
import { Badge, Glyph } from "./ui";

/**
 * The frame around a shared copy: the lockup, then the page. The reader has no account here.
 * `wide` makes room for the comments beside the copy.
 */
export function ShareFrame({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="app-share">
      <header className="app-share__bar">
        <Lockup className="app-share__lockup" />
        <span className="rs-meta">Shared copy, read only</span>
      </header>
      <main className={wide ? "app-share__main app-share__main--comments" : "app-share__main"} id="main">
        {children}
      </main>
    </div>
  );
}

/**
 * What the copy's coach is given to comment with: which line or fact is chosen, how to choose
 * another, and the threads and form to show beside the copy.
 */
export interface ShareCommenting {
  selected: ShareTarget | null;
  onSelect(target: ShareTarget): void;
  aside: ReactNode;
}

/** Whether two targets name the same line of the same resume version, or the same fact. */
export function sameTarget(a: ShareTarget | null, b: ShareTarget | null): boolean {
  if (a === null || b === null || a.kind !== b.kind) return false;
  return a.kind === "line"
    ? b.kind === "line" && a.resumeId === b.resumeId && a.version === b.version && a.lineId === b.lineId
    : b.kind === "fact" && a.factId === b.factId;
}

/**
 * A line or a fact as a button, for the reader who can comment on it. It reads as the text it
 * holds, and says whether it is the one chosen. `sheet` is a line on the resume's paper, which
 * takes the sheet's own tint when chosen.
 */
function Pick({ target, commenting, sheet, children }: { target: ShareTarget; commenting: ShareCommenting; sheet?: boolean; children: ReactNode }) {
  const chosen = sameTarget(commenting.selected, target);
  return (
    <button
      type="button"
      className={["app-share__pick", sheet ? "rs-line" : "", sheet && chosen ? "is-open" : ""].filter(Boolean).join(" ")}
      aria-pressed={chosen}
      onClick={() => commenting.onSelect(target)}
    >
      {children}
    </button>
  );
}

const RESUME_CHECK: Readonly<Record<SharedResume["verification"], { tone: string; text: string }>> = {
  verified: { tone: "ready", text: "Every line checked against confirmed facts" },
  "user-authored": { tone: "mine", text: "Written by the owner" },
  mixed: { tone: "proposed", text: "Some lines haven\u2019t been checked" },
  unverified: { tone: "proposed", text: "Lines haven\u2019t been checked" },
};

/** Kept separate so the same read-only snapshot can be tested without a browser session. */
/** `notice` is said under the heading, before the copy: what a named coach can do with it, say. */
/**
 * `comments` is given only for the coach the copy names, once the copy is in their list. Each
 * resume line and each fact is then a button to choose, and the threads sit beside the copy.
 * Without it the copy is text to read, exactly as every other reader has it.
 */
export function ShareSnapshotContent({ view, notice, comments }: { view: SharedView; notice?: ReactNode; comments?: ShareCommenting }) {
  const { facts, resumes } = view.snapshot;
  const documents = view.snapshot.documents ?? [];
  const owner = view.snapshot.owner?.name || null;
  /** Several letters, say, are told apart by number when nothing else does it. */
  const numbered = (document: SharedDocument, index: number) =>
    documents.filter((other) => other.kind === document.kind).length > 1
      ? documents.slice(0, index + 1).filter((other) => other.kind === document.kind).length
      : null;
  const copy = (
    <>
      {facts.length > 0 && (
        <section className="rs-panel app-share__facts" aria-labelledby="share-facts">
          <h2 id="share-facts">Confirmed facts</h2>
          <ul className="plain-list">
            {facts.map((fact) => (
              <li key={fact.id}>
                <p>{comments ? <Pick target={{ kind: "fact", factId: fact.id }} commenting={comments}>{fact.text}</Pick> : fact.text}</p>
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
        <SharedResumeSheet resume={resume} comments={comments} key={`${resume.id}:${resume.version}`} />
      ))}
      {documents.map((document, index) => (
        <SharedDocumentSheet document={document} number={numbered(document, index)} key={`${document.id}:${document.version}`} />
      ))}
    </>
  );
  return (
    <ShareFrame wide={comments !== undefined}>
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
      {notice && <div className="app-share__notice">{notice}</div>}
      {comments ? (
        <div className="app-share__columns">
          <div className="app-share__copy">{copy}</div>
          <aside className="app-share__aside" aria-labelledby="share-comments">
            <h2 id="share-comments">Comments</h2>
            {comments.aside}
          </aside>
        </div>
      ) : (
        copy
      )}
    </ShareFrame>
  );
}

const DOCUMENT_NAMES: Readonly<Record<SharedDocument["kind"], string>> = {
  letter: "Cover letter",
  prep: "Interview preparation",
};

/** A cover letter's body, or interview questions with the points prepared for each. */
function SharedDocumentSheet({ document, number }: { document: SharedDocument & { job?: SharedJob | null }; number: number | null }) {
  const job = [document.job?.title, document.job?.company].filter(Boolean).join(" at ");
  const name = number === null ? DOCUMENT_NAMES[document.kind] : `${DOCUMENT_NAMES[document.kind]} ${number}`;
  return (
    <section className="app-share__resume" aria-label={job ? `${name}, for ${job}` : name}>
      <div className="app-share__resume-head">
        <div>
          <h2>{name}</h2>
          {job && <p className="rs-meta app-share__job">For {job}</p>}
        </div>
        <Badge tone="ready">
          <Glyph name="check" />
          Every sentence checked against confirmed facts
        </Badge>
      </div>
      {/* Paper like the resume's, but text to read at its own size, not a page scaled to fit. */}
      <article className="app-share__paper">
        {document.kind === "letter"
          ? document.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)
          : document.questions.map((item, index) => (
              <div className="app-share__question" key={index}>
                <h3>{item.question}</h3>
                {item.points.length > 0 ? (
                  <ul>
                    {item.points.map((point, at) => (
                      <li key={at}>{point}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="app-share__flag">Nothing prepared for this question.</p>
                )}
              </div>
            ))}
      </article>
    </section>
  );
}

function SharedResumeSheet({ resume, comments }: { resume: SharedResume & { job?: SharedJob | null }; comments?: ShareCommenting }) {
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
  const words = (value: SharedLine, bullet: boolean) => (
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
  // The summary and the lines under a role are what a coach can comment on. Headings, contact
  // details and skills are not lines, and have no ID in a copy to name them by.
  const line = (value: SharedLine, bullet = false) =>
    comments ? (
      <Pick target={{ kind: "line", resumeId: resume.id, version: resume.version, lineId: value.id }} commenting={comments} sheet>
        {words(value, bullet)}
      </Pick>
    ) : (
      words(value, bullet)
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
