/** Where beta feedback and privacy questions go. Make sure this mailbox exists before inviting anyone. */
export const SUPPORT_EMAIL = "support@resumatic.app";

export const feedbackHref = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Resumatic beta feedback")}`;
