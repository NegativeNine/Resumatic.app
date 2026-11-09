import type { ReactNode } from "react";
import { SUPPORT_EMAIL, feedbackHref } from "../config";
import { href } from "../router";

// The beta's privacy notice and terms. Both describe how this build actually handles data, and both
// are drafts: counsel reviews them before the beta opens beyond the first invited users.

export type LegalDoc = "privacy" | "terms";

export const LEGAL_TITLES: Record<LegalDoc, string> = {
  privacy: "Privacy notice",
  terms: "Beta terms",
};

const UPDATED = "November 2026";

export function LegalPage({ doc }: { doc: LegalDoc }) {
  return (
    <article className="legal" aria-labelledby="legal-title">
      <h1 id="legal-title">{LEGAL_TITLES[doc]}</h1>
      <p className="meta">Last updated {UPDATED}</p>
      <p className="notice draft-note">
        This is a draft for the private beta. It describes how Resumatic works today, and it may change after legal
        review. If it changes in a way that matters, we’ll tell you in the app first.
      </p>
      {doc === "privacy" ? <Privacy /> : <Terms />}
      <p className="meta">
        Questions? Write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.{" "}
        {doc === "privacy" ? <a href={href.terms}>Read the beta terms</a> : <a href={href.privacy}>Read the privacy notice</a>}.
      </p>
    </article>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Privacy() {
  return (
    <>
      <Section title="What we keep">
        <ul>
          <li>Your Google account’s email address and account ID, so you can sign in.</li>
          <li>The profile details you enter: name, email, phone, location and links.</li>
          <li>
            The files you upload, the text read from them, and the roles and facts found in that text, each with the
            words it came from.
          </li>
          <li>Facts and roles you add or edit, the job descriptions you paste, and the resumes made from them.</li>
          <li>How many resumes you have tailored this month, for the monthly limit.</li>
        </ul>
        <p>
          We use one cookie to keep you signed in for up to seven days, and a short-lived one during sign-in. There are
          no advertising or analytics cookies, and we do not sell or share your data for marketing.
        </p>
      </Section>
      <Section title="Where it is kept">
        <p>
          Your career data lives in a database of its own, separate from every other user’s, on Cloudflare. It is
          created in a Cloudflare region near where you first sign in. Your uploads and downloaded PDFs are stored
          with it in Cloudflare R2. A separate directory holds only your email address, your sign-in ID and the ID of
          your database. The beta does not yet guarantee that data stays in your country.
        </p>
      </Section>
      <Section title="How AI is used">
        <p>
          Cloudflare Workers AI turns your uploads into text and indexes your facts. Language models from providers
          such as Anthropic and OpenAI find facts in your uploads, read job descriptions, write resume lines and check
          each line against your facts. They are reached through Cloudflare AI Gateway with request logging turned off,
          and each one receives only the text its step needs: your upload’s text, a job description, or the facts
          chosen for one resume. Resume lines are checked against your confirmed facts, and a line those facts do not
          support is never shown to you.
        </p>
        <p>
          Our own logs record IDs, counts and error codes. They never record your files, facts, job descriptions or
          resume text.
        </p>
      </Section>
      <Section title="Your choices">
        <ul>
          <li>
            <strong>See and correct it:</strong> every fact, role and profile detail can be edited or rejected under{" "}
            <a href={href.facts}>Facts</a> and <a href={href.account}>Account</a>.
          </li>
          <li>
            <strong>Take it with you:</strong> the data export under Account downloads everything in your account, with
            links to your original uploads.
          </li>
          <li>
            <strong>Delete it:</strong> deleting your account under Account stops any work in progress and erases your
            database, uploads, PDFs and directory entry. A final sweep of stored files runs within an hour.
          </li>
        </ul>
        <p>We keep your data until you delete it, or until the beta ends and we tell you how to export it first.</p>
      </Section>
    </>
  );
}

function Terms() {
  return (
    <>
      <Section title="The beta">
        <p>
          Resumatic is in a private beta, open by invitation. Features will change, things may break, and we may pause
          or end the beta. If we end it, we’ll give you notice and time to export your data.
        </p>
      </Section>
      <Section title="Your content">
        <p>
          You own what you upload and write. You allow us to store and process it, including with the AI services
          described in the <a href={href.privacy}>privacy notice</a>, only to run Resumatic for you. Upload only
          resumes and information that are yours or that you have the right to use.
        </p>
      </Section>
      <Section title="Checking your resumes">
        <p>
          Resumatic builds each resume only from facts you have confirmed, and it checks every line against them. It
          can still make mistakes. Read every resume before you send it, and send only what is true.
        </p>
      </Section>
      <Section title="Fair use">
        <ul>
          <li>Don’t try to reach other people’s data, get around limits, or disrupt the service.</li>
          <li>Don’t upload malware or content you have no right to share.</li>
          <li>
            Each account has a monthly limit on tailored resumes and a limit on stored uploads. Your current use is
            shown at the top of the app.
          </li>
        </ul>
      </Section>
      <Section title="Ending">
        <p>
          You can delete your account at any time. We may suspend an account that breaks these terms, and we’ll tell
          you why unless the law prevents it.
        </p>
      </Section>
      <Section title="No warranty">
        <p>
          The beta is provided as it is, without warranties, to the extent the law allows. We are not responsible for
          decisions made using resumes it produces.
        </p>
      </Section>
      <Section title="Feedback">
        <p>
          We’d like to hear what works and what doesn’t: <a href={feedbackHref}>send feedback</a>.
        </p>
      </Section>
    </>
  );
}
