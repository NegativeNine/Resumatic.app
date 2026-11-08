import type { SheetLine, SheetModel } from "../../shared/sheet";

/**
 * The resume sheet (ResumePaper): exactly what the PDF prints, from the same model as
 * src/render/template.ts, in the PDF's own type and colors in every theme. Nothing on the paper
 * but the resume: status, evidence and tools live in the margin.
 */
export function ResumePaper({
  model,
  open,
  onToggleLine,
}: {
  model: SheetModel;
  /** Lines whose notes are open, tinted on the sheet (never printed). */
  open: ReadonlySet<string>;
  /** Clicking a line opens its note. The note's toggle is the keyboard path. */
  onToggleLine?: (lineId: string) => void;
}) {
  const props = (l: SheetLine, className?: string) => ({
    className: ["rs-line", className, open.has(l.line.id) ? "is-open" : ""].filter(Boolean).join(" "),
    "data-line-id": l.line.id,
    onClick: onToggleLine ? () => onToggleLine(l.line.id) : undefined,
  });

  return (
    <article className="rs-sheet" aria-label="Resume preview">
      {model.name && <h1>{model.name}</h1>}
      {model.contact.length > 0 && <p className="rs-sheet__contact">{model.contact.join(" · ")}</p>}
      {model.summary && <p {...props(model.summary, "rs-sheet__summary")}>{model.summary.text}</p>}
      {model.sections.map((section) => (
        <section key={section.heading}>
          <h2>{section.heading}</h2>
          {section.roles.map((role) => (
            <div className="rs-sheet__role" key={role.index}>
              <div className="rs-sheet__role-head">
                <h3>{role.heading}</h3>
                <span className="rs-sheet__dates">{role.dates}</span>
              </div>
              {role.lines.length > 0 && <ul>{role.lines.map((l) => (
                    <li key={l.line.id} {...props(l)}>
                      {l.text}
                    </li>
                  ))}</ul>}
            </div>
          ))}
        </section>
      ))}
      {model.skills.length > 0 && (
        <section>
          <h2>Skills</h2>
          <p>{model.skills.join(" · ")}</p>
        </section>
      )}
    </article>
  );
}
