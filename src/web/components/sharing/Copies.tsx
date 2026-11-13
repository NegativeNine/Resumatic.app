import { useId, useState } from "react";
import { MAX_SHARE_LABEL_CHARS, type ShareCoach, type ShareGrant } from "../../../shared/sharing";
import { api, ApiError } from "../../api";
import { count, formatDateTime } from "../../format";
import { useAction, useResource, type Resource } from "../../hooks";
import { ActionError, Badge, EmptyState, ErrorNote, Field, Glyph, Loading, Message, Success } from "../ui";
import "../workspace.css";

// The copies the owner shares with a coach, on Sharing › Coaches: the list of copies already
// shared, and the form that makes a new one. The page holds the list and the one-time link, so
// the two can sit in different columns: making a copy reloads the list, and revoking the copy whose
// link is on show takes the link away. A copy is fixed when it is made, and holds only confirmed
// facts, finished resumes and documents the owner chose. A label, a coach's name and a coach's
// address are someone's own words, shown as text.

/** A copy just made and its link, shown once. */
export interface CreatedCopy {
  grant: ShareGrant;
  url: string;
}

/** The copies already shared, newest first, each with what it holds, its state and a way to revoke it. */
export function CopyList({
  grants,
  onRevoked,
}: {
  grants: Resource<{ grants: ShareGrant[] }>;
  /** Called once a copy is revoked, with that copy's ID, before the list is read again. */
  onRevoked: (grantId: string) => void;
}) {
  const action = useAction();
  const id = useId();
  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Copies you’ve shared</h2>
      {grants.error && <ErrorNote message={grants.error} onRetry={grants.reload} />}
      {!grants.data && !grants.error && <Loading>Loading share links…</Loading>}
      {grants.data?.grants.length === 0 && <EmptyState>You have no share links.</EmptyState>}
      {grants.data && grants.data.grants.length > 0 && (
        <ul className="plain-list app-share-links">
          {grants.data.grants.map((grant) => {
            const active = grant.revokedAt === null && grant.expiresAt > Date.now();
            return (
              <li className="rs-setting" key={grant.id}>
                <div className="rs-setting__text">
                  <strong>
                    {grant.label || shareContents(grant)}{" "}
                    {active && grant.available !== false && (
                      <Badge tone="backed">
                        <Glyph name="check" />
                        Active
                      </Badge>
                    )}
                    {!active && <Badge tone="note">{grant.revokedAt ? "Revoked" : "Expired"}</Badge>}
                  </strong>
                  <span>
                    {grant.label ? `${shareContents(grant)}. ` : ""}
                    Created {formatDateTime(grant.createdAt)}.{" "}
                    {grant.revokedAt
                      ? `Revoked ${formatDateTime(grant.revokedAt)}.`
                      : `${active ? "Expires" : "Expired"} ${formatDateTime(grant.expiresAt)}.`}{" "}
                    {shareOpened(grant, active)}
                    {grant.coach && ` ${shareCoach(grant.coach)}`}
                  </span>
                  {active && grant.available === false && (
                    <Message tone="info">
                      This link is currently unavailable. If it includes a resume, review that version before creating a
                      new link. If it holds a fact you keep private, it stays closed while you keep it private. You can
                      still revoke this one.
                    </Message>
                  )}
                </div>
                {active ? (
                  <button
                    type="button"
                    className="small"
                    disabled={action.pending}
                    onClick={() =>
                      void action.run(async () => {
                        await api.revokeShare(grant.id);
                        onRevoked(grant.id);
                        await grants.reload();
                      })
                    }
                  >
                    Revoke link
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <ActionError message={action.error} />
    </section>
  );
}

/**
 * The form for a new copy, behind "Choose what to share" so that opening the page doesn't read
 * every fact, job and document, and the copy's link once it is made.
 */
export function NewCopy({
  created,
  onCreated,
}: {
  /** The copy just made, whose link is shown once, or null. */
  created: CreatedCopy | null;
  onCreated: (next: CreatedCopy) => Promise<void>;
}) {
  const action = useAction();
  const [selecting, setSelecting] = useState(false);
  const [copied, setCopied] = useState(false);
  const id = useId();
  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Share a new copy</h2>
      <p className="card-text meta">The copy is made now and doesn’t change afterwards.</p>
      <p className="card-text">
        Choose confirmed facts, saved resume versions, cover letters and interview preparation to share as a fixed
        copy. Anyone with the link can read that copy, including the contact details on the resumes you choose. Later
        changes to your facts don’t change it.
      </p>
      <button
        type="button"
        aria-expanded={selecting}
        aria-controls={`${id}-selection`}
        onClick={() => setSelecting(!selecting)}
      >
        {selecting ? "Close selection" : "Choose what to share"}
      </button>
      {selecting && (
        <div id={`${id}-selection`}>
          <ShareSelection
            onCreated={async (next) => {
              setCopied(false);
              setSelecting(false);
              await onCreated(next);
            }}
          />
        </div>
      )}
      {created && (
        <div className="confirm-panel">
          <Field
            id={`${id}-link`}
            label="Your share link"
            hint="Copy this link now. It’s shown only once. You can revoke it under Copies you’ve shared at any time."
          >
            <input
              id={`${id}-link`}
              type="text"
              readOnly
              value={created.url}
              onFocus={(event) => event.target.select()}
              aria-describedby={`${id}-link-hint`}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <p className="meta">Expires {formatDateTime(created.grant.expiresAt)}.</p>
          <div className="actions">
            <button
              type="button"
              className="small"
              disabled={action.pending}
              onClick={() =>
                void action.run(async () => {
                  await navigator.clipboard.writeText(created.url);
                  setCopied(true);
                })
              }
            >
              Copy link
            </button>
            <a className="rs-btn rs-btn--sm" href={created.url} target="_blank" rel="noreferrer">
              Open shared copy
            </a>
            {copied && <Success>Copied.</Success>}
          </div>
        </div>
      )}
      <ActionError message={action.error} />
    </section>
  );
}

/** "2 facts, 1 resume version and 1 document", leaving out whatever the copy doesn't hold. */
export function shareContents(grant: ShareGrant): string {
  const documents = grant.documentCount ?? 0;
  const parts = [
    grant.factCount > 0 ? count(grant.factCount, "fact") : "",
    grant.resumeCount > 0 ? count(grant.resumeCount, "resume version") : "",
    documents > 0 ? count(documents, "document") : "",
  ].filter(Boolean);
  if (parts.length === 0) return "Empty copy";
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)!}`;
}

const DOCUMENT_NAMES = { letter: "Cover letter", prep: "Interview preparation" } as const;

/** Who the link names as its coach, and whether that account has taken the copy up. */
function shareCoach(coach: ShareCoach): string {
  if (coach.joinedAt === null) return `Names ${coach.email} as coach. Not in their client list yet.`;
  return `${coach.name ?? coach.email} added it to their client list on ${formatDateTime(coach.joinedAt)}.`;
}

/**
 * When the copy was last opened. A reply without the reading (from a server that doesn't record it)
 * says nothing, instead of claiming the copy hasn't been opened.
 */
function shareOpened(grant: ShareGrant, active: boolean): string {
  if (grant.lastReadAt === undefined) return "";
  if (grant.lastReadAt === null) return active ? "Not opened yet." : "Never opened.";
  return `Last opened ${formatDateTime(grant.lastReadAt)}.`;
}

function ShareSelection({
  onCreated,
}: {
  onCreated: (value: { grant: ShareGrant; url: string }) => Promise<void>;
}) {
  const choices = useResource(async () => {
    const [facts, applications, roles, documents] = await Promise.all([
      api.facts("confirmed"),
      api.applications(),
      api.roles(),
      // A server from before documents could be shared has no such list, and so none to offer.
      api.shareableDocuments().catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) return { documents: [] };
        throw error;
      }),
    ]);
    const jobName = new Map(
      applications.applications.map((application) => [
        application.id,
        [application.title, application.company].filter(Boolean).join(" at ") || application.excerpt,
      ]),
    );
    const confirmedRoles = new Set(
      roles.roles
        .filter((role) => role.state === "confirmed")
        .map((role) => role.id),
    );
    // A fact kept private can't go into a copy, so it isn't offered. The form says when one was left out.
    const offered = facts.facts.filter((fact) => !fact.sensitive);
    return {
      facts: offered.filter(
        (fact) => fact.roleId === null || confirmedRoles.has(fact.roleId),
      ),
      withheld: offered.length < facts.facts.length,
      resumes: applications.applications
        .flatMap((application) =>
          application.resumes
            .filter((resume) => resume.state === "ready")
            .map((resume) => ({
              ...resume,
              title:
                [application.title, application.company]
                  .filter(Boolean)
                  .join(" at ") || application.excerpt,
            })),
        )
        .sort((a, b) => b.createdAt - a.createdAt),
      documents: documents.documents.map((document) => ({
        ...document,
        title: `${DOCUMENT_NAMES[document.kind]} for ${jobName.get(document.applicationId) ?? "a job"}`,
      })),
    };
  });
  const [factIds, setFactIds] = useState(new Set<string>());
  const [resumes, setResumes] = useState(new Map<string, number>());
  /** Chosen documents, each with the version that was listed. */
  const [documents, setDocuments] = useState(new Map<string, number>());
  const [days, setDays] = useState(7);
  const [label, setLabel] = useState("");
  const [coachEmail, setCoachEmail] = useState("");
  const [showName, setShowName] = useState(true);
  const [showJobs, setShowJobs] = useState(false);
  const action = useAction();
  const id = useId();
  const coach = coachEmail.trim();
  /** Enough of an address to send. The server decides whether it is one. */
  const badCoach = coach !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(coach);
  /** How many chosen things were made for a job, and so could say which. */
  const forJobs = resumes.size + documents.size;
  function toggleFact(factId: string) {
    setFactIds((before) => {
      const next = new Set(before);
      if (!next.delete(factId)) next.add(factId);
      return next;
    });
  }
  function toggleDocument(documentId: string, version: number) {
    setDocuments((before) => {
      const next = new Map(before);
      if (!next.delete(documentId)) next.set(documentId, version);
      return next;
    });
  }
  function changeVersion(resumeId: string, version: number) {
    setResumes((before) => new Map(before).set(resumeId, version));
  }
  async function toggleResume(resumeId: string) {
    if (resumes.has(resumeId)) {
      setResumes((before) => {
        const next = new Map(before);
        next.delete(resumeId);
        return next;
      });
      return;
    }
    await action.run(async () => {
      const resume = await api.resume(resumeId);
      changeVersion(resumeId, resume.version);
    });
  }
  return (
    <form
      className="inline-form share-selection"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(async () => {
          const created = await api.createShare({
            factIds: [...factIds],
            resumes: [...resumes].map(([resumeId, version]) => ({
              id: resumeId,
              version,
            })),
            ...(documents.size > 0 ? { documents: [...documents].map(([documentId, version]) => ({ id: documentId, version })) } : {}),
            expiresAt: Date.now() + days * 24 * 60 * 60 * 1000,
            ...(label.trim() ? { label: label.trim() } : {}),
            ...(coach ? { coachEmail: coach } : {}),
            showName,
            showJobs: showJobs && forJobs > 0,
          });
          await onCreated(created);
        });
      }}
    >
      {choices.error && (
        <ErrorNote message={choices.error} onRetry={choices.reload} />
      )}
      {!choices.data && !choices.error && (
        <Loading>Loading items you can share…</Loading>
      )}
      {choices.data && (
        <>
          <fieldset>
            <legend>
              Confirmed facts ({factIds.size} selected, up to 100)
            </legend>
            {choices.data.withheld && <p className="rs-meta">Facts you keep private aren’t listed.</p>}
            {choices.data.facts.length === 0 ? (
              <p className="rs-meta">You have no confirmed facts to share yet.</p>
            ) : (
              <ul className="plain-list selection-list">
                {choices.data.facts.map((fact) => (
                  <li key={fact.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={factIds.has(fact.id)}
                        disabled={
                          action.pending ||
                          (!factIds.has(fact.id) && factIds.size >= 100)
                        }
                        onChange={() => toggleFact(fact.id)}
                      />
                      <span>{fact.text}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          <fieldset>
            <legend>
              Saved resume versions ({resumes.size} selected, up to 20)
            </legend>
            {choices.data.resumes.length === 0 ? (
              <p className="rs-meta">You have no finished resumes to share yet.</p>
            ) : (
              <ul className="plain-list selection-list">
                {choices.data.resumes.map((resume) => (
                  <li key={resume.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={resumes.has(resume.id)}
                        disabled={
                          action.pending ||
                          (!resumes.has(resume.id) && resumes.size >= 20)
                        }
                        onChange={() => void toggleResume(resume.id)}
                      />
                      <span>
                        {resume.title}
                        <span className="meta">
                          {", "}
                          {formatDateTime(resume.createdAt)}
                        </span>
                      </span>
                    </label>
                    {resumes.has(resume.id) && (
                      <ShareVersionPicker
                        resumeId={resume.id}
                        version={resumes.get(resume.id)!}
                        onChange={(version) =>
                          changeVersion(resume.id, version)
                        }
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          <fieldset>
            <legend>
              Cover letters and interview preparation ({documents.size} selected, up to 20)
            </legend>
            {choices.data.documents.length === 0 ? (
              <p className="rs-meta">You have no finished cover letters or interview preparation yet.</p>
            ) : (
              <ul className="plain-list selection-list">
                {choices.data.documents.map((document) => (
                  <li key={document.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={documents.has(document.id)}
                        disabled={
                          action.pending ||
                          !document.shareable ||
                          (!documents.has(document.id) && documents.size >= 20)
                        }
                        onChange={() => toggleDocument(document.id, document.version)}
                      />
                      <span>
                        {document.title}
                        <span className="meta">
                          {", "}
                          {formatDateTime(document.createdAt)}
                          {/* It can't go into a copy: it uses a private fact, or its sentences can't be checked again. */}
                          {!document.shareable &&
                            (document.usesSensitive
                              ? ". Uses a fact you keep private. Create a new one to share it."
                              : ". Written before documents could be shared. Write a new one to share it.")}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          <Field
            id={`${id}-label`}
            label="Who it’s for"
            optional
            hint="A note for your own list of links, such as a coach’s name. The reader doesn’t see it."
          >
            <input
              id={`${id}-label`}
              type="text"
              value={label}
              maxLength={MAX_SHARE_LABEL_CHARS}
              disabled={action.pending}
              onChange={(event) => setLabel(event.target.value)}
              aria-describedby={`${id}-label-hint`}
              autoComplete="off"
            />
          </Field>
          <Field
            id={`${id}-coach`}
            label="Your coach’s sign-in address"
            optional
            hint="If your coach has a Resumatic account, this lets them keep the copy in their client list, open it without the link and comment on it. Anyone with the link can still read it. Only your coach can comment."
            error={badCoach ? "Enter a full email address, or leave this empty." : undefined}
          >
            <input
              id={`${id}-coach`}
              type="email"
              value={coachEmail}
              maxLength={254}
              disabled={action.pending}
              onChange={(event) => setCoachEmail(event.target.value)}
              aria-invalid={badCoach}
              aria-describedby={badCoach ? `${id}-coach-error` : `${id}-coach-hint`}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <label className="app-share-name">
            <input
              type="checkbox"
              checked={showName}
              disabled={action.pending}
              onChange={(event) => setShowName(event.target.checked)}
              aria-describedby={`${id}-name-hint`}
            />
            <span>Put my name at the top of the copy</span>
          </label>
          <p className="rs-hint" id={`${id}-name-hint`}>
            The name from your contact details. A resume you share shows your name either way.
          </p>
          <label className="app-share-name">
            <input
              type="checkbox"
              checked={showJobs && forJobs > 0}
              disabled={action.pending || forJobs === 0}
              onChange={(event) => setShowJobs(event.target.checked)}
              aria-describedby={`${id}-jobs-hint`}
            />
            <span>Say which job each resume and document is for</span>
          </label>
          <p className="rs-hint" id={`${id}-jobs-hint`}>
            {forJobs === 0
              ? "Choose a resume or a document first. Each one can show the job title and company it was made for."
              : "Shows the job title and company beside each resume and document. Leave it off to keep where you’re applying to yourself."}
          </p>
          <Field id={`${id}-expiry`} label="Link expires after">
            <select
              id={`${id}-expiry`}
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              <option value={1}>1 day</option>
              <option value={3}>3 days</option>
              <option value={7}>7 days</option>
            </select>
          </Field>
          <div className="actions">
            <button
              type="submit"
              className="primary"
              disabled={action.pending || badCoach || factIds.size + resumes.size + documents.size === 0}
            >
              {action.pending ? "Preparing…" : "Create share link"}
            </button>
          </div>
        </>
      )}
      <ActionError message={action.error} />
    </form>
  );
}

function ShareVersionPicker({
  resumeId,
  version,
  onChange,
}: {
  resumeId: string;
  version: number;
  onChange: (version: number) => void;
}) {
  const versions = useResource(() => api.resumeVersions(resumeId));
  const id = useId();
  const values = versions.data?.versions ?? [{ version, createdAt: 0 }];
  return (
    <div className="share-version">
      <label htmlFor={id}>Version to share</label>
      <select
        id={id}
        value={version}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {values.map((saved) => (
          <option value={saved.version} key={saved.version}>
            Version {saved.version}
            {saved.createdAt ? `, saved ${formatDateTime(saved.createdAt)}` : ""}
          </option>
        ))}
      </select>
      {versions.error && (
        <ErrorNote message={versions.error} onRetry={versions.reload} />
      )}
    </div>
  );
}
