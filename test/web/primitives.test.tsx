import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ActionError,
  Badge,
  CharCount,
  EmptyState,
  ErrorNote,
  Field,
  LINE_MARK,
  Loading,
  Message,
  PageHeader,
  Quote,
  REVIEW_MARK,
  REVIEW_TICK,
  RUN_MARK,
  Success,
  Tick,
  type MarkTone,
  type TickState,
} from "../../src/web/components/ui";
import { StateCard, Stopped } from "../../src/web/components/States";

describe("messages", () => {
  it("announces a failed load as an alert, with a way to try again", async () => {
    let resolve!: () => void;
    const onRetry = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<ErrorNote message="Your jobs couldn’t load." onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Your jobs couldn’t load.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("button", { name: "Trying again…" })).toBeDisabled();
    resolve();
    expect(await screen.findByRole("button", { name: "Try again" })).toBeEnabled();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("shows an action’s error only when there is one", () => {
    const { rerender, container } = render(<ActionError message={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ActionError message="This file is empty." />);
    expect(screen.getByRole("alert")).toHaveTextContent("This file is empty.");
  });

  it("announces information and success as status", () => {
    render(
      <>
        <Message tone="info">You’ve used all 20 outputs for Nov 2026.</Message>
        <Success>Profile saved.</Success>
      </>,
    );
    const statuses = screen.getAllByRole("status");
    expect(statuses.map((s) => s.textContent)).toEqual(["You’ve used all 20 outputs for Nov 2026.", "Profile saved."]);
  });

  it("names the next step in an empty state", () => {
    render(
      <EmptyState title="You’re all caught up">
        Nothing is waiting for review. Next, <a href="#/jobs">add a job</a>.
      </EmptyState>,
    );
    expect(screen.getByText("You’re all caught up").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "add a job" })).toHaveAttribute("href", "#/jobs");
  });
});

describe("marks and ticks", () => {
  it("draws each tone as its plain status mark", () => {
    const tones: MarkTone[] = ["backed", "needs-you", "note", "working", "problem", "beta", "status"];
    render(
      <>
        {tones.map((tone) => (
          <Badge key={tone} tone={tone}>{`Mark ${tone}`}</Badge>
        ))}
      </>,
    );
    for (const tone of tones) expect(screen.getByText(`Mark ${tone}`)).toHaveClass("rs-mark", `rs-mark--${tone}`);
  });

  it("maps stored states to the plain tones, so no earlier class name reaches the page", () => {
    expect(REVIEW_MARK).toEqual({ proposed: "needs-you", confirmed: "backed", rejected: "note" });
    expect(REVIEW_TICK).toEqual({ proposed: "needs-you", confirmed: "backed", rejected: "left-out" });
    expect(LINE_MARK).toEqual({ kept: "backed", repaired: "note", replaced: "note", edited: "note" });
    expect(RUN_MARK).toEqual({ queued: "working", running: "working", ready: "backed", failed: "problem" });
  });

  it("names a tick only when it carries meaning on its own", () => {
    render(
      <>
        <Tick state="backed" label="Confirmed" />
        <Tick state="needs-you" />
      </>,
    );
    expect(screen.getByRole("img", { name: "Confirmed" })).toHaveClass("rs-tick--backed");
    expect(document.querySelector(".rs-tick--needs-you")).toHaveAttribute("aria-hidden", "true");
  });

  it("draws a check when backed, a cross when left out and an alert for a problem, and nothing otherwise", () => {
    const states: TickState[] = ["backed", "needs-you", "left-out", "working", "problem", "todo"];
    render(
      <>
        {states.map((state) => (
          <Tick key={state} state={state} />
        ))}
      </>,
    );
    const glyph = (state: TickState) => document.querySelector(`.rs-tick--${state} .rs-g`)?.className ?? null;
    expect(glyph("backed")).toBe("rs-g rs-g--check");
    expect(glyph("left-out")).toBe("rs-g rs-g--cross");
    expect(glyph("problem")).toBe("rs-g rs-g--alert");
    for (const state of ["needs-you", "working", "todo"] as const) expect(glyph(state)).toBeNull();
  });
});

describe("Quote", () => {
  it("highlights the person’s words and keeps the file in the caption", () => {
    render(<Quote text="  Led migration of 40 services  " caption="From sam-rivera-2024.pdf" />);
    const mark = screen.getByText("Led migration of 40 services");
    expect(mark.tagName).toBe("MARK");
    expect(mark.closest("blockquote")).not.toBeNull();
    expect(screen.getByText("From sam-rivera-2024.pdf").tagName).toBe("FIGCAPTION");
  });

  it("Quote carries the quote icon", () => {
    render(<Quote text="Led migration of 40 services" />);
    const icon = document.querySelector("figure > .rs-g");
    expect(icon).toHaveClass("rs-g--quote");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector(".rs-g--follows")).toBeNull();
  });

  it("sets a little context around the quote, muted", () => {
    render(<Quote text="Helped migrate the pipeline" context={{ before: "Northwind, 2020. ", after: ", and on-call." }} />);
    expect(document.querySelector("figure")).toHaveClass("rs-quote--context");
    expect(screen.getByText("Northwind, 2020.")).toHaveClass("rs-quote__context");
  });
});

describe("fields", () => {
  it("labels its control and describes it with the hint", () => {
    render(
      <Field id="level" label="Level (optional)" hint="How much of the work was yours.">
        <select id="level" aria-describedby="level-hint" />
      </Field>,
    );
    expect(screen.getByRole("combobox", { name: "Level (optional)" })).toHaveAccessibleDescription("How much of the work was yours.");
  });

  it("counts characters, and says by how much a text is over", () => {
    const { rerender } = render(<CharCount id="c" length={1200} max={20000} />);
    expect(screen.getByText("1,200 of 20,000 characters")).not.toHaveClass("is-over");
    rerender(<CharCount id="c" length={20012} max={20000} />);
    expect(screen.getByText("12 characters over the 20,000 limit")).toHaveClass("is-over");
  });
});

describe("page parts", () => {
  it("gives the page one h1 and a lede", () => {
    render(<PageHeader title="Facts">Check each fact against the words it came from.</PageHeader>);
    expect(screen.getByRole("heading", { level: 1, name: "Facts" })).toHaveClass("rs-h1");
    expect(screen.getByText("Check each fact against the words it came from.")).toHaveClass("rs-lede");
  });

  it("announces loading", () => {
    render(<Loading>Loading your jobs…</Loading>);
    expect(screen.getByRole("status")).toHaveTextContent("Loading your jobs…");
  });
});

describe("states", () => {
  it("StateCard names what happened under its heading; Stopped is an alert with at most one action", () => {
    const card = render(
      <StateCard title="This copy can’t be opened" action={<a href="#/coaching/clients">Back to your clients</a>}>
        This copy has ended.
      </StateCard>,
    );
    const region = screen.getByRole("region", { name: "This copy can’t be opened" });
    expect(region).toHaveClass("rs-panel", "app-state-card");
    expect(screen.getByRole("heading", { level: 2, name: "This copy can’t be opened" })).toHaveClass("rs-h3");
    expect(screen.getByText("This copy has ended.")).toHaveClass("rs-meta");
    expect(screen.getByRole("link", { name: "Back to your clients" })).toBeInTheDocument();
    card.unmount();
    // Where the card is the whole page, its heading is the page's.
    const page = render(<StateCard level={1} title="This link isn’t available">Ask them for a new one.</StateCard>);
    expect(screen.getByRole("heading", { level: 1, name: "This link isn’t available" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    page.unmount();
    render(<Stopped action={<a href="#/account/plan">See plans</a>}>You’ve used all 20 documents for this month.</Stopped>);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("rs-msg", "rs-msg--error");
    expect(alert).toHaveTextContent("You’ve used all 20 documents for this month.See plans");
    expect(alert.querySelector(".rs-g--alert")).toHaveAttribute("aria-hidden", "true");
    expect(alert.querySelectorAll("a, button")).toHaveLength(1);
  });
});

