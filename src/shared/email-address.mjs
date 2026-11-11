// The address email notices are sent from, as a deployment names it in EMAIL_FROM. One pattern,
// shared by the configuration check (scripts/validate-config.mjs, in Node) and the Worker, so the
// two can't come to disagree about which sender is well formed.
//
// It is stricter than what mail allows: a local part without spaces, angle brackets, quotes,
// commas, colons, semicolons or a backslash, and a domain of at least two labels. A display name
// ("Resumatic <notices@example.com>") is refused: the sender's name is set where the message is
// built, never taken from configuration.

export const EMAIL_ADDRESS = /^[^\s@<>()",;:\\]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;

/**
 * The sender address as configured, or null when it isn't one: not a string, longer than 254
 * characters, changed by trimming, or outside EMAIL_ADDRESS.
 */
export function senderAddress(value) {
  if (typeof value !== "string" || value.length > 254 || value !== value.trim()) return null;
  return EMAIL_ADDRESS.test(value) ? value : null;
}
