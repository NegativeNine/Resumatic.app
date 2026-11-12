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

/**
 * The notices ESCO and O*NET ask a product that shows their data to carry, word for word as the
 * latest build's manifest has them (docs/taxonomy-build-2026-11-11.json, `notices`).
 * test/web/legal.test.tsx holds them to it.
 */
export const TAXONOMY_NOTICES = [
  "This service uses the ESCO classification of the European Commission.",
  "This service includes information from the O*NET 31.0 Database by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA). Used under the CC BY 4.0 license. O*NET® is a trademark of USDOL/ETA. Resumatic has modified all or some of this information. USDOL/ETA has not approved, endorsed, or tested these modifications.",
] as const;

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
            The job preferences you enter: a place, job types, when you’re available and a pay floor. They stay in
            your database. They are not shown to anyone, not put in a resume or a shared copy, not sent to a
            connected app or an AI model, and nothing uses them yet.
          </li>
          <li>
            The files you upload or text you paste, the text read from them, and the roles and facts found in that
            text, each with the words it came from.
          </li>
          <li>
            Facts and roles you add or edit, and your answers to interview questions, which are saved as facts.
          </li>
          <li>
            The jobs you save: the posting’s text and link, the status you set, the date you applied and your notes.
            Where reading a posting from its link is turned on and you ask for it, our servers fetch that page. The
            job site sees a request from Resumatic, not from you, and nothing about you is sent with it.
          </li>
          <li>The resumes, cover letters, interview preparation and fit previews made from your facts for those jobs.</li>
          <li>
            The links you make to share a copy: what each copy holds, the label you give it and when it was last
            opened. If you name a coach on a link, their sign-in address is kept with it.
          </li>
          <li>
            If someone names you as their coach and you add their copy to your client list: whose copy it is, when
            you added it and when it ends.
          </li>
          <li>
            Comments a coach writes on a copy you shared and wording they suggest, and your replies, with the line or
            fact each is about and the coach’s name and sign-in address.
          </li>
          <li>
            If you turn on email notices: which ones are on, when each was last sent, and a one-way code made from the
            address you sign in with, so a notice goes only to that address.
          </li>
          <li>The apps you connect, what you allowed each one to do and when its access ends.</li>
          <li>How many resumes and documents you have made in the current period, for your plan’s limit.</li>
          <li>
            If you choose a paid plan: the plan, its billing period and the IDs Stripe gives your account,
            subscription, invoices and checkout. Stripe takes the payment. We never see your card number.
          </li>
        </ul>
        <p>
          We use one cookie to keep you signed in for up to seven days, and a short-lived one during sign-in. Someone
          who opens a copy you shared gets cookies that keep that copy open in their browser for up to an hour. There
          are no advertising or analytics cookies, and we do not sell or share your data for marketing.
        </p>
      </Section>
      <Section title="Where it is kept">
        <p>
          Your career data lives in a database of its own, separate from every other user’s, on Cloudflare. It is
          created in a Cloudflare region near where you first sign in. Your uploads, the text you paste and
          downloaded PDFs are stored with it in Cloudflare R2. A separate directory holds only your email address, your sign-in ID, the ID of
          your database and, if you have a paid plan, the Stripe IDs and billing period that tie payments to your
          account. If you connect an app, the credentials it uses are kept in a separate Cloudflare store until they
          expire or you revoke them. The beta does not yet guarantee that data stays in your country.
        </p>
      </Section>
      <Section title="How AI is used">
        <p>
          Cloudflare Workers AI turns your uploads into text and indexes your facts. Language models from providers
          such as Anthropic and OpenAI find facts in your uploads and the text you paste, read job descriptions, write
          resume lines, cover letters and interview preparation, and check each line against your facts. They are
          reached through Cloudflare AI Gateway with request logging turned off, and each one receives only the text
          its step needs: your upload’s text or the text you pasted, a job description, or the facts chosen for one
          resume or document. Lines are checked against your confirmed facts, and a line those facts do not support is
          never shown to you. Comments on a shared copy are never sent to a language model or used to write or check a
          resume.
        </p>
        <p>
          Wording a coach suggests is sent to a model only if you accept it, to be checked against your facts like any
          edit you make.
        </p>
        <p>
          Our own logs record IDs, counts and error codes. They never record your files, facts, job descriptions or
          resume text.
        </p>
      </Section>
      <Section title="Sharing a copy">
        <p>
          You can share facts, resume versions, cover letters and interview preparation you choose with someone,
          such as a coach, by making a link. Anyone who has the link can read that copy, without an account, until
          it expires or you revoke it. A link lasts seven days at most.
        </p>
        <ul>
          <li>The copy is fixed when you make it. Later changes to your facts and resumes don’t reach it.</li>
          <li>
            It includes the contact details printed on any resume you choose. It shows your name at the top, or the
            job a resume or document was made for, only if you choose that.
          </li>
          <li>
            Revoking a link removes the copy from our systems at once. It cannot take back what someone has already
            read or saved.
          </li>
          <li>
            We keep when a copy was last opened, to the minute, and show you that time. We keep nothing else about
            the person who opens it, and the copy tells them what you can see.
          </li>
          <li>
            You can name a coach by the address they sign in to Resumatic with. That one account can add the copy to
            its client list and open it from there without the link, for as long as the link lasts. You see the name
            on their account and when they added it. Naming a coach doesn’t close the link to anyone else who has it.
          </li>
          <li>
            The coach you name can comment on a line or a fact in the copy once they have added it to their client
            list. Nobody else with the link can read or write comments. You answer and delete them under Account,
            where they stay after the copy ends until you delete them. We send email only if you turn on email notices
            under Account. A notice says only that there’s something new to see, with a link to Resumatic: it holds no
            career details, comment, suggested wording or coach’s name, and it’s sent through Cloudflare’s email service
            to the address you sign in with. A count of new comments shows the next time you open Resumatic.
          </li>
          <li>
            A coach you name can suggest new wording for a line. Nothing changes unless you accept it, and then it is
            checked against your confirmed facts first. Your coach is told whether you used it, and nothing else.
          </li>
        </ul>
        <p>
          <strong>If you are reading a copy someone shared with you:</strong> we don’t ask who you are. We keep the
          time the copy was last opened, which its owner can see, and nothing else about you. Cookies keep the copy
          open in your browser for up to an hour. To limit abuse, opening a link is rate-limited with a short-lived
          code made from your network address, which is not kept with the copy.
        </p>
        <p>
          <strong>If you are signed in to Resumatic when you read it:</strong> we check whether your sign-in address
          is the one the copy names as its coach, and keep nothing from that check. If it is and you add the copy to
          your client list, we keep your account ID and the name on your account with the owner’s link, and the owner
          sees that name and when you added it. Your list keeps the owner’s name as the copy gives it. An entry leaves
          your list when you remove it, or thirty days after the copy’s last day. If you comment, your words are kept
          in the owner’s account, not yours, with your name, sign-in address and account ID. You can delete a comment
          while the copy is open to you. After that the owner keeps it until they delete it or their account, even if
          you delete yours. If you suggest wording, it is kept in the owner’s account like a comment and shown to them
          with the name on your account. If they accept it, it is sent to a model to be checked. You are told whether
          they used it. You can delete a suggestion while the copy is open to you; if the owner had already accepted
          it, the check they started, and any resume line it became, keep the wording.
        </p>
      </Section>
      <Section title="Connecting an app">
        <p>
          Where connected apps are turned on, you can let an AI tool work with your account. You approve each
          connection yourself and choose what the app may do:
        </p>
        <ul>
          <li>read your confirmed facts and finished resumes;</li>
          <li>see your saved jobs and add new ones;</li>
          <li>create documents, which count toward your plan’s limit, and check your fit for the saved jobs it can see, which doesn’t.</li>
        </ul>
        <p>
          A fit check gives the app each requirement read from a job’s posting and the confirmed facts matched to it.
          Connected apps together can start at most 20 fit checks a day.
          A connected app never receives your uploaded files, the words a fact came from, or your notes on a job. It
          never receives a fact you have marked sensitive, or a resume that uses one. It never receives a coach’s
          comments or suggested wording either. Its
          access lasts an hour, or up to thirty days if you allow it to continue, and you can revoke it at any time
          under <a href={href.account}>Account</a>. What an app has already read is then held by the company that
          runs it, under that company’s terms, and revoking access does not remove it from there.
        </p>
      </Section>
      <Section title="Your choices">
        <ul>
          <li>
            <strong>See and correct it:</strong> every fact, role, profile detail and job preference can be edited,
            rejected or cleared under <a href={href.facts}>Facts</a> and <a href={href.account}>Account</a>.
          </li>
          <li>
            <strong>Keep a fact to yourself:</strong> mark a fact sensitive under <a href={href.facts}>Facts</a> and it
            is left out of every new resume, letter, interview preparation and fit preview, never put in a shared copy
            and never shown to a connected app. A resume that already uses it can’t be downloaded, shared or read by an
            app until you remove those lines. It stays in your search index, so the model that indexes your facts can
            still receive its words when you edit it or the index is rebuilt. Marking cannot take back what a model, a
            reader or an app received before.
          </li>
          <li>
            <strong>Take it with you:</strong> the data export under Account downloads everything in your account, with
            links to your original uploads and the text you pasted.
          </li>
          <li>
            <strong>Delete it:</strong> deleting your account under Account stops any work in progress, cancels a paid
            plan, ends every shared copy and app connection, and erases your database, uploads, pasted text, PDFs and directory
            entry. A final sweep of stored files runs within an hour.
          </li>
        </ul>
        <p>We keep your data until you delete it, or until the beta ends and we tell you how to export it first.</p>
      </Section>
      <Credits />
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
      <Credits />
    </>
  );
}

/** The last section of both pages: the two classifications Resumatic describes work in, credited as their licences ask. */
function Credits() {
  return (
    <Section title="Credits">
      <p>Resumatic describes work in the terms of two public classifications.</p>
      {TAXONOMY_NOTICES.map((notice) => (
        <blockquote key={notice}>
          <p>{notice}</p>
        </blockquote>
      ))}
      <p>
        We reuse ESCO under{" "}
        <a href="https://esco.ec.europa.eu/en/use-esco/download">Commission Decision 2011/833/EU</a> and O*NET under the{" "}
        <a href="https://creativecommons.org/licenses/by/4.0/">Creative Commons Attribution 4.0 International licence</a>.
        We hold the two in one set and add labels and links of our own, each marked as ours; we reword nothing in
        either.
      </p>
    </Section>
  );
}
