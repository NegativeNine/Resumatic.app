import type { Gold } from "./score";
export interface PrivateCase {
  id: string;
  split: "dev" | "holdout";
  markdown: string;
  referenceDate: string;
  gold: Gold;
  meta: {
    origin: "synthetic" | "real";
    format: "pdf" | "docx";
    language: string;
    layout: string;
    pdfTagged?: boolean;
    pageCount?: number;
    documentKind?: "resume" | "academic-cv";
    dateTraps: ("odd-date" | "numbers-in-dates")[];
  };
}
export interface PrivateDataset {
  root: string;
  manifestHash: string;
  cases: PrivateCase[];
  manifest: { version: number; profile: "round-1" | "full"; cases: unknown[] };
}
export function sha256(bytes: string | Uint8Array): string;
export function privateRoot(path: string): string;
export function readPrivate(
  root: string,
  path: string,
  maxBytes: number,
): Buffer;
export function loadPrivateDataset(path: string): PrivateDataset;
export function createPrivateSnapshot(
  root: string,
  snapshot: { runId: string; [key: string]: unknown },
): { runId: string; sha256: string };
export function readPrivateJson(
  root: string,
  path: string,
  max?: number,
): { bytes: Buffer; value: unknown; sha256: string };
