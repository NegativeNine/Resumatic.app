import { useEffect, useRef, type ReactNode } from "react";
import { useLiveProgress } from "../live";
import { feedbackHref } from "../config";
import { formatDate, formatMonth } from "../format";
import { href, type Route } from "../router";
import { useSession } from "../session";

const NAV: { to: string; label: string; pages: readonly Route["page"][] }[] = [
  { to: href.sources, label: "Sources & facts", pages: ["sources"] },
  {
    to: href.applications,
    label: "Applications",
    pages: ["applications", "resume"],
  },
  { to: href.account, label: "Account", pages: ["account"] },
];

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
  const main = useRef<HTMLElement>(null);
  const routeKey = route.page === "resume" ? `resume/${route.id}` : route.page;
  const shownKey = useRef(routeKey);

  useEffect(() => {
    document.title = `${title} · Resumatic`;
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
      <header className="site-header">
        <div className="site-header-inner">
          <div className="topline">
            <a className="brand" href={href.sources}>
              Resumatic <span className="beta">Private beta</span>
            </a>
            <QuotaLine />
          </div>
          <nav className="nav" aria-label="Main">
            <ul>
              {NAV.map((item) => (
                <li key={item.to}>
                  <a
                    href={item.to}
                    aria-current={
                      item.pages.includes(route.page) ? "page" : undefined
                    }
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
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
    <footer className="site-footer">
      <nav aria-label="About Resumatic">
        <a href={href.privacy}>Privacy</a>
        <a href={href.terms}>Terms</a>
        <a href={feedbackHref}>Send feedback</a>
      </nav>
    </footer>
  );
}

function QuotaLine() {
  const { used, limit, reserved = 0, month, periodEnd } = useSession().me.quota;
  return (
    <p className={used + reserved >= limit ? "quota quota-full" : "quota"}>
      {used} of {limit} outputs used{reserved > 0 && ` · ${reserved} reserved`}
      {periodEnd
        ? ` · renews ${formatDate(periodEnd)}`
        : ` · ${formatMonth(month)}`}
    </p>
  );
}
