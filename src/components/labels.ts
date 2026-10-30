/** Plain-English labels for stored codes shown in the UI. Unknown codes fall back to "Word word". */

const LABELS: Record<string, string> = {
  // Attachment kinds
  diagnostic_evaluation: "Diagnostic evaluation",
  iep: "IEP",
  ifsp: "IFSP",
  prior_evaluation: "Prior evaluation",
  outcome_measure: "Outcome measure",
  payor_form: "Payor form",
  other: "Other",
  // Authorization and plan kinds
  initial: "Initial",
  reauth: "Reauthorization",
  // Insurance priority
  primary: "Primary",
  secondary: "Secondary",
  // Unit basis
  week: "Week",
  month: "Month",
  auth: "Whole authorization",
  // Roles
  BCBA: "BCBA",
  BCaBA: "BCaBA",
  RBT: "RBT",
  AUTH_COORDINATOR: "Authorization coordinator",
  PARENT: "Parent",
};

export function label(code: string | null | undefined): string {
  if (!code) return "";
  if (LABELS[code]) return LABELS[code];
  const s = code.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Select options with readable labels; the stored value is unchanged. */
export const labeled = (codes: readonly string[]) => codes.map((value) => ({ value, label: label(value) }));
