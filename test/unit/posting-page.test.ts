import { describe, expect, it } from "vitest";
import { MAX_JD_CHARS } from "../../src/shared/api";
import { composePosting, extractJobPosting, htmlToText } from "../../src/worker/posting-page";

const page = (...blocks: string[]) =>
  `<!doctype html><html><head><title>Careers</title>${blocks.join("\n")}</head><body><h1>Platform Engineer</h1></body></html>`;
const ld = (value: unknown, attributes = 'type="application/ld+json"') => `<script ${attributes}>${JSON.stringify(value)}</script>`;

const POSTING = {
  "@context": "https://schema.org",
  "@type": "JobPosting",
  title: "Platform Engineer",
  hiringOrganization: { "@type": "Organization", name: "Litware" },
  jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "Toronto", addressRegion: "ON", addressCountry: "CA" } },
  description: "<p>Run our Kubernetes fleet &amp; build the tools product teams ship with.</p><ul><li>Own the release pipeline</li><li>Cut latency</li></ul>",
};

describe("finding a posting in a page", () => {
  it("reads the title, company, place and body a page declares", () => {
    expect(extractJobPosting(page(ld(POSTING)))).toEqual({
      title: "Platform Engineer",
      company: "Litware",
      location: "Toronto, ON, CA",
      description: "Run our Kubernetes fleet & build the tools product teams ship with.\n\n- Own the release pipeline\n- Cut latency",
    });
  });

  it("finds a posting beside other data, in a graph, a list or under another entity", () => {
    const other = { "@type": "Organization", name: "Litware", description: "Not a job" };
    for (const value of [
      [other, POSTING],
      { "@context": "https://schema.org", "@graph": [other, { "@type": "WebPage", name: "Careers" }, POSTING] },
      { "@type": "WebPage", mainEntity: POSTING },
      { "@type": "ItemList", itemListElement: [{ "@type": "ListItem", item: POSTING }] },
      { ...POSTING, "@type": ["Thing", "JobPosting"] },
      { ...POSTING, "@type": "https://schema.org/JobPosting" },
    ])
      expect(extractJobPosting(page(ld(other), ld(value)))?.title, JSON.stringify(value).slice(0, 60)).toBe("Platform Engineer");
  });

  it("takes the script's own type, however it is written, and no other script", () => {
    for (const attributes of ['type="application/ld+json"', "type='application/ld+json'", "type=application/ld+json", 'id="x" TYPE="Application/LD+JSON; charset=utf-8" data-n="1"'])
      expect(extractJobPosting(page(ld(POSTING, attributes)))?.company, attributes).toBe("Litware");
    for (const attributes of ['type="application/json"', 'type="text/javascript"', "", 'data-type="application/ld+json"', 'data-type="application/ld+json" type="text/plain"'])
      expect(extractJobPosting(page(ld(POSTING, attributes))), attributes).toBeNull();
  });

  it("passes over a block it can't read and uses the next", () => {
    const broken = '<script type="application/ld+json">{"@type":"JobPosting","title":</script>';
    expect(extractJobPosting(page(broken, ld(POSTING)))?.title).toBe("Platform Engineer");
    // Sites wrap the JSON in comments or CDATA, and leave raw line breaks inside strings.
    const raw = JSON.stringify({ ...POSTING, description: "Line one\nLine two has enough words to be a posting" }).replace("\\n", "\n");
    for (const body of [`<!--${JSON.stringify(POSTING)}-->`, `//<![CDATA[\n${JSON.stringify(POSTING)}\n//]]>`, raw])
      expect(extractJobPosting(page(`<script type="application/ld+json">${body}</script>`))?.company, body.slice(0, 30)).toBe("Litware");
  });

  it("says nothing when the page declares no posting, or one with no body", () => {
    expect(extractJobPosting(page())).toBeNull();
    expect(extractJobPosting(page(ld({ "@type": "Article", headline: "We're hiring", description: "Come work here" })))).toBeNull();
    expect(extractJobPosting(page(ld({ "@type": "JobPosting", title: "Platform Engineer" })))).toBeNull();
    expect(extractJobPosting(page(ld({ "@type": "JobPosting", title: "Platform Engineer", description: "  <p> </p> " })))).toBeNull();
    expect(extractJobPosting(page(ld("JobPosting"), ld(null), ld(7), ld([])))).toBeNull();
    // A posting buried deeper than a page would put one isn't looked for.
    let deep: unknown = POSTING;
    for (let i = 0; i < 12; i++) deep = { "@type": "Thing", mainEntity: deep };
    expect(extractJobPosting(page(ld(deep)))).toBeNull();
  });

  it("reads names and places in the forms sites use, as one line each", () => {
    const found = (extra: Record<string, unknown>) => extractJobPosting(page(ld({ ...POSTING, ...extra })))!;
    expect(found({ hiringOrganization: "Litware Inc." }).company).toBe("Litware Inc.");
    expect(found({ hiringOrganization: { name: "  Litware\n <b>Payments</b> " } }).company).toBe("Litware Payments");
    expect(found({ hiringOrganization: 7 }).company).toBeNull();
    expect(found({ title: undefined, name: "Staff Engineer" }).title).toBe("Staff Engineer");
    expect(found({ title: "x".repeat(400) }).title).toHaveLength(160);
    expect(found({ jobLocation: [{ address: { addressLocality: "Berlin", addressCountry: { "@type": "Country", name: "Germany" } } }, { address: "Elsewhere" }] }).location).toBe("Berlin, Germany");
    expect(found({ jobLocation: { address: "1 Main St, Toronto" } }).location).toBe("1 Main St, Toronto");
    expect(found({ jobLocation: undefined, jobLocationType: "TELECOMMUTE" }).location).toBe("Remote");
    expect(found({ jobLocationType: ["TELECOMMUTE"] }).location).toBe("Toronto, ON, CA. Remote");
    expect(found({ jobLocation: undefined }).location).toBeNull();
  });

  it("adds the parts a site keeps apart, once", () => {
    const found = extractJobPosting(page(ld({
      ...POSTING,
      responsibilities: "<li>Own the release pipeline</li>",
      qualifications: "Five years running Kubernetes in production",
      skills: ["not text"],
    })))!;
    expect(found.description).toContain("Qualifications\nFive years running Kubernetes in production");
    // The body already lists it, so it isn't said twice.
    expect(found.description).not.toContain("Responsibilities");
    expect(found.description).not.toContain("Skills");
  });
});

describe("a posting's markup as text", () => {
  it("turns paragraphs, breaks and lists into lines", () => {
    expect(htmlToText("<h2>About</h2><p>First<br>second</p><ul><li>One</li><li><p>Two</p></li><li>\n Three </li></ul><p>End</p>")).toBe(
      "About\n\nFirst\nsecond\n\n- One\n- Two\n- Three\n\nEnd",
    );
  });

  it("decodes what was encoded once, or twice as many sites send it", () => {
    expect(htmlToText("Caf&eacute; &amp; bar &#8212; 5&nbsp;days &#x2014; &lt;3 years&gt; &unknown; &#0; &#xD800;")).toBe("Café & bar — 5 days — <3 years> &unknown;");
    expect(htmlToText("&lt;p&gt;Run &amp;amp; build&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Ship&lt;/li&gt;&lt;/ul&gt;")).toBe("Run & build\n\n- Ship");
  });

  it("leaves a less-than sign that isn't markup as the text it is", () => {
    expect(htmlToText("Latency < 200 ms and uptime > 99.9%, with C++ & Rust")).toBe("Latency < 200 ms and uptime > 99.9%, with C++ & Rust");
    expect(htmlToText("p95 <200ms; a<b; 3 < 5 > 2")).toBe("p95 <200ms; a<b; 3 < 5 > 2");
  });

  it("drops scripts, styles and comments with what they hold, and anything after one left open", () => {
    expect(htmlToText("Before<script>alert('x')</script> <style>p{color:red}</style><!-- note -->after")).toBe("Before after");
    expect(htmlToText("Kept <script>never closed, so nothing after it is text")).toBe("Kept");
    expect(htmlToText("Kept <!-- never closed")).toBe("Kept");
    expect(htmlToText("Kept <STYLE media=print>x</STYLE >too")).toBe("Kept too");
  });

  it("keeps only what a person reads", () => {
    expect(htmlToText("A\u200bB\u0000C\u00a0\u00a0D\t\tE\r\nF\u0085 \n\n\n\n G  ")).toBe("ABC D E\nF\n\nG");
    expect(htmlToText("")).toBe("");
    expect(htmlToText("<div><div><p></p></div></div>")).toBe("");
  });

  it.each([
    "202A", "202B", "202C", "202D", "202E", "2066", "2067", "2068", "2069", "200E", "200F", "061C",
  ])("removes the mark of direction U+%s, so a posting is read in the order it is shown", (hex) => {
    const mark = String.fromCodePoint(Number.parseInt(hex, 16));
    // A word with a mark inside it is shown as the word, and read as the word.
    expect(htmlToText(`<p>Run our Kuber${mark}netes fleet</p>`)).toBe("Run our Kubernetes fleet");
    expect(htmlToText(`Run our ${mark}Kubernetes${mark} fleet`)).toBe("Run our Kubernetes fleet");
    // Written as an entity, it is removed once decoded.
    expect(htmlToText(`Run our Kuber&#x${hex};netes fleet`)).toBe("Run our Kubernetes fleet");
  });

  it("shows a posting in the order it is read, once a mark has reordered it for display", () => {
    // "‮" shows what follows right to left: "‮setenrebuk‬" is shown as "kubernetes"
    // but read as "setenrebuk". Without the mark it is shown as it is read.
    expect(htmlToText("Run our ‮setenrebuk‬ fleet")).toBe("Run our setenrebuk fleet");
  });

  it("keeps a soft hyphen in a posting, as before", () => {
    // Pasted text loses every character Unicode marks as not shown; a posting keeps its narrower set.
    const softHyphen = String.fromCharCode(0xad);
    expect(htmlToText(`<p>Kuber${softHyphen}netes</p>`)).toBe(`Kuber${softHyphen}netes`);
    expect(htmlToText("Kuber&#xAD;netes")).toBe(htmlToText(`Kuber${softHyphen}netes`));
  });

  it("keeps right-to-left writing and every other letter as it was", () => {
    expect(htmlToText("<p>Hebrew: שלום; Arabic: مرحبا; café — naïve</p>"))
      .toBe("Hebrew: שלום; Arabic: مرحبا; café — naïve");
  });

  it("reads a page built to be slow to read in a moment", () => {
    const started = Date.now();
    for (const hostile of ["<script>".repeat(100_000), "<!--".repeat(100_000), "<style>".repeat(50_000), "<".repeat(300_000), "&".repeat(300_000), "<li>".repeat(80_000), "\n-".repeat(150_000), `<script type="application/ld+json">`.repeat(30_000)]) {
      htmlToText(hostile);
      expect(extractJobPosting(hostile)).toBeNull();
    }
    expect(extractJobPosting(`<script type="application/ld+json">${"[".repeat(200_000)}</script>`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("the posting as the text a person would have pasted", () => {
  const found = { title: "Platform Engineer", company: "Litware", location: "Toronto, ON", description: "Run the fleet.\n\n- Own the pipeline" };

  it("heads the body with what the job is and where", () => {
    expect(composePosting(found)).toEqual({ text: "Platform Engineer at Litware\nLocation: Toronto, ON\n\nRun the fleet.\n\n- Own the pipeline", truncated: false });
    expect(composePosting({ ...found, company: null, location: null }).text).toBe("Platform Engineer\n\nRun the fleet.\n\n- Own the pipeline");
    expect(composePosting({ ...found, title: null }).text.split("\n")[0]).toBe("Litware");
    expect(composePosting({ title: null, company: null, location: null, description: "Body only" }).text).toBe("Body only");
  });

  it("cuts a posting longer than one can be, on a whole line where one ends nearby", () => {
    const lines = { ...found, description: Array.from({ length: 2_000 }, (_, i) => `Requirement ${i} is written out in a full line.`).join("\n") };
    const cut = composePosting(lines);
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(MAX_JD_CHARS);
    expect(cut.text.endsWith("is written out in a full line.")).toBe(true);
    const unbroken = composePosting({ ...found, description: "x".repeat(MAX_JD_CHARS * 2) });
    expect(unbroken).toMatchObject({ truncated: true });
    expect(unbroken.text).toHaveLength(MAX_JD_CHARS);
    expect(composePosting({ title: null, company: null, location: null, description: "y".repeat(100) }, 60).text).toHaveLength(60);
  });
});
