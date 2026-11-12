import { useId, useState } from "react";
import { api } from "../api";
import { formatDate } from "../format";
import { useAction, useResource } from "../hooks";
import { useSession } from "../session";
import { QuotaMeter } from "./QuotaMeter";
import { ActionError, Badge, ErrorNote, Field, Loading } from "./ui";
import "./workspace.css";

// The plan on Account, under Plan: what this period allows and has used, and, where plans can be
// bought, checkout or the billing portal. Sharing's tools are on Sharing › Coaches
// (components/sharing/Copies.tsx).

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
      <h2 id={`${id}-title`}>Plan</h2>
      <QuotaMeter className="app-plan-quota" />
      <p className="rs-meta app-plan-note">
        A tailored resume, cover letter or interview preparation counts as one document when it finishes. A line check,
        or suggested wording you accept, counts toward your documents too. Checking your fit never does.
        {me.quota.periodEnd ? ` Your documents renew on ${formatDate(me.quota.periodEnd)}.` : ""}
      </p>
      {!data && !billing.error && <Loading>Loading billing details…</Loading>}
      {billing.error && (
        <ErrorNote message={billing.error} onRetry={billing.reload} />
      )}
      {data && !data.enabled && (
        <p className="rs-meta">
          Plans can’t be bought at the moment. The documents you already have stay available.
        </p>
      )}
      {data?.enabled && (
        <>
          {data.current && (
            <div className="rs-setting">
              <p className="rs-setting__text">
                <strong>
                  {planName(data.current.planId)} plan{" "}
                  <Badge tone={data.current.cancelAtPeriodEnd ? "note" : data.current.status === "active" || data.current.status === "trialing" ? "backed" : "problem"}>
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
                      {planName(plan.id)}, {plan.generationLimit} documents each billing period
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
