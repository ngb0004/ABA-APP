/**
 * Client status: active, or inactive (discontinued). Shared by the server and the UI, so it holds
 * plain values only. An inactive client raises no alerts or due dates and takes no new records;
 * everything already recorded stays readable and nothing is deleted.
 */
export const CLIENT_STATUSES = ["active", "inactive"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const INACTIVE_REASONS = [
  "discharged_goals_met",
  "transferred",
  "insurance_ended",
  "family_withdrew",
  "other",
] as const;
export type InactiveReason = (typeof INACTIVE_REASONS)[number];

export const INACTIVE_REASON_LABELS: Record<InactiveReason, string> = {
  discharged_goals_met: "Discharged, goals met",
  transferred: "Transferred to another provider",
  insurance_ended: "Insurance ended",
  family_withdrew: "Family withdrew from services",
  other: "Other",
};

export const inactiveReasonLabel = (code: string | null | undefined): string =>
  code && code in INACTIVE_REASON_LABELS
    ? INACTIVE_REASON_LABELS[code as InactiveReason]
    : "Reason not recorded";

export const INACTIVE_NOTE_MAX = 500;

/**
 * What an inactive client still allows (QUESTIONS_FOR_BCBA #48), in one place so the banner, the
 * Mark-inactive dialog, and the 409 message cannot drift apart.
 */
export const INACTIVE_FROZEN =
  "New plans, sessions, goals, data, assessments, imports, and payor letters, and changes to plan drafts and packets, wait until the client is reactivated.";
export const INACTIVE_STILL_EDITABLE =
  "Insurance, authorizations, diagnoses, attachments, benefits checks, intake, and the client's details stay editable for corrections.";

/** The 409 message for any new record (or draft change) on an inactive client. */
export const CLIENT_INACTIVE_MESSAGE =
  "This client is inactive, so new plans, sessions, goals, data, assessments, letters, and changes to plan drafts and packets wait. Reactivate the client first.";

/** ?status=inactive opens the Inactive tab; anything else is the Active tab. */
export const statusFromParam = (v: string | string[] | undefined): ClientStatus =>
  v === "inactive" ? "inactive" : "active";
