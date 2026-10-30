/**
 * How an inactive (discontinued) client's figures are shown: as history, frozen at the inactive date,
 * with nothing due and nothing flagged. Pure functions, used by the client, requirements, and packet
 * pages. The pre-submission audit keeps the live evaluation (export is blocked for inactive clients).
 */
import { toDay, type Day } from "./dates";
import type { RuleResult } from "./payors/types";
import type { CodeUtilization } from "./utilization";

/** The day an inactive client's figures are evaluated as of: the inactive date, never later than today. */
export function historicalAsOf(asOf: Day, inactiveSince: Date | null): Day {
  if (!inactiveSince) return asOf;
  const since = toDay(inactiveSince);
  return since < asOf ? since : asOf;
}

export const inactiveRuleMessage = (since: Day | null) =>
  `Not tracked: the client is inactive${since ? ` since ${since}` : ""}.`;

/**
 * Rule results for an inactive client: whatever would fail, warn, or fall due is shown as n/a with the
 * reason, and the due-date lines are dropped. The evidence stays, as a record of what was on file.
 */
export function historicalRuleResults(results: RuleResult[], since: Day | null): RuleResult[] {
  return results.map((r) => {
    if (r.status === "n/a" && r.rawStatus === "n/a") return { ...r, schedule: undefined };
    return {
      ...r,
      status: "n/a",
      rawStatus: "n/a",
      message: inactiveRuleMessage(since),
      schedule: undefined,
    };
  });
}

/** Utilization for an inactive client: the figures as they stood, with no under/over-delivery flags. */
export function historicalUtilization(rows: CodeUtilization[]): CodeUtilization[] {
  return rows.map((u) => ({ ...u, flag: null, weeks: u.weeks.map((w) => ({ ...w, flag: null })) }));
}
