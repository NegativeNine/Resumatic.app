import type { Quota } from "../shared/api";
import { api } from "./api";
import { formatMonth, formatMonthAfter } from "./format";
import { useAction } from "./hooks";
import { href, navigate } from "./router";
import { useSession } from "./session";

export function quotaMessage({ limit, month }: Quota): string {
  const reset = formatMonthAfter(month);
  return `You've used all ${limit} tailored resumes for ${formatMonth(month)}.${reset ? ` You can tailor more from ${reset}.` : ""}`;
}

/** Starts a Tailor run for an application, then opens the new resume. */
export function useTailor() {
  const { me, refreshMe } = useSession();
  const { run, pending, error } = useAction();

  const tailor = (applicationId: string) =>
    run(
      async () => {
        const { resumeId } = await api.tailor(applicationId);
        void refreshMe();
        navigate(href.resume(resumeId));
      },
      {
        quota: quotaMessage(me.quota),
        conflict:
          "Another resume is still being tailored, and Resumatic works on one at a time. Wait for it to finish, then try again.",
      },
    );

  return { tailor, pending, error };
}
