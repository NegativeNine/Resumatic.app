/** A sender address as a deployment may name it: a local part and a domain of two or more labels, nothing else. */
export const EMAIL_ADDRESS: RegExp;
/** The sender address as configured, or null when it isn't one. */
export function senderAddress(value: unknown): string | null;
