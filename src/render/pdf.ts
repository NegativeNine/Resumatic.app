import { AppError } from "../shared/errors";

type Renderer = (env: Env, html: string) => Promise<Uint8Array>;

let override: Renderer | null = null;

/** Replaces the renderer for tests, which cannot reach Browser Run. Pass null to restore. */
export function setPdfRenderer(renderer: Renderer | null): void {
  override = renderer;
}

/** Renders HTML to a Letter-size PDF with Browser Run. */
export async function renderPdf(env: Env, html: string): Promise<Uint8Array> {
  // Browser Run is billed separately from Workers AI. Its cost has no proven
  // per-request bound in the shared pilot ledger, so do not dispatch while
  // that mode is active (or when its configuration is malformed).
  if (env.PILOT_SHARED_BUDGET !== undefined && !["true", "false"].includes(env.PILOT_SHARED_BUDGET))
    throw new AppError("unavailable", "pilot budget configuration is invalid");
  if (env.PILOT_SHARED_BUDGET === "true")
    throw new AppError("unavailable", "PDF generation is unavailable during the budgeted pilot");
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
