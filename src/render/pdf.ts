import puppeteer from "@cloudflare/puppeteer";

type Renderer = (env: Env, html: string) => Promise<Uint8Array>;

let override: Renderer | null = null;

/** Replaces the renderer for tests, which cannot reach Browser Run. Pass null to restore. */
export function setPdfRenderer(renderer: Renderer | null): void {
  override = renderer;
}

/** Renders HTML to a Letter-size PDF with Browser Run. */
export async function renderPdf(env: Env, html: string): Promise<Uint8Array> {
  if (override) return override(env, html);
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({ format: "letter", printBackground: true, preferCSSPageSize: true });
    return new Uint8Array(pdf);
  } finally {
    await browser.close();
  }
}
