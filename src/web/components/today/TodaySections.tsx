import { useId } from "react";
import type { Today, TodayEvent, TodayWaiting, TodayWorking } from "../../../shared/today";
import { formatDate, formatDateTime } from "../../format";
import { eventSentence, waitingRow, workingRow } from "../../pages/today/rows";
import { href } from "../../router";
import { Tick } from "../ui";

// The lists of Today's main column: what else waits, what Resumatic is working on, and what
// happened lately. Each is left out when it has nothing to say.

const waitingKey = (item: TodayWaiting): string => {
  switch (item.kind) {
    case "unreadable":
      return `unreadable/${item.sourceId}`;
    case "check":
      return `check/${item.sourceId ?? ""}`;
    case "kit":
      return `kit/${item.applicationId}`;
    case "comments":
    case "suggestions":
      return `${item.kind}/${item.grantId}`;
  }
};

/**
 * What waits besides the next step, one row each. Its heading counts them in the header's units,
 * `count`, and when the rows show fewer than the header counts, a closing line says where the rest
 * are. Shown when it has a row or a count.
 */
export function WaitingSection({ items, count, more }: { items: TodayWaiting[]; count: number; more: boolean }) {
  const id = useId();
  if (items.length === 0 && count === 0) return null;
  const shown = count.toLocaleString();
  return (
    <section className="rs-panel" aria-labelledby={id}>
      <h2 id={id} className="rs-h3">
        Also waiting for you
        {count > 0 && (
          <>
            <span className="app-n" aria-hidden="true">
              {shown}
            </span>
            <span className="rs-visually-hidden">{`, ${shown}`}</span>
          </>
        )}
      </h2>
      {items.length > 0 && (
        <ul className="app-today-rows">
          {items.map((item, index) => {
            const row = waitingRow(item);
            const titleId = `${id}-${index}`;
            return (
              <li key={waitingKey(item)} className="app-q">
                <Tick state={row.tick} />
                <div>
                  <p className="app-q__t" id={titleId}>
                    {row.title}
                  </p>
                  <p className="rs-meta">{row.sentence}</p>
                </div>
                <a className="rs-btn rs-btn--sm" href={row.to} aria-describedby={titleId}>
                  {row.action}
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {more && (
        <p className="rs-meta">
          More are waiting than this list shows. <a href={href.facts}>Facts</a>, <a href={href.jobs}>Jobs</a> and{" "}
          <a href={href.sharing}>Sharing</a> each list all of theirs.
        </p>
      )}
    </section>
  );
}

const workingKey = (item: TodayWorking): string =>
  item.kind === "reading" ? `reading/${item.sourceId}` : item.kind === "tailoring" ? `tailoring/${item.resumeId}` : `document/${item.documentId}`;

/** Work in progress, each with how far it has got and a way to open it. */
export function WorkingSection({ items }: { items: TodayWorking[] }) {
  const id = useId();
  if (items.length === 0) return null;
  return (
    <section className="rs-panel" aria-labelledby={id}>
      <h2 id={id} className="rs-h3">
        Resumatic is working on
      </h2>
      <ul className="app-today-rows">
        {items.map((item, index) => {
          const row = workingRow(item);
          const titleId = `${id}-${index}`;
          return (
            <li key={workingKey(item)} className="app-q">
              <Tick state="working" />
              <div>
                <p className="app-q__t" id={titleId}>
                  {row.title}
                </p>
                <p className="rs-meta" role="status">
                  {row.status}
                </p>
              </div>
              <a className="rs-btn rs-btn--sm" href={row.to} aria-describedby={titleId}>
                Open
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The moment as a <time> element states it, or nothing for a time no date can hold. */
function machineTime(at: number): string | undefined {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

const eventKey = (event: TodayEvent): string =>
  event.kind === "resumeReady" ? `${event.kind}/${event.resumeId}/${event.version}` : `${event.kind}/${event.grantId}/${event.at}`;

/** What happened since `since`, newest first, as sentences with their times. */
export function RecentSection({ today, events }: { today: Today; events: TodayEvent[] }) {
  const id = useId();
  if (events.length === 0) return null;
  return (
    <section className="rs-panel" aria-labelledby={id}>
      <h2 id={id} className="rs-h3">
        Since {formatDate(today.since)}
      </h2>
      <ul className="app-list app-today-recent">
        {events.map((event) => (
          <li key={eventKey(event)}>
            <span>{eventSentence(event)}</span> <time className="rs-meta" dateTime={machineTime(event.at)}>{formatDateTime(event.at)}</time>
          </li>
        ))}
      </ul>
    </section>
  );
}
