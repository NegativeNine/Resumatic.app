/** Older failures used one message for both unreadable files and service errors. */
export function sourceErrorMessage(error: string | null): string {
  if (!error || error === "We could not read this file." || error === "We couldn't read this file.")
    return "We couldn't finish reading this file. Please try again later.";
  return error;
}
