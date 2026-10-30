/**
 * Goal values are referenced internally by the goal's position ({{goal.3.baseline_pct}}); readers
 * never see that number (goals are named, not numbered). When a goal added by mistake is removed,
 * later goals move down one and their tokens move with them, so every reference still points at
 * the same goal record and renders exactly as before.
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
