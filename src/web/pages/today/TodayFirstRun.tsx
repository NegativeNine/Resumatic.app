import { useId, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { AddSource, type AddSourceState } from "../../components/AddSource";
import { Tick, type TickState } from "../../components/ui";
import type { Reload } from "../../hooks";
import { href } from "../../router";

/** One of the three first steps: its tick, its numbered title, a sentence, and what it offers. */
function Step({ tick, title, text, children }: { tick: TickState; title: string; text: string; children?: ReactNode }) {
  return (
    <li className="app-q">
      <Tick state={tick} />
      <div>
        <h3 className="app-q__t">{title}</h3>
        <p className="rs-meta">{text}</p>
        {children}
      </div>
    </li>
  );
}

/**
 * Today before the record holds anything: three steps, the first open with the Facts page's own
 * way to add a file or paste text, and what Resumatic won't do. The page keeps what is being added,
 * because adding the first file ends first run and with it this view.
 */
export function TodayFirstRun({
  reload,
  adding,
  onAdding,
  children,
}: {
  reload: Reload;
  adding: AddSourceState;
  onAdding: Dispatch<SetStateAction<AddSourceState>>;
  /** What waits or is under way, under the steps. */
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="app-cols">
      <div className="app-main app-stack">
        <section className="rs-panel" aria-labelledby={`${id}-steps`}>
          <h2 id={`${id}-steps`} className="rs-visually-hidden">
            Three steps to a tailored resume
          </h2>
          <ol className="app-today-steps">
            <Step tick="needs-you" title="1. Add the resume you have" text="Resumatic reads it and lists what you’ve done, each with the words it came from.">
              <AddSource onAdded={reload} size="first-run" state={adding} onState={onAdding} />
              <p className="rs-meta">
                No file to hand? <a href={href.factsAll}>Add a fact yourself</a>.
              </p>
            </Step>
            <Step tick="todo" title="2. Check what Resumatic found" text="“Is this right?”, one fact at a time. Nothing is used until you say it is." />
            <Step
              tick="todo"
              title="3. Tailor it to a job"
              text="Add a job description and get a resume that uses only what’s in your record, with every line checked."
            />
          </ol>
        </section>
        {children}
      </div>
      <aside className="app-side app-stack" aria-label="What to expect">
        <section className="rs-panel" aria-labelledby={`${id}-wont`}>
          <h2 id={`${id}-wont`} className="rs-h3">
            What Resumatic won’t do
          </h2>
          <ul className="app-list">
            <li>Make up a number, a title or a skill. If a job asks for something your record doesn’t show, it tells you.</li>
            <li>Share or send anything until you choose to.</li>
            <li>Sell your data, or share it for marketing.</li>
          </ul>
        </section>
        <section className="rs-panel" aria-labelledby={`${id}-data`}>
          <h2 id={`${id}-data`} className="rs-h3">
            Your data
          </h2>
          <p>Your record is kept in its own database, separate from everyone else’s. You can download all of it or delete your account at any time.</p>
          <p className="app-today-action">
            <a href={href.accountSection("data")}>See your data</a>
          </p>
        </section>
      </aside>
    </div>
  );
}
