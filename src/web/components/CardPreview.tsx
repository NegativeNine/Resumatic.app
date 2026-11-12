import { useId } from "react";
import type { CardPreview, ExperienceBand, PrivateCard } from "../../shared/card";
import { loadCardPreview } from "../card-preview";
import { useResource } from "../hooks";
import { href } from "../router";
import { ErrorNote, Loading, Message } from "./ui";

// The Card preview section on Account: the card a recruiter would see if its owner ever chose to be
// found. It loads from its own route, is shown to its owner alone, and changes nothing: there is no
// way to make a card visible to anyone. docs/visibility-design.md says what a card holds.

const EXPERIENCE: Record<ExperienceBand | "unknown", string> = {
  "under-2": "Under 2 years",
  "2-5": "2 to 5 years",
  "5-10": "5 to 10 years",
  "10-plus": "10 years or more",
  unknown: "Unknown: a confirmed job is missing a date",
};

export function CardPreviewSection() {
  const preview = useResource(loadCardPreview);
  const id = useId();
  return (
    <section className="card app-card-preview" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Card preview</h2>
      <p className="card-text meta">
        If you ever chose to be found, recruiters would see a card like this instead of your resume. It’s built only from
        tags you’ve confirmed on your jobs and facts. It never holds your name, employers, dates or your own words, or
        anything from a fact you’ve marked sensitive.
      </p>
      <Message tone="info" live={false}>
        Only you can see this. Nothing is published: there’s no way to make a card visible to anyone, and this preview
        doesn’t change that.
      </Message>
      {preview.error ? (
        <ErrorNote message={preview.error} onRetry={preview.reload} />
      ) : !preview.data ? (
        <Loading>Loading your card…</Loading>
      ) : (
        <PreviewBody preview={preview.data} />
      )}
      <p className="card-text meta">
        A card would also say where you’d work, the kinds of job you want and when you could start. Those come from your
        job preferences, which this preview doesn’t read.
      </p>
      <p className="card-text meta">
        Occupations and skills come from ESCO and O*NET. <a href={href.privacy}>See the credits</a>
      </p>
    </section>
  );
}

function PreviewBody({ preview }: { preview: CardPreview }) {
  if (preview.state === "unavailable")
    return (
      <p className="card-text">
        The card preview isn’t available here yet. It needs the list of occupations and skills that tags come from, and
        that isn’t connected.
      </p>
    );
  const { card } = preview;
  return (
    <>
      {!card.occupation && !card.skills.length && (
        <p className="card-text">
          Your card is empty. It uses only confirmed tags, and none of yours are confirmed: tags are still being tested,
          and nobody can confirm one in Resumatic yet.
        </p>
      )}
      <CardFields card={card} />
    </>
  );
}

function CardFields({ card }: { card: PrivateCard }) {
  return (
    <dl className="app-card-preview__fields">
      <div>
        <dt>Occupation</dt>
        <dd>{card.occupation ? card.occupation.label : "Not known yet"}</dd>
      </div>
      <div>
        <dt>Experience</dt>
        <dd>
          <span>{card.experience === null ? "No confirmed jobs yet" : EXPERIENCE[card.experience]}</span>
          <p className="hint">
            Counted from your confirmed jobs’ dates, with overlaps counted once.
          </p>
        </dd>
      </div>
      <div>
        <dt>Skills</dt>
        <dd>
          {card.skills.length ? (
            <ul>
              {card.skills.map((skill) => (
                <li key={skill.id}>{skill.label}</li>
              ))}
            </ul>
          ) : (
            <span>None confirmed yet</span>
          )}
          <p className="hint">
            Each is shown as the broader group it belongs to, and only if a confirmed fact shows it.
          </p>
        </dd>
      </div>
    </dl>
  );
}
