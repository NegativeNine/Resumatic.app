import type { Quota } from "../shared/api";
import { api } from "./api";
import { formatDate, formatMonthAfter } from "./format";
import { useAction } from "./hooks";
import { href, navigate } from "./router";
import { useSession } from "./session";

export function quotaMessage({
  used,
  limit,
  reserved = 0,
  month,
  periodEnd,
}: Quota): string {
  const reset = periodEnd ? formatDate(periodEnd) : formatMonthAfter(month);
  if (reserved > 0 && used < limit)
    return `${used} documents used and ${reserved} reserved for work in progress. Wait for it to finish or cancel a run to release its reservation.`;
  return `You’ve used all ${limit} documents for this allowance period.${reset ? ` Your allowance renews on ${reset}.` : ""}`;
}

/** Starts a Tailor run for a job, then opens the new run on the job's page. */
export function useTailor() {
  const { me, refreshMe } = useSession();
  const { run, pending, error } = useAction();

  const tailor = (applicationId: string) =>
    run(
      async () => {
        const { resumeId } = await api.tailor(applicationId);
        void refreshMe();
        navigate(href.jobResume(applicationId, resumeId));
      },
      {
        quota: quotaMessage(me.quota),
        conflict:
          "Another document is still being prepared. Wait for it to finish, then try again.",
      },
    );

  return { tailor, pending, error };
}
