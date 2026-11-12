// Sends one email notice through Cloudflare's send_email binding, and reduces whatever went wrong
// to a code from a fixed list. A provider's error message never leaves this file: not into a log,
// a metric, the vault or a reply. Only `.code` is read, and only when it looks like one of the
// provider's codes.

/** The provider's codes a notice can meet, as the binding names them. Any other code is `E_OTHER`. */
const PROVIDER_CODES = [
  "E_RATE_LIMIT_EXCEEDED",
  "E_INTERNAL_SERVER_ERROR",
  "E_DELIVERY_FAILED",
  "E_SENDER_NOT_VERIFIED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_RECIPIENT_SUPPRESSED",
  "E_DAILY_LIMIT_EXCEEDED",
] as const;

/**
 * Every code a notice's outcome, metric or log line can carry: the provider's, and the Vault's own
 * for what happens around a send.
 */
export const NOTICE_ERROR_CODES = [
  ...PROVIDER_CODES,
  // The provider's error had no code, or one that isn't a code.
  "E_NO_CODE",
  // The provider's error had a code this list doesn't know.
  "E_OTHER",
  // No binding or no sender address, so nothing was sent.
  "E_NOT_CONFIGURED",
  // The Directory couldn't be asked for the owner's address.
  "E_ADDRESS_UNAVAILABLE",
  // The Directory holds no active address for this vault's owner.
  "E_NO_ADDRESS",
  // The Directory's address isn't the one the notice was turned on with.
  "E_ADDRESS_CHANGED",
  // The last of the attempts never came back, so the notice is settled as failed.
  "E_UNANSWERED",
] as const;
export type NoticeErrorCode = (typeof NOTICE_ERROR_CODES)[number];

/**
 * Codes worth another attempt: the provider was busy or failed for a while, gave no code, or the
 * Directory couldn't be reached. Every other code is final, including a daily limit, which no
 * retry within the hour can get past, and a code nobody has listed.
 */
const TEMPORARY: ReadonlySet<NoticeErrorCode> = new Set<NoticeErrorCode>([
  "E_RATE_LIMIT_EXCEEDED",
  "E_INTERNAL_SERVER_ERROR",
  "E_DELIVERY_FAILED",
  "E_NO_CODE",
  "E_ADDRESS_UNAVAILABLE",
]);

/** True when a notice that failed with this code may be tried again. */
export function isTemporary(code: NoticeErrorCode): boolean {
  return TEMPORARY.has(code);
}

export type SendOutcome = { ok: true } | { ok: false; code: NoticeErrorCode; retry: boolean };

export interface EmailSender {
  send(to: string, message: { subject: string; text: string }): Promise<SendOutcome>;
}

/**
 * The code of a provider's error. Only `.code` is read, inside a try, so a getter that throws
 * gives `E_NO_CODE`; a value that isn't shaped like a code is no code. The message is never read.
 */
export function sendErrorCode(error: unknown): NoticeErrorCode {
  let code: unknown;
  try {
    code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  } catch {
    return "E_NO_CODE";
  }
  if (typeof code !== "string" || !/^E_[A-Z_]{1,40}$/.test(code)) return "E_NO_CODE";
  return (PROVIDER_CODES as readonly string[]).includes(code) ? (code as NoticeErrorCode) : "E_OTHER";
}

/**
 * A sender over the deployment's EMAIL binding. The message is the sender, one recipient, a subject
 * and plain text, and nothing else: no HTML, copies, reply address, headers or attachments.
 */
export function cloudflareSender(binding: SendEmail | undefined, from: string | null): EmailSender {
  return {
    async send(to, message) {
      if (!binding || typeof binding.send !== "function" || !from) return { ok: false, code: "E_NOT_CONFIGURED", retry: false };
      try {
        await binding.send({ from: { email: from, name: "Resumatic" }, to, subject: message.subject, text: message.text });
        return { ok: true };
      } catch (error) {
        const code = sendErrorCode(error);
        return { ok: false, code, retry: isTemporary(code) };
      }
    },
  };
}
