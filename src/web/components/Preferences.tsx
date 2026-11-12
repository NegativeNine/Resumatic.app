import { useId, useState } from "react";
import {
  CURRENCIES,
  JOB_TYPES,
  MAX_PLACE_CHARS,
  PAY_PERIODS,
  cleanPreferences,
  type JobType,
  type PayPeriod,
  type Preferences,
} from "../../shared/preferences";
import { api, ApiError } from "../api";
import { formatDate } from "../format";
import { useAction, useResource } from "../hooks";
import { availabilityOptions, isPreferencesSnapshot, preferencesWriteObserved, retiredChoices } from "../preferences-save";
import { ActionError, ErrorNote, Field, Loading, Message } from "./ui";

// The Job preferences card on Account. It loads from its own route and never from the session, and
// nothing else in the app reads what it saves: not Jobs, not a fit preview, not tailoring.

const JOB_TYPE_LABEL: Record<JobType, string> = {
  full_time: "Full time",
  part_time: "Part time",
  contract: "Contract",
  temporary: "Temporary",
  internship: "Internship",
};

const PAY_PERIOD_LABEL: Record<PayPeriod, string> = {
  year: "Year",
  month: "Month",
  week: "Week",
  day: "Day",
  hour: "Hour",
};

/** How a saved job type or period reads once it has left its list. Its stored token is never printed. */
const RETIRED = "A choice that’s no longer offered";
const CHOOSE_LISTED = "Choose one of the listed options.";
const PAY_INCOMPLETE = "A pay floor needs an amount, a currency and a period. Fill in all three, or clear all three.";
const AMOUNT_DIGITS = "Enter the amount in digits only, such as 140000.";
/** The form's own words for a save that was refused. The server's detail is never shown. */
const REFUSED = "These preferences couldn’t be saved as written. Check each field, then save again.";
const INCOMPLETE_REPLY = "The response was incomplete.";
/** A whole number of the currency's main unit, up to the cap. "140,000" and "1,5" differ by locale, so neither is read. */
const AMOUNT = /^[1-9][0-9]{0,11}$/;

/** Reads the saved preferences, and takes nothing less than a whole saved row for them. */
async function loadPreferences(): Promise<Preferences> {
  const loaded = await api.preferences();
  if (!isPreferencesSnapshot(loaded)) throw new ApiError(502, "unavailable", INCOMPLETE_REPLY);
  return loaded;
}

export function JobPreferences() {
  const preferences = useResource(loadPreferences);
  const id = useId();
  return (
    <section className="card app-preferences" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Job preferences</h2>
      <p className="card-text meta">The work you’re looking for. Leave empty anything you’d rather not say.</p>
      <Message tone="info" live={false}>
        Nothing here is shown to anyone or used yet. It stays in your record: it isn’t put in a resume or a shared
        copy, and connected apps can’t read it.
      </Message>
      {/* Once the form is up it stays up: a later reload that fails changes nothing the person sees. */}
      {preferences.data ? (
        <PreferencesForm initial={preferences.data} />
      ) : preferences.error ? (
        <ErrorNote message={preferences.error} onRetry={preferences.reload} />
      ) : (
        <Loading>Loading your preferences…</Loading>
      )}
    </section>
  );
}

/** The form's fields as they are typed and chosen. An empty string is a field with nothing said. */
interface Draft {
  place: string;
  availableFrom: string;
  jobTypes: string[];
  amount: string;
  currency: string;
  period: string;
}

const toDraft = (saved: Preferences): Draft => ({
  place: saved.place ?? "",
  availableFrom: saved.availableFrom ?? "",
  jobTypes: saved.jobTypes,
  amount: saved.payFloor ? String(saved.payFloor.amount) : "",
  currency: saved.payFloor?.currency ?? "",
  period: saved.payFloor?.period ?? "",
});

/** The draft as a save would send it, for the rule to judge. Three empty pay fields are no pay floor. */
function toValues(draft: Draft): unknown {
  const amount = draft.amount.trim();
  return {
    place: draft.place,
    jobTypes: draft.jobTypes,
    availableFrom: draft.availableFrom || null,
    payFloor:
      amount === "" && draft.currency === "" && draft.period === ""
        ? null
        : { amount: AMOUNT.test(amount) ? Number(amount) : amount, currency: draft.currency, period: draft.period },
  };
}

/** The IDs of whatever describes a control just now, or nothing. */
const describedBy = (...ids: (string | false)[]) => ids.filter(Boolean).join(" ") || undefined;

function PreferencesForm({ initial }: { initial: Preferences }) {
  // Both are set once from the first load. A background reload hands this component a new
  // `initial` and changes neither, so it can't replace what is being typed.
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(() => toDraft(initial));
  const [justSaved, setJustSaved] = useState(false);
  /** Whether the action under way is a save. Loading the saved preferences locks the form too, and is not one. */
  const [saving, setSaving] = useState(false);
  // The months offered are counted from the day the form opened, so a choice can't drop out of the list at midnight.
  const [today] = useState(() => new Date());
  const { run, pending, error } = useAction();
  const id = useId();

  const edit = (change: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...change }));
    setJustSaved(false);
  };
  const toggle = (type: string) =>
    edit({ jobTypes: draft.jobTypes.includes(type) ? draft.jobTypes.filter((chosen) => chosen !== type) : [...draft.jobTypes, type] });

  // A choice that has left its list stays listed for as long as the saved preferences hold it.
  const retired = retiredChoices(saved);
  const amount = draft.amount.trim();
  const filled = [amount, draft.currency, draft.period].filter((value) => value !== "").length;
  const badAmount = amount !== "" && !AMOUNT.test(amount);
  const incomplete = !badAmount && filled > 0 && filled < 3;
  const retiredType = draft.jobTypes.some((type) => !(JOB_TYPES as readonly string[]).includes(type));
  const retiredCurrency = draft.currency !== "" && !(CURRENCIES as readonly string[]).includes(draft.currency);
  const retiredPeriod = draft.period !== "" && !(PAY_PERIODS as readonly string[]).includes(draft.period);
  /** A field message stands, and it says what to change before saving. */
  const held = badAmount || incomplete || retiredType || retiredCurrency || retiredPeriod;

  async function save() {
    setSaving(true);
    const ok = await run(
      async () => {
        const values = cleanPreferences(toValues(draft));
        // Refused here by the same rule the server runs, so nothing is sent.
        if (!values) throw new ApiError(422, "invalid", "");
        const revision = saved.revision;
        let stored: Preferences;
        try {
          stored = await api.updatePreferences(values, revision);
          if (!preferencesWriteObserved(stored, revision, values)) throw new ApiError(502, "unavailable", INCOMPLETE_REPLY);
        } catch (error) {
          if (error instanceof ApiError && (error.status === 401 || error.status === 410)) throw error;
          // A failed reply can follow a save that landed, and a save sent twice is refused the
          // second time. Either way a fresh read decides: only the next revision holding exactly
          // the submitted values counts as saved.
          let current: Preferences;
          try {
            current = await api.preferences();
          } catch (readError) {
            if (readError instanceof ApiError && (readError.status === 401 || readError.status === 410)) throw readError;
            throw error;
          }
          if (!preferencesWriteObserved(current, revision, values)) throw error;
          stored = current;
        }
        setSaved(stored);
        setDraft(toDraft(stored));
      },
      { invalid: REFUSED },
    );
    if (ok) setJustSaved(true);
  }

  async function loadSaved() {
    setSaving(false);
    await run(async () => {
      const current = await loadPreferences();
      setSaved(current);
      setDraft(toDraft(current));
      setJustSaved(false);
    });
  }

  return (
    <form
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        if (!held) void save();
      }}
    >
      <div className="field-grid">
        <Field id={`${id}-place`} label="Place" hint="Where you’d work in person, such as a city or region.">
          <input
            id={`${id}-place`}
            type="text"
            value={draft.place}
            maxLength={MAX_PLACE_CHARS}
            readOnly={pending}
            onChange={(event) => edit({ place: event.target.value })}
            aria-describedby={`${id}-place-hint`}
            autoComplete="off"
          />
        </Field>
        <Field id={`${id}-from`} label="Available from">
          <select id={`${id}-from`} value={draft.availableFrom} disabled={pending} onChange={(event) => edit({ availableFrom: event.target.value })}>
            <option value="">Not said</option>
            {availabilityOptions(today, saved.availableFrom).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <fieldset aria-describedby={describedBy(`${id}-types-hint`, retiredType && `${id}-types-error`)}>
        <legend>Job types</legend>
        <div className="app-preferences__checks">
          {[...JOB_TYPES, ...retired.jobTypes].map((type) => {
            const gone = !(JOB_TYPES as readonly string[]).includes(type);
            const chosen = draft.jobTypes.includes(type);
            return (
              <label key={type}>
                <input
                  type="checkbox"
                  checked={chosen}
                  disabled={pending}
                  onChange={() => toggle(type)}
                  aria-invalid={gone && chosen ? true : undefined}
                  aria-describedby={gone && chosen ? `${id}-types-error` : undefined}
                />
                <span>{gone ? RETIRED : JOB_TYPE_LABEL[type as JobType]}</span>
              </label>
            );
          })}
        </div>
        <p className="rs-hint" id={`${id}-types-hint`}>
          Tick any that suit you. None ticked means not said.
        </p>
        {retiredType && (
          <p className="rs-inline-error" id={`${id}-types-error`}>
            {CHOOSE_LISTED}
          </p>
        )}
      </fieldset>

      <fieldset aria-describedby={describedBy(`${id}-pay-hint`, incomplete && `${id}-pay-error`)}>
        <legend>Pay floor</legend>
        <div className="field-grid">
          <Field id={`${id}-amount`} label="Amount" error={badAmount ? AMOUNT_DIGITS : undefined}>
            <input
              id={`${id}-amount`}
              type="text"
              inputMode="numeric"
              value={draft.amount}
              readOnly={pending}
              onChange={(event) => edit({ amount: event.target.value })}
              aria-invalid={badAmount || (incomplete && amount === "")}
              aria-describedby={describedBy(badAmount && `${id}-amount-error`, incomplete && `${id}-pay-error`, `${id}-pay-hint`)}
              autoComplete="off"
            />
          </Field>
          <Field id={`${id}-currency`} label="Currency" error={retiredCurrency ? CHOOSE_LISTED : undefined}>
            <select
              id={`${id}-currency`}
              value={draft.currency}
              disabled={pending}
              onChange={(event) => edit({ currency: event.target.value })}
              aria-invalid={retiredCurrency || (incomplete && draft.currency === "")}
              aria-describedby={describedBy(retiredCurrency && `${id}-currency-error`, incomplete && `${id}-pay-error`)}
            >
              <option value="">Not said</option>
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
              {/* A code is safe to print: a saved currency is three capital letters or it didn't load. */}
              {retired.currency && <option value={retired.currency}>{retired.currency} (no longer offered)</option>}
            </select>
          </Field>
          <Field id={`${id}-period`} label="Per" error={retiredPeriod ? CHOOSE_LISTED : undefined}>
            <select
              id={`${id}-period`}
              value={draft.period}
              disabled={pending}
              onChange={(event) => edit({ period: event.target.value })}
              aria-invalid={retiredPeriod || (incomplete && draft.period === "")}
              aria-describedby={describedBy(retiredPeriod && `${id}-period-error`, incomplete && `${id}-pay-error`)}
            >
              <option value="">Not said</option>
              {PAY_PERIODS.map((period) => (
                <option key={period} value={period}>
                  {PAY_PERIOD_LABEL[period]}
                </option>
              ))}
              {retired.period && <option value={retired.period}>{RETIRED}</option>}
            </select>
          </Field>
        </div>
        <p className="rs-hint" id={`${id}-pay-hint`}>
          The lowest pay you’d consider, before tax. Digits only, without cents.
        </p>
        {incomplete && (
          <p className="rs-inline-error" id={`${id}-pay-error`}>
            {PAY_INCOMPLETE}
          </p>
        )}
      </fieldset>

      <div className="actions">
        <button type="submit" className="primary" disabled={pending || held}>
          {pending && saving ? "Saving…" : "Save preferences"}
        </button>
        <button type="button" disabled={pending} onClick={() => void loadSaved()}>
          Load saved preferences
        </button>
        {justSaved && (
          <p className="success inline" role="status">
            Preferences saved.
          </p>
        )}
      </div>
      {saved.updatedAt !== null && <p className="hint">Last saved {formatDate(saved.updatedAt)}.</p>}
      <p className="hint">Loading the saved preferences replaces your unsaved changes in this form.</p>
      <ActionError message={error} />
    </form>
  );
}
