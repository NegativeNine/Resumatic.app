import { useId, useState } from "react";
import type { ShareGrant } from "../../shared/sharing";
import { api } from "../api";
import { formatDate, formatDateTime } from "../format";
import { useAction, useResource } from "../hooks";
import { useSession } from "../session";
import { ActionError, Badge, ErrorNote, Field, Loading } from "./ui";
import "./workspace.css";

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
      <p>
        {me.quota.used} of {me.quota.limit} outputs used
        {(me.quota.reserved ?? 0) > 0 &&
          `, with ${me.quota.reserved} reserved for work in progress`}
        .
      </p>
      {me.quota.periodEnd && (
        <p className="meta">
          Allowance renews {formatDate(me.quota.periodEnd)}.
        </p>
      )}
      {!data && !billing.error && <Loading>Loading billing details…</Loading>}
      {billing.error && (
        <ErrorNote message={billing.error} onRetry={billing.reload} />
      )}
      {data && !data.enabled && (
        <p className="hint">
          Plan purchases are currently unavailable. Your existing allowance
          remains available.
        </p>
      )}
      {data?.enabled && (
        <>
          {data.current && (
            <div className="option-row">
              <div>
                <p>Plan: {data.current.planId}</p>
                <p className="meta">
                  {data.current.cancelAtPeriodEnd
                    ? `Cancellation scheduled. Access continues through ${formatDate(data.current.validUntil)}.`
                    : `Status: ${data.current.status}.`}
                </p>
              </div>
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
                      {plan.id} · {plan.generationLimit} outputs per billing
                      period
                    </option>
                  ))}
                </select>
              </Field>
              <p className="hint">
                The price and billing terms are shown at secure checkout before
                you pay.
              </p>
              <div className="actions">
                <button
                  type="submit"
                  className="primary"
                  disabled={action.pending}
                >
                  Continue to secure checkout
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
          <div className="actions">
            <button
              type="button"
              className="small"
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
        Choose confirmed facts and saved resume versions to share as a fixed
        copy. Anyone with the link can read that copy, including contact details
        in selected resumes. Later changes to your vault do not change it.
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
            hint="Copy this link now. It is only displayed when created; you can revoke it below."
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
              className="button small"
              href={created.url}
              target="_blank"
              rel="noreferrer"
            >
              Open shared copy
            </a>
            {copied && (
              <span className="success inline" role="status">
                Copied.
              </span>
            )}
          </div>
        </div>
      )}
      {grants.error && (
        <ErrorNote message={grants.error} onRetry={grants.reload} />
      )}
      {!grants.data && !grants.error && <Loading>Loading share links…</Loading>}
      {grants.data?.grants.length === 0 && (
        <p className="hint">You have no share links.</p>
      )}
      {grants.data && grants.data.grants.length > 0 && (
        <ul className="plain-list document-list">
          {grants.data.grants.map((grant) => {
            const active =
              grant.revokedAt === null && grant.expiresAt > Date.now();
            return (
              <li className="option-row" key={grant.id}>
                <div>
                  <p>
                    {grant.factCount} facts · {grant.resumeCount} resume
                    versions
                  </p>
                  <p className="meta">
                    Created {formatDateTime(grant.createdAt)} · expires{" "}
                    {formatDateTime(grant.expiresAt)}
                  </p>
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
                ) : (
                  <Badge tone="rejected">
                    {grant.revokedAt ? "Revoked" : "Expired"}
                  </Badge>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ActionError message={action.error} />
    </section>
  );
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
              <p className="meta">No confirmed facts are available.</p>
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
              <p className="meta">No completed resumes are available.</p>
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
                          {" "}
                          · {formatDateTime(resume.createdAt)}
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
            {saved.createdAt ? ` · ${formatDateTime(saved.createdAt)}` : ""}
          </option>
        ))}
      </select>
      {versions.error && (
        <ErrorNote message={versions.error} onRetry={versions.reload} />
      )}
    </div>
  );
}
