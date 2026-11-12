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

const BACK_TO_SEEKING = { label: "Back to looking for work", to: href.home };

export const PLACEHOLDERS = {
  // stage 3: today

  // stage 4: facts
  attest: {
    title: "Ask a colleague to confirm a fact",
    lede: "Someone who worked with you can confirm one fact. Their answer comes to you, and you decide who else sees it.",
    note: "Asking a colleague opens later, once the terms for keeping their answer are settled.",
  },

  // stage 5: jobs
  jobsFind: {
    title: "Find jobs",
    lede: "Search listings, and see how your record fits each one before you save it.",
    note: "Finding jobs needs a licensed listings provider. Until then, add a job by pasting its job description.",
    back: { label: "Go to your jobs", to: href.jobs },
  },
  jobsApplications: {
    title: "Applications",
    lede: "Applications Resumatic prepared under your rules. Nothing is sent until you say so.",
    note: "Prepared applications wait for your rules, and for a way to send each one that you approve first. Until then, each job’s kit is on its page under Your jobs, for you to send yourself.",
    back: { label: "Rules and answers", to: href.rules },
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
    lede: "A coaching practice shares one client list, so a colleague can pick up where you left off.",
    note: "Coaching organisations and seats open later. A client will still choose who may read their copy.",
    back: { label: "Back to your clients", to: href.clients },
  },
  hiringOpenings: {
    title: "Openings",
    lede: "An opening is what you list, search and request against. Every one names its pay.",
    note: "The hiring workspace isn’t open yet. Openings wait for organisation verification, legal sign-off and the result of a paid pilot.",
    back: BACK_TO_SEEKING,
  },
  hiringCandidates: {
    title: "Candidates",
    lede: "People whose confirmed facts fit an opening. You see an anonymous profile. They decide whether you see more.",
    note: "The hiring workspace isn’t open yet. Searching for candidates waits for legal sign-off and the result of a paid pilot.",
    back: BACK_TO_SEEKING,
  },
  hiringIntroductions: {
    title: "Introductions",
    lede: "Requests you’ve sent, and the people who said yes. A credit is charged only for a yes.",
    note: "The hiring workspace isn’t open yet. Introductions open first, arranged by hand in a small paid pilot, once it has legal sign-off.",
    back: BACK_TO_SEEKING,
  },
  hiringOrganisation: {
    title: "Organisation",
    lede: "Who your organisation is to a candidate, who can act for it, and what it has paid for.",
    note: "The hiring workspace isn’t open yet. Organisations wait for verification checks and legal sign-off.",
    back: BACK_TO_SEEKING,
  },
} satisfies Record<string, PlaceholderCopy>;

export type PlaceholderName = keyof typeof PLACEHOLDERS;

/** Sections of a real page that aren't built yet, shown where they will be. */
export const PLACEHOLDER_SECTIONS = {
  // stage 3: today

  // stage 4: facts
  factsCheckKinds: {
    title: "More to check",
    note: "Checking the skills Resumatic reads from your facts, joining the same fact found twice, and splitting a line that says two things open next. So does answering experience questions here. For now they’re asked on a job’s page.",
  },
  factsSplit: {
    title: "Split it in two",
    note: "Splitting a line into what you did and its result, each a fact in the same words, opens next.",
  },
  factsSkillYears: {
    title: "Years per skill",
    note: "How long you used each skill opens next. It will count only years you’ve confirmed or a dated line shows, and never guess.",
  },

  // stage 5: jobs
  rules: {
    title: "Rules",
    note: "Rules for what Resumatic may prepare for you, such as roles, places, a pay floor and a weekly limit, open next. Your saved answers below work now.",
  },
  sending: {
    title: "Sending for you",
    note: "Resumatic doesn’t send applications. Sending waits for a way to send each one that you approve first. Until then, download your kit and send it yourself.",
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
