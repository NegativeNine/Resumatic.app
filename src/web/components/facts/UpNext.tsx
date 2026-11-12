import { FACT_KIND_LABEL } from "../../format";
import { href } from "../../router";
import type { ReviewQuestion } from "../../vault";
import { Tick } from "../ui";
import { questionText } from "./Question";

/** How many of the questions after this one Up next lists. */
export const UP_NEXT_MAX = 4;

/** What a role is, said beside it: confirming one of its facts confirms it too. */
export const ROLE_NOTE = "A role. Saying one of its facts is right confirms the role too.";

function meta(question: ReviewQuestion): string {
  if (question.kind === "role") return ROLE_NOTE;
  const kind = FACT_KIND_LABEL[question.fact.kind];
  return question.role ? `${kind}, at ${question.role.org}` : `${kind}, not tied to a role`;
}

/**
 * The questions after this one, to read ahead. They are words only: each is answered when it is
 * the question, so nothing here can be pressed but the way to add what isn't here.
 */
export function UpNext({ questions }: { questions: ReviewQuestion[] }) {
  return (
    <section className="rs-panel facts-upnext" aria-labelledby="facts-upnext-heading">
      <h2 id="facts-upnext-heading" className="rs-h3">
        Up next
      </h2>
      {questions.length > 0 && (
        <ol className="facts-upnext__list">
          {questions.slice(0, UP_NEXT_MAX).map((question) => (
            <li key={question.key} className="app-q">
              <Tick state="needs-you" />
              <div>
                <p className="app-q__t facts-upnext__text">{questionText(question)}</p>
                <p className="rs-meta">{meta(question)}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
      <p className="rs-meta facts-upnext__add">
        Something true that isn’t here? <a href={href.factsAll}>Add a fact or a role yourself</a>.
      </p>
    </section>
  );
}
