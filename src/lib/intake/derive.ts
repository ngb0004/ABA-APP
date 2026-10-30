/**
 * Derived intake outputs: staff safety summary, prior-evaluation upload
 * checklist, allowed signers, availability vs recommended hours, and the
 * minimum-necessary AI payload.
 */
import { BLOCKS, DAYS, FIELD_BY_ID, INTAKE_FIELDS, isNa, valueOf, type IntakeAnswers } from "./schema";

export type SafetyFlag = {
  fieldId: string;
  label: string;
  detail?: string;
  /** Rated intensity (mild, moderate, severe) for behavior flags such as aggression. */
  intensity?: string;
};

export function safetyFlags(answers: IntakeAnswers): SafetyFlag[] {
  const out: SafetyFlag[] = [];
  for (const field of INTAKE_FIELDS) {
    const a = answers[field.id];
    if (!a || isNa(a) || !field.safetyFlag || field.sensitivity === "restricted") continue;
    const comment = (a as { comment?: string }).comment;
    if (field.type === "intensity") {
      // Aggression and self-injury at any rated intensity are a risk to staff and family.
      const intensity = valueOf<string>(a);
      if (intensity && field.options?.includes(intensity))
        out.push({
          fieldId: field.id,
          label: field.safetyFlag,
          intensity,
          detail: comment ? `${intensity}; ${comment}` : intensity,
        });
    } else if (valueOf<boolean>(a) === true)
      out.push({ fieldId: field.id, label: field.safetyFlag, detail: comment });
  }
  const transport = valueOf<string[]>(answers.transportation_risks);
  if (transport?.length)
    out.push({ fieldId: "transportation_risks", label: "Transportation risk", detail: transport.join(", ") });
  return out;
}

export type UploadItem = { label: string; type: string; date: string; uploaded: boolean };

export function priorEvaluationChecklist(
  answers: IntakeAnswers,
  attachments: { kind: string; title: string }[],
): UploadItem[] {
  const rows = valueOf<{ type: string; provider: string; date: string }[]>(answers.prior_evaluations) ?? [];
  return rows.map((r) => ({
    label: `${r.type} (${r.provider}, ${r.date})`,
    type: r.type,
    date: r.date,
    uploaded: attachments.some(
      (a) =>
        (a.kind === "prior_evaluation" || a.kind === "diagnostic_evaluation") &&
        a.title.toLowerCase().includes(r.type.toLowerCase()),
    ),
  }));
}

export type Guardian = { name: string; relationship: string; legalCustody: boolean };

/**
 * Custody answers decide who can sign. Joint custody: any guardian with legal
 * custody (open question whether both must sign). Sole/guardian/state: only
 * those with legal custody. No answer: nobody until the BCBA records custody.
 */
export function allowedSigners(
  answers: IntakeAnswers,
  guardians: Guardian[],
): { signers: Guardian[]; requireAll: boolean; reason: string } {
  const arrangement = valueOf<string>(answers.custody_arrangement);
  const custodial = guardians.filter((g) => g.legalCustody);
  if (!arrangement) return { signers: [], requireAll: false, reason: "Custody arrangement not recorded" };
  if (arrangement === "Joint legal custody")
    return { signers: custodial, requireAll: false, reason: "Joint legal custody: any custodial guardian" };
  if (arrangement === "State custody")
    return {
      signers: custodial,
      requireAll: true,
      reason: "State custody: caseworker or agency representative",
    };
  return { signers: custodial, requireAll: true, reason: `${arrangement}: custodial guardian only` };
}

export function availableHoursPerWeek(answers: IntakeAnswers): number | null {
  const grid = valueOf<Record<string, number[]>>(answers.availability);
  if (!grid) return null;
  let hours = 0;
  for (const day of DAYS) for (const b of grid[day] ?? []) hours += BLOCKS[b]![1] - BLOCKS[b]![0];
  return hours;
}

export function availabilityFit(answers: IntakeAnswers, recommendedHoursPerWeek: number | null | undefined) {
  const available = availableHoursPerWeek(answers);
  if (available === null || !recommendedHoursPerWeek)
    return { available, recommended: recommendedHoursPerWeek ?? null, fits: null as boolean | null };
  return { available, recommended: recommendedHoursPerWeek, fits: available >= recommendedHoursPerWeek };
}

/**
 * Minimum-necessary intake payload for AI calls: restricted fields are removed
 * entirely, names are replaced with [Client], and dates are not included.
 * The AI receives only a boolean telling it that a BCBA-written statement exists.
 */
export function intakeForAi(answers: IntakeAnswers, names: PseudonymNames) {
  const payload: Record<string, unknown> = {};
  let restrictedPresent = false;
  for (const [id, a] of Object.entries(answers)) {
    const field = FIELD_BY_ID.get(id);
    if (!field) continue;
    if (field.sensitivity === "restricted") {
      restrictedPresent = true;
      continue;
    }
    if (
      field.type === "date" ||
      field.type === "prior_evaluation_table" ||
      field.type === "medication_table" ||
      field.type === "frequency_duration" ||
      field.type === "availability_grid"
    ) {
      // Values with numbers or dates are referenced as sourced tokens, not passed as text.
      payload[id] = isNa(a) ? "none / not applicable" : "(recorded; reference by token)";
      continue;
    }
    payload[id] = isNa(a) ? "none / not applicable" : pseudonymize(JSON.stringify(valueOf(a)), names);
    const c = (a as { comment?: string }).comment;
    if (c) payload[`${id}__comment`] = pseudonymize(c, names);
  }
  return { fields: payload, bcbaAuthoredRestrictedStatement: restrictedPresent };
}

/** Client names become [Client]; guardian and other household names become [Caregiver]. */
export type PseudonymNames = { client: string[]; others: string[] };

export function pseudonymize(text: string, names: PseudonymNames): string {
  const all = [
    ...names.client.map((n) => [n, "[Client]"] as const),
    ...names.others.map((n) => [n, "[Caregiver]"] as const),
  ].filter(([n]) => n && n.trim().length >= 2);
  // Longest first, so "Jordan Testparent" is replaced before "Jordan".
  let out = text;
  for (const [n, tag] of all.sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), tag);
  }
  return out;
}

/** Name parts to pseudonymize for a client record. */
export function pseudonymNames(client: {
  firstName: string;
  lastName: string;
  preferredName?: string | null;
  guardians: unknown;
}): PseudonymNames {
  const guardians = (Array.isArray(client.guardians) ? client.guardians : []) as { name?: string }[];
  const others = guardians.flatMap((g) => (g.name ? [g.name, ...g.name.split(/\s+/)] : []));
  return {
    client: [
      client.firstName,
      client.lastName,
      client.preferredName ?? "",
      `${client.firstName} ${client.lastName}`,
    ],
    others,
  };
}
