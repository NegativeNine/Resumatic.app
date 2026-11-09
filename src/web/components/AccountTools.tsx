import { useId, useState } from "react";
import type { ShareGrant } from "../../shared/sharing";
import { api } from "../api";
import { count, formatDate, formatDateTime } from "../format";
import { useAction, useResource } from "../hooks";
import { useSession } from "../session";
import { QuotaMeter } from "./QuotaMeter";
import { ActionError, Badge, ErrorNote, Field, Glyph, Loading, Message, Success } from "./ui";
import "./workspace.css";

/** Plan ids are lower-case keys such as "plus"; people read them as names. */
function planName(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

const PLAN_STATUS: Readonly<Record<string, string>> = {
  active: "Active",
  trialing: "In trial",
  past_due: "Payment overdue",
  canceled: "Cancelled",
  unpaid: "Payment needed",
  incomplete: "Payment not finished",
};

export function BillingTools() {
  const billing = useResource(api.billing);
  const action = useAction();
  const { me, refreshMe } = useSession();
  const [planId, setPlanId] = useState("");
  const id = useId();
  const data = billing.data;
  const selected =
    data?.plans.find((plan) => plan.id === planId) ?? data?.plans[0];
  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Your plan</h2>
      <QuotaMeter className="app-plan-quota" />
      <p className="rs-meta app-plan-note">
        A tailored resume, cover letter or interview preparation uses one output when it finishes.
        {me.quota.periodEnd ? ` Your outputs renew on ${formatDate(me.quota.periodEnd)}.` : ""}
      </p>
      {!data && !billing.error && <Loading>Loading billing details…</Loading>}
      {billing.error && (
        <ErrorNote message={billing.error} onRetry={billing.reload} />
      )}
      {data && !data.enabled && (
        <p className="rs-meta">
          Plans can’t be bought at the moment. The outputs you already have stay available.
        </p>
      )}
      {data?.enabled && (
        <>
          {data.current && (
            <div className="rs-setting">
              <p className="rs-setting__text">
                <strong>
                  {planName(data.current.planId)} plan{" "}
                  <Badge tone={data.current.cancelAtPeriodEnd ? "rejected" : data.current.status === "active" || data.current.status === "trialing" ? "ready" : "failed"}>
                    {data.current.cancelAtPeriodEnd ? "Ending" : PLAN_STATUS[data.current.status] ?? planName(data.current.status)}
                  </Badge>
                </strong>
                <span>
                  {data.current.cancelAtPeriodEnd
                    ? `Cancellation is scheduled. Your plan runs until ${formatDate(data.current.validUntil)}.`
                    : `Paid until ${formatDate(data.current.validUntil)}.`}
                </span>
              </p>
              <button
                type="button"
                disabled={action.pending}
                onClick={() =>
                  void action.run(async () => {
                    const { url } = await api.billingPortal();
                    window.location.assign(url);
                  })
                }
              >
                Manage billing or cancel
              </button>
            </div>
          )}
          {!data.current && selected && (
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                void action.run(async () => {
                  const { url } = await api.checkout(selected.id);
                  window.location.assign(url);
                });
              }}
            >
              <Field id={`${id}-plan`} label="Choose a plan">
                <select
                  id={`${id}-plan`}
                  value={selected.id}
                  onChange={(event) => setPlanId(event.target.value)}
                >
                  {data.plans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {planName(plan.id)}, {plan.generationLimit} outputs each billing period
                    </option>
                  ))}
                </select>
              </Field>
              <p className="rs-meta">
                The price and billing terms are shown at checkout before you pay.
              </p>
              <div className="actions">
                <button
                  type="submit"
                  className="primary"
                  disabled={action.pending}
                >
                  Continue to checkout
                </button>
                <button
                  type="button"
                  disabled={action.pending}
                  onClick={() =>
                    void action.run(async () => {
                      await api.cancelCheckout();
                      await Promise.all([billing.reload(), refreshMe()]);
                    })
                  }
                >
                  Cancel pending checkout
                </button>
              </div>
            </form>
          )}
          <div className="actions app-plan-refresh">
            <button
              type="button"
              className="rs-linkbtn"
              disabled={action.pending}
              onClick={() =>
                void action.run(async () => {
                  await Promise.all([billing.reload(), refreshMe()]);
                })
              }
            >
              Refresh payment status
            </button>
          </div>
        </>
      )}
      <ActionError message={action.error} />
    </section>
  );
}

export function CoachSharingTools() {
  const grants = useResource(api.shares);
  const action = useAction();
  const [selecting, setSelecting] = useState(false);
  const [created, setCreated] = useState<{
    grant: ShareGrant;
    url: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const id = useId();
  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Share with a coach</h2>
      <p className="card-text">
        Choose confirmed facts and saved resume versions to share as a fixed copy. Anyone with the link can
        read that copy, including the contact details on the resumes you choose. Later changes to your facts
        don’t change it.
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
              setCreated(next);
              setCopied(false);
              setSelecting(false);
              await grants.reload();
            }}
          />
        </div>
      )}
      {created && (
        <div className="confirm-panel">
          <Field
            id={`${id}-link`}
            label="Your share link"
            hint="Copy this link now. It’s shown only once. You can revoke it below at any time."
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
          <p className="meta">
            Expires {formatDateTime(created.grant.expiresAt)}.
          </p>
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
            <a
              className="rs-btn rs-btn--sm"
              href={created.url}
              target="_blank"
              rel="noreferrer"
            >
              Open shared copy
            </a>
            {copied && <Success>Copied.</Success>}
          </div>
        </div>
      )}
      {grants.error && (
        <ErrorNote message={grants.error} onRetry={grants.reload} />
      )}
      {!grants.data && !grants.error && <Loading>Loading share links…</Loading>}
      {grants.data?.grants.length === 0 && (
        <p className="rs-meta app-share-none">You have no share links.</p>
      )}
      {grants.data && grants.data.grants.length > 0 && (
        <ul className="plain-list app-share-links">
          {grants.data.grants.map((grant) => {
            const active =
              grant.revokedAt === null && grant.expiresAt > Date.now();
            return (
              <li className="rs-setting" key={grant.id}>
                <div className="rs-setting__text">
                  <strong>
                    {shareContents(grant)}{" "}
                    {active && grant.available !== false && (
                      <Badge tone="ready">
                        <Glyph name="check" />
                        Active
                      </Badge>
                    )}
                    {!active && (
                      <Badge tone="rejected">{grant.revokedAt ? "Revoked" : "Expired"}</Badge>
                    )}
                  </strong>
                  <span>
                    Created {formatDateTime(grant.createdAt)}.{" "}
                    {grant.revokedAt
                      ? `Revoked ${formatDateTime(grant.revokedAt)}.`
                      : `${active ? "Expires" : "Expired"} ${formatDateTime(grant.expiresAt)}.`}
                  </span>
                  {active && grant.available === false && (
                    <Message tone="info">
                      This link is currently unavailable. If it includes a resume, review that version before
                      creating a new link. You can still revoke this one.
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
                        if (created?.grant.id === grant.id) setCreated(null);
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

/** "2 facts and 1 resume version", leaving out whichever the copy doesn't hold. */
function shareContents(grant: ShareGrant): string {
  const parts = [
    grant.factCount > 0 ? count(grant.factCount, "fact") : "",
    grant.resumeCount > 0 ? count(grant.resumeCount, "resume version") : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" and ") : "Empty copy";
}

function ShareSelection({
  onCreated,
}: {
  onCreated: (value: { grant: ShareGrant; url: string }) => Promise<void>;
}) {
  const choices = useResource(async () => {
    const [facts, applications, roles] = await Promise.all([
      api.facts("confirmed"),
      api.applications(),
      api.roles(),
    ]);
    const confirmedRoles = new Set(
      roles.roles
        .filter((role) => role.state === "confirmed")
        .map((role) => role.id),
    );
    return {
      facts: facts.facts.filter(
        (fact) => fact.roleId === null || confirmedRoles.has(fact.roleId),
      ),
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
    };
  });
  const [factIds, setFactIds] = useState(new Set<string>());
  const [resumes, setResumes] = useState(new Map<string, number>());
  const [days, setDays] = useState(7);
  const action = useAction();
  const id = useId();
  function toggleFact(factId: string) {
    setFactIds((before) => {
      const next = new Set(before);
      if (!next.delete(factId)) next.add(factId);
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
            expiresAt: Date.now() + days * 24 * 60 * 60 * 1000,
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
              disabled={action.pending || factIds.size + resumes.size === 0}
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
