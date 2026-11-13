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
  StateCard,
  Stopped,
  Success,
  Tick,
  type MarkTone,
  type TickState,
} from "../../src/web/components/ui";

describe("messages", () => {
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
});

// One component for each state a room can be in, each with the role its places announce it by.
describe("states", () => {
  it("Loading says what is being read, as a status", () => {
    render(<Loading>Loading your jobs…</Loading>);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading your jobs…");
    expect(status).toHaveClass("rs-loading");
    expect(status.querySelector(".rs-spinner")).toHaveAttribute("aria-hidden", "true");
  });

  it("ErrorNote is an alert, and Try again waits for the retry", async () => {
    let resolve!: () => void;
    const onRetry = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const { unmount } = render(<ErrorNote message="Your jobs couldn’t load." onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Your jobs couldn’t load.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("button", { name: "Trying again…" })).toBeDisabled();
    resolve();
    expect(await screen.findByRole("button", { name: "Try again" })).toBeEnabled();
    expect(onRetry).toHaveBeenCalledOnce();
    unmount();
    // With nothing to retry, it only says what failed.
    render(<ErrorNote message="Your confirmed facts couldn’t be loaded. Close this editor, then try again." />);
    expect(screen.getByRole("alert")).toHaveClass("rs-msg", "rs-msg--error", "app-msg-block");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("ActionError is an alert by default, a status or silent where its place says so, and nothing without a message", () => {
    const { rerender, container } = render(<ActionError message="This file is empty." />);
    expect(screen.getByRole("alert")).toHaveTextContent("This file is empty.");
    rerender(<ActionError role="status" message="This document couldn’t be finished." />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("This document couldn’t be finished.");
    rerender(<ActionError role={null} message="No text could be read from this file." />);
    const line = screen.getByText("No text could be read from this file.").closest("p")!;
    expect(line).toHaveClass("rs-inline-error");
    expect(line).not.toHaveAttribute("role");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(line.querySelector(".rs-g--alert")).toHaveAttribute("aria-hidden", "true");
    rerender(<ActionError message={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("Message is a status unless it is not live, with its one action inside", () => {
    const { rerender } = render(
      <Message tone="info" action={<button type="button">Save it again</button>}>
        You’ve already saved this job.
      </Message>,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveClass("rs-msg", "rs-msg--info", "app-msg-block");
    expect(status).toHaveTextContent("You’ve already saved this job.");
    expect(status).toContainElement(screen.getByRole("button", { name: "Save it again" }));
    rerender(
      <Message tone="info" live={false}>
        This copy isn’t open to Dana any more.
      </Message>,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("This copy isn’t open to Dana any more.").closest(".rs-msg")).not.toHaveAttribute("role");
  });

  it("Stopped is an alert with at most one action, or silent where it is shown on arrival", () => {
    const { rerender } = render(<Stopped action={<a href="#/account/plan">See plans</a>}>You’ve used all 20 documents for this month.</Stopped>);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("rs-msg", "rs-msg--error", "app-msg-block");
    expect(alert).toHaveTextContent("You’ve used all 20 documents for this month.See plans");
    expect(alert.querySelector(".rs-g--alert")).toHaveAttribute("aria-hidden", "true");
    expect(alert.querySelectorAll("a, button")).toHaveLength(1);
    rerender(<Stopped role={null}>Your documents for this period are used or held for work in progress.</Stopped>);
    expect(screen.queryByRole("alert")).toBeNull();
    const stop = screen.getByText("Your documents for this period are used or held for work in progress.").closest(".rs-msg")!;
    expect(stop).toHaveClass("rs-msg--error", "app-msg-block");
    expect(stop).not.toHaveAttribute("role");
  });

  it("StateCard names what happened under its heading", () => {
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
    render(<StateCard level={1} title="This link isn’t available">Ask them for a new one.</StateCard>);
    expect(screen.getByRole("heading", { level: 1, name: "This link isn’t available" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("EmptyState names the empty list in bold, then the next step, and announces nothing", () => {
    render(
      <EmptyState title="No jobs yet.">
        Paste a job description above to start your first one. Or <a href="#/jobs">add a job</a>.
      </EmptyState>,
    );
    const title = screen.getByText("No jobs yet.");
    expect(title.tagName).toBe("STRONG");
    const empty = title.closest("p")!;
    expect(empty).toHaveClass("rs-empty");
    expect(empty).toHaveTextContent("No jobs yet.Paste a job description above to start your first one.");
    expect(screen.getByRole("link", { name: "add a job" })).toHaveAttribute("href", "#/jobs");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
