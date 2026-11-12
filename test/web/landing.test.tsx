import { render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Landing } from "../../src/web/pages/outside/Landing";

// The page a signed-out visitor sees first. Every claim on it has to be true of the app as built;
// what isn't built is named only under Coming later. It collects nothing and loads nothing from
// another site. Its copy waits on the owner's review before production.

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

/** What a person reads on the page, as one string with spaces between its parts. */
function words(element: Element): string {
  return [...element.querySelectorAll("h1, h2, h3, p, li, th, td, figcaption, blockquote, a, button")]
    .map((part) => (part.textContent ?? "").replace(/\s+/g, " ").trim())
    .join(" \n ");
}

const COMING_LATER = [
  "Finding jobs: search listings and see how your record fits each one.",
  "Applications Resumatic prepares under rules you set, sent only when you say so.",
  "Being found by recruiters through an anonymous profile, and choosing who sees more.",
  "Live access for a coach, following your record as it changes.",
  "Coaching organisations that share one client list.",
];

describe("the landing page", () => {
  it("leads with the result, and reaches sign-in, privacy and terms", () => {
    render(<Landing />);
    const main = screen.getByRole("main");
    // The result first, then how, then the one primary button.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("A tailored resume you can stand behind.");
    expect(within(main).getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      screen.getByText("Resumatic writes a resume for each job using only what you’ve really done, and shows where every line came from."),
    ).toBeInTheDocument();
    const primary = document.querySelectorAll(".rs-btn--primary");
    expect(primary).toHaveLength(1);
    expect(primary[0]).toHaveTextContent("Sign in");
    expect(primary[0]).toHaveAttribute("href", "#/sign-in");
    // Every way in leads to the sign-in page, never straight to the provider.
    const signIn = screen.getAllByRole("link", { name: "Sign in" });
    expect(signIn.length).toBeGreaterThanOrEqual(3);
    for (const link of signIn) expect(link).toHaveAttribute("href", "#/sign-in");
    expect(screen.queryByRole("link", { name: /Google/ })).toBeNull();
    const footer = screen.getByRole("navigation", { name: "About Resumatic" });
    expect(within(footer).getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "#/privacy");
    expect(within(footer).getByRole("link", { name: "Terms" })).toHaveAttribute("href", "#/terms");
    expect(within(footer).getByRole("link", { name: "Send feedback" })).toHaveAttribute("href", expect.stringMatching(/^mailto:support@resumatic\.app/));
    // The labelled example: a line, and the words it came from.
    const caption = screen.getByText("An example: a line on a resume, and where it came from");
    expect(caption.tagName).toBe("FIGCAPTION");
    const example = caption.closest("figure")!;
    expect(within(example).getByText("Reduced p95 API latency from 900 ms to 210 ms by moving hot paths to Redis.")).toBeInTheDocument();
    expect(within(example).getByText("Something you did")).toBeInTheDocument();
    expect(within(example).getByText("Cut p95 API latency from 900ms to 210ms by moving hot paths to Redis")).toBeInTheDocument();
    expect(within(example).getByText("From your 2024 resume")).toBeInTheDocument();
    // The sections, in order.
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Three steps",
      "See how you fit before you tailor",
      "What Resumatic won’t do",
      "Beside what you might use now",
      "See what backs every line of a client’s resume",
      "Coming later",
      "Start with the resume you have.",
    ]);
    const steps = screen.getByRole("region", { name: "Three steps" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(3);
    expect(within(steps).getByRole("list").tagName).toBe("OL");
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["If you use", "With Resumatic"]);
    expect(within(table).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["A template builder", "A keyword scanner", "An auto-apply tool"]);
  });

  it("names what isn't built only under Coming later", () => {
    render(<Landing />);
    const later = screen.getByRole("region", { name: "Coming later" });
    expect(within(later).getByText("These aren’t available yet.")).toBeInTheDocument();
    expect(within(later).getAllByRole("listitem").map((item) => item.textContent)).toEqual(COMING_LATER);
    // Nowhere else on the page, in the present tense or any other.
    later.remove();
    const rest = `${words(document.body)} ${document.title}`;
    expect(rest).not.toMatch(/find(ing)? jobs|search listings|recruiter|live access|prepares? applications|anonymous profile|organisation/i);
    // Nor plans, prices, trials or quotes from people, none of which exist yet.
    expect(rest).not.toMatch(/\[|price|30-day|per month|a month|testimonial|“[^”]*” —/i);
  });

  it("says the beta is by invitation and has no form, field or address to collect", () => {
    render(<Landing />);
    expect(screen.getByText("Resumatic is in a private beta, by invitation. You need an invitation for the address you sign in with.")).toBeInTheDocument();
    expect(screen.getByText("Private beta, by invitation.")).toBeInTheDocument();
    expect(screen.getByText("During the beta, coaches sign in with an invitation too.")).toBeInTheDocument();
    expect(document.querySelectorAll("form, input, textarea, select, button, [contenteditable]")).toHaveLength(0);
    expect(screen.queryByRole("textbox")).toBeNull();
    // The only address on the page is the feedback link the app's footer always has.
    expect([...document.querySelectorAll("a[href^='mailto:']")].map((link) => link.textContent)).toEqual(["Send feedback"]);
    expect(document.cookie).toBe("");
  });

  it("speaks in the interface's voice: no we, our, please, exclamation or straight quote", () => {
    render(<Landing />);
    const text = words(document.body);
    expect(text).not.toMatch(/\b(we|our|us|please)\b/i);
    expect(text).not.toMatch(/[!'"]/);
    expect(text).not.toMatch(/\b(AI|magic|smart|powered by|ATS)\b/);
    for (const label of [...document.querySelectorAll("[aria-label]")].map((element) => element.getAttribute("aria-label")!))
      expect(label).not.toMatch(/[!'"]|\b(we|our|please)\b/i);
  });

  it("loads nothing from another site", () => {
    render(<Landing />);
    expect(document.querySelectorAll("img, iframe, script, link, object, embed, video, audio, source")).toHaveLength(0);
    for (const element of document.querySelectorAll("[src], [href], [srcset], [action]"))
      for (const attribute of ["src", "href", "srcset", "action"])
        expect(element.getAttribute(attribute) ?? "", element.outerHTML.slice(0, 80)).not.toMatch(/^(https?:)?\/\//);
    // The document itself names nothing on another site, and says what the page is.
    const index = read("index.html");
    expect(index).toContain(
      '<meta name="description" content="Resumatic writes a resume for each job using only what you’ve really done, and shows where every line came from. Private beta, by invitation." />',
    );
    expect(index).toContain("<title>A tailored resume you can stand behind – Resumatic</title>");
    expect(index).not.toMatch(/https?:\/\//);
    // And the security policy that keeps it that way is the one stage 2 shipped (72aff93), to the byte.
    expect(read("public/_headers").split("\n").find((line) => line.trim().startsWith("Content-Security-Policy:"))).toBe(
      "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'",
    );
  });

  it("sets the window's title", async () => {
    render(<Landing />);
    await waitFor(() => expect(document.title).toBe("A tailored resume you can stand behind – Resumatic"));
  });
});
