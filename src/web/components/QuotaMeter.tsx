import type { Quota } from "../../shared/api";
import { formatDayMonth, formatDayMonthAfter } from "../format";
import { useSession } from "../session";

/** Above this many outputs a month, each tick stands for a tenth of the allowance. */
const MAX_TICKS = 40;

/** The words beside the tally, which carry its meaning; the ticks are decoration. */
export function quotaWords({ used, limit, reserved = 0, month, periodEnd }: Quota): { text: string; full: boolean } {
  const full = used + reserved >= limit;
  const resets = periodEnd ? formatDayMonth(periodEnd) : formatDayMonthAfter(month);
  const inProgress = reserved > 0 ? `, ${reserved} in progress` : "";
  if (full) return { full, text: `${used} of ${limit} used${inProgress}.${resets ? ` More from ${resets}` : ""}` };
  const period = periodEnd ? ` until ${formatDayMonth(periodEnd)}` : " this month";
  return { full, text: `${used} of ${limit} outputs used${period}${inProgress}` };
}

type TickState = "used" | "reserved" | "free";

export function quotaTicks({ used, limit, reserved = 0 }: Quota): TickState[] {
  if (limit <= 0) return [];
  const count = limit > MAX_TICKS ? 10 : limit;
  const scale = count / limit;
  const usedTicks = Math.min(count, Math.round(used * scale));
  const reservedTicks = Math.min(count - usedTicks, Math.round(reserved * scale));
  return Array.from({ length: count }, (_, i): TickState => (i < usedTicks ? "used" : i < usedTicks + reservedTicks ? "reserved" : "free"));
}

/** The month's allowance as a tally: a tick per output, filled as they're used (QuotaMeter). */
export function QuotaMeter({ className }: { className?: string }) {
  const { quota } = useSession().me;
  const { text, full } = quotaWords(quota);
  return (
    <p className={["rs-quota", full ? "is-full" : "", className ?? ""].filter(Boolean).join(" ")}>
      <span className="rs-quota__ticks" aria-hidden="true">
        {quotaTicks(quota).map((state, i) => (
          <i key={i} className={state === "free" ? undefined : `is-${state}`} />
        ))}
      </span>
      <span>{text}</span>
    </p>
  );
}
