/** Goal suggestions from a verified VB-MAPP administration: lowest domains and next unmastered milestones. */
import { catalogType, scalesFor, type Catalog } from "../assessments/catalog";
import type { AssessmentItem } from "../assessments/view";
import type { Day } from "../dates";
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

/** A low-scoring skill area of a confirmed ABLLS-R or AFLS (any type with suggest_goals). */
export type AreaSuggestion = {
  assessmentId: string;
  /** "ABLLS-R" or "AFLS · Basic Living Skills". */
  assessmentName: string;
  administeredOn: Day | null;
  areaKey: string;
  area: string;
  value: number;
  possible: number;
  /** Share of the possible points scored, 0 to 1. */
  share: number;
  /** Goal bank domain whose templates fit (catalog goal_domain); null: no template yet. */
  goalBankDomain: number | null;
  tier: number;
};

/** Tier by share of possible points: under a third is tier 1, under two thirds tier 2, else tier 3. */
export function tierForShare(share: number): number {
  return share < 1 / 3 ? 1 : share < 2 / 3 ? 2 : 3;
}

/**
 * The lowest areas (by share of possible points) of the latest confirmed administration of each
 * series (type and module) whose type suggests goals. Fully scored areas are skipped.
 */
export function suggestFromAreas(
  catalog: Catalog,
  items: AssessmentItem[],
  perAssessment = 5,
): AreaSuggestion[] {
  const latest = new Map<string, AssessmentItem>();
  for (const i of items) {
    const t = catalogType(catalog, i.typeKey);
    if (!t?.suggestGoals || i.status !== "confirmed") continue;
    const k = `${i.typeKey}|${i.module ?? ""}`;
    const cur = latest.get(k);
    if (!cur || (i.administeredOn ?? "") > (cur.administeredOn ?? "")) latest.set(k, i);
  }
  const out: AreaSuggestion[] = [];
  for (const i of [...latest.values()].sort((a, b) => a.typeName.localeCompare(b.typeName))) {
    const t = catalogType(catalog, i.typeKey)!;
    const scales = scalesFor(t, i.module);
    const areas = i.scores
      .filter((s) => s.kind === "score_of_possible" && !s.parent && s.possible && s.value < s.possible)
      .map((s) => ({ s, share: s.value / s.possible!, order: scales.findIndex((c) => c.key === s.key) }))
      .sort((a, b) => a.share - b.share || a.order - b.order)
      .slice(0, perAssessment);
    for (const { s, share } of areas)
      out.push({
        assessmentId: i.id,
        assessmentName: [i.typeName, i.moduleName].filter(Boolean).join(" · "),
        administeredOn: i.administeredOn,
        areaKey: s.key,
        area: s.name,
        value: s.value,
        possible: s.possible!,
        share,
        goalBankDomain: scales.find((c) => c.key === s.key)?.goal_domain ?? null,
        tier: tierForShare(share),
      });
  }
  return out;
}
