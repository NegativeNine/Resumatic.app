import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENCIES, PREFERENCES_CHANGED, PREFERENCES_REFUSED, type Preferences } from "../../src/shared/preferences";
import { JobPreferences } from "../../src/web/components/Preferences";
import { typeset } from "../../src/web/format";
import { VAULT_CHANGED } from "../../src/web/live";
import { AccountPage } from "../../src/web/pages/AccountPage";
import { ACCOUNT_DELETED_NOTE } from "../../src/web/session";
import { installFakeApi, type FakeApi } from "./api-fake";
import { fixtures, type Fixtures } from "./fixtures";
import { renderWithSession } from "./render";

const ROUTE = /^\/api\/preferences$/;
// Noon where the test runs, so the day it is shown as is the same in every time zone.
const SAVED_AT = new Date(2026, 10, 11, 12).getTime();
const saved = (extra: Partial<Preferences> = {}): Preferences => ({
  revision: 3,
  place: "Toronto, Ontario",
  jobTypes: ["full_time", "contract"],
  availableFrom: "2027-03",
  payFloor: { amount: 140000, currency: "CAD", period: "year" },
  updatedAt: SAVED_AT,
  ...extra,
});
const REFUSED = "These preferences couldn’t be saved as written. Check each field, then save again.";
const CHANGED = "Your preferences were changed somewhere else. Load the saved preferences, check them, then save again.";
const BUSY = "Resumatic is busy right now. Try again in a minute.";

// The months the form offers are counted from today, so today is fixed. Only the clock's reading is
// replaced: timers run as they are, which is what waiting for the page relies on.
beforeEach(() => void vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 11, 12) }));
afterEach(() => void vi.useRealTimers());

/** The card by itself, in a signed-in session, over the fake API. */
function open(change: (state: Fixtures) => void = () => {}) {
  const state = fixtures();
  change(state);
  const api = installFakeApi(state);
  const session = renderWithSession(<JobPreferences />, state.me);
  return { state, api, session };
}

/** The form's controls, once it has loaded. */
async function form() {
  const save = await screen.findByRole("button", { name: "Save preferences" });
  const types = screen.getByRole("group", { name: "Job types" });
  const pay = screen.getByRole("group", { name: "Pay floor" });
  return {
    save,
    load: screen.getByRole("button", { name: "Load saved preferences" }),
    place: screen.getByRole("textbox", { name: "Place" }),
    from: screen.getByRole("combobox", { name: "Available from" }),
    types,
    type: (name: string) => within(types).getByRole("checkbox", { name }),
    pay,
    amount: within(pay).getByRole("textbox", { name: "Amount" }),
    currency: within(pay).getByRole("combobox", { name: "Currency" }),
    period: within(pay).getByRole("combobox", { name: "Per" }),
  };
}

const options = (select: HTMLElement) => within(select).getAllByRole("option").map((option) => option.textContent);
const sent = (api: FakeApi) => api.callsTo("PUT", ROUTE).map((call) => call.body);
/** Lets every request through to the fake API, after `before` has had its say about it. */
function intercept(api: FakeApi, before: (method: string, respond: () => Promise<Response>) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => before((init?.method ?? "GET").toUpperCase(), () => api.fetch(input, init))));
}
/** Waits until the latest request has been answered and the page has had its turn with the answer. */
async function settled() {
  await vi.mocked(fetch).mock.results.at(-1)?.value;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
const violations = async () => (await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).violations.map((violation) => `${violation.id}: ${violation.help}`);

describe("job preferences", () => {
  it("says nothing here is shown to anyone or used yet", async () => {
    const state = fixtures();
    const api = installFakeApi(state);
    renderWithSession(<AccountPage />, state.me);
    const card = await screen.findByRole("region", { name: "Job preferences" });
    await within(card).findByRole("button", { name: "Save preferences" });
    expect(within(card).getByText("The work you’re looking for. Leave empty anything you’d rather not say.")).toBeInTheDocument();
    expect(card.querySelector(".rs-msg")!.textContent!.replace(/\s+/g, " ")).toBe(
      "Nothing here is shown to anyone or used yet. It stays in your vault: it isn’t put in a resume or a shared copy, and connected apps can’t read it.",
    );
    // The note is part of the card, not an announcement each time the page opens.
    expect(card.querySelector(".rs-msg")).not.toHaveAttribute("role");
    // On Account, directly after the profile.
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent).slice(0, 2)).toEqual(["Profile", "Job preferences"]);
    // Loaded by the card from its own route, once, and never with the session.
    expect(api.callsTo("GET", ROUTE)).toHaveLength(1);
    expect(JSON.stringify(state.me)).not.toMatch(/preferences|payFloor|jobTypes/);
  });

  it("starts with nothing chosen, and saves that as nothing said", async () => {
    const { api, state } = open();
    expect(screen.getByText("Loading your preferences…")).toBeInTheDocument();
    const f = await form();
    // Nothing is filled in for the person: no place from their profile, no currency, no period.
    expect(state.me.profile.location).toBe("Waterloo, ON");
    expect(f.place).toHaveValue("");
    expect(f.place).toHaveAttribute("maxlength", "120");
    expect(f.place).toHaveAttribute("autocomplete", "off");
    expect(f.place).toHaveAccessibleDescription("Where you’d work in person, such as a city or region.");
    expect(f.from).toHaveDisplayValue("Not said");
    expect(within(f.types).getAllByRole("checkbox").map((box) => [box.closest("label")!.textContent, (box as HTMLInputElement).checked])).toEqual([
      ["Full time", false], ["Part time", false], ["Contract", false], ["Temporary", false], ["Internship", false],
    ]);
    expect(f.types).toHaveAccessibleDescription("Tick any that suit you. None ticked means not said.");
    expect(f.amount).toHaveValue("");
    expect(f.amount).toHaveAttribute("inputmode", "numeric");
    expect(f.amount).toHaveAttribute("autocomplete", "off");
    expect(f.currency).toHaveDisplayValue("Not said");
    expect(f.period).toHaveDisplayValue("Not said");
    expect(f.pay).toHaveAccessibleDescription("The lowest pay you’d consider, before tax. Digits only, without cents.");

    // What each list offers: not said, now, then the next 24 months; every currency by its code; five periods.
    const months = options(f.from);
    expect(months).toHaveLength(26);
    expect(months.slice(0, 4)).toEqual(["Not said", "Now", "Dec 2026", "Jan 2027"]);
    expect(months.at(-1)).toBe("Nov 2028");
    expect(options(f.currency)).toEqual(["Not said", ...CURRENCIES]);
    expect(options(f.period)).toEqual(["Not said", "Year", "Month", "Week", "Day", "Hour"]);
    // Never saved, so there is no day it was last saved.
    expect(screen.queryByText(/^Last saved/)).toBeNull();
    expect(f.save).toBeEnabled();

    await userEvent.click(f.save);
    expect(await screen.findByRole("status")).toHaveTextContent("Preferences saved.");
    expect(sent(api)).toEqual([{ place: null, jobTypes: [], availableFrom: null, payFloor: null, expectedRevision: 0 }]);
    expect(state.preferences).toMatchObject({ revision: 1, place: null, jobTypes: [], availableFrom: null, payFloor: null });
    expect(screen.getByText("Last saved 11 Nov 2026.")).toBeInTheDocument();
  });

  it("shows what was saved, and when", async () => {
    const { api } = open((state) => (state.preferences = saved({ availableFrom: "2025-03" })));
    const f = await form();
    expect(f.place).toHaveValue("Toronto, Ontario");
    expect(f.type("Full time")).toBeChecked();
    expect(f.type("Contract")).toBeChecked();
    for (const name of ["Part time", "Temporary", "Internship"]) expect(f.type(name)).not.toBeChecked();
    expect(f.amount).toHaveValue("140000");
    expect(f.currency).toHaveDisplayValue("CAD");
    expect(f.period).toHaveDisplayValue("Year");
    expect(screen.getByText("Last saved 11 Nov 2026.")).toBeInTheDocument();
    // A month that has passed since it was saved is still the one selected, in its place by date.
    expect(f.from).toHaveDisplayValue("Mar 2025");
    expect(options(f.from).slice(0, 4)).toEqual(["Not said", "Now", "Mar 2025", "Dec 2026"]);
    expect(options(f.from)).toHaveLength(27);
    // Opening the form says nothing was just saved, and sends nothing.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(sent(api)).toEqual([]);
    expect(await violations()).toEqual([]);
  });

  it("sends exactly what was chosen, at the revision it loaded, and says it saved", async () => {
    const { api, state } = open((fixture) => (fixture.preferences = saved()));
    const f = await form();
    await userEvent.clear(f.place);
    await userEvent.type(f.place, "  Leeds ");
    await userEvent.click(f.type("Contract"));
    await userEvent.click(f.type("Internship"));
    await userEvent.click(f.type("Part time"));
    await userEvent.selectOptions(f.from, "Now");
    await userEvent.clear(f.amount);
    await userEvent.type(f.amount, "25 ");
    await userEvent.selectOptions(f.currency, "GBP");
    await userEvent.selectOptions(f.period, "Hour");

    // While the save is on its way the form says so, and nothing in it can be changed.
    let arrive!: () => void;
    const held = new Promise<void>((resolve) => (arrive = resolve));
    intercept(api, async (method, respond) => {
      if (method === "PUT") await held;
      return respond();
    });
    await userEvent.click(f.save);
    const saving = await screen.findByRole("button", { name: "Saving…" });
    expect(saving).toBeDisabled();
    expect(f.load).toBeDisabled();
    expect(f.place).toHaveAttribute("readonly");
    expect(f.amount).toHaveAttribute("readonly");
    for (const control of [f.from, f.currency, f.period, ...within(f.types).getAllByRole("checkbox")]) expect(control).toBeDisabled();
    expect(saving.closest("form")).toHaveAttribute("aria-busy", "true");
    arrive();

    expect(await screen.findByRole("status")).toHaveTextContent("Preferences saved.");
    // The place trimmed, the job types in the list's order whatever order they were ticked in, the amount a number.
    expect(sent(api)).toEqual([{ place: "Leeds", jobTypes: ["full_time", "part_time", "internship"], availableFrom: "now", payFloor: { amount: 25, currency: "GBP", period: "hour" }, expectedRevision: 3 }]);
    expect(state.preferences).toMatchObject({ revision: 4, place: "Leeds" });
    // The form now shows what was stored, and is unlocked.
    expect(f.place).toHaveValue("Leeds");
    expect(f.place).not.toHaveAttribute("readonly");
    expect(f.amount).toHaveValue("25");
    expect(screen.getByRole("button", { name: "Save preferences" })).toBeEnabled();
    // Changing anything takes the confirmation away, and the next save names the new revision.
    await userEvent.click(f.type("Temporary"));
    expect(screen.queryByRole("status")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Preferences saved.");
    expect(sent(api)[1]).toMatchObject({ jobTypes: ["full_time", "part_time", "temporary", "internship"], expectedRevision: 4 });
  });

  it("holds the save while a pay floor is incomplete or not in digits, and says which", async () => {
    const { api } = open();
    const f = await form();
    const INCOMPLETE = "A pay floor needs an amount, a currency and a period. Fill in all three, or clear all three.";
    const DIGITS = "Enter the amount in digits only, such as 140000.";

    // One of the three, then two: incomplete, and the fields still empty are the ones marked.
    await userEvent.type(f.amount, "140000");
    expect(within(f.pay).getByText(INCOMPLETE)).toBeInTheDocument();
    expect(f.save).toBeDisabled();
    expect(f.amount).toHaveAttribute("aria-invalid", "false");
    for (const empty of [f.currency, f.period]) {
      expect(empty).toHaveAttribute("aria-invalid", "true");
      expect(empty).toHaveAccessibleDescription(INCOMPLETE);
    }
    expect(f.pay).toHaveAccessibleDescription(`The lowest pay you’d consider, before tax. Digits only, without cents. ${INCOMPLETE}`);
    expect(await violations()).toEqual([]);
    await userEvent.selectOptions(f.currency, "CAD");
    expect(within(f.pay).getByText(INCOMPLETE)).toBeInTheDocument();
    expect(f.currency).toHaveAttribute("aria-invalid", "false");
    expect(f.save).toBeDisabled();
    // Pressing Enter in a field is a save too, and it is held as the button is.
    await userEvent.type(f.amount, "{Enter}");
    expect(sent(api)).toEqual([]);
    // All three, and there is nothing to say.
    await userEvent.selectOptions(f.period, "Year");
    expect(within(f.pay).queryByText(INCOMPLETE)).toBeNull();
    expect(f.save).toBeEnabled();

    // An amount that isn't whole digits is said as that, whatever else is filled in.
    for (const typed of ["140,000", "140 000", "140000.50", "1,5", "140k", "$140000", "0", "0140000", "-5", "1000000000000"]) {
      await userEvent.clear(f.amount);
      await userEvent.type(f.amount, typed);
      expect(within(f.pay).getByText(DIGITS), typed).toBeInTheDocument();
      expect(within(f.pay).queryByText(INCOMPLETE), typed).toBeNull();
      expect(f.amount, typed).toHaveAttribute("aria-invalid", "true");
      expect(f.amount.getAttribute("aria-describedby")!.split(" ")[0], typed).toBe(within(f.pay).getByText(DIGITS).id);
      expect(f.save, typed).toBeDisabled();
    }
    expect(await violations()).toEqual([]);
    // The largest amount there is, and white space around the digits, are both fine.
    for (const typed of ["999999999999", " 140000 "]) {
      await userEvent.clear(f.amount);
      await userEvent.type(f.amount, typed);
      expect(within(f.pay).queryByText(DIGITS), typed).toBeNull();
      expect(f.save, typed).toBeEnabled();
    }
    // Cleared, all three, is no pay floor, and that can be saved.
    await userEvent.clear(f.amount);
    await userEvent.selectOptions(f.currency, "Not said");
    await userEvent.selectOptions(f.period, "Not said");
    expect(within(f.pay).queryByText(INCOMPLETE)).toBeNull();
    expect(sent(api)).toEqual([]);
    await userEvent.click(f.save);
    expect(await screen.findByRole("status")).toHaveTextContent("Preferences saved.");
    expect(sent(api)).toEqual([{ place: null, jobTypes: [], availableFrom: null, payFloor: null, expectedRevision: 0 }]);
  });

  it("lists a saved choice that is no longer offered under fixed copy, holds the save while it is selected, and saves once it is replaced", async () => {
    // Saved when a seasonal job type, a fortnightly period and the kuna were all offered.
    const { api, state } = open((fixture) => (fixture.preferences = saved({ revision: 7, place: "Zagreb", jobTypes: ["full_time", "seasonal"], availableFrom: "2021-06", payFloor: { amount: 9000, currency: "HRK", period: "biweekly" } })));
    const f = await form();
    const RETIRED = "A choice that’s no longer offered";
    const CHOOSE = "Choose one of the listed options.";
    // Each is still there, still chosen, and named by fixed copy: a stored token is never printed.
    const boxes = within(f.types).getAllByRole("checkbox");
    expect(boxes.map((box) => box.closest("label")!.textContent)).toEqual(["Full time", "Part time", "Contract", "Temporary", "Internship", RETIRED]);
    expect(f.type(RETIRED)).toBeChecked();
    expect(f.currency).toHaveDisplayValue("HRK (no longer offered)");
    expect(options(f.currency)).toEqual(["Not said", ...CURRENCIES, "HRK (no longer offered)"]);
    expect(f.period).toHaveDisplayValue(RETIRED);
    expect(options(f.period)).toEqual(["Not said", "Year", "Month", "Week", "Day", "Hour", RETIRED]);
    expect(f.from).toHaveDisplayValue("Jun 2021");
    expect(document.body.textContent).not.toMatch(/seasonal|biweekly/);

    // Each of the three says what to do, where it is, and the save waits for all of them.
    expect(screen.getAllByText(CHOOSE)).toHaveLength(3);
    expect(f.type(RETIRED)).toHaveAttribute("aria-invalid", "true");
    expect(f.type(RETIRED)).toHaveAccessibleDescription(CHOOSE);
    expect(f.type("Full time")).not.toHaveAttribute("aria-invalid");
    for (const select of [f.currency, f.period]) {
      expect(select).toHaveAttribute("aria-invalid", "true");
      expect(select).toHaveAccessibleDescription(CHOOSE);
    }
    expect(f.save).toBeDisabled();
    expect(await violations()).toEqual([]);

    await userEvent.click(f.type(RETIRED));
    expect(screen.getAllByText(CHOOSE)).toHaveLength(2);
    // Unticked, it stays listed until a save: it is what the saved preferences still hold.
    expect(f.type(RETIRED)).not.toBeChecked();
    expect(f.save).toBeDisabled();
    await userEvent.selectOptions(f.currency, "EUR");
    expect(screen.getAllByText(CHOOSE)).toHaveLength(1);
    expect(f.save).toBeDisabled();
    await userEvent.selectOptions(f.period, "Month");
    expect(screen.queryByText(CHOOSE)).toBeNull();
    expect(f.save).toBeEnabled();
    expect(sent(api)).toEqual([]);

    await userEvent.click(f.save);
    expect(await screen.findByRole("status")).toHaveTextContent("Preferences saved.");
    expect(sent(api)).toEqual([{ place: "Zagreb", jobTypes: ["full_time"], availableFrom: "2021-06", payFloor: { amount: 9000, currency: "EUR", period: "month" }, expectedRevision: 7 }]);
    expect(state.preferences).toMatchObject({ revision: 8, jobTypes: ["full_time"], payFloor: { currency: "EUR", period: "month" } });
    // Replaced and saved, the choices that left their lists are gone from the form.
    expect(within(f.types).getAllByRole("checkbox")).toHaveLength(5);
    expect(options(f.currency)).toEqual(["Not said", ...CURRENCIES]);
    expect(options(f.period)).toHaveLength(6);
    expect(screen.queryByText(RETIRED)).toBeNull();
    // The month that has passed was never withdrawn, and is still what is saved.
    expect(f.from).toHaveDisplayValue("Jun 2021");
  });

  it("keeps the draft when someone saved first", async () => {
    const { api, state } = open((fixture) => (fixture.preferences = saved()));
    const f = await form();
    await userEvent.clear(f.place);
    await userEvent.type(f.place, "Leeds");
    await userEvent.click(f.type("Internship"));
    // Another tab saves while this form is open.
    state.preferences = saved({ revision: 4, place: "Montréal", jobTypes: ["part_time"], payFloor: null });

    await userEvent.click(f.save);
    // The server's own sentence, which says what happened and what to do.
    expect(await screen.findByRole("alert")).toHaveTextContent(CHANGED);
    expect(CHANGED).toBe(PREFERENCES_CHANGED);
    expect(screen.queryByRole("status")).toBeNull();
    // Nothing typed is lost, and nothing of the other save has replaced it.
    expect(f.place).toHaveValue("Leeds");
    expect(f.type("Internship")).toBeChecked();
    expect(f.amount).toHaveValue("140000");
    expect(state.preferences).toMatchObject({ revision: 4, place: "Montréal" });
    // Saving again without loading is refused again: the form still holds the revision it read.
    await userEvent.click(f.save);
    await waitFor(() => expect(sent(api)).toHaveLength(2));
    expect(sent(api).map((body) => (body as { expectedRevision: number }).expectedRevision)).toEqual([3, 3]);
    expect(await screen.findByRole("alert")).toHaveTextContent(CHANGED);

    // Loading the saved preferences shows what the other tab saved, and a save then lands.
    await userEvent.click(f.load);
    await waitFor(() => expect(f.place).toHaveValue("Montréal"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(f.type("Part time")).toBeChecked();
    expect(f.type("Internship")).not.toBeChecked();
    expect(f.amount).toHaveValue("");
    await userEvent.click(f.type("Internship"));
    await userEvent.click(f.save);
    expect(await screen.findByRole("status")).toHaveTextContent("Preferences saved.");
    expect(sent(api)[2]).toMatchObject({ place: "Montréal", jobTypes: ["part_time", "internship"], expectedRevision: 4 });
    expect(state.preferences).toMatchObject({ revision: 5 });
  });

  it("counts a lost reply as saved once a fresh read shows it, and keeps the draft otherwise", async () => {
    const { api, state } = open((fixture) => (fixture.preferences = saved()));
    const f = await form();
    const retype = async (place: string) => {
      await userEvent.clear(f.place);
      await userEvent.type(f.place, place);
    };

    // The save lands and its reply never arrives. A fresh read shows it, at the next revision.
    let lose = 1;
    intercept(api, async (method, respond) => {
      const response = await respond();
      if (method === "PUT" && lose-- > 0) throw new TypeError("Failed to fetch");
      return response;
    });
    await retype("Leeds");
    await userEvent.click(f.save);
    expect(await screen.findByRole("status")).toHaveTextContent("Preferences saved.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(state.preferences).toMatchObject({ revision: 4, place: "Leeds" });
    expect(api.callsTo("GET", ROUTE)).toHaveLength(2);

    // The save never lands. The fresh read shows what was there before, so the first error stands.
    api.fail("PUT", ROUTE, 503, "unavailable", "storage is busy");
    await retype("York");
    await userEvent.click(f.save);
    expect(await screen.findByRole("alert")).toHaveTextContent(BUSY);
    expect(screen.queryByRole("status")).toBeNull();
    expect(f.place).toHaveValue("York");
    expect(state.preferences).toMatchObject({ revision: 4, place: "Leeds" });

    // The same save sent again, after the first one landed unseen, is refused as stale. The fresh
    // read shows exactly what was sent at exactly the next revision, so it is this save.
    state.preferences = saved({ revision: 5, place: "York", updatedAt: SAVED_AT + 1 });
    await userEvent.click(f.save);
    expect(await screen.findByRole("status")).toHaveTextContent("Preferences saved.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(sent(api).at(-1)).toMatchObject({ place: "York", expectedRevision: 4 });

    // A reply that is not a saved row is no proof of a save either.
    api.fail("PUT", ROUTE, 200, "unexpected", "not a row");
    await retype("Hull");
    await userEvent.click(f.save);
    expect(await screen.findByRole("alert")).toHaveTextContent(BUSY);
    expect(f.place).toHaveValue("Hull");
    // Nor is a fresh read one revision on that holds someone else's values, or one that fails.
    state.preferences = saved({ revision: 6, place: "Bath", updatedAt: SAVED_AT + 2 });
    await userEvent.click(f.save);
    expect(await screen.findByRole("alert")).toHaveTextContent(CHANGED);
    expect(f.place).toHaveValue("Hull");
    api.fail("PUT", ROUTE, 503, "unavailable", "storage is busy");
    api.fail("GET", ROUTE, 500, "internal", "something went wrong");
    await userEvent.click(f.save);
    expect(await screen.findByRole("alert")).toHaveTextContent(BUSY);
    expect(f.place).toHaveValue("Hull");
    expect(screen.queryByRole("status")).toBeNull();
    expect(state.preferences).toMatchObject({ revision: 6, place: "Bath" });
  });

  it("words a refusal itself and never shows the server's detail", async () => {
    const { api, state } = open((fixture) => (fixture.preferences = saved()));
    const f = await form();
    // The form's sentence is the server's, set as the interface writes one.
    expect(typeset(PREFERENCES_REFUSED)).toBe(REFUSED);

    api.fail("PUT", ROUTE, 422, "invalid", '✖ Unrecognized key: "workAuthorisation" ✖ Invalid input: expected nonoptional, received undefined → at place');
    await userEvent.clear(f.place);
    await userEvent.type(f.place, "Leeds");
    await userEvent.click(f.save);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(REFUSED);
    expect(document.body.textContent).not.toMatch(/Unrecognized|workAuthorisation|nonoptional/);
    expect(f.place).toHaveValue("Leeds");
    expect(screen.queryByRole("status")).toBeNull();
    expect(state.preferences).toMatchObject({ revision: 3, place: "Toronto, Ontario" });

    // What the rule refuses is refused in the form, in the same words, and nothing is sent.
    const before = api.calls.length;
    fireEvent.change(f.place, { target: { value: "Leeds\tYork" } });
    expect(screen.queryByRole("alert")).not.toBeNull();
    await userEvent.click(f.save);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save preferences" })).toBeEnabled());
    expect(screen.getByRole("alert")).toHaveTextContent(REFUSED);
    expect(api.calls).toHaveLength(before);
    expect(f.place).toHaveValue("Leeds\tYork");
  });

  it("keeps the draft through a background reload, and replaces it with the saved preferences when asked", async () => {
    const { api, state } = open((fixture) => (fixture.preferences = saved()));
    const f = await form();
    await userEvent.clear(f.place);
    await userEvent.type(f.place, "Leeds");
    await userEvent.click(f.type("Internship"));

    // Something else in the vault changes, and every card on the page reads again.
    state.preferences = saved({ revision: 4, place: "Montréal", jobTypes: [], availableFrom: null, payFloor: null });
    window.dispatchEvent(new Event(VAULT_CHANGED));
    await waitFor(() => expect(api.callsTo("GET", ROUTE)).toHaveLength(2));
    await settled();
    expect(f.place).toHaveValue("Leeds");
    expect(f.type("Internship")).toBeChecked();
    expect(f.amount).toHaveValue("140000");
    // A reload that fails changes nothing either: the form stays, with no error over it.
    api.fail("GET", ROUTE, 503, "unavailable", "storage is busy");
    window.dispatchEvent(new Event(VAULT_CHANGED));
    await waitFor(() => expect(api.callsTo("GET", ROUTE)).toHaveLength(3));
    await settled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Loading your preferences…")).toBeNull();
    expect(f.place).toHaveValue("Leeds");
    expect(screen.getByRole("button", { name: "Save preferences" })).toBeEnabled();

    // Asked for, the saved preferences replace the draft, and the form says that they will.
    expect(screen.getByText("Loading the saved preferences replaces your unsaved changes in this form.")).toBeInTheDocument();
    await userEvent.click(f.load);
    await waitFor(() => expect(f.place).toHaveValue("Montréal"));
    for (const box of within(f.types).getAllByRole("checkbox")) expect(box).not.toBeChecked();
    expect(f.from).toHaveDisplayValue("Not said");
    expect(f.amount).toHaveValue("");
    expect(f.currency).toHaveDisplayValue("Not said");
    expect(screen.queryByRole("status")).toBeNull();
    // A saved row that arrives misshapen replaces nothing.
    await userEvent.type(f.place, " Nord");
    api.fail("GET", ROUTE, 200, "unexpected", "not a row");
    await userEvent.click(f.load);
    expect(await screen.findByRole("alert")).toHaveTextContent(BUSY);
    expect(f.place).toHaveValue("Montréal Nord");
  });

  it("shows a failed load with a way to retry, and ends the session when it is over", async () => {
    const state = fixtures();
    state.preferences = saved();
    const api = installFakeApi(state);
    api.fail("GET", ROUTE, 503, "unavailable", "storage is busy");
    const first = renderWithSession(<JobPreferences />, state.me);
    expect(await screen.findByRole("alert")).toHaveTextContent(BUSY);
    expect(screen.queryByRole("button", { name: "Save preferences" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Place" })).toBeNull();
    // A reply that is not a whole saved row is no better: half a form is not shown.
    api.fail("GET", ROUTE, 200, "unexpected", "not a row");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(api.callsTo("GET", ROUTE)).toHaveLength(2));
    expect(await screen.findByRole("alert")).toHaveTextContent(BUSY);
    expect(screen.queryByRole("button", { name: "Save preferences" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("textbox", { name: "Place" })).toHaveValue("Toronto, Ontario");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(first.ended).toEqual([]);

    // A session that ended while a save was on its way: the app signs out, and asks nothing more.
    api.fail("PUT", ROUTE, 401, "unauthenticated", "this session was signed out");
    const reads = api.callsTo("GET", ROUTE).length;
    await userEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() => expect(first.ended).toEqual(["Your session has ended. Sign in again to carry on."]));
    expect(api.callsTo("GET", ROUTE)).toHaveLength(reads);
    expect(screen.queryByRole("status")).toBeNull();
    first.unmount();

    // And one that had ended before the card loaded, or whose account is gone.
    for (const [status, code, note] of [[401, "unauthenticated", "Your session has ended. Sign in again to carry on."], [410, "gone", ACCOUNT_DELETED_NOTE]] as const) {
      api.fail("GET", ROUTE, status, code, "over");
      const session = renderWithSession(<JobPreferences />, state.me);
      await waitFor(() => expect(session.ended).toEqual([note]));
      expect(screen.queryByRole("button", { name: "Save preferences" })).toBeNull();
      session.unmount();
    }
  });
});
