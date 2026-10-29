/**
 * Treatment plan structure: eleven sections. Provisional until docs/SPEC.md
 * ("Treatment plan structure") is added; see docs/QUESTIONS_FOR_BCBA.md.
 * Each section lists required items. Intake-driven items are added from the
 * intake schema's feeds_sections; payor plan_content topics are added per payor.
 */
import type { SectionKey } from "../intake/schema";

export type SectionDef = {
  key: SectionKey;
  title: string;
  /** Instructions to the drafting model. Never includes values. */
  guidance: string;
  /** Sourced-value key prefixes relevant to this section. */
  valuePrefixes: string[];
  /** Static required items: answered or explicitly "none". */
  items: { key: string; label: string; reauthOnly?: boolean }[];
  /** Section text is written by the BCBA only (no AI drafting). */
  bcbaOnly?: boolean;
};

export const SECTIONS: SectionDef[] = [
  {
    key: "identifying",
    title: "Identifying Information and Reason for Referral",
    guidance:
      "State the reason for referral and the services requested. Identifying details (name, date of birth, member ID) are filled from the record by the system; do not restate them.",
    valuePrefixes: ["client.", "dx.", "auth.number", "auth.start", "auth.end"],
    items: [
      { key: "referral_source", label: "Referral source documented" },
      { key: "guardian_signers", label: "Guardian(s) who may sign identified from custody answers" },
    ],
  },
  {
    key: "background",
    title: "Background and History",
    guidance:
      "Summarize developmental, medical, educational, and family background relevant to treatment, using the intake fields provided. Restricted history (abuse, substance use, suicidal behavior, custody, family psychiatric history) is never provided to you; if bcbaAuthoredRestrictedStatement is true, write the sentence: 'Additional history is documented by the BCBA.'",
    valuePrefixes: ["client.", "dx."],
    items: [
      { key: "medical_history", label: "Medical history and medications reviewed" },
      { key: "restricted_statement", label: "BCBA-written statement for restricted history (or none)" },
    ],
  },
  {
    key: "assessment",
    title: "Assessment Procedures and Results",
    guidance:
      "Summarize the VB-MAPP profile: strengths, the lowest domains, and why targets were prioritized. Refer to scores only by token. If the importer flagged isolated scores, add a sentence asking the BCBA to verify them against protocol.",
    valuePrefixes: ["vbmapp.", "score.", "dx.eval_date"],
    items: [
      { key: "assessment_dates", label: "Assessment dates and tools listed" },
      { key: "isolated_scores_verified", label: "Isolated-score flags verified against protocol (or none)" },
    ],
  },
  {
    key: "behavior",
    title: "Behavior Assessment",
    guidance:
      "Describe target problem behaviors, their likely function, and safety concerns reported at intake. Use qualitative descriptions; frequency values only by token.",
    valuePrefixes: ["intake.", "goal."],
    items: [{ key: "function_hypothesis", label: "Function of behavior identified (or none)" }],
  },
  {
    key: "skill_goals",
    title: "Skill Acquisition Goals and Progress",
    guidance:
      "Introduce the skill acquisition goals and, for a reauthorization, summarize progress for each goal by comparing baseline and current performance tokens. Do not restate goal sentences; they are rendered from the goal records.",
    valuePrefixes: ["goal.", "score."],
    items: [
      {
        key: "progress_each_goal",
        label: "Progress summarized for every goal (baseline vs current)",
        reauthOnly: true,
      },
    ],
  },
  {
    key: "behavior_goals",
    title: "Behavior Reduction Goals and Behavior Intervention Plan",
    guidance:
      "Summarize behavior reduction goals and their paired replacement behaviors, antecedent and consequence strategies, and how progress is measured.",
    valuePrefixes: ["goal."],
    items: [
      { key: "replacement_paired", label: "Each reduction goal paired with a replacement behavior" },
      { key: "bip_strategies", label: "Antecedent, replacement, and consequence strategies described" },
    ],
  },
  {
    key: "caregiver",
    title: "Caregiver Training",
    guidance:
      "Describe caregiver training goals, the skills caregivers will practice, and how generalization to caregivers will be measured.",
    valuePrefixes: ["goal.", "caregiver.", "auth.97156"],
    items: [{ key: "caregiver_goals_two", label: "At least two caregiver goals" }],
  },
  {
    key: "services",
    title: "Service Recommendations and Medical Necessity",
    guidance:
      "State the recommended services per CPT code and link each requested hour block to the goals and data that justify it. Use the authorization tokens for every hour and unit figure.",
    valuePrefixes: ["auth.", "util.", "plan.", "intake.availability"],
    items: [
      { key: "hours_linked_to_goals", label: "Every requested hour block linked to goals and data" },
      { key: "schedule_fits", label: "Recommended hours fit the family's availability (or explained)" },
    ],
  },
  {
    key: "coordination",
    title: "Coordination of Care",
    guidance:
      "Describe coordination with the physician, school, and other therapy providers listed at intake.",
    valuePrefixes: ["client."],
    items: [
      { key: "providers_contacted", label: "Other providers and school coordination documented (or none)" },
    ],
  },
  {
    key: "crisis",
    title: "Crisis and Safety Plan",
    guidance:
      "Write the crisis and safety plan covering every staff safety flag provided (e.g., allergies, elopement, transportation risk) and emergency procedures.",
    valuePrefixes: ["client."],
    items: [
      { key: "safety_flags_addressed", label: "Every staff safety flag addressed" },
      { key: "emergency_contacts", label: "Emergency contacts and procedures documented" },
    ],
  },
  {
    key: "transition",
    title: "Transition, Fade, and Discharge Plan",
    guidance:
      "Describe the transition and fade plan tied to goal mastery, generalization to caregivers, and discharge criteria.",
    valuePrefixes: ["goal.", "auth."],
    items: [
      { key: "discharge_criteria", label: "Discharge criteria stated" },
      { key: "fade_plan", label: "Fade plan tied to goals" },
    ],
  },
];

export const SECTION_BY_KEY = new Map(SECTIONS.map((s) => [s.key, s]));
