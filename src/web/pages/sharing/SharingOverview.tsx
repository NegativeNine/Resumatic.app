import { useId } from "react";
import type { Me } from "../../../shared/api";
import type { McpGrant } from "../../../shared/mcp";
import type { ShareGrant } from "../../../shared/sharing";
import type { Today } from "../../../shared/today";
import { api } from "../../api";
import { permissions } from "../../components/ConnectedApps";
import { shareContents } from "../../components/sharing/Copies";
import { Badge, ErrorNote, Loading, PageHeader, Tick } from "../../components/ui";
import { count, formatDate } from "../../format";
import { useResource } from "../../hooks";
import { href } from "../../router";
import { useSession } from "../../session";
import { useToday } from "../../today";
import "../../styles/rooms/sharing.css";

// Sharing › Overview: the three ways anything could leave the record, and what each holds now. It
// summarises; it reads only the owner's own copies, the apps they connected and Today as the shell
// loaded it. It never reads a comment thread or marks one seen, so a coach's comments stay new
// until the person opens Coaches. Names here are other people's words or the owner's own labels,
// shown as text.

/** The most copies "Open now" names. The rest are counted. */
const MAX_NAMED = 3;

export function SharingOverview() {
  const { me } = useSession();
  return (
    <>
      <PageHeader title="Sharing">
        The three ways anything could leave your record, and what each holds now. Nothing leaves without your choice.
      </PageHeader>
      <div className="app-sharing-ways">
        <CoachesWay />
        <RecruitersWay />
        {/* The apps are asked for only where they can be connected at all. */}
        {me.capabilities?.connectedApps ? <AppsWay /> : <AppsOff />}
      </div>
      <NeverLeaves />
    </>
  );
}

/** What waits for the person on Coaches: the number the Coaches tab shows. */
function coachesWaiting(today: Today | undefined, me: Me): number {
  return today ? today.counts.sharing : (me.newFromCoach ?? 0);
}

function CoachesWay() {
  const { me } = useSession();
  const { today } = useToday();
  const copies = useResource(api.shares);
  const id = useId();
  const waiting = coachesWaiting(today, me);
  return (
    <section className="rs-panel app-sharing-way" aria-labelledby={id}>
      <div className="app-row">
        <h2 id={id} className="rs-h2">
          Coaches
        </h2>
        {waiting > 0 && <Badge tone="needs-you">{`${waiting.toLocaleString()} waiting for you`}</Badge>}
      </div>
      <p className="app-sharing-way__text">
        A coach reads a fixed copy you chose. They can comment and suggest wording. Only you can change anything.
      </p>
      <dl className="app-kv">
        <dt>Open now</dt>
        <dd>
          {copies.error ? (
            <ErrorNote message={copies.error} onRetry={copies.reload} />
          ) : !copies.data ? (
            <Loading>Loading your copies…</Loading>
          ) : (
            <Lines lines={openCopies(copies.data.grants, Date.now())} />
          )}
        </dd>
        <dt>Waiting for you</dt>
        <dd>{coachesWaitingWords(today, me)}</dd>
      </dl>
      <p className="app-sharing-way__links">
        <a className="rs-btn rs-btn--sm" href={href.coaches}>
          Open Coaches
        </a>
      </p>
    </section>
  );
}

/** One sentence for each copy a coach can open now, up to three, then what is left and what is closed. */
function openCopies(grants: readonly ShareGrant[], now: number): string[] {
  const live = grants.filter((grant) => grant.revokedAt === null && grant.expiresAt > now);
  const active = live.filter((grant) => grant.available !== false);
  const closed = live.length - active.length;
  const lines = active.length
    ? active
        .slice(0, MAX_NAMED)
        .map(
          (grant) =>
            `${grant.label || grant.coach?.name || grant.coach?.email || "A link"}: ${shareContents(grant)}, until ${formatDate(grant.expiresAt)}.`,
        )
    : ["No copy is open."];
  if (active.length > MAX_NAMED) lines.push(`and ${(active.length - MAX_NAMED).toLocaleString()} more.`);
  if (closed > 0) lines.push(`${count(closed, "copy", "copies")} closed for now.`);
  return lines;
}

/** What waits on Coaches, in words: from Today where it has loaded, otherwise from the session. */
function coachesWaitingWords(today: Today | undefined, me: Me): string {
  if (!today) {
    const comments = me.newFromCoach ?? 0;
    return comments > 0 ? `${count(comments, "new comment")}.` : "Nothing.";
  }
  let comments = 0;
  let suggestions = 0;
  for (const item of today.waiting) {
    if (item.kind === "comments") comments += item.count;
    else if (item.kind === "suggestions") suggestions += item.count;
  }
  // "Suggested wording" has no plural of its own, so it is counted in lines.
  const parts = [
    comments > 0 ? count(comments, "new comment") : "",
    suggestions > 0 ? count(suggestions, "line of suggested wording", "lines of suggested wording") : "",
  ].filter(Boolean);
  return parts.length ? `${parts.join(" and ")}.` : "Nothing.";
}

function RecruitersWay() {
  const id = useId();
  // It reads no route: what the person is looking for is read only by its own card on Recruiters.
  return (
    <section className="rs-panel app-sharing-way" aria-labelledby={id}>
      <h2 id={id} className="rs-h2">
        Recruiters
      </h2>
      <p className="app-sharing-way__text">
        No recruiter can find you today. What you’re looking for stays in your record, and nobody is shown it.
      </p>
      <dl className="app-kv">
        <dt>Open now</dt>
        <dd>Nothing.</dd>
      </dl>
      <p className="app-sharing-way__links">
        <a className="rs-btn rs-btn--sm" href={href.recruiters}>
          Open Recruiters
        </a>
      </p>
    </section>
  );
}

/**
 * Whether a connected app's access has ended, is waiting for it to finish connecting, or is in use:
 * the rules ConnectedApps applies to its own list, so the two never disagree.
 */
function appStanding(grant: McpGrant, now: number): "inactive" | "pending" | "active" | "other" {
  const inactive = grant.revokedAt !== null || grant.expiresAt <= now;
  if (inactive) return "inactive";
  if (grant.state === "pending") return "pending";
  if (grant.state === "active") return "active";
  return "other";
}

function AppsWay() {
  const grants = useResource(api.mcpGrants);
  const id = useId();
  const now = Date.now();
  const all = grants.data?.grants ?? [];
  const active = all.filter((grant) => appStanding(grant, now) === "active");
  const pending = all.filter((grant) => appStanding(grant, now) === "pending");
  return (
    <section className="rs-panel app-sharing-way" aria-labelledby={id}>
      <div className="app-row">
        <h2 id={id} className="rs-h2">
          Connected apps
        </h2>
        {active.length > 0 && <Badge tone="backed">{`${active.length.toLocaleString()} connected`}</Badge>}
      </div>
      <p className="app-sharing-way__text">
        An app you connect can do only what you allowed, and only until its access runs out.
      </p>
      {grants.error ? (
        <ErrorNote message={grants.error} onRetry={grants.reload} />
      ) : !grants.data ? (
        <Loading>Loading your apps…</Loading>
      ) : (
        <dl className="app-kv">
          <dt>Open now</dt>
          <dd>
            <Lines
              lines={
                active.length
                  ? active.map((grant) => `${grant.clientName}: ${permissions(grant.scopes)} Access ends ${formatDate(grant.expiresAt)}.`)
                  : ["No app is connected."]
              }
            />
          </dd>
          {pending.length > 0 && (
            <>
              <dt>Waiting</dt>
              <dd>
                <Lines lines={pending.map((grant) => `${grant.clientName} hasn’t finished connecting.`)} />
              </dd>
            </>
          )}
        </dl>
      )}
      <p className="app-sharing-way__links">
        <a className="rs-btn rs-btn--sm" href={href.apps}>
          Open Connected apps
        </a>
      </p>
    </section>
  );
}

/** Where this deployment has connected apps off: nothing to ask for, and nowhere to go. */
function AppsOff() {
  const id = useId();
  return (
    <section className="rs-panel app-sharing-way" aria-labelledby={id}>
      <h2 id={id} className="rs-h2">
        Connected apps
      </h2>
      <p className="app-sharing-way__text">Connected apps aren’t turned on here, so no app can reach your record.</p>
    </section>
  );
}

/** Sentences one under another. */
function Lines({ lines }: { lines: readonly string[] }) {
  return (
    <>
      {lines.map((line, index) => (
        <span className="app-kv__line" key={index}>
          {line}
        </span>
      ))}
    </>
  );
}

const NEVER: { title: string; text: string; link?: { label: string; to: string } }[] = [
  {
    title: "Facts you keep private",
    text: "They’re left out of every new resume and letter, never put in a shared copy and never shown to a connected app.",
    link: { label: "See your facts", to: href.factsAll },
  },
  {
    title: "Your files",
    text: "A coach or an app can be given facts and resumes. Neither is given a file you added.",
    link: { label: "Your files", to: href.files },
  },
  {
    title: "The words a fact came from",
    text: "The words in your files can name a person or a client. No coach or app is shown them.",
  },
  {
    title: "Your pay floor",
    text: "It stays in your record. Nobody is shown it, and nothing uses it yet.",
  },
];

function NeverLeaves() {
  const id = useId();
  return (
    <section className="rs-panel app-sharing-never" aria-labelledby={id}>
      <h2 id={id} className="rs-h2">
        What never leaves your record
      </h2>
      <div className="app-sharing-never__rows">
        {NEVER.map((row) => (
          <div className="app-q" key={row.title}>
            <Tick state="left-out" />
            <div>
              <p className="app-q__t">{row.title}</p>
              <p className="rs-meta">{row.text}</p>
            </div>
            {row.link ? (
              <a className="rs-linkbtn" href={row.link.to}>
                {row.link.label}
              </a>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
      <p className="rs-meta app-sharing-never__notice">
        The <a href={href.privacy}>privacy notice</a> says what sharing and connected apps do with your data.
      </p>
    </section>
  );
}
