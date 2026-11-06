import type { VerifiedExtraction } from "../../src/pipeline/extract/types";
import type { CaseScore, Gold } from "./score";
export function scoreVerified(pred: VerifiedExtraction, gold: Gold): CaseScore;
