import type { Vault } from "../../vault";
import { Tick } from "../ui";

// Before anything is uploaded, To check opens on one big dropzone and says what happens next.

/** Nothing has been added yet: no file, no role and no fact. */
export const isFirstRun = (vault: Vault) => vault.sources.length === 0 && vault.roles.length === 0 && vault.facts.length === 0;

const STEPS = [
  {
    title: "Resumatic reads it",
    text: "It finds your roles and the facts in each one, and keeps the exact words every fact came from.",
  },
  {
    title: "You confirm what’s true",
    text: "Check each fact against its words. Say that’s right, fix it, or leave it out. Nothing is used until you confirm it.",
  },
  {
    title: "You tailor it to a job",
    text: "Paste a job description, and get a resume built only from your confirmed facts, with every line checked.",
  },
];

export function WhatHappensNext() {
  return (
    <section className="facts-next" aria-labelledby="next-heading">
      <h2 id="next-heading" className="rs-h2">
        What happens next
      </h2>
      <ol className="facts-next__steps">
        {STEPS.map((step) => (
          <li key={step.title}>
            <Tick state="todo" />
            <h3 className="rs-h3">{step.title}</h3>
            <p className="rs-p">{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
