/**
 * Pre-submission audit. Each check returns pass / warn / fail; any "fail"
 * blocks export. Payor rules come from the evaluator: unverified rules can only
 * warn, so they never block.
 */
import { diffDays, toDay, type Day } from "../dates";
import { validateBcbaText, type SourcedContext } from "../firewall";
import {
  diagnosisLinkIssues,
  duplicateRationales,
  requiredCategoryChecks,
  unresolvedPlaceholders,
} from "../goals/checks";
import type { RuleResult } from "../payors/types";
import type { PlanBundle } from "./context";
import { dataGaps, flatProgress } from "./progress";

export type CheckStatus = "pass" | "warn" | "fail";
export type AuditCheck = {
  id: string;
  category: string;
  status: CheckStatus;
  message: string;
  details?: string[];
  goalId?: string;
  action?: string;
};

export const MIN_DATA_POINTS = 12;

export function runPresubmissionAudit(
  b: PlanBundle,
  sourced: SourcedContext,
  ruleResults: RuleResult[],
  asOf: Day,
): AuditCheck[] {
  const checks: AuditCheck[] = [];
  const push = (c: AuditCheck) => checks.push(c);
  const authStart = b.auth ? toDay(b.auth.startDate) : null;
  const windowStart = authStart && b.plan.type === "reauth" ? authStart : null;

  // ---- Graphs
  for (const g of b.goals) {
    const pts = g.dataPoints
      .map((p) => ({ date: toDay(p.date), value: p.value }))
      .filter((p) => !windowStart || p.date >= windowStart || b.plan.type === "reauth");
    const label = `Goal ${g.ordinal} (${g.domain})`;
    if (!pts.length) {
      push({
        id: `graph.missing.${g.ordinal}`,
        category: "Graphs",
        status: b.plan.type === "reauth" ? "fail" : "warn",
        message: `${label}: no data points`,
        goalId: g.id,
        action: "Enter session data or explain in the progress summary",
      });
      continue;
    }
    if (pts.length < MIN_DATA_POINTS)
      push({
        id: `graph.min.${g.ordinal}`,
        category: "Graphs",
        status: b.plan.type === "reauth" ? "fail" : "warn",
        message: `${label}: ${pts.length} data points (minimum ${MIN_DATA_POINTS})`,
        goalId: g.id,
      });
    const gaps = dataGaps(pts);
    if (gaps.length)
      push({
        id: `graph.gaps.${g.ordinal}`,
        category: "Graphs",
        status: "warn",
        message: `${label}: ${gaps.length} gap(s) over 7 days between data points`,
        details: gaps.map((x) => `${x.from} → ${x.to} (${x.days} days)`),
        goalId: g.id,
        action: "Explain the gaps (illness, holiday, cancellations) in the progress summary",
      });
    if (b.plan.type === "reauth") {
      const fp = flatProgress(pts, g.measure, asOf);
      if (fp.flat)
        push({
          id: `progress.flat.${g.ordinal}`,
          category: "Progress",
          status: g.flatExplanation?.trim() ? "pass" : "fail",
          message: g.flatExplanation?.trim()
            ? `${label}: flat progress over 8+ weeks, explained by BCBA`
            : `${label}: no improvement over the last 8 weeks. A BCBA explanation is required before export.`,
          goalId: g.id,
          action: "Record a flat-progress explanation and any program change on the goal",
        });
    }
  }

  // ---- Goals
  const goalLikes = b.goals.map((g) => ({
    id: g.id,
    ordinal: g.ordinal,
    category: g.category,
    objective: g.objective,
    rationale: g.rationale,
    replacementForGoalId: g.replacementForGoalId,
    diagnosisId: g.diagnosisId,
    deficitArea: g.deficitArea,
  }));
  const unlinked = diagnosisLinkIssues(goalLikes, b.client.diagnoses);
  push({
    id: "goals.dx_link",
    category: "Goals",
    status: unlinked.length ? "fail" : "pass",
    message: unlinked.length
      ? `${unlinked.length} goal(s) not linked to a diagnosis deficit area`
      : "Every goal is linked to a diagnosed deficit area",
    details: unlinked.map((id) => `Goal ${b.goals.find((g) => g.id === id)?.ordinal}`),
  });
  for (const g of b.goals) {
    const ph = unresolvedPlaceholders(g.objective, g.rationale, g.sd, g.targetBehavior);
    if (ph.length)
      push({
        id: `goals.placeholder.${g.ordinal}`,
        category: "Goals",
        status: "fail",
        message: `Goal ${g.ordinal}: unresolved placeholders ${ph.join(", ")}`,
        goalId: g.id,
      });
    if (g.status !== "approved")
      push({
        id: `goals.approved.${g.ordinal}`,
        category: "Goals",
        status: "fail",
        message: `Goal ${g.ordinal} is not approved by the BCBA`,
        goalId: g.id,
      });
  }
  const dups = duplicateRationales(goalLikes);
  push({
    id: "goals.duplicate_rationale",
    category: "Goals",
    status: dups.length ? "fail" : "pass",
    message: dups.length
      ? `${dups.length} pair(s) of goals with near-identical rationale text`
      : "Rationales are distinct",
    details: dups.map(
      (d) =>
        `Goal ${b.goals.find((g) => g.id === d.a)?.ordinal} and goal ${b.goals.find((g) => g.id === d.b)?.ordinal} (similarity ${d.similarity})`,
    ),
  });
  for (const c of requiredCategoryChecks(goalLikes))
    push({
      id: `goals.category.${c.category}`,
      category: "Goals",
      status: c.ok ? "pass" : "fail",
      message: `${c.message} (${c.found} found)`,
    });

  // ---- Caregiver training
  const cgSessions = b.sessions.filter((s) => s.cptCode === "97156").length;
  const cgRequested = b.auth?.units.some((u) => u.cptCode === "97156");
  if (b.plan.type === "reauth" && cgRequested && cgSessions === 0)
    push({
      id: "caregiver.none",
      category: "Caregiver training",
      status: "fail",
      message: "No caregiver training (97156) sessions delivered this authorization",
    });
  for (const r of ruleResults.filter(
    (x) => x.rule.type === "min_sessions_per_auth" && x.rawStatus === "fail",
  ))
    push({
      id: `caregiver.min.${r.rule.id}`,
      category: "Caregiver training",
      status: r.status === "fail" ? "fail" : "warn",
      message: `Caregiver training below payor minimum: ${r.message}${r.rule.verified ? "" : " (unverified rule)"}`,
      details: r.evidence,
    });

  // ---- Progress summaries
  if (b.plan.type === "reauth") {
    const s = b.plan.sections.find((x) => x.key === "skill_goals");
    const text = s?.content ?? "";
    const missing = b.goals
      .filter((g) => g.category !== "caregiver")
      .filter(
        (g) => !(text.includes(`goal.${g.ordinal}.baseline_`) && text.includes(`goal.${g.ordinal}.current_`)),
      );
    push({
      id: "progress.summary",
      category: "Progress",
      status: missing.length ? "fail" : "pass",
      message: missing.length
        ? `Progress summary is thin: ${missing.length} goal(s) lack a baseline-vs-current comparison`
        : "Progress summary compares baseline and current data for every goal",
      details: missing.map((g) => `Goal ${g.ordinal} (${g.domain})`),
    });
  }

  // ---- Sections and numbers
  const unapproved = b.plan.sections.filter((s) => s.state !== "approved");
  push({
    id: "sections.approved",
    category: "Sections",
    status: unapproved.length ? "fail" : "pass",
    message: unapproved.length
      ? `${unapproved.length} section(s) not approved`
      : "All sections approved by the BCBA",
    details: unapproved.map((s) => s.title),
  });
  const unsourced: string[] = [];
  for (const s of b.plan.sections) {
    const v = validateBcbaText(s.content, sourced);
    if (!v.ok)
      push({
        id: `sections.tokens.${s.key}`,
        category: "Sections",
        status: "fail",
        message: `${s.title}: invalid value references`,
        details: v.errors.map((e) => `${e.kind}: ${e.detail}`),
      });
    if (v.unsourcedNumbers.length) unsourced.push(`${s.title}: ${v.unsourcedNumbers.join(", ")}`);
    const ph = unresolvedPlaceholders(s.content);
    if (ph.length)
      push({
        id: `sections.placeholder.${s.key}`,
        category: "Sections",
        status: "fail",
        message: `${s.title}: unresolved placeholders ${ph.join(", ")}`,
      });
  }
  if (unsourced.length)
    push({
      id: "sections.unsourced_numbers",
      category: "Sections",
      status: "warn",
      message: "BCBA-typed numbers without a source link. Confirm each one.",
      details: unsourced,
    });

  // ---- Medical necessity: every requested hour block linked to goals and data
  if (b.auth) {
    const hasData = (cat: (c: string) => boolean) =>
      b.goals.some((g) => cat(g.category) && g.dataPoints.length > 0);
    const links: Record<string, [boolean, string]> = {
      "97153": [hasData((c) => c !== "caregiver"), "skill acquisition or behavior goals with data"],
      "97155": [b.goals.length > 0, "goals whose protocols are modified under supervision"],
      "97156": [hasData((c) => c === "caregiver"), "caregiver goals with data"],
      "97151": [
        (b.plan.sections.find((x) => x.key === "assessment")?.content ?? "").trim().length > 0,
        "an assessment section",
      ],
    };
    for (const u of b.auth.units) {
      const l = links[u.cptCode];
      if (!l) continue;
      push({
        id: `necessity.${u.cptCode}`,
        category: "Medical necessity",
        status: l[0] ? "pass" : "fail",
        message: `${u.cptCode} ${l[0] ? "is linked to" : "has no link to"} ${l[1]}`,
      });
    }
  }

  // ---- Payor rules (from the evaluator)
  for (const r of ruleResults) {
    if (r.status === "n/a" || (r.status === "pass" && r.rule.verified)) continue;
    push({
      id: `payor.${r.rule.id}`,
      category: "Payor rules",
      status: r.status === "fail" ? "fail" : r.status === "pass" ? "pass" : "warn",
      message: `${r.rule.type.replace(/_/g, " ")}: ${r.message}`,
      details: [
        ...r.evidence,
        r.rule.source.name
          ? `Source: ${r.rule.source.name}${r.rule.source.version ? ` (${r.rule.source.version})` : ""}${r.rule.source.section ? `, ${r.rule.source.section}` : ""}`
          : "Source: none recorded",
      ],
    });
  }

  // ---- Universal checks
  const att = b.client.attachments;
  const unsigned = att.filter((a) => !a.caregiverSigned && a.kind !== "outcome_measure");
  push({
    id: "universal.caregiver_signatures",
    category: "Universal",
    status: unsigned.length ? "warn" : "pass",
    message: unsigned.length
      ? `${unsigned.length} document(s) without a caregiver signature`
      : "Caregiver signatures on file for all documents",
    details: unsigned.map((a) => a.title),
  });
  const formRules = ruleResults.filter(
    (r) => r.rule.type === "required_document" && /form|cover/i.test(String(r.rule.params.doc ?? "")),
  );
  const formMissing = formRules.filter((r) => r.rawStatus === "fail");
  push({
    id: "universal.payor_form",
    category: "Universal",
    status: formRules.length === 0 ? "warn" : formMissing.length ? "warn" : "pass",
    message:
      formRules.length === 0
        ? "No payor request form rule on file; confirm the correct form"
        : formMissing.length
          ? `Payor form/cover missing: ${formMissing.map((r) => r.rule.params.doc).join(", ")}`
          : "Correct payor request form attached",
  });
  const dxEval = att.some((a) => a.kind === "diagnostic_evaluation");
  push({
    id: "universal.diagnostic_evaluation",
    category: "Universal",
    status: dxEval ? "pass" : "fail",
    message: dxEval ? "Diagnostic evaluation attached" : "Diagnostic evaluation not attached",
  });
  if (b.client.hasIep) {
    const iep = att.some((a) => a.kind === "iep");
    push({
      id: "universal.iep",
      category: "Universal",
      status: iep ? "pass" : "fail",
      message: iep ? "IEP attached" : "Client has an IEP but it is not attached",
    });
  }
  const secondary = b.client.payors.filter((p) => p.priority === "secondary");
  if (secondary.length) {
    const unsignedSec = secondary.filter((p) => !p.secondaryDocsSigned);
    push({
      id: "universal.secondary",
      category: "Universal",
      status: unsignedSec.length ? "fail" : "pass",
      message: unsignedSec.length
        ? `Secondary insurance (${unsignedSec.map((p) => p.payor.name).join(", ")}): documents not signed`
        : "Secondary insurance checked and documents signed",
    });
  }
  const dateIssues: string[] = [];
  const planDay = toDay(b.plan.createdAt);
  for (const d of b.client.diagnoses)
    if (d.evaluationDate && toDay(d.evaluationDate) > planDay)
      dateIssues.push(`Diagnostic evaluation dated after the plan (${toDay(d.evaluationDate)})`);
  for (const a of b.administrations)
    if (a.testDate && toDay(a.testDate) > asOf)
      dateIssues.push(`VB-MAPP administration ${a.adminNumber} dated in the future`);
  const latest = b.administrations.at(-1);
  if (
    latest?.testDate &&
    b.auth &&
    b.plan.type === "reauth" &&
    diffDays(toDay(b.auth.endDate), toDay(latest.testDate)) > 120
  )
    dateIssues.push("Latest VB-MAPP is more than four months before the authorization end");
  push({
    id: "universal.dates",
    category: "Universal",
    status: dateIssues.length ? "fail" : "pass",
    message: dateIssues.length
      ? "Plan and evaluation dates are inconsistent"
      : "Plan and evaluation dates are consistent",
    details: dateIssues,
  });
  push({
    id: "universal.routing",
    category: "Universal",
    status: "warn",
    message: "Confirm documents are routed to the payor and physician where required (manual check)",
  });

  return checks;
}

export function exportBlockers(checks: AuditCheck[]) {
  return checks.filter((c) => c.status === "fail");
}
