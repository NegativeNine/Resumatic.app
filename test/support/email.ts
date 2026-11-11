// A stand-in for Cloudflare's send_email binding. It is installed as `env.EMAIL` itself, so a test
// runs the Vault's real sender over it: the binding check, the message it builds and the way a
// provider's error is reduced to a code. Nothing is delivered anywhere.

/** A message as the binding was given it. */
export type Sent = EmailMessageBuilder & { subject: string; text?: string };

export class RecordingEmail implements SendEmail {
  /** Every message the binding was asked to send, in order, whether or not it was taken. */
  readonly calls: Sent[] = [];
  /** The messages that were taken. */
  readonly sent: Sent[] = [];
  /** Errors to throw, one a call, before any message is taken again. */
  readonly failures: unknown[] = [];

  async send(message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> {
    if (!("subject" in message)) throw new Error("the stand-in takes only composed messages");
    const copy = structuredClone(message) as Sent;
    this.calls.push(copy);
    if (this.failures.length) throw this.failures.shift();
    this.sent.push(copy);
    return { messageId: `<${crypto.randomUUID()}@recording.test>` };
  }

  /** Makes the next sends fail with these errors, as the provider would throw them. */
  failWith(...errors: unknown[]): void {
    this.failures.push(...errors);
  }
}

/** A provider's error with a code, and a message that must never be seen again. */
export function providerError(code: string | undefined, message = "provider says: secret-provider-detail for owner@example.test"): Error {
  const error = new Error(message);
  if (code !== undefined) (error as Error & { code: string }).code = code;
  return error;
}

/** The settings a deployment needs before it sends notices. */
export type EmailEnv = Pick<Env, "EMAIL_ENABLED" | "EMAIL_FROM" | "APP_ORIGIN" | "EMAIL">;

export const SENDER = "notices@notices.example.test";
export const ORIGIN = "https://app.example.test";

const restores: (() => void)[] = [];

/**
 * Switches notices on for this deployment with a recording binding, a sender and an https origin.
 * An override replaces one setting, and one given as undefined takes it away. Undo it with
 * `restoreEmail()` after each test.
 */
export function installEmail(env: Env, overrides: Partial<Record<keyof EmailEnv, unknown>> = {}): RecordingEmail {
  const recorder = new RecordingEmail();
  const settings: Record<string, unknown> = { EMAIL_ENABLED: "true", EMAIL_FROM: SENDER, APP_ORIGIN: ORIGIN, EMAIL: recorder, ...overrides };
  const target = env as unknown as Record<string, unknown>;
  const before = Object.fromEntries(Object.keys(settings).map((key) => [key, [Object.hasOwn(target, key), target[key]] as const]));
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
  restores.push(() => {
    for (const [key, [had, value]] of Object.entries(before)) {
      if (had) target[key] = value;
      else delete target[key];
    }
  });
  return recorder;
}

/** Puts back every setting installEmail changed, latest first. */
export function restoreEmail(): void {
  for (const undo of restores.splice(0).reverse()) undo();
}
