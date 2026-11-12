import { href } from "./router";

// The words of every page and section that isn't built yet. Each says what it will do and what it
// waits for, and offers at most one plain way back to a page that works. A placeholder page is
// named as its route is. A room's stage takes its own entries out when it builds them, and adds
// only inside its own block.

export interface PlaceholderCopy {
  title: string;
  /** The board's one sentence about the page. */
  lede: string;
  /** What it will do and what it waits for. */
  note: string;
  back?: { label: string; to: string };
}

export interface PlaceholderSectionCopy {
  title: string;
  note: string;
}

const HIRING_CLOSED = "The hiring workspace isn’t open yet. It opens later, for verified employers.";
const BACK_TO_SEEKING = { label: "Back to looking for work", to: href.home };

export const PLACEHOLDERS = {
  // stage 3: today
  today: {
    title: "Today",
    lede: "What is waiting for you, with the next step first.",
    note: "Today will gather what each room is waiting on. Until it opens, each room shows its own.",
    back: { label: "Check your facts", to: href.facts },
  },

  // stage 4: facts
  factsSkills: {
    title: "Skills",
    lede: "The skills and tools your confirmed facts show, each named from one shared list.",
    note: "Skills are shown once the tags on your facts have been checked and you’ve confirmed them. Years per skill wait for dates your record shows.",
    back: { label: "See all your facts", to: href.factsAll },
  },
  attest: {
    title: "Ask a colleague to confirm a fact",
    lede: "Someone who worked with you can confirm one fact. Their answer comes to you, and you decide who else sees it.",
    note: "Asking a colleague opens later, once the terms for keeping their answer are settled.",
  },

  // stage 5: jobs
  jobsFind: {
    title: "Find jobs",
    lede: "Search listings, and see how your record fits each one before you save it.",
    note: "Finding jobs needs a source of listings first. Until then, add a job by pasting its posting.",
    back: { label: "Go to your jobs", to: href.jobs },
  },
  jobsApplications: {
    title: "Applications",
    lede: "Applications Resumatic prepared under your rules. Nothing is sent until you say so.",
    note: "Prepared applications wait for rules about what Resumatic may prepare. Each job’s application kit is on that job, under Your jobs.",
  },

  // stage 6: sharing and account
  introRequest: {
    title: "Introduction request",
    lede: "A recruiter’s request to meet you, and what they’ve seen so far.",
    note: "Introduction requests open later, once recruiters can find an anonymous profile. No recruiter can find you today.",
    back: { label: "Back to Recruiters", to: href.recruiters },
  },

  // stage 7: outside
  coachingOrganisation: {
    title: "Organisation",
    lede: "Coaches who work together, and the seats they share.",
    note: "Coaching organisations and seats open later.",
  },
  hiringOpenings: {
    title: "Openings",
    lede: "An opening is what you list, search and request against. Every one names its pay.",
    note: HIRING_CLOSED,
    back: BACK_TO_SEEKING,
  },
  hiringCandidates: {
    title: "Candidates",
    lede: "People whose confirmed facts fit an opening. You see an anonymous profile. They decide whether you see more.",
    note: HIRING_CLOSED,
    back: BACK_TO_SEEKING,
  },
  hiringIntroductions: {
    title: "Introductions",
    lede: "Requests you’ve sent, and the people who said yes. A credit is charged only for a yes.",
    note: "The hiring workspace isn’t open yet. Introductions open first, arranged by hand for a small pilot.",
    back: BACK_TO_SEEKING,
  },
  hiringOrganisation: {
    title: "Organisation",
    lede: "Who your organisation is to a candidate, who can act for it, and what it has paid for.",
    note: HIRING_CLOSED,
    back: BACK_TO_SEEKING,
  },
} satisfies Record<string, PlaceholderCopy>;

export type PlaceholderName = keyof typeof PLACEHOLDERS;

/** Sections of a real page that aren't built yet, shown where they will be. */
export const PLACEHOLDER_SECTIONS = {
  // stage 3: today

  // stage 4: facts

  // stage 5: jobs
  rules: {
    title: "Rules",
    note: "Rules for what Resumatic may prepare for you, such as roles, places, a pay floor and a weekly limit, open next. Your saved answers below work now.",
  },

  // stage 6: sharing and account
  recruitersVisibility: {
    title: "Can recruiters find you?",
    note: "Choosing whether recruiters can find you, the companies to hide from and how many requests reach you each week opens later, once consent and notices have legal sign-off. No recruiter can find you today.",
  },
  recruitersRequests: {
    title: "Requests to meet you",
    note: "Introduction requests open later, once recruiters can find an anonymous profile. Until then, none can reach you.",
  },
  liveAccess: {
    title: "Live access",
    note: "Letting a coach follow your record as it changes opens next. Every copy you share today is fixed.",
  },
  moreNotices: {
    title: "More email notices",
    note: "Email when a resume or document is ready, or the day before a link or an app’s access ends, opens later. The three notices above work now.",
  },
  accountRegion: {
    title: "Where your record is kept",
    note: "Choosing to keep your record in the European Union opens later. Until then, it is created in a Cloudflare region near where you first sign in.",
  },

  // stage 7: outside
} satisfies Record<string, PlaceholderSectionCopy>;

export type PlaceholderSectionName = keyof typeof PLACEHOLDER_SECTIONS;
