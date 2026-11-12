import { useId } from "react";
import type { TodayWaiting } from "../../../shared/today";
import { waitingRow } from "../../pages/today/rows";
import { Tick } from "../ui";

/**
 * The one next step at the top of Today: amber while it waits for the person, with its title, one
 * sentence and the page's one green button, which goes to the page that resolves it.
 */
export function NextStep({ item }: { item: TodayWaiting }) {
  const id = useId();
  const row = waitingRow(item);
  return (
    <section className="rs-next" aria-labelledby={id}>
      <p className="rs-next__label">
        <Tick state="needs-you" />
        Next for you
      </p>
      <div>
        <h2 className="rs-next__title" id={id}>
          {row.nextTitle}
        </h2>
        <p className="rs-next__text">{row.sentence}</p>
      </div>
      <a className="rs-btn rs-btn--primary" href={row.to}>
        {row.action}
      </a>
    </section>
  );
}
