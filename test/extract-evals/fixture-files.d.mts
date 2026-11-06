export interface SyntheticSourceFixture {
  name: string;
  bytes: Uint8Array;
  meta: {
    id: string;
    split: string;
    format: string;
    language: string;
    layout: string;
    pages: number;
    origin: string;
    pdfTextTransform: string | null;
    goldOffsets: string;
    conversionStatus: string;
    promotionEligible: boolean;
    sha256: string;
  };
}
export function docxFixture(markdown: string): Uint8Array;
export function pdfSafe(text: string): string;
export function pdfFixture(pages: string[], columns?: number): Uint8Array;
export function scanPixels(text: string): { width: number; height: number; pixels: Uint8Array };
export function scannedPdfFixture(text: string): Uint8Array;
export function makeFixtures(): SyntheticSourceFixture[];
