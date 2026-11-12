import { useEffect, useRef } from "react";
import { Lockup } from "../../components/Lockup";
import { SiteFooter } from "../../components/Shell";
import { Quote } from "../../components/ui";
import { SIGN_IN_HASH } from "./signed-out";
import "../../styles/rooms/outside.css";

// The page a signed-out visitor sees at the site's root. Every claim on it is true of the app as it
// is built; what isn't built yet is named only under Coming later. It loads nothing but the app's
// own files, and asks for nothing: there is no form and no field, and signing in is by invitation.
// Its copy waits on the owner's review before production (docs/redesign-plan.md, stage 7).

const STEPS: readonly { title: string; text: string }[] = [
  {
    title: "Add the resume you have",
    text: "A resume or CV as a PDF or Word file, a LinkedIn export, or pasted text. Resumatic reads it and lists what you’ve done, each with the words it came from.",
  },
  {
    title: "Check what Resumatic found",
    text: "For each fact, say that’s right, fix it, or leave it out. Nothing is used until you say it’s right.",
  },
  {
    title: "Tailor it to a job",
    text: "Paste a job description. Resumatic writes a resume from the facts you’ve confirmed, and checks every line against them before you see it.",
  },
];

const WONT: readonly { title: string; text: string }[] = [
  {
    title: "Add a number, a title or a skill you haven’t confirmed.",
    text: "What a job asks for and your record doesn’t show is listed for you, never filled in.",
  },
  {
    title: "Start a trial that turns into a subscription.",
    text: "The free plan doesn’t turn into anything. A paid plan starts only when you choose one.",
  },
  {
    title: "Sell your data.",
    text: "Your record is kept in its own database, separate from everyone else’s. You can download all of it or delete your account at any time.",
  },
  {
    title: "Share your record without your say-so.",
    text: "A coach reads only the fixed copy you choose, and only until it ends.",
  },
];

const BESIDE: readonly [string, string][] = [
  ["A template builder", "No phrase bank. Every line starts from something you did."],
  ["A keyword scanner", "A score tells you what’s missing. Resumatic shows what you can honestly say, and lists the rest."],
  ["An auto-apply tool", "Fewer, stronger applications you can stand behind in the interview."],
];

/** What isn't built yet. Nothing here is said anywhere else on the page. */
const COMING_LATER: readonly string[] = [
  "Finding jobs: search listings and see how your record fits each one.",
  "Applications Resumatic prepares under rules you set, sent only when you say so.",
  "Being found by recruiters through an anonymous profile, and choosing who sees more.",
  "Live access for a coach, following your record as it changes.",
  "Coaching organisations that share one client list.",
];

export function Landing() {
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    document.title = "A tailored resume you can stand behind – Resumatic";
  }, []);

  return (
    <>
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          // The address is the page here: following "#main" would leave the landing page.
          event.preventDefault();
          main.current?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="rs-header">
        <div className="rs-header__inner">
          <span className="rs-brand">
            <Lockup />
          </span>
          <div className="rs-header__end">
            <a className="rs-btn" href={SIGN_IN_HASH}>
              Sign in
            </a>
          </div>
        </div>
      </header>
      <main className="app-landing" id="main" ref={main} tabIndex={-1}>
        <section className="app-landing__open" aria-labelledby="landing-title">
          <div className="app-landing__lead">
            <h1 id="landing-title" className="app-landing__display">
              A tailored resume you can stand behind.
            </h1>
            <p className="rs-lede">
              Resumatic writes a resume for each job using only what you’ve really done, and shows where every line came from.
            </p>
            <p className="app-landing__cta">
              <a className="rs-btn rs-btn--primary rs-btn--lg" href={SIGN_IN_HASH}>
                Sign in
              </a>
            </p>
            <p className="rs-meta">Resumatic is in a private beta, by invitation. You need an invitation for the address you sign in with.</p>
          </div>
          <figure className="rs-panel app-landing__example">
            <figcaption className="rs-meta">An example: a line on a resume, and where it came from</figcaption>
            <div className="rs-sheet-frame">
              <div className="rs-sheet app-landing__sheet">
                <p className="rs-line is-open">Reduced p95 API latency from 900 ms to 210 ms by moving hot paths to Redis.</p>
              </div>
            </div>
            <div className="app-landing__source">
              <p className="rs-note__label">Something you did</p>
              <Quote size="sm" text="Cut p95 API latency from 900ms to 210ms by moving hot paths to Redis" caption="From your 2024 resume" />
            </div>
          </figure>
        </section>

        <section className="app-landing__section" aria-labelledby="landing-steps">
          <h2 id="landing-steps" className="rs-h1">
            Three steps
          </h2>
          <ol className="plain-list app-landing__steps">
            {STEPS.map((step, index) => (
              <li className="rs-panel" key={step.title}>
                <h3 className="rs-h2">
                  <span className="app-landing__n" aria-hidden="true">
                    {index + 1}.
                  </span>{" "}
                  {step.title}
                </h3>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="app-landing__section app-landing__pair" aria-labelledby="landing-fit">
          <h2 id="landing-fit" className="rs-h1">
            See how you fit before you tailor
          </h2>
          <div>
            <p className="rs-lede">
              Paste a job description and check your fit. Resumatic shows what the job asks for that your record already covers, and what it doesn’t.
            </p>
            <p>There is no score to chase. If you’ve done something the job asks for, add it in your own words. If you haven’t, it stays off your resume.</p>
          </div>
        </section>

        <section className="app-landing__section app-landing__pair" aria-labelledby="landing-wont">
          <div>
            <h2 id="landing-wont" className="rs-h1">
              What Resumatic won’t do
            </h2>
            <p className="rs-lede">Said as plainly as what it will.</p>
          </div>
          <ul className="plain-list rs-panel app-landing__wont">
            {WONT.map((item) => (
              <li key={item.title}>
                <p className="app-landing__wont-title">{item.title}</p>
                <p className="rs-meta">{item.text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="app-landing__section" aria-labelledby="landing-beside">
          <h2 id="landing-beside" className="rs-h1">
            Beside what you might use now
          </h2>
          <div className="rs-panel app-landing__table">
            <table>
              <thead>
                <tr>
                  <th scope="col">If you use</th>
                  <th scope="col">With Resumatic</th>
                </tr>
              </thead>
              <tbody>
                {BESIDE.map(([tool, instead]) => (
                  <tr key={tool}>
                    <th scope="row">{tool}</th>
                    <td>{instead}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="app-landing__section app-landing__pair" aria-labelledby="landing-coaches">
          <div>
            <p className="rs-meta app-landing__kicker">For career coaches and resume writers</p>
            <h2 id="landing-coaches" className="rs-h1">
              See what backs every line of a client’s resume
            </h2>
          </div>
          <div>
            <p className="rs-lede">
              A client shares a copy with you. You read it, comment on a line or a fact, and suggest wording. A suggestion is checked against the client’s confirmed facts before it changes anything.
            </p>
            <p>During the beta, coaches sign in with an invitation too.</p>
          </div>
        </section>

        <section className="app-landing__section" aria-labelledby="landing-later">
          <h2 id="landing-later" className="rs-h1">
            Coming later
          </h2>
          <p className="rs-lede">These aren’t available yet.</p>
          <ul className="app-landing__later">
            {COMING_LATER.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <section className="rs-panel app-landing__section app-landing__close" aria-labelledby="landing-close">
          <h2 id="landing-close" className="rs-h1">
            Start with the resume you have.
          </h2>
          <p className="rs-meta">Private beta, by invitation.</p>
          <p>
            <a className="rs-btn" href={SIGN_IN_HASH}>
              Sign in
            </a>
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
