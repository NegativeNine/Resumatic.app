export function pdfText(bytes: Uint8Array): Promise<string>;
export function docxText(bytes: Uint8Array): string;
export function checkAtsSmoke(
  pdf: Uint8Array,
  docx: Uint8Array,
  markers: Record<string, string>,
): Promise<{
  status: "passed" | "failed";
  promotionEligible: false;
  checks: { pdf: Record<string, boolean>; docx: Record<string, boolean> };
}>;
