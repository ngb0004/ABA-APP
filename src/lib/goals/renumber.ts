/**
 * Goal values are referenced by number ({{goal.3.baseline_pct}}). When a goal
 * added by mistake is removed, later goals move down one so the plan reads
 * "Goal 1, 2, 3" without gaps; their tokens move with them, so every reference
 * still points at the same goal record.
 */

/** Stands in for a reference to a removed goal: an unresolved bracket blocks approval until the BCBA fixes it. */
export const REMOVED_GOAL_PLACEHOLDER = "[value of a removed goal]";

const GOAL_TOKEN = /\{\{\s*goal\.(\d+)\.([a-zA-Z0-9_.:-]+)\s*\}\}/g;

export function renumberGoalTokens(text: string, removedOrdinal: number): string {
  return text.replace(GOAL_TOKEN, (m, n: string, field: string) => {
    const k = Number(n);
    if (k === removedOrdinal) return REMOVED_GOAL_PLACEHOLDER;
    if (k > removedOrdinal) return `{{goal.${k - 1}.${field}}}`;
    return m;
  });
}

/** The goal numbers a text refers to, ascending. */
export function goalTokenOrdinals(text: string): number[] {
  return [...new Set([...text.matchAll(GOAL_TOKEN)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}
