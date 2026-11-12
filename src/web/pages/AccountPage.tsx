import { useId, useState, type ChangeEvent, type ReactNode } from "react";
import type { Profile } from "../../shared/api";
import { api, ApiError } from "../api";
import { ActionError, Field, Glyph, PageHeader } from "../components/ui";
import { MoreChoices } from "../components/account/MoreChoices";
import { BillingTools } from "../components/AccountTools";
import { EmailNotices } from "../components/EmailNotices";
import { PlaceholderSection } from "../components/Placeholder";
import { useAction } from "../hooks";
import { ACCOUNT_ANCHORS, ACCOUNT_SECTIONS, href, type AccountSection } from "../router";
import { useSession } from "../session";
import { isProfileSnapshot, profileWriteObserved } from "../profile-save";
import { getThemeChoice, setThemeChoice, type ThemeChoice } from "../theme";
import "../styles/rooms/account.css";

// Account: who the person is on a resume, what their plan allows, their notices and theme, their
// data, signing in, and deleting the account, last. What leaves the record (coaches, recruiters and
// connected apps) is under Sharing, and saved answers are under Jobs › Rules and answers.

const CONFIRM_PHRASE = "delete my account";
const DELETION_NOTE =
  "Your account is being deleted. You’ve been signed out, and your files, facts, jobs and documents are being removed.";

/** Each section's name in the list beside them. */
const SECTION_NAMES: Readonly<Record<AccountSection, string>> = {
  profile: "Profile",
  plan: "Plan",
  notifications: "Notifications",
  appearance: "Appearance",
  data: "Your data",
  "signing-in": "Signing in",
};

/** `section` is the one the address names, if any: the shell scrolls to it and focuses it. */
export function AccountPage({ section }: { section?: AccountSection } = {}) {
  const { me } = useSession();
  const notices = me.capabilities?.emailNotices === true;
  const listed = ACCOUNT_SECTIONS.filter((name) => name !== "notifications" || notices);
  return (
    <>
      <PageHeader title="Account">Who you are on a resume, what your plan allows, and what happens to your data.</PageHeader>
      <div className="app-account">
        <div className="app-account-side">
          <nav aria-label="Account sections" className="app-account-nav">
            <ul>
              {listed.map((name) => (
                <li key={name}>
                  <a href={href.accountSection(name)} aria-current={name === section ? "location" : undefined}>
                    {SECTION_NAMES[name]}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <p className="rs-meta app-account-moved">
            Saved answers are under <a href={href.rules}>Jobs › Rules and answers</a>.
          </p>
        </div>
        <div className="app-stack">
          <Anchor section="profile"><ProfileForm /></Anchor>
          <Anchor section="plan"><BillingTools /></Anchor>
          {notices && (
            <Anchor section="notifications">
              <EmailNotices>
                <MoreChoices hint="A resume or document is ready, or a link or an app’s access is about to end">
                  <PlaceholderSection name="moreNotices" />
                </MoreChoices>
              </EmailNotices>
            </Anchor>
          )}
          <Anchor section="appearance"><Appearance /></Anchor>
          <Anchor section="data">
            <section className="card" aria-labelledby="data-heading">
              <h2 id="data-heading">Your data</h2>
              <p className="card-text meta">Your record is kept in a database of its own, separate from everyone else’s.</p>
              <div className="rs-setting">
                <p className="rs-setting__text">
                  <strong>Everything</strong>
                  <span>
                    Your record and your files together, as a ZIP archive. It holds up to 128 files and 100 MiB of
                    data.
                  </span>
                </p>
                <a className="rs-btn" href={api.exportArchiveUrl} download>
                  <Glyph name="download" />
                  Download your record and files (ZIP)
                </a>
              </div>
              <div className="rs-setting">
                <p className="rs-setting__text">
                  <strong>Your record only</strong>
                  <span>
                    One JSON file. For a larger record, download this and the individual files from{" "}
                    <a href={href.facts}>Facts</a> while your account is active.
                  </span>
                </p>
                <a className="rs-btn" href={api.exportUrl} download>
                  <Glyph name="download" />
                  Download your record (JSON)
                </a>
              </div>
            </section>
          </Anchor>
          <PlaceholderSection name="accountRegion" />
          <Anchor section="signing-in"><SignOutCard /></Anchor>
          <DeleteAccount />
        </div>
      </div>
    </>
  );
}

/**
 * Where a section's own address lands: the menu's links open Account at a section, and the shell
 * scrolls to this and focuses it.
 */
function Anchor({ section, children }: { section: AccountSection; children: ReactNode }) {
  return (
    <div id={ACCOUNT_ANCHORS[section]} tabIndex={-1}>
      {children}
    </div>
  );
}

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "Match system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Light, dark, or whatever the device uses. The choice is kept in this browser. */
function Appearance() {
  const [choice, setChoice] = useState<ThemeChoice>(() => getThemeChoice());
  const choose = (next: ThemeChoice) => {
    setChoice(next);
    setThemeChoice(next);
  };
  return (
    <section className="card" aria-labelledby="appearance-heading">
      <h2 id="appearance-heading">Appearance</h2>
      <div className="rs-setting">
        <p className="rs-setting__text">
          <strong>Theme</strong>
          <span>
            The resume preview stays white in every theme, because it shows what prints. The choice is kept in this
            browser.
          </span>
        </p>
        <fieldset className="rs-filter">
          <legend>Theme</legend>
          {THEMES.map((theme) => (
            <label key={theme.value}>
              <input
                type="radio"
                name="theme"
                value={theme.value}
                checked={choice === theme.value}
                onChange={() => choose(theme.value)}
              />
              <span className="rs-filter__opt">{theme.label}</span>
            </label>
          ))}
        </fieldset>
      </div>
    </section>
  );
}

type ProfileDraft = Omit<Profile, "links"> & { links: string };

const toDraft = (profile: Profile): ProfileDraft => ({
  ...profile,
  links: profile.links.join("\n"),
});

function ProfileForm() {
  const { me, updateMe } = useSession();
  const [draft, setDraft] = useState(() => toDraft(me.profile));
  const [saved, setSaved] = useState(false);
  const { run, pending, error } = useAction();
  const id = useId();

  const edit =
    (key: keyof ProfileDraft) =>
    (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = e.target.value;
      setDraft((current) => ({ ...current, [key]: value }));
      setSaved(false);
    };

  async function save() {
    const profile: Profile = {
      name: draft.name.trim(),
      email: draft.email.trim(),
      phone: draft.phone.trim(),
      location: draft.location.trim(),
      links: draft.links
        .split("\n")
        .map((link) => link.trim())
        .filter(Boolean),
    };
    const ok = await run(async () => {
      const revision = draft.revision;
      if (!Number.isSafeInteger(revision) || revision! < 1 || revision! >= Number.MAX_SAFE_INTEGER)
        throw new ApiError(409, "conflict", "Load the saved profile before saving your changes.");
      let stored: Profile;
      try {
        stored = await api.updateProfile(profile, revision!);
        if (!profileWriteObserved(stored, revision, profile))
          throw new ApiError(502, "unavailable", "The response was incomplete.");
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 410)) throw error;
        // A failed reply can follow a committed update. Only accept a fresh
        // read at the next revision with exactly the submitted values.
        let current: Profile;
        try { current = await api.profile(); }
        catch (readError) {
          if (readError instanceof ApiError && (readError.status === 401 || readError.status === 410)) throw readError;
          throw error;
        }
        if (!profileWriteObserved(current, revision, profile)) throw error;
        stored = current;
      }
      updateMe((current) => ({ ...current, profile: stored }));
      setDraft(toDraft(stored));
    });
    if (ok) setSaved(true);
  }

  async function loadSaved() {
    await run(async () => {
      const current = await api.profile();
      if (!isProfileSnapshot(current))
        throw new ApiError(502, "unavailable", "The response was incomplete.");
      updateMe((me) => ({ ...me, profile: current }));
      setDraft(toDraft(current));
      setSaved(false);
    });
  }

  return (
    <form
      className="card"
      aria-labelledby="profile-heading"
      aria-busy={pending}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 id="profile-heading">Profile</h2>
      <p className="card-text meta">
        Your contact details, for the top of your resumes. Nothing here is a fact about your work.
      </p>
      <div className="field-grid">
        <Field id={`${id}-name`} label="Name">
          <input
            id={`${id}-name`}
            type="text"
            autoComplete="name"
            value={draft.name}
            readOnly={pending}
            onChange={edit("name")}
          />
        </Field>
        <Field id={`${id}-email`} label="Email">
          <input
            id={`${id}-email`}
            type="email"
            autoComplete="email"
            value={draft.email}
            readOnly={pending}
            onChange={edit("email")}
          />
        </Field>
        <Field id={`${id}-phone`} label="Phone">
          <input
            id={`${id}-phone`}
            type="tel"
            autoComplete="tel"
            value={draft.phone}
            readOnly={pending}
            onChange={edit("phone")}
          />
        </Field>
        <Field id={`${id}-location`} label="Location">
          <input
            id={`${id}-location`}
            type="text"
            autoComplete="address-level2"
            placeholder="City, country"
            value={draft.location}
            readOnly={pending}
            onChange={edit("location")}
          />
        </Field>
      </div>
      <Field
        id={`${id}-links`}
        label="Links"
        hint="One per line, such as your LinkedIn profile or portfolio."
      >
        <textarea
          id={`${id}-links`}
          rows={3}
          value={draft.links}
          readOnly={pending}
          onChange={edit("links")}
          aria-describedby={`${id}-links-hint`}
        />
      </Field>
      <div className="actions">
        <button type="submit" className="primary" disabled={pending}>
          {pending ? "Saving…" : "Save profile"}
        </button>
        <button type="button" disabled={pending} onClick={() => void loadSaved()}>
          Load saved profile
        </button>
        {saved && (
          <p className="success inline" role="status">
            Profile saved.
          </p>
        )}
      </div>
      <p className="hint">Loading the saved profile replaces your unsaved changes in this form.</p>
      <ActionError message={error} />
    </form>
  );
}

function SignOutCard() {
  const { me, endSession } = useSession();
  const here = useAction();
  const everywhere = useAction();
  const busy = here.pending || everywhere.pending;

  const signOut = () =>
    here.run(async () => {
      await api.logout();
      endSession("You’ve signed out.");
    });

  const signOutEverywhere = () =>
    everywhere.run(async () => {
      await api.signOutEverywhere();
      await api.logout().catch(() => undefined);
      endSession("You’ve been signed out on every device.");
    });

  return (
    <section className="card" aria-labelledby="sign-out-heading">
      <h2 id="sign-out-heading">Signing in</h2>
      {/* A session from before the address was carried says nothing, rather than guess. */}
      {me.signInEmail && <p className="card-text meta app-account-signed-in">Signed in with Google as {me.signInEmail}.</p>}
      <div className="rs-setting">
        <p className="rs-setting__text">
          <strong>This device</strong>
          <span>Sign out of Resumatic on this device.</span>
        </p>
        <button type="button" onClick={() => void signOut()} disabled={busy}>
          {here.pending ? "Signing out…" : "Sign out"}
        </button>
      </div>
      <ActionError message={here.error} />
      <div className="rs-setting">
        <p className="rs-setting__text">
          <strong>Every device</strong>
          <span>Sign out on every device where you’re signed in, including this one.</span>
        </p>
        <button
          type="button"
          onClick={() => void signOutEverywhere()}
          disabled={busy}
        >
          {everywhere.pending ? "Signing out…" : "Sign out everywhere"}
        </button>
      </div>
      <ActionError message={everywhere.error} />
    </section>
  );
}

function DeleteAccount() {
  const { endSession } = useSession();
  const [typed, setTyped] = useState("");
  const { run, pending, error } = useAction();
  const id = useId();
  const confirmed = typed.trim().toLowerCase() === CONFIRM_PHRASE;

  return (
    <section className="rs-panel rs-danger-zone" aria-labelledby="delete-heading">
      <h2 id="delete-heading" className="rs-h2">Delete account</h2>
      <p className="card-text">
        This permanently deletes your account and everything in your record: your files, roles, facts, jobs and
        documents. Copies you’ve shared stop working and connected apps lose access. It can’t be undone, so{" "}
        <a href={href.accountSection("data")}>download your record</a> first if you want to keep it.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!confirmed) return;
          void run(async () => {
            await api.deleteAccount();
            endSession(DELETION_NOTE);
          });
        }}
      >
        <label htmlFor={id}>
          Type <strong>{CONFIRM_PHRASE}</strong> to confirm
        </label>
        <input
          id={id}
          className="rs-input"
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="actions">
          <button
            type="submit"
            className="rs-btn rs-btn--danger"
            disabled={!confirmed || pending}
          >
            {pending ? "Deleting…" : "Delete my account"}
          </button>
        </div>
        <ActionError message={error} />
      </form>
    </section>
  );
}
