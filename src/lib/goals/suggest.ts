/** Goal suggestions from a verified VB-MAPP administration: lowest domains and next unmastered milestones. */
import { LEVELS } from "../vbmapp/layout";
import type { GridScore } from "../vbmapp/carry-forward";
import { DOMAIN_VBMAPP } from "./bank";

export type Suggestion = {
  level: number;
  domain: string;
  domainScore: number;
  domainMax: number;
  nextMilestone: number;
  goalBankDomain: number | null;
  tier: number;
};

export function suggestGoals(scores: GridScore[], limit = 8): Suggestion[] {
  const out: Suggestion[] = [];
  // Work at the learner's current level: the lowest level with any unmastered milestone that has scores at or below it.
  for (const level of LEVELS) {
    for (const { name } of level.domains) {
      const ds = scores.filter((s) => s.level === level.level && s.domain === name);
      const score = ds.reduce((t, s) => t + s.score, 0);
      const max = level.topMilestone - level.bottomMilestone + 1;
      if (score >= max) continue;
      let next = level.bottomMilestone;
      while (next <= level.topMilestone && ds.find((s) => s.milestone === next)?.score === 1) next++;
      const bank = Object.entries(DOMAIN_VBMAPP).find(([, v]) => v.includes(name));
      out.push({
        level: level.level,
        domain: name,
        domainScore: score,
        domainMax: max,
        nextMilestone: next,
        goalBankDomain: bank ? Number(bank[0]) : null,
        tier: level.level,
      });
    }
  }
  // Lowest level first, then lowest proportion of the domain mastered.
  return out
    .sort((a, b) => a.level - b.level || a.domainScore / a.domainMax - b.domainScore / b.domainMax)
    .slice(0, limit);
}
