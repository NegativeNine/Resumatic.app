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
  Loading,
  Message,
  PageHeader,
  Quote,
  Success,
  Tick,
} from "../../src/web/components/ui";

describe("messages", () => {
  it("announces a failed load as an alert, with a way to try again", async () => {
    let resolve!: () => void;
    const onRetry = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<ErrorNote message="Your jobs couldn't load." onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Your jobs couldn't load.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("button", { name: "Trying again…" })).toBeDisabled();
    resolve();
    expect(await screen.findByRole("button", { name: "Try again" })).toBeEnabled();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("shows an action's error only when there is one", () => {
    const { rerender, container } = render(<ActionError message={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ActionError message="This file is empty." />);
    expect(screen.getByRole("alert")).toHaveTextContent("This file is empty.");
  });

  it("announces information and success as status", () => {
    render(
      <>
        <Message tone="info">You've used all 20 outputs for Nov 2026.</Message>
        <Success>Profile saved.</Success>
      </>,
    );
    const statuses = screen.getAllByRole("status");
    expect(statuses.map((s) => s.textContent)).toEqual(["You've used all 20 outputs for Nov 2026.", "Profile saved."]);
  });

  it("names the next step in an empty state", () => {
    render(
      <EmptyState title="You're all caught up">
        Nothing is waiting for review. Next, <a href="#/jobs">add a job</a>.
      </EmptyState>,
    );
    expect(screen.getByText("You're all caught up").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "add a job" })).toHaveAttribute("href", "#/jobs");
  });
});

describe("marks and ticks", () => {
  it("draws a v1 tone as its status mark", () => {
    render(
      <>
        <Badge tone="proposed">Proposed role</Badge>
        <Badge tone="queued">Reading…</Badge>
      </>,
    );
    expect(screen.getByText("Proposed role")).toHaveClass("rs-mark", "rs-mark--proposed");
    expect(screen.getByText("Reading…")).toHaveClass("rs-mark", "rs-mark--reading");
  });

  it("names a tick only when it carries meaning on its own", () => {
    render(
      <>
        <Tick state="confirmed" label="Confirmed" />
        <Tick state="proposed" />
      </>,
    );
    expect(screen.getByRole("img", { name: "Confirmed" })).toHaveClass("rs-tick--confirmed");
    expect(document.querySelector(".rs-tick--proposed")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("Quote", () => {
  it("highlights the person's words and keeps the source in the caption", () => {
    render(<Quote text="  Led migration of 40 services  " caption="From sam-rivera-2024.pdf" />);
    const mark = screen.getByText("Led migration of 40 services");
    expect(mark.tagName).toBe("MARK");
    expect(mark.closest("blockquote")).not.toBeNull();
    expect(screen.getByText("From sam-rivera-2024.pdf").tagName).toBe("FIGCAPTION");
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
