import type { ReactNode } from "react";
import type { Me } from "../shared/api";
import { PlaceholderPage } from "./components/Placeholder";
import { EmptyState, PageHeader } from "./components/ui";
import { AccountPage } from "./pages/AccountPage";
import { CoachClients } from "./pages/outside/CoachClients";
import { CoachCopy } from "./pages/outside/CoachCopy";
import { JobsPage } from "./pages/JobsPage";
import { JobPage } from "./pages/jobs/JobPage";
import { RulesPage } from "./pages/jobs/RulesPage";
import { LEGAL_TITLES, LegalPage } from "./pages/LegalPage";
import { FactsRecord } from "./pages/facts/FactsRecord";
import { FactsReview } from "./pages/facts/FactsReview";
import { FactsSkills } from "./pages/facts/FactsSkills";
import { FactsSources } from "./pages/facts/FactsSources";
import { SharingApps } from "./pages/sharing/SharingApps";
import { SharingCoaches } from "./pages/sharing/SharingCoaches";
import { SharingOverview } from "./pages/sharing/SharingOverview";
import { SharingRecruiters } from "./pages/sharing/SharingRecruiters";
import { TodayPage } from "./pages/today/TodayPage";
import { PLACEHOLDERS, type PlaceholderName } from "./placeholders";
import { href, NOT_FOUND_ROUTE, routeNeeds, type Route, type RouteName } from "./router";

// What each address shows: one line per route in ROUTES. A screen is today's page, a page made
// from today's sections (pages/interim), or a placeholder. Each room's stage changes only the
// lines in its own block, so the type below makes sure every route keeps a screen.

export interface Screen {
  /** The page's name, for the window's title. */
  title: string;
  render: (route: Route) => ReactNode;
}

const placeholder = (name: PlaceholderName): Screen => ({ title: PLACEHOLDERS[name].title, render: () => <PlaceholderPage name={name} /> });

export const SCREENS: { [K in RouteName]: Screen } = {
  // stage 2: the shell
  privacy: { title: LEGAL_TITLES.privacy, render: () => <LegalPage doc="privacy" /> },
  terms: { title: LEGAL_TITLES.terms, render: () => <LegalPage doc="terms" /> },
  notFound: { title: "Page not found", render: () => <NotFoundPage /> },

  // stage 3: today
  today: { title: "Today", render: () => <TodayPage /> },

  // stage 4: facts
  factsCheck: { title: "To check", render: () => <FactsReview /> },
  factsAll: { title: "All facts", render: () => <FactsRecord /> },
  attest: placeholder("attest"),
  factsSkills: { title: "Skills", render: () => <FactsSkills /> },
  factsFiles: { title: "Your files", render: () => <FactsSources /> },

  // stage 5: jobs
  jobs: { title: "Jobs", render: () => <JobsPage /> },
  jobsFind: placeholder("jobsFind"),
  jobsApplications: placeholder("jobsApplications"),
  jobsRules: { title: "Rules and answers", render: () => <RulesPage /> },
  job: { title: "Jobs", render: (route) => <JobPage id={route.params.id!} tab={route.params.jobTab!} /> },
  resume: { title: "Jobs", render: (route) => <JobPage id={route.params.id} tab="resume" resumeId={route.params.resumeId!} /> },

  // stage 6: sharing and account
  sharing: { title: "Sharing", render: () => <SharingOverview /> },
  sharingCoaches: { title: "Coaches", render: () => <SharingCoaches /> },
  sharingRecruiters: { title: "Recruiters", render: () => <SharingRecruiters /> },
  introRequest: placeholder("introRequest"),
  sharingApps: { title: "Connected apps", render: () => <SharingApps /> },
  account: { title: "Account", render: (route) => <AccountPage section={route.params.section} /> },

  // stage 7: outside
  coachingClients: { title: "Clients", render: () => <CoachClients /> },
  coachingClient: { title: "A client’s copy", render: (r) => <CoachCopy key={r.params.id} grantId={r.params.id!} /> },
  coachingOrganisation: placeholder("coachingOrganisation"),
  hiringOpenings: placeholder("hiringOpenings"),
  hiringCandidates: placeholder("hiringCandidates"),
  hiringIntroductions: placeholder("hiringIntroductions"),
  hiringOrganisation: placeholder("hiringOrganisation"),
};

/** The route to show: not found in place of a page whose capability this deployment has off. */
export function shownRoute(route: Route, me: Me): Route {
  const needs = routeNeeds(route);
  return needs && !me.capabilities?.[needs] ? NOT_FOUND_ROUTE : route;
}

function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found">There’s nothing at this address.</PageHeader>
      <EmptyState title="Looking for something?">
        Your <a href={href.facts}>facts</a> and <a href={href.jobs}>jobs</a> are where you left them.
      </EmptyState>
    </>
  );
}
