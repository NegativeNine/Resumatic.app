import { useId, useState, type ChangeEvent } from "react";
import type { Profile } from "../../shared/api";
import { api } from "../api";
import { ActionError, Field, PageHeader } from "../components/ui";
import { BillingTools, CoachSharingTools } from "../components/AccountTools";
import { ConnectedApps } from "../components/ConnectedApps";
import { useAction } from "../hooks";
import { href } from "../router";
import { useSession } from "../session";

const CONFIRM_PHRASE = "delete my account";
const DELETION_NOTE =
  "Your account is being deleted. You've been signed out, and your uploads, facts, applications and resumes are being removed.";

export function AccountPage() {
  const { me } = useSession();
  return (
    <>
      <PageHeader title="Account" />
      <div className="stack">
        <ProfileForm />
        <BillingTools />
        <CoachSharingTools />
        {me.capabilities?.connectedApps && <ConnectedApps />}
        <SignOutCard />
        <section className="card" aria-labelledby="data-heading">
          <h2 id="data-heading">Your data</h2>
          <p className="card-text">
            Download your vault data and source files together as a ZIP archive.
            The archive supports up to 128 source files and 100 MiB of data.
            For larger vaults, download the JSON and individual files from
            {" "}<a href={href.sources}>Sources &amp; facts</a> while your account is active.
          </p>
          <a className="button primary" href={api.exportArchiveUrl} download>
            Download vault archive (ZIP)
          </a>{" "}
          <a className="button" href={api.exportUrl} download>
            Download vault data (JSON)
          </a>
        </section>
        <DeleteAccount />
      </div>
    </>
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
      const stored = (await api.updateProfile(profile)) ?? profile;
      updateMe((current) => ({ ...current, profile: stored }));
      setDraft(toDraft(stored));
    });
    if (ok) setSaved(true);
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
        Your contact details, for the top of your resumes.
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
        {saved && (
          <p className="success inline" role="status">
            Profile saved.
          </p>
        )}
      </div>
      <ActionError message={error} />
    </form>
  );
}

function SignOutCard() {
  const { endSession } = useSession();
  const here = useAction();
  const everywhere = useAction();
  const busy = here.pending || everywhere.pending;

  const signOut = () =>
    here.run(async () => {
      await api.logout();
      endSession("You've signed out.");
    });

  const signOutEverywhere = () =>
    everywhere.run(async () => {
      await api.signOutEverywhere();
      await api.logout().catch(() => undefined);
      endSession("You've been signed out on every device.");
    });

  return (
    <section className="card" aria-labelledby="sign-out-heading">
      <h2 id="sign-out-heading">Signing out</h2>
      <div className="option-row">
        <p>Sign out of Resumatic on this device.</p>
        <button type="button" onClick={() => void signOut()} disabled={busy}>
          {here.pending ? "Signing out…" : "Sign out"}
        </button>
      </div>
      <ActionError message={here.error} />
      <div className="option-row">
        <p>
          Sign out on every device where you're signed in, including this one.
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
    <section className="card danger-card" aria-labelledby="delete-heading">
      <h2 id="delete-heading">Delete account</h2>
      <p className="card-text">
        This permanently deletes your account and everything in your vault:
        uploaded files, roles, facts, applications and resumes. It can't be
        undone. Before deleting, download your vault data and any original files
        you want to keep from <a href={href.sources}>Sources &amp; facts</a>.
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
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="actions">
          <button
            type="submit"
            className="danger"
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
