/**
 * What a section draft sends to the model: the system prompt, the payload
 * (minimum necessary, values as keys and labels only), and the clean-up applied
 * to the model's text before it is stored. The single AI module adds the
 * numeric-firewall rules, the privacy guard, and the audit event.
 */
import type { SourcedContext } from "../firewall";
import { intakeForAi, safetyFlags, type PseudonymNames } from "../intake/derive";
import { INTAKE_FIELDS, type IntakeAnswers } from "../intake/schema";
import { goalKeyKind, levelToken, type PlanBundle } from "./context";
import { sectionTakesField, type SectionDef } from "./sections";

export const DRAFT_SYSTEM_PROMPT = `You draft one section of an ABA treatment plan that will be submitted to a health plan. A Board Certified Behavior Analyst (BCBA) reviews, edits, and approves every section; your draft is a starting point.

Write two or three short paragraphs of plain clinical prose, ready to submit. No headings, lists, or markdown. Write about the client, in the third person; never address the BCBA, describe what the section should say, or give advice about the plan.

Use only the information provided. Never invent operational definitions, procedures, policies, history, diagnoses, assessment results, emergency details, contacts, locations, settings, or dates. When something the section needs is not provided, write one short bracketed note for the BCBA in its place, such as "[BCBA: add the operational definition of hitting]". Those notes block export until the BCBA replaces them, so use them only for missing information, keep them short, and use no more than two per section.

Cover only this section's topic. The plan's other sections are listed in otherSections; do not repeat their content, and do not contradict them. Goal progress figures (baseline and current levels, mastery criteria) belong only to the goal sections that are given them; elsewhere, refer to goals by number or domain without restating figures. Never restate a goal's target, criterion, or mastery requirement in your own words (for example, do not turn "fewer than one episode" into "no episodes"); the goal records are printed with the plan and carry those details.

Values whose labels say "reported at intake" are what caregivers estimated before or at the start of services; they are not current performance. Current performance comes only from goal data. Never present an intake estimate as current, and do not claim risks (such as injury) that the information does not state.

When a count is zero, do not write a sentence about it unless the section is about that count.

Value labels say what each value is. Values labeled as the current authorization describe the authorization now in effect; for a reauthorization, that authorization is ending and the request is for the next period, so never call the current authorization's dates the upcoming or requested period. Some values render with their unit (their label says so); write those tokens without a unit after them. The caregiver value already includes the client's name, so write it on its own, never with a possessive or "the" before it.`;

const REQUEST_CONTEXT = {
  reauth:
    "Reauthorization: a request to continue services for the next authorization period. Values labeled 'current authorization' describe the authorization now in effect, which this request follows; the requested period starts on auth.requested_start, and its end date is not on record.",
  initial:
    "Initial request. Values labeled 'current authorization' describe the authorization on record for this client.",
} as const;

export function buildDraftPayload(input: {
  def: SectionDef;
  bundle: PlanBundle;
  sourced: SourcedContext;
  names: PseudonymNames;
}): Record<string, unknown> {
  const { def, bundle: b, sourced, names } = input;
  const answers = (b.intake?.answers ?? {}) as IntakeAnswers;
  const sectionAnswers = Object.fromEntries(
    Object.entries(answers).filter(([id]) => {
      const f = INTAKE_FIELDS.find((x) => x.id === id);
      return !!f && sectionTakesField(def, f);
    }),
  );
  const goalsFor = def.context?.goals;
  const goals = goalsFor ? b.goals.filter((g) => goalsFor === true || goalsFor.includes(g.category)) : [];
  const figures = !!def.context?.goalFigures;
  const payload: Record<string, unknown> = {
    task: "draft_section",
    sectionKey: def.key,
    sectionTitle: def.title,
    planType: b.plan.type,
    requestContext: b.plan.type === "reauth" ? REQUEST_CONTEXT.reauth : REQUEST_CONTEXT.initial,
    guidance: def.guidance,
    otherSections: b.plan.sections.filter((s) => s.key !== def.key).map((s) => s.title),
    availableValues: sourced.forModel([
      "client.name",
      "caregiver.primary",
      ...valuePrefixesFor(
        def,
        goals.map((g) => g.ordinal),
      ),
    ]),
    intake: intakeForAi(sectionAnswers as IntakeAnswers, names),
  };
  if (goalsFor)
    payload.goals = goals.map((g) => ({
      goalNumber: `goal.${g.ordinal}`,
      domain: g.domain,
      category: g.category,
      measure: g.measure,
      // The goal sentence carries its mastery criteria; only the goal sections need it.
      ...(figures ? { objective: g.objective } : {}),
      status: g.progressStatus,
      trend: sourced.get(`goal.${g.ordinal}.current_${goalKeyKind(g.measure)}`)?.facts ?? [],
    }));
  if (def.context?.safetyFlags)
    payload.staffSafetyFlags = safetyFlags(answers).map(
      (f) => `${f.label}${f.intensity ? ` (${f.intensity})` : ""}`,
    );
  if (def.context?.isolatedScores) {
    const flags = b.administrations.flatMap((a) =>
      (a.flags as { code: string; level?: number; domain?: string }[])
        .filter((f) => f.code === "isolated_score")
        // The level is a token: the firewall rejects digits and number words in model text.
        .map((f) => `${levelToken(f.level ?? "")} ${f.domain}`),
    );
    payload.isolatedScoreFlags = [...new Set(flags)];
  }
  return payload;
}

/**
 * The section's value prefixes, with "goal." narrowed to the goals the section
 * covers: a section given only behavior goals does not see skill goal figures.
 */
export function valuePrefixesFor(def: SectionDef, goalOrdinals: number[]): string[] {
  const goalsFor = def.context?.goals;
  return def.valuePrefixes.flatMap((p) =>
    p === "goal." && goalsFor !== undefined && goalsFor !== true
      ? goalOrdinals.map((n) => `goal.${n}.`)
      : [p],
  );
}

/**
 * The caregiver value renders as "Bravo's mother", so "{{client.name}}'s
 * {{caregiver.primary}}" and "the {{caregiver.primary}}" would read "Bravo's
 * Bravo's mother" and "the Bravo's mother". Drop the extra words.
 */
export function tidyDraft(text: string): string {
  return text
    .replace(/\{\{client\.name\}\}(?:'|’)s\s+\{\{caregiver\.primary\}\}/g, "{{caregiver.primary}}")
    .replace(/\b[Tt]he\s+\{\{caregiver\.primary\}\}/g, "{{caregiver.primary}}")
    .replace(/\b[Tt]he\s+client(?:'|’)s\s+\{\{caregiver\.primary\}\}/g, "{{caregiver.primary}}");
}
