// Sender addresses for EMAIL_FROM, shared by the configuration check's test (scripts/config.test.mjs)
// and the Worker's (test/unit/email-sender.test.ts), so both hold the one pattern to the same cases.

/** Addresses a deployment may send from. */
export const ACCEPTED_SENDERS = [
  "notices@notices.example.com",
  "resumatic.notices+beta@mail.example.co.uk",
  `${"a".repeat(64)}@example.com`,
];

/** Addresses refused, each with why. */
export const REFUSED_SENDERS = [
  ["", "empty"],
  [" notices@example.com", "a space before"],
  ["notices@example.com ", "a space after"],
  ["no tices@example.com", "a space inside"],
  ["Resumatic <notices@example.com>", "a display name"],
  ['"Resumatic" notices@example.com', "a quoted name"],
  ["notices", "a local part alone"],
  ["notices@", "no domain"],
  ["notices@localhost", "a one-label domain"],
  ["@example.com", "no local part"],
  ["notices@exa_mple.com", "an underscore in the domain"],
  ["a@b@example.com", "two at signs"],
  [`${"a".repeat(65)}@example.com`, "a local part over 64"],
  [`notices@${"a".repeat(64)}.com`, "a label over 63"],
  [`notices@${Array.from({ length: 4 }, () => "a".repeat(62)).join(".")}.com`, "over 254 in all"],
  [undefined, "absent"],
  [42, "not a string"],
];
