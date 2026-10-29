import type { Score } from "./parse";
import { milestoneKey } from "./layout";

export type GridScore = Pick<Score, "level" | "domain" | "milestone" | "score" | "firstAdmin"> & {
  carriedForward?: boolean;
};

/**
 * Pre-fills a new administration with milestones mastered (score 1) in any prior
 * administration. Scores already present in the new administration are kept
 * unless they are lower than a prior mastery.
 */
export function carryForward(prior: GridScore[][], next: GridScore[]): GridScore[] {
  const out = new Map<string, GridScore>();
  for (const s of next)
    out.set(milestoneKey(s.level, s.domain, s.milestone), { ...s, carriedForward: false });
  for (const admin of prior) {
    for (const s of admin) {
      if (s.score !== 1) continue;
      const k = milestoneKey(s.level, s.domain, s.milestone);
      const cur = out.get(k);
      if (!cur || cur.score < 1) out.set(k, { ...s, score: 1, carriedForward: true });
      else if (s.firstAdmin < cur.firstAdmin) out.set(k, { ...cur, firstAdmin: s.firstAdmin });
    }
  }
  return [...out.values()].sort(
    (a, b) => a.level - b.level || a.domain.localeCompare(b.domain) || a.milestone - b.milestone,
  );
}

/** Recompute totals from scores (never from workbook totals). */
export function totalsFromScores(scores: GridScore[]) {
  const levels: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
  const domains: Record<string, number> = {};
  for (const s of scores) {
    levels[s.level] = (levels[s.level] ?? 0) + s.score;
    const k = `L${s.level}.${s.domain}`;
    domains[k] = (domains[k] ?? 0) + s.score;
  }
  return { total: levels[1]! + levels[2]! + levels[3]!, levels, domains };
}
