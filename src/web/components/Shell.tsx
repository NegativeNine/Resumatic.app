import { Fragment, useEffect, useRef, type ReactNode } from "react";
import type { Me } from "../../shared/api";
import type { Today } from "../../shared/today";
import { api } from "../api";
import { feedbackHref } from "../config";
import { useResource } from "../hooks";
import { COUNTS_CHANGED, useLiveProgress } from "../live";
import { ACCOUNT_ANCHORS, href, ROOM_TABS, ROOMS, routeKey, TODAY_OPEN, type NavItem, type Route } from "../router";
import { useSession } from "../session";
import { TodayContext } from "../today";
import { AccountMenu } from "./AccountMenu";
import { Lockup } from "./Lockup";
import { QuotaMeter } from "./QuotaMeter";

// The frame of every signed-in page: the first row names the rooms of the workspace, the second
// the pages of the room, and the name opens the account menu. A count says how many things wait
// for the person there, in amber, and nothing else is counted.

/** What the mark beside the lockup says, and what the rooms' row is called, in each workspace. */
const WORKSPACE_NAME = { seeking: "Private beta", coaching: "Coaching", hiring: "Hiring" } as const;
const ROOMS_NAME = { seeking: "Rooms", coaching: "Coaching", hiring: "Hiring" } as const;

const hasCapability = (me: Me, item: NavItem) => !item.needs || me.capabilities?.[item.needs] === true;

/**
 * A link that names its count in words, such as "Facts, 7 waiting for you"; the number beside it is
 * for the eye. The words are in the link rather than in an aria-label, so the name a person hears
 * starts with the word they see.
 */
function CountedLink({ item, current, count, countClass }: { item: NavItem; current: boolean; count: number; countClass: string }) {
  const shown = count.toLocaleString();
  return (
    <a href={item.to} aria-current={current ? "page" : undefined}>
      {item.label}
      {count > 0 && (
        <>
          <span className={countClass} aria-hidden="true">
            {shown}
          </span>
          <span className="rs-visually-hidden">{`, ${shown} waiting for you`}</span>
        </>
      )}
    </a>
  );
}

export function Shell({
  route,
  title,
  children,
}: {
  route: Route;
  title: string;
  children: ReactNode;
}) {
  useLiveProgress();
  const { me } = useSession();
  const loaded = useResource(api.today, (today) => today.working.length > 0);
  const reload = loaded.reload;
  // A failure of any kind, an older server's included, shows no count from Today at all.
  const today: Today | undefined = loaded.error ? undefined : loaded.data;
  const main = useRef<HTMLElement>(null);
  const key = routeKey(route);
  const shownKey = useRef(key);
  const section = route.name === "account" ? route.params.section : undefined;
  const place = `${route.workspace}/${route.room ?? ""}`;
  const shownPlace = useRef(place);

  useEffect(() => {
    document.title = `${title} – Resumatic`;
  }, [title]);

  // Today is read again on a change of room or workspace, not of tab, and after a change this tab
  // made. The live socket's changes reach it as they reach every resource.
  useEffect(() => {
    if (shownPlace.current === place) return;
    shownPlace.current = place;
    void reload();
  }, [place, reload]);
  useEffect(() => {
    const changed = () => void reload();
    window.addEventListener(COUNTS_CHANGED, changed);
    return () => window.removeEventListener(COUNTS_CHANGED, changed);
  }, [reload]);

  // A new screen moves focus to the page. An Account section named in the address is focused
  // instead, on the first page too, or the page if this account shows no such section.
  useEffect(() => {
    const moved = shownKey.current !== key;
    shownKey.current = key;
    if (section) {
      const target = document.getElementById(ACCOUNT_ANCHORS[section]);
      if (target) {
        target.scrollIntoView?.({ block: "start" });
        target.focus({ preventScroll: true });
        return;
      }
    } else if (!moved) return;
    window.scrollTo(0, 0);
    main.current?.focus({ preventScroll: true });
  }, [key, section]);

  // Until Today opens, each room counts what waits in it. A coach's comment is counted from the
  // session until Today has loaded, or when it can't be, so it is never left uncounted.
  const sharing = today ? today.counts.sharing : (me.newFromCoach ?? 0);
  const toCheck = today ? today.waiting.reduce((sum, item) => (item.kind === "check" ? sum + item.roles + item.facts : sum), 0) : 0;
  const roomCount = (key: NavItem["key"]): number => {
    if (route.workspace !== "seeking") return 0;
    if (TODAY_OPEN) return key === "today" ? (today?.counts.today ?? 0) : 0;
    if (key === "facts") return today?.counts.facts ?? 0;
    if (key === "jobs") return today?.counts.jobs ?? 0;
    if (key === "sharing") return sharing;
    return 0;
  };
  const tabCount = (key: NavItem["key"]): number => (key === "check" ? toCheck : key === "coaches" ? sharing : 0);

  const seeking = route.workspace === "seeking";
  const room = seeking ? ROOMS.seeking.find((item) => item.key === route.room) : undefined;
  const tabs = room ? ROOM_TABS[room.key as keyof typeof ROOM_TABS]?.filter((item) => hasCapability(me, item)) : undefined;

  return (
    <TodayContext value={{ today, reload }}>
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          main.current?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="rs-header">
        <div className="rs-header__inner">
          <a className="rs-brand" href={href.today} aria-label="Resumatic, go to Today">
            <Lockup className="app-brand-wordmark" />
          </a>
          <span className="rs-mark rs-mark--beta">{WORKSPACE_NAME[route.workspace]}</span>
          <nav className="app-rooms" aria-label={ROOMS_NAME[route.workspace]}>
            <ul className="rs-nav">
              {ROOMS[route.workspace].filter((item) => hasCapability(me, item)).map((item) => (
                <li key={item.key}>
                  <CountedLink
                    item={item}
                    current={seeking ? item.key === route.room : item.key === route.tab}
                    count={roomCount(item.key)}
                    countClass="rs-nav__count"
                  />
                </li>
              ))}
            </ul>
          </nav>
          <div className="rs-header__end">
            {seeking && <QuotaMeter />}
            <AccountMenu route={route} />
          </div>
        </div>
      </header>
      {room && tabs && (
        <nav className="app-sub" aria-label={room.label}>
          <div className="app-sub__inner">
            <ul className="app-tabs">
              {tabs.map((item) => (
                <li key={item.key}>
                  <CountedLink item={item} current={item.key === route.tab} count={tabCount(item.key)} countClass="app-n" />
                </li>
              ))}
            </ul>
          </div>
        </nav>
      )}
      <main className="page" id="main" ref={main} tabIndex={-1}>
        <Fragment key={key}>{children}</Fragment>
      </main>
      <SiteFooter />
    </TodayContext>
  );
}

export function SiteFooter() {
  return (
    <footer className="rs-footer">
      <nav className="app-footer-nav" aria-label="About Resumatic">
        <a href={href.privacy}>Privacy</a>
        <a href={href.terms}>Terms</a>
        <a href={feedbackHref}>Send feedback</a>
      </nav>
    </footer>
  );
}
