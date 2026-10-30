/** Why someone reports a payor rule. Shared by the report form (client) and the service (server). */
export const REPORT_REASONS = [
  ["doesnt_match_letter", "Doesn't match my authorization letter or denial"],
  ["outdated", "Outdated (the payor changed it)"],
  ["wrong_for_state_plan", "Wrong for my state or plan type"],
  ["other", "Something else"],
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number][0];
export const REPORT_REASON_LABELS = Object.fromEntries(REPORT_REASONS) as Record<ReportReason, string>;
/** Longest note a report may carry. */
export const REPORT_NOTE_MAX = 1000;
