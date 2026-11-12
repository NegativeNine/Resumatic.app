import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { api } from "../api";
import { useAction } from "../hooks";
import { href, type AccountSection, type Route, type Workspace } from "../router";
import { useSession } from "../session";
import { ActionError, Glyph } from "./ui";

// The menu under the person's name: who they are signed in as, their workspaces, Account's
// sections and Sign out. It is a disclosure, a button and the panel after it, not an ARIA menu:
// the panel holds headings and a button as well as links, and Tab moves through it as a page.

const SECTIONS: readonly { section: AccountSection; label: string }[] = [
  { section: "profile", label: "Profile" },
  { section: "plan", label: "Plan" },
  { section: "notifications", label: "Notifications" },
  { section: "data", label: "Your data" },
];

export function AccountMenu({ route }: { route: Route }) {
  const { me, endSession } = useSession();
  const [open, setOpen] = useState(false);
  const signOut = useAction();
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const whole = useRef<HTMLDivElement>(null);
  const name = me.profile.name.trim() || me.signInEmail || "Your account";
  const clients = me.clients ?? 0;
  const { used, limit } = me.quota;

  // Going anywhere closes it, and leaves focus where the new page puts it.
  useEffect(() => setOpen(false), [route]);

  // A press anywhere outside it closes it too.
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!whole.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    setOpen(false);
    button.current?.focus();
  };

  // Tabbing out of it closes it. Moving between the button and the panel doesn't.
  const onBlur = (event: FocusEvent) => {
    if (event.relatedTarget instanceof Node && whole.current?.contains(event.relatedTarget)) return;
    if (event.relatedTarget === null) return;
    setOpen(false);
  };

  const workspace = (key: Workspace, label: string, to: string, meta?: string) => {
    const current = route.workspace === key;
    return (
      <a href={to} aria-current={current ? "true" : undefined}>
        <span>{label}</span>
        {meta && <span className="rs-meta">{meta}</span>}
        {current && <Glyph name="check" />}
      </a>
    );
  };

  return (
    <div className="app-who" ref={whole} onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        type="button"
        className="rs-who"
        ref={button}
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        onClick={() => setOpen((was) => !was)}
      >
        {name}
        <Glyph name="chevron" />
        <span className="rs-visually-hidden">, account and workspaces</span>
      </button>
      <div className="app-menu" id={`${id}-menu`} hidden={!open}>
        {me.signInEmail && (
          <>
            <p className="app-menu__h">Signed in as {me.signInEmail}</p>
            <hr />
          </>
        )}
        <h2 className="app-menu__h">Workspaces</h2>
        {workspace("seeking", "Looking for work", href.home)}
        {(clients > 0 || route.workspace === "coaching") &&
          workspace("coaching", "Coaching", href.clients, clients > 0 ? (clients === 1 ? "1 client" : `${clients.toLocaleString()} clients`) : undefined)}
        {workspace("hiring", "Hiring", href.hiringOpenings, "Not open yet")}
        <hr />
        <h2 className="app-menu__h">Account</h2>
        {SECTIONS.filter(({ section }) => section !== "notifications" || me.capabilities?.emailNotices).map(({ section, label }) => (
          <a
            key={section}
            href={href.accountSection(section)}
            aria-current={route.name === "account" && route.params.section === section ? "page" : undefined}
          >
            <span>{label}</span>
            {section === "plan" && <span className="rs-meta">{`${used.toLocaleString()} of ${limit.toLocaleString()} documents used`}</span>}
          </a>
        ))}
        <hr />
        <button
          type="button"
          className="app-menu__item"
          disabled={signOut.pending}
          onClick={() =>
            void signOut.run(async () => {
              await api.logout();
              endSession("You’ve signed out.");
            })
          }
        >
          {signOut.pending ? "Signing out…" : "Sign out"}
        </button>
        <ActionError message={signOut.error} />
      </div>
    </div>
  );
}
