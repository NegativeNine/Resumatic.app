import { senderAddress } from "./email-address.mjs";

// Email notices: three kinds an owner turns on one by one under Account. A notice says only that
// there is something new to see, with one link to the app. It holds no comment, suggested wording,
// fact, job, name, ID or token, so its words are fixed here and nothing else is ever put in one.
//
// A deployment offers notices only when all four settings below hold. With any one missing the
// Account section isn't shown, both routes answer 503, nothing is queued and nothing is sent.

/** The kinds of notice, in the order the Vault's alarm considers them. */
export const NOTICE_KINDS = ["comment", "suggestion", "reminder"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** Which kinds are on, and how the last notices went: `paused` when the sign-in address has changed. */
export interface NoticeSettings {
  comment: boolean;
  suggestion: boolean;
  reminder: boolean;
  status: "ok" | "failing" | "paused";
}

/** The settings as the owner's page reads them, with the address of the session asking. */
export type EmailNotices = NoticeSettings & { address: string | null };

/** The sentence both routes and both Vault methods answer with when the deployment offers no notices. */
export const EMAIL_OFF = "email notices aren't available";

/** The settings that decide whether a deployment sends notices. The binding is typed by shape, so the web app can share this file. */
export interface EmailSettings {
  EMAIL_ENABLED?: string;
  EMAIL_FROM?: string;
  APP_ORIGIN?: string;
  EMAIL?: unknown;
}

/** The configured sender address, or null when it isn't a well-formed one. */
export function emailFrom(env: EmailSettings): string | null {
  return senderAddress(env.EMAIL_FROM);
}

/**
 * The app's origin for the one link a notice holds, or null. The same rule as a connected app's
 * origin: https, and no path, query, fragment or credentials.
 */
export function emailOrigin(env: EmailSettings): string | null {
  if (typeof env.APP_ORIGIN !== "string" || !env.APP_ORIGIN) return null;
  try {
    const url = new URL(env.APP_ORIGIN);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** True only when the switch is exactly "true", the EMAIL binding is there, and the sender and origin are well formed. */
export function emailConfigured(env: EmailSettings): boolean {
  const binding = env.EMAIL as { send?: unknown } | undefined;
  return env.EMAIL_ENABLED === "true" && typeof binding?.send === "function" && emailFrom(env) !== null && emailOrigin(env) !== null;
}

const FOOTER = "You get this email because you turned on email notices in Resumatic. To stop them, turn them off under Account.\n";

/** A notice's subject and plain text. Nothing but its kind and the app's origin goes into it. */
export function noticeMessage(kind: NoticeKind, origin: string): { subject: string; text: string } {
  switch (kind) {
    case "comment":
      return {
        subject: "New comment in Resumatic",
        text: `A coach has left a new comment on a copy you shared.\n\nSign in to read it: ${origin}/\n\n${FOOTER}`,
      };
    case "suggestion":
      return {
        subject: "New suggested wording in Resumatic",
        text: `A coach has suggested new wording for a line in a copy you shared.\n\nSign in to see it: ${origin}/\n\n${FOOTER}`,
      };
    case "reminder":
      return {
        subject: "Facts are waiting for your review in Resumatic",
        text: `Some facts Resumatic read for you have been waiting for your review for 3 days or more.\n\nSign in to review them: ${origin}/\n\n${FOOTER}`,
      };
  }
}
