import { useEffect, useRef, type ReactNode } from "react";
import { useLiveProgress } from "../live";
import { feedbackHref } from "../config";
import { href, type Route } from "../router";
import { useSession } from "../session";
import { BrandMark, Lockup } from "./Lockup";
import { QuotaMeter } from "./QuotaMeter";

type NavItem = { to: string; label: string; pages: readonly Route["page"][] };
const NAV: NavItem[] = [
  { to: href.facts, label: "Facts", pages: ["facts"] },
  // A resume belongs to the job it was tailored for, so Jobs stays current on a resume page.
  { to: href.jobs, label: "Jobs", pages: ["jobs", "resume"] },
  { to: href.account, label: "Account", pages: ["account"] },
];
/** Shown only to someone with a client, or on the page itself: most people here are nobody's coach. */
const CLIENTS: NavItem = { to: href.clients, label: "Clients", pages: ["clients"] };

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
  const clients = useSession().me.clients ?? 0;
  const main = useRef<HTMLElement>(null);
  const routeKey = route.page === "resume" ? `resume/${route.id}` : route.page;
  const shownKey = useRef(routeKey);

  useEffect(() => {
    document.title = `${title} – Resumatic`;
  }, [title]);

  useEffect(() => {
    if (shownKey.current === routeKey) return;
    shownKey.current = routeKey;
    window.scrollTo(0, 0);
    main.current?.focus({ preventScroll: true });
  }, [routeKey]);

  return (
    <>
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
          <a className="rs-brand" href={href.facts} aria-label="Resumatic, go to Facts">
            <Lockup className="app-brand-lockup" />
            <BrandMark className="app-brand-mark" />
          </a>
          <span className="rs-mark rs-mark--beta">Private beta</span>
          <nav className="app-nav" aria-label="Main">
            <ul className="rs-nav">
              {(clients > 0 || route.page === "clients" ? [NAV[0]!, NAV[1]!, CLIENTS, NAV[2]!] : NAV).map((item) => (
                <li key={item.to}>
                  <a href={item.to} aria-current={item.pages.includes(route.page) ? "page" : undefined}>
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="rs-header__end">
            <QuotaMeter />
          </div>
        </div>
      </header>
      <main className="page" id="main" ref={main} tabIndex={-1}>
        {children}
      </main>
      <SiteFooter />
    </>
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
