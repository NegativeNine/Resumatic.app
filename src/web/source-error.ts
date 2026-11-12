import { asSentence } from "../shared/sentence";
import { typeset } from "./format";

const NOT_FINISHED = "Resumatic couldn’t finish reading this file. Try again in a few minutes.";

/** Reasons stored before the copy took the interface's voice, in the words they have now. */
const EARLIER: Readonly<Record<string, string>> = {
  // Older failures used one message for both unreadable files and service errors.
  "We could not read this file.": NOT_FINISHED,
  "We couldn't read this file.": NOT_FINISHED,
  "We couldn't finish reading this file. Please try again later.": NOT_FINISHED,
  "Reading is temporarily unavailable. Please try again later.": "Reading isn’t available right now. Try again in a few minutes.",
  "Could not start this request. Please try again.": "Reading couldn’t be started. Try again.",
  // Stored by runs before stage 4 of the redesign, which named the person's file a source.
  "The import source changed. Upload it again.": "The file changed while it was being read. Upload it again.",
};

/** Why a source failed, as sentences in the interface's voice. */
export function sourceErrorMessage(error: string | null): string {
  if (!error) return NOT_FINISHED;
  return EARLIER[error] ?? typeset(asSentence(error));
}

/** Why tailoring failed, as sentences in the interface's voice. */
export function resumeErrorMessage(error: string | null | undefined): string {
  if (!error) return "Tailoring stopped unexpectedly. Try again.";
  if (error === "Could not start this request. Please try again.") return "Tailoring couldn’t be started. Try again.";
  return typeset(asSentence(error));
}
