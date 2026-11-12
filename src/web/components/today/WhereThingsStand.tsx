import { useId } from "react";
import type { Me } from "../../../shared/api";
import type { Today } from "../../../shared/today";
import { standingLines } from "../../pages/today/rows";
import { href } from "../../router";

/** One line per room, each linking to it: numbers only, and the plan. */
export function WhereThingsStand({ today, me }: { today: Today; me: Me }) {
  const id = useId();
  return (
    <section className="rs-panel" aria-labelledby={id}>
      <h2 id={id} className="rs-h3">
        Where things stand
      </h2>
      <ul className="app-list app-today-stand">
        {standingLines(today, me).map((line) => (
          <li key={line.key}>
            <a href={line.to}>{line.label}</a>
            <p className="rs-meta">{line.text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What email notices say and when, where the deployment sends them, with the way to choose them. */
export function ByEmail({ me }: { me: Me }) {
  const id = useId();
  if (!me.capabilities?.emailNotices) return null;
  return (
    <section className="rs-panel" aria-labelledby={id}>
      <h2 id={id} className="rs-h3">
        By email
      </h2>
      <p className="rs-meta">
        Resumatic can email you when a coach comments or suggests new wording, and when facts have waited 3 days for you to check them. An email
        says only that something is waiting, never what it says.
      </p>
      <p className="app-today-action">
        <a className="rs-btn rs-btn--sm" href={href.accountSection("notifications")}>
          Choose what to email
        </a>
      </p>
    </section>
  );
}
