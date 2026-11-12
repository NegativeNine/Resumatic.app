import { describe, expect, it } from "vitest";
import { senderAddress } from "../../src/shared/email-address.mjs";
import { emailConfigured, emailOrigin } from "../../src/shared/email-notices";
import { NOTICE_ERROR_CODES, cloudflareSender, sendErrorCode } from "../../src/vault/email-sender";
import { RecordingEmail, providerError } from "../support/email";
import { ACCEPTED_SENDERS, REFUSED_SENDERS } from "../support/sender-addresses.mjs";

// The sender over Cloudflare's send_email binding, with the recording binding the integration tests
// install as env.EMAIL. What it sends is exactly a sender, one recipient, a subject and plain text;
// what it says of a failure is one code from a fixed list, and never the provider's message.

const FROM = "notices@notices.example.test";
const TO = "owner@example.test";
const MESSAGE = { subject: "New comment in Resumatic", text: "A coach has left a new comment on a copy you shared.\n" };
const SECRET = "secret-provider-detail";

describe("sending one email notice", () => {
  it("sends exactly from, to, subject and text", async () => {
    const binding = new RecordingEmail();
    expect(await cloudflareSender(binding, FROM).send(TO, MESSAGE)).toEqual({ ok: true });
    expect(binding.sent).toEqual([{ from: { email: FROM, name: "Resumatic" }, to: TO, subject: MESSAGE.subject, text: MESSAGE.text }]);
    expect(Object.keys(binding.sent[0]!).sort()).toEqual(["from", "subject", "text", "to"]);
  });

  it("each code maps to retry or not, and an unknown code is E_OTHER and final", async () => {
    const expected: [string, string, boolean][] = [
      ["E_RATE_LIMIT_EXCEEDED", "E_RATE_LIMIT_EXCEEDED", true],
      ["E_INTERNAL_SERVER_ERROR", "E_INTERNAL_SERVER_ERROR", true],
      ["E_DELIVERY_FAILED", "E_DELIVERY_FAILED", true],
      ["E_SENDER_NOT_VERIFIED", "E_SENDER_NOT_VERIFIED", false],
      ["E_SENDER_DOMAIN_NOT_AVAILABLE", "E_SENDER_DOMAIN_NOT_AVAILABLE", false],
      ["E_RECIPIENT_SUPPRESSED", "E_RECIPIENT_SUPPRESSED", false],
      ["E_DAILY_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED", false],
      ["E_SOMETHING_NEW", "E_OTHER", false],
    ];
    for (const [thrown, code, retry] of expected) {
      const binding = new RecordingEmail();
      binding.failWith(providerError(thrown));
      expect(await cloudflareSender(binding, FROM).send(TO, MESSAGE), thrown).toEqual({ ok: false, code, retry });
      expect(binding.sent).toEqual([]);
      expect(binding.calls).toHaveLength(1);
    }
    // Every code an outcome can carry is on the one list.
    for (const [, code] of expected) expect(NOTICE_ERROR_CODES).toContain(code);
  });

  it("a code-less error is temporary", async () => {
    for (const thrown of [providerError(undefined), new TypeError("network"), "a string", null, { code: 42 }, { code: "e_lower" }, { code: `E_${"A".repeat(41)}` }]) {
      const binding = new RecordingEmail();
      binding.failWith(thrown);
      expect(await cloudflareSender(binding, FROM).send(TO, MESSAGE), String(thrown)).toEqual({ ok: false, code: "E_NO_CODE", retry: true });
    }
  });

  it("an error whose code getter throws is E_NO_CODE", async () => {
    const hostile = Object.defineProperty(new Error(SECRET), "code", {
      get() {
        throw new Error(SECRET);
      },
    });
    expect(sendErrorCode(hostile)).toBe("E_NO_CODE");
    const binding = new RecordingEmail();
    binding.failWith(hostile);
    expect(await cloudflareSender(binding, FROM).send(TO, MESSAGE)).toEqual({ ok: false, code: "E_NO_CODE", retry: true });
  });

  it("the error's message is never in the outcome", async () => {
    let read = false;
    const watched = new Proxy(providerError("E_DELIVERY_FAILED", `${SECRET} for ${TO}`), {
      get(target, key, receiver) {
        if (key === "message" || key === "stack" || key === "toString") read = true;
        return Reflect.get(target, key, receiver);
      },
    });
    const binding = new RecordingEmail();
    binding.failWith(watched);
    const outcome = await cloudflareSender(binding, FROM).send(TO, MESSAGE);
    expect(outcome).toEqual({ ok: false, code: "E_DELIVERY_FAILED", retry: true });
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    expect(JSON.stringify(outcome)).not.toContain(TO);
    expect(read).toBe(false);
  });

  it("no binding or no sender sends nothing", async () => {
    const binding = new RecordingEmail();
    expect(await cloudflareSender(undefined, FROM).send(TO, MESSAGE)).toEqual({ ok: false, code: "E_NOT_CONFIGURED", retry: false });
    expect(await cloudflareSender(binding, null).send(TO, MESSAGE)).toEqual({ ok: false, code: "E_NOT_CONFIGURED", retry: false });
    expect(await cloudflareSender({} as SendEmail, FROM).send(TO, MESSAGE)).toEqual({ ok: false, code: "E_NOT_CONFIGURED", retry: false });
    expect(binding.calls).toEqual([]);
  });

  it("senderAddress refuses an empty, spaced, named, local-only or overlong address", () => {
    for (const address of ACCEPTED_SENDERS) expect(senderAddress(address), address).toBe(address);
    for (const [address, why] of REFUSED_SENDERS) expect(senderAddress(address), why).toBeNull();
  });
});

describe("whether a deployment sends notices", () => {
  const configured = { EMAIL_ENABLED: "true", EMAIL_FROM: FROM, APP_ORIGIN: "https://app.example.test", EMAIL: new RecordingEmail() };

  it("needs the switch, the binding, a sender and an https origin, all four", () => {
    expect(emailConfigured(configured)).toBe(true);
    for (const EMAIL_ENABLED of ["false", "", "TRUE", "1", undefined]) expect(emailConfigured({ ...configured, EMAIL_ENABLED }), String(EMAIL_ENABLED)).toBe(false);
    for (const EMAIL of [undefined, {}, { send: "yes" }]) expect(emailConfigured({ ...configured, EMAIL })).toBe(false);
    for (const [EMAIL_FROM] of REFUSED_SENDERS) expect(emailConfigured({ ...configured, EMAIL_FROM: EMAIL_FROM as string })).toBe(false);
    for (const APP_ORIGIN of [undefined, "", "http://app.example.test", "https://app.example.test/path", "https://user:pass@app.example.test", "https://app.example.test/?q=1", "not a url"])
      expect(emailConfigured({ ...configured, APP_ORIGIN }), String(APP_ORIGIN)).toBe(false);
    expect(emailOrigin({ APP_ORIGIN: "https://app.example.test/" })).toBe("https://app.example.test");
  });
});
