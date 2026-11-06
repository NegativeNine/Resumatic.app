import { AppError } from "../shared/errors";

type Renderer = (env: Env, html: string) => Promise<Uint8Array>;

let override: Renderer | null = null;

/** Replaces the renderer for tests, which cannot reach Browser Run. Pass null to restore. */
export function setPdfRenderer(renderer: Renderer | null): void {
  override = renderer;
}

/** Renders HTML to a Letter-size PDF with Browser Run. */
export async function renderPdf(env: Env, html: string): Promise<Uint8Array> {
  if (override) return override(env, html);
  const response = await env.BROWSER.quickAction("pdf", {
    html,
    pdfOptions: {
      format: "letter",
      printBackground: true,
      preferCSSPageSize: true,
    },
    rejectRequestPattern: [".*"],
  });
  if (
    !response.ok ||
    !response.headers.get("content-type")?.includes("application/pdf")
  ) {
    throw new AppError(
      "unavailable",
      "the PDF renderer is unavailable; try again",
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}
