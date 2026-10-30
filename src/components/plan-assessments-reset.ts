export type PlanAssessmentOption = {
  id: string;
  typeName: string;
  administeredOn: string | null;
  status: "draft" | "confirmed";
  /** VB-MAPP administrations (verified) are always used. */
  vbmapp: boolean;
  selected: boolean;
  /** What "Reset to default" would select (the window in force now, from the plan's creation). */
  byDefault: boolean;
};

/**
 * The confirm text for "Reset to default": what it unchecks and checks, and that approved
 * sections using assessments reopen. Null when the selection already is the default.
 */
export function resetConfirmText(options: PlanAssessmentOption[], chosen: Set<string>): string | null {
  const editable = options.filter((o) => !o.vbmapp);
  const name = (o: PlanAssessmentOption) => `${o.typeName} (${o.administeredOn ?? "no date"})`;
  const off = editable.filter((o) => chosen.has(o.id) && !o.byDefault);
  const on = editable.filter((o) => !chosen.has(o.id) && o.byDefault);
  if (!off.length && !on.length) return null;
  const lines = ["Reset to the default selection?"];
  if (off.length) lines.push("", "Unchecks:", ...off.map((o) => `- ${name(o)}`));
  if (on.length) lines.push("", "Checks:", ...on.map((o) => `- ${name(o)}`));
  // Drafts give no values, so only a change among confirmed ones reopens sections.
  if ([...off, ...on].some((o) => o.status === "confirmed"))
    lines.push(
      "",
      "Sections that use assessments, approved ones included, are reopened for a redraft. This cannot be undone.",
    );
  return lines.join("\n");
}
