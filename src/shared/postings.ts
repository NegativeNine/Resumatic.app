/** A posting read from its page: the text to check and save, and what the page calls the job. */
export interface ReadPosting {
  text: string;
  title: string | null;
  company: string | null;
  /** The posting was longer than a saved posting can be, so the text ends early. */
  truncated: boolean;
  /** The host the text finally came from, after any redirects. */
  host: string;
}

/**
 * What reading a link came to. Not finding a posting is an answer, not an error:
 * - unreachable: the site didn't answer with the page (it refused, timed out or sent elsewhere);
 * - not_a_page: the address isn't an HTML page;
 * - no_posting: the page is there, but declares no job posting that can be read.
 */
export type PostingRead =
  | { posting: ReadPosting }
  | { posting: null; reason: "unreachable" | "not_a_page" | "no_posting" };
