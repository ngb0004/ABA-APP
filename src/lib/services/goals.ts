import { goalNames } from "../goals/names";
import { withOrg, type OrgCtx } from "../db";
import { toDay, type Day } from "../dates";
import { renderTokens } from "../firewall";
import {
  diagnosisLinkIssues,
  duplicateRationales,
  requiredCategoryChecks,
  unresolvedPlaceholders,
} from "../goals/checks";
import { assessmentCatalog } from "../assessments/catalog";
import { assessmentItem } from "../assessments/view";
import { suggestFromAreas, suggestGoals } from "../goals/suggest";
import { requirePermission } from "../permissions";
import { buildSourcedContext, loadClientData } from "../plan/context";
import { goalGraphSvg } from "../plan/graphs";
import { flatProgress } from "../plan/progress";
import { goalRemovalBlocker, loadGoalRemovalContext } from "./plans";

export async function goalsView(ctx: OrgCtx, clientId: string, asOf: Day) {
  requirePermission(ctx.role, "client:read");
  return withOrg(ctx, async (tx) => {
    const data = await loadClientData(tx, clientId);
    const sourced = buildSourcedContext(data, asOf);
    const render = (t: string) => {
      try {
        return renderTokens(t, sourced, "html");
      } catch {
        return renderTokens(t.replace(/\{\{[^}]+\}\}/g, "[missing value]"), sourced, "html");
      }
    };
    const removal = await loadGoalRemovalContext(tx, clientId);
    const templates = await tx.goalTemplate.findMany({ orderBy: [{ domainNumber: "asc" }, { tier: "asc" }] });
    const latest = data.administrations.at(-1);
    const suggestions = latest
      ? suggestGoals(
          latest.scores.map((s) => ({
            level: s.level,
            domain: s.domain,
            milestone: s.milestone,
            score: s.score as 0.5 | 1,
            firstAdmin: s.firstAdmin,
          })),
        )
      : [];
    // Low-scoring ABLLS-R and AFLS areas (catalog: suggest_goals), latest confirmed of each.
    const catalog = assessmentCatalog();
    const areaSuggestions = suggestFromAreas(
      catalog,
      data.assessments.map((a) => assessmentItem(catalog, clientId, a)),
    ).map((s) => ({
      ...s,
      template: templates.find((t) => t.domainNumber === s.goalBankDomain && t.tier === s.tier) ?? null,
    }));
    const likes = data.goals.map((g) => ({
      id: g.id,
      category: g.category,
      objective: g.objective,
      rationale: g.rationale,
      replacementForGoalId: g.replacementForGoalId,
      diagnosisId: g.diagnosisId,
      deficitArea: g.deficitArea,
    }));
    // Goals are named, never numbered, in what readers see.
    const names = goalNames(data.goals);
    return {
      client: data.client,
      goals: data.goals.map((g) => {
        const pts = g.dataPoints.map((p) => ({ date: toDay(p.date), value: p.value }));
        return {
          ...g,
          name: names.get(g.id)!,
          objectiveHtml: render(g.objective),
          rationaleHtml: render(g.rationale),
          placeholders: unresolvedPlaceholders(g.objective, g.rationale, g.sd, g.targetBehavior),
          // Why "Remove" is not offered (the server applies the same rule), or null when it is.
          removeBlocker: goalRemovalBlocker(
            removal.goals.find((r) => r.id === g.id)!,
            removal,
          ),
          flat: flatProgress(pts, g.measure, asOf).flat,
          graph: goalGraphSvg({
            title: names.get(g.id)!,
            measure: g.measure,
            points: pts,
            phaseChanges: g.phaseChanges.map((p) => ({ date: toDay(p.date), label: p.label })),
            masteryPct: g.masteryAccuracyPct,
          }),
        };
      }),
      templates,
      suggestions: suggestions.map((s) => ({
        ...s,
        template: templates.find((t) => t.domainNumber === s.goalBankDomain && t.tier === s.tier) ?? null,
      })),
      latestVerified: latest ?? null,
      areaSuggestions,
      categories: requiredCategoryChecks(likes),
      duplicates: duplicateRationales(likes),
      unlinked: diagnosisLinkIssues(likes, data.client.diagnoses),
      tokens: sourced
        .values()
        .filter((v) => v.key.startsWith("goal."))
        .map((v) => ({ key: v.key, label: v.label })),
    };
  });
}
