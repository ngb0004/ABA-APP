/**
 * Treatment plan structure: 23 sections, built from what the payor documents
 * and state templates in docs/PAYOR_DOCUMENTS_REVIEW.md ask for. Three are
 * conditional (group, school, telehealth): the BCBA marks them not applicable.
 * Plans created before this structure keep their eleven sections (LEGACY_SECTIONS).
 *
 * Each section lists required items. Intake-driven items are added from the
 * intake schema's feeds_sections; payor plan_content topics are added per payor.
 * Item labels describe what to cover; payor-specific thresholds live in the
 * payor rules, never here.
 */

export type SectionKey =
  | "client_information"
  | "diagnosis_and_referral"
  | "biopsychosocial"
  | "direct_observation"
  | "assessment_results"
  | "goal_summary"
  | "skill_acquisition_goals"
  | "behavior_intervention_plan"
  | "behavior_reduction_goals"
  | "caregiver_training_goals"
  | "group_goals"
  | "generalization_maintenance"
  | "coordination_of_care"
  | "transition_fade_plan"
  | "discharge_criteria"
  | "crisis_plan"
  | "school_plan"
  | "barriers_to_treatment"
  | "medical_necessity"
  | "service_recommendations"
  | "anticipated_schedule"
  | "telehealth_readiness"
  | "signatures_attestation";

export type LegacySectionKey =
  | "identifying"
  | "background"
  | "assessment"
  | "behavior"
  | "skill_goals"
  | "behavior_goals"
  | "caregiver"
  | "services"
  | "coordination"
  | "crisis"
  | "transition";

/** Conditions under which a conditional section applies. */
export type SectionCondition = "group" | "school" | "telehealth";

export type SectionDef = {
  key: SectionKey | LegacySectionKey;
  title: string;
  /** Instructions to the drafting model. Never includes values. */
  guidance: string;
  /** Sourced-value key prefixes relevant to this section. */
  valuePrefixes: string[];
  /** Static required items: answered or explicitly "none". */
  items: { key: string; label: string; reauthOnly?: boolean }[];
  /** Section text is written by the BCBA only (no AI drafting). */
  bcbaOnly?: boolean;
  /** Only required when this applies; otherwise the BCBA marks it not applicable. */
  condition?: SectionCondition;
  /** What the drafting call may see besides values and intake answers. */
  context?: {
    /** Goal categories to include (all goals when true). */
    goals?: true | string[];
    /**
     * Goal figures (baseline, current, mastery criteria) and goal sentences are
     * sent only to the goal sections; other sections see each goal's number,
     * domain, status, and trend, so progress is not restated across the plan.
     */
    goalFigures?: boolean;
    safetyFlags?: boolean;
    isolatedScores?: boolean;
    /** The assessments selected for the plan (names, tokens, and domain names only). */
    assessments?: boolean;
  };
  /** Intake answers this section collects (defaults to its own key). */
  intakeFrom?: SectionKey[];
  /** Exact intake fields, frozen for the legacy structure so its required items never change. */
  intakeFields?: string[];
};

const REDUCTION = ["behavior_reduction", "replacement"];
const SKILL = ["communication", "social_play", "other"];

export const SECTIONS: SectionDef[] = [
  {
    key: "client_information",
    title: "Client and Request Information",
    guidance:
      "State the request type (initial assessment, initial treatment, or continued treatment) and, in one sentence, the services requested. For a reauthorization, the request is for the next period starting {{auth.requested_start}}; the auth.number, auth.start, and auth.end values describe the current authorization this request continues. Identifying details (name, date of birth, member ID, guardian, provider) are filled from the record by the system; do not restate them.",
    valuePrefixes: [
      "client.",
      "auth.number",
      "auth.start",
      "auth.end",
      "auth.requested_start",
      "dx.eval_date",
      "vbmapp.",
    ],
    items: [
      { key: "request_type", label: "Request type stated (initial assessment, treatment, or continued)" },
      { key: "assessment_dates", label: "Initial assessment and current reassessment dates" },
      { key: "guardian_contact", label: "Parent/guardian or legal representative and contact on file" },
    ],
  },
  {
    key: "diagnosis_and_referral",
    title: "Diagnosis, Referral, and Diagnostic Evaluation",
    guidance:
      "Summarize the qualifying autism diagnosis, who made it and when (by token), the diagnostic tools named in the record, and the referral. List every co-occurring diagnosis given as a dx value (its code and name by token); say there are none only when no co-occurring dx value is provided. Do not describe tools or results that are not in the record.",
    valuePrefixes: ["dx.", "client."],
    items: [
      { key: "referral_source", label: "Referral source and ordering provider documented" },
      { key: "dx_code_and_criteria", label: "Diagnosis code and level of support stated" },
      { key: "diagnostician", label: "Diagnostician name, credentials, and date of diagnosis" },
      { key: "diagnostic_tools", label: "Diagnostic tools used, with dates" },
      { key: "comorbid_diagnoses", label: "Comorbid diagnoses listed (or none)" },
    ],
  },
  {
    key: "biopsychosocial",
    title: "Biopsychosocial Background",
    guidance:
      "Summarize family structure, medical and developmental history, medications, school placement, prior and current services, and caregiver concerns, using the intake fields provided. Restricted history (abuse, substance use, suicidal behavior, custody, family psychiatric history) is never provided to you; if bcbaAuthoredRestrictedStatement is true, write the sentence: 'Additional history is documented by the BCBA.'",
    valuePrefixes: ["client.", "dx."],
    items: [
      { key: "family_structure", label: "Family structure and living situation" },
      { key: "medical_history", label: "Medical history, allergies, and medications reviewed" },
      { key: "aba_history", label: "Prior ABA services and other current services (or none)" },
      { key: "restricted_statement", label: "BCBA-written statement for restricted history (or none)" },
    ],
  },
  {
    key: "direct_observation",
    title: "Direct Observation and Clinical Presentation",
    guidance:
      "Describe the client's clinical presentation: strengths and challenges in communication, social, adaptive, and behavior domains, using only what the record and intake provide (observation dates by token). The detailed assessment scores belong to the assessment section; do not restate them. Where observation details by setting are not in the record, write one bracketed note for the BCBA rather than several.",
    valuePrefixes: ["vbmapp.", "intake.", "client."],
    items: [
      {
        key: "observation_all_settings",
        label: "Observation in each setting where services occur, with date",
      },
      { key: "domain_strengths_challenges", label: "Strengths and challenges in each core domain" },
      { key: "domain_prior_progress", label: "Progress since the previous authorization", reauthOnly: true },
    ],
  },
  {
    key: "assessment_results",
    title: "Standardized Assessment Procedures and Results",
    guidance:
      "Summarize the VB-MAPP profile, level by level, and each assessment listed in assessments (the ones the BCBA selected for this plan): name it, its date, form, and respondent by token, and its main scores by token, then why targets were prioritized. Name every assessment only by its name token. Refer to scores only by token; a score's facts say what a higher score means on that scale (stronger skills, or more concern), which areas or domains are lowest or highest and what that means, and whether it is higher or lower than before. Higher is not always better: follow each score's direction fact, and where a score has none, do not call it good or bad, a strength or a concern. Describe a change without calling it progress unless the direction fact says a higher score means stronger skills. Read each score's facts: a level whose facts say it is mastered is described as mastered; at a level the facts call emerging, do not call any domain a strength or a weakness. Rank domains only where the facts say lowest or highest. This is the only section that reports the VB-MAPP scores in detail. If the assessor or respondent is not provided, write a bracketed note for the BCBA. If the importer flagged isolated scores, add a bracketed note asking the BCBA to verify them against protocol.",
    valuePrefixes: ["vbmapp.", "score.", "assessment.", "dx.eval_date"],
    items: [
      { key: "tools_and_dates", label: "Each tool with date, respondent, and form" },
      { key: "descriptive_analysis", label: "Results analyzed and tied to goal selection" },
      { key: "outcome_measures", label: "Payor-required outcome measures included (or none)" },
      { key: "isolated_scores_verified", label: "Isolated-score flags verified against protocol (or none)" },
    ],
    context: { isolatedScores: true, assessments: true },
  },
  {
    key: "goal_summary",
    title: "Goal Summary and Response to Treatment",
    guidance:
      "Summarize the goals for this period by status (mastered, in progress, on hold, discontinued, new) using the goal count tokens, and the overall response to treatment in a few sentences. Name goals that are at or above their mastery criterion. For an initial plan, state that this is the first treatment period. If progress is lacking, say what was changed. Per-goal detail belongs to the skill acquisition, behavior reduction, and caregiver training sections.",
    valuePrefixes: ["goals.", "goal."],
    items: [
      { key: "response_to_treatment", label: "Response to treatment summarized", reauthOnly: true },
      { key: "no_progress_modification", label: "Changes made where progress is lacking (or none)" },
    ],
    context: { goals: true, goalFigures: true },
  },
  {
    key: "skill_acquisition_goals",
    title: "Skill Acquisition Goals and Progress",
    guidance:
      "Introduce the skill acquisition goals by domain and, for a reauthorization, summarize progress for each goal by comparing baseline and current performance tokens. Do not restate goal sentences or mastery criteria; they are rendered from the goal records with their dates, baselines, and graphs.",
    valuePrefixes: ["goal."],
    items: [
      { key: "per_goal_rationale", label: "Every goal has a medical-necessity rationale" },
      {
        key: "progress_each_goal",
        label: "Progress summarized for every goal (baseline vs current)",
        reauthOnly: true,
      },
      { key: "per_goal_barriers", label: "Barriers recorded on goals that are not progressing (or none)" },
      { key: "excluded_goal_content", label: "No academic, vocational, or duplicated-service goals" },
    ],
    context: { goals: SKILL, goalFigures: true },
  },
  {
    key: "behavior_intervention_plan",
    title: "Behavior Assessment and Behavior Intervention Plan",
    guidance:
      "Describe the target problem behaviors, their likely function, safety concerns reported at intake, the paired replacement behaviors, and antecedent, consequence, and de-escalation strategies. Target behaviors are the behaviors that have a behavior reduction goal; mention other reported behaviors only as monitored, not targeted. Use the intake's own description of each behavior; where no operational definition or behavior assessment is in the record, write a bracketed note for the BCBA instead of writing one. Do not recommend aversive or restrictive procedures, and do not write a policy statement about them. Frequency values only by token; progress figures belong to the behavior reduction section.",
    valuePrefixes: ["intake."],
    items: [
      { key: "fba_summary", label: "Behavior assessment method, date, and setting (or none)" },
      { key: "function_hypothesis", label: "Function of each behavior identified (or none)" },
      { key: "replacement_paired", label: "Each reduction goal paired with a replacement behavior" },
      { key: "bip_strategies", label: "Antecedent, replacement, consequence, and de-escalation strategies" },
    ],
    context: { goals: REDUCTION, safetyFlags: true },
  },
  {
    key: "behavior_reduction_goals",
    title: "Behavior Reduction Goals and Progress",
    guidance:
      "Summarize the behavior reduction goals and, for a reauthorization, progress for each behavior by comparing baseline and current tokens, including variability and any program changes. Strategies are described in the behavior intervention plan; do not repeat them.",
    valuePrefixes: ["goal."],
    items: [
      {
        key: "progress_summary_each_behavior",
        label: "Progress summarized for every behavior (variability, effectiveness, changes)",
        reauthOnly: true,
      },
    ],
    context: { goals: REDUCTION, goalFigures: true },
  },
  {
    key: "caregiver_training_goals",
    title: "Parent and Caregiver Training Goals",
    guidance:
      "Describe the caregiver training goals, the caregiver behaviors each one measures (attendance alone does not count), caregiver participation, whether each goal is at or near its mastery criterion, and how generalization to caregivers will be measured.",
    valuePrefixes: ["goal.", "caregiver.", "auth.97156"],
    items: [
      { key: "measures_caregiver_behavior", label: "Each goal measures a caregiver behavior" },
      { key: "caregiver_participation", label: "Caregiver participation and barriers summarized" },
    ],
    context: { goals: ["caregiver"], goalFigures: true },
  },
  {
    key: "group_goals",
    title: "Group Treatment Goals",
    guidance:
      "Describe readiness for group treatment without one-to-one support, the medical necessity for it, and the separately labeled group goals. If no group service code is in the authorization and no goal is a group goal, write exactly one sentence saying group treatment is not requested for this period, and nothing else.",
    valuePrefixes: ["goal.", "auth."],
    items: [
      { key: "group_readiness", label: "Group readiness and medical necessity" },
      { key: "group_goals_labeled", label: "Group goals labeled separately, with baselines" },
    ],
    condition: "group",
    context: { goals: true, goalFigures: true },
  },
  {
    key: "generalization_maintenance",
    title: "Generalization and Maintenance Plan",
    guidance:
      "Describe, in natural prose, how skills will generalize across people, settings (home, school, community, as named in the record), and materials, and how mastered skills will be maintained. Refer to goals by domain; do not list each goal's mastery criteria or progress figures.",
    valuePrefixes: [],
    items: [
      { key: "generalization_steps", label: "Steps across people, settings, and materials" },
      { key: "maintenance_plan", label: "Maintenance plan for mastered skills" },
    ],
    context: { goals: true },
  },
  {
    key: "coordination_of_care",
    title: "Coordination of Care",
    guidance:
      "Describe coordination with the physician, school, and other therapy providers listed at intake, and any communication with the primary care provider. Tie coordination to the co-occurring diagnoses and the goal domains it supports (for example, communication goals with speech therapy).",
    valuePrefixes: ["client.", "dx."],
    items: [
      { key: "providers_contacted", label: "Other providers and school coordination documented (or none)" },
      { key: "release_on_file", label: "Release for provider communication on file (or refusal noted)" },
    ],
    context: { goals: true },
  },
  {
    key: "transition_fade_plan",
    title: "Transition and Fading Plan",
    guidance:
      "Describe how service intensity will step down as goals are mastered, any fading between service locations, and transition steps (school, adult services) where relevant. Where the record gives no step-down thresholds, write a bracketed note for the BCBA rather than inventing them. Do not restate goal progress figures.",
    valuePrefixes: ["auth.", "plan."],
    items: [{ key: "fade_plan", label: "Fading steps tied to goal milestones" }],
    context: { goals: true },
  },
  {
    key: "discharge_criteria",
    title: "Discharge Criteria and Plan",
    guidance:
      "State individualized discharge criteria tied to goal attainment, and the discharge plan (next level of care and community resources). Summarize the criteria briefly by goal domain: each goal's own mastery criterion is shown with the goal, so do not repeat it goal by goal. Add functional outcomes only where the record supports them; otherwise write a bracketed note for the BCBA.",
    valuePrefixes: ["goals."],
    items: [
      { key: "discharge_criteria", label: "Measurable, individualized discharge criteria" },
      { key: "discharge_plan_linkages", label: "Next level of care and service linkages" },
    ],
    context: { goals: true },
  },
  {
    key: "crisis_plan",
    title: "Crisis and Safety Plan",
    guidance:
      "Write the crisis and safety plan covering every staff safety flag provided (for example aggression, self-injury, allergies, elopement, transportation risk), with the triggers, prevention, and de-escalation steps for each, and when to pause or end a session. Use the behavior intervention plan's strategies; do not contradict them. Do not recommend restrictive procedures or describe a restrictive-procedures policy. Emergency contacts, locations, and medical or severe-weather procedures that are not in the record go in one bracketed note for the BCBA; never invent them. If bcbaAuthoredRestrictedStatement is true, write the sentence: 'Additional safety history is documented by the BCBA.'",
    valuePrefixes: ["client.", "intake.aggression", "intake.tantrums"],
    items: [
      { key: "safety_flags_addressed", label: "Every staff safety flag addressed" },
      { key: "prevention_deescalation", label: "Triggers, prevention, and de-escalation steps" },
      { key: "emergency_contacts", label: "Emergency contacts and procedures documented" },
    ],
    context: { goals: REDUCTION, safetyFlags: true },
  },
  {
    key: "school_plan",
    title: "School-Based Services Plan",
    guidance:
      "Describe the school-setting targets, the times of day they occur most, coordination with school staff, and the plan for fading school services. ABA does not replace the setting's own aide or educational duties. Give baseline and current figures only for goals targeted at school. If the share of requested hours delivered at school is not in the record, write a bracketed note for the BCBA.",
    valuePrefixes: ["goal.", "client."],
    items: [
      { key: "school_iep", label: "Most recent IEP, IFSP, or 504 plan attached (or none)" },
      { key: "school_targets", label: "School-setting targets with baseline and current data" },
      { key: "school_titration", label: "Plan for fading school services" },
    ],
    condition: "school",
    context: { goals: true, goalFigures: true },
  },
  {
    key: "barriers_to_treatment",
    title: "Barriers to Treatment",
    guidance:
      "List barriers to treatment (scheduling, staffing, home environment, lapses in service) and the steps taken or planned to address each. Use the utilization values and their facts: a code approved once per authorization (such as an assessment code) is not underutilized. Use the weeks-under-threshold values to describe delivery gaps. Do not restate goal progress.",
    valuePrefixes: ["util.", "auth.", "intake.availability"],
    items: [{ key: "barriers_listed", label: "Barriers listed with remediation (or none)" }],
  },
  {
    key: "medical_necessity",
    title: "Medical Necessity and Treatment Intensity",
    guidance:
      "Explain why the requested intensity is medically necessary: tie it to core autism deficits, current functioning, safety risks reported at intake, the goals, and the response to treatment, and say why fewer hours would not be enough. Refer to the assessment and goal sections instead of restating their scores and progress figures. Use tokens for every hour figure.",
    valuePrefixes: ["auth.", "plan.", "goals.", "dx.", "intake."],
    items: [
      { key: "mn_core_deficits", label: "Rationale tied to core deficits and current functioning" },
      { key: "hours_linked_to_goals", label: "Every requested hour block linked to goals and data" },
      { key: "change_in_codes_rationale", label: "Reason for any change in codes or hours (or none)" },
    ],
    context: { goals: true, safetyFlags: true },
  },
  {
    key: "service_recommendations",
    title: "Recommended Services and Requested Codes",
    guidance:
      "State the recommended services per CPT code, the supervision plan, and utilization so far. Use the authorization and utilization tokens for every hour and unit figure. The auth values describe the current authorization: for a reauthorization, present them as the current period's approved services and utilization, and state the request as continued services for the next period starting {{auth.requested_start}}; never call the current authorization dates the upcoming or requested period.",
    valuePrefixes: ["auth.", "util.", "plan.", "intake.availability"],
    items: [
      { key: "requested_codes_grid", label: "Hours and units per code from the authorization record" },
      { key: "supervision_plan", label: "Supervision plan and supervisor credentials" },
      { key: "schedule_fits", label: "Recommended hours fit the family's availability (or explained)" },
    ],
  },
  {
    key: "anticipated_schedule",
    title: "Anticipated Weekly Schedule",
    guidance:
      "Describe the anticipated weekly schedule by service and location, consistent with the requested hours and the family's availability (use the availability facts for which days the family is available). For a reauthorization, the schedule is for the next period starting {{auth.requested_start}}, not the current authorization's dates. If the service location is not provided, write a bracketed note for the BCBA.",
    valuePrefixes: ["auth.", "plan.", "intake.availability"],
    items: [{ key: "weekly_grid", label: "Weekly schedule consistent with the requested hours" }],
  },
  {
    key: "telehealth_readiness",
    title: "Telehealth Readiness",
    guidance:
      "Summarize readiness for the services requested by telehealth and the consent on file. The readiness checklist answers are the BCBA's.",
    valuePrefixes: ["auth."],
    items: [
      { key: "readiness_checklist", label: "Telehealth readiness checklist answered by the BCBA" },
      { key: "telehealth_consent", label: "Signed telehealth consent on file" },
    ],
    condition: "telehealth",
    bcbaOnly: true,
  },
  {
    key: "signatures_attestation",
    title: "Provider Information, Attestation, and Signatures",
    guidance: "Written by the BCBA.",
    valuePrefixes: ["client."],
    items: [
      { key: "provider_block", label: "Provider name, credentials, and address (org settings)" },
      { key: "bcba_signature", label: "Supervising BCBA signature, credentials, and date" },
      { key: "guardian_signers", label: "Guardian(s) who may sign identified from custody answers" },
      { key: "consent_for_treatment", label: "Signed consent for treatment on file" },
    ],
    bcbaOnly: true,
  },
];

/** The provisional eleven-section structure, kept so plans created with it still open and export unchanged. */
export const LEGACY_SECTIONS: SectionDef[] = [
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
    intakeFields: ["custody_arrangement"],
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
    intakeFields: [
      "primary_concerns",
      "diagnosis_date",
      "diagnosing_provider_type",
      "medications",
      "seizures",
      "sleep_difficulty",
      "feeding_concerns",
      "communication_modes",
      "school_placement",
      "prior_evaluations",
      "substance_use",
      "abuse_history",
      "family_psychiatric_history",
    ],
  },
  {
    key: "assessment",
    title: "Assessment Procedures and Results",
    guidance:
      "Summarize the VB-MAPP profile and each assessment listed in assessments: strengths, the lowest domains or areas, and why targets were prioritized. Name every assessment only by its name token, and refer to scores only by token. If the importer flagged isolated scores, add a sentence asking the BCBA to verify them against protocol.",
    valuePrefixes: ["vbmapp.", "score.", "assessment.", "dx.eval_date"],
    items: [
      { key: "assessment_dates", label: "Assessment dates and tools listed" },
      { key: "isolated_scores_verified", label: "Isolated-score flags verified against protocol (or none)" },
    ],
    context: { isolatedScores: true, assessments: true },
    intakeFields: ["prior_evaluations"],
  },
  {
    key: "behavior",
    title: "Behavior Assessment",
    guidance:
      "Describe target problem behaviors, their likely function, and safety concerns reported at intake. Use qualitative descriptions; frequency values only by token.",
    valuePrefixes: ["intake.", "goal."],
    items: [{ key: "function_hypothesis", label: "Function of behavior identified (or none)" }],
    context: { goals: true, safetyFlags: true },
    intakeFields: [
      "aggression",
      "aggression_frequency",
      "self_injury",
      "tantrums",
      "transitions_difficulty",
      "bolting",
      "pica",
    ],
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
    context: { goals: true },
    intakeFields: [
      "primary_concerns",
      "feeding_concerns",
      "toileting_status",
      "communication_modes",
      "independent_community",
      "caregiver_priorities",
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
    context: { goals: true },
    intakeFields: ["aggression", "aggression_frequency", "self_injury", "tantrums"],
  },
  {
    key: "caregiver",
    title: "Caregiver Training",
    guidance:
      "Describe caregiver training goals, the skills caregivers will practice, and how generalization to caregivers will be measured.",
    valuePrefixes: ["goal.", "caregiver.", "auth.97156"],
    items: [{ key: "caregiver_goals_two", label: "At least two caregiver goals" }],
    context: { goals: true },
    intakeFields: ["caregiver_priorities", "caregiver_training_availability"],
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
    context: { goals: true },
    intakeFields: ["caregiver_training_availability", "availability"],
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
    intakeFields: ["school_placement", "has_iep", "other_therapies"],
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
    context: { safetyFlags: true },
    intakeFields: [
      "medications",
      "severe_allergy",
      "epipen",
      "inhaler",
      "seizures",
      "self_injury",
      "bolting",
      "overnight_wandering",
      "pica",
      "transportation_risks",
      "independent_community",
      "suicidal_behavior",
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
    context: { goals: true },
    intakeFields: [],
  },
];

export const SECTION_BY_KEY = new Map<string, SectionDef>(
  [...SECTIONS, ...LEGACY_SECTIONS].map((s) => [s.key, s]),
);

/** Intake section keys a section collects answers for. */
export const intakeKeysFor = (def: SectionDef): string[] => def.intakeFrom ?? [def.key];

/** Whether an intake field (by id and the sections it feeds) belongs to this section. */
export const sectionTakesField = (def: SectionDef, field: { id: string; feeds_sections: string[] }) =>
  def.intakeFields
    ? def.intakeFields.includes(field.id)
    : field.feeds_sections.some((k) => intakeKeysFor(def).includes(k));

/** A plan created with the eleven-section structure. */
export const isLegacyPlan = (sectionKeys: string[]) => sectionKeys.includes("identifying");

/** Approved, or a conditional section the BCBA marked not applicable. */
export const sectionDone = (state: string) => state === "approved" || state === "not_applicable";

/**
 * Plan-content topics (payor plan_content must_include values and app checks)
 * mapped to the sections that cover them, in both structures. A topic is
 * present when every listed section has content.
 */
export const PLAN_TOPICS: Record<string, { current: SectionKey[]; legacy: LegacySectionKey[] }> = {
  background: { current: ["biopsychosocial"], legacy: ["background"] },
  medications: { current: ["biopsychosocial"], legacy: ["background"] },
  parent_concerns: { current: ["biopsychosocial"], legacy: ["background"] },
  assessment_results: { current: ["assessment_results"], legacy: ["assessment"] },
  evaluation_date: { current: ["assessment_results"], legacy: ["assessment"] },
  goals: { current: ["skill_acquisition_goals"], legacy: ["skill_goals", "behavior_goals"] },
  skill_goals: { current: ["skill_acquisition_goals"], legacy: ["skill_goals"] },
  behavior_goals: { current: ["behavior_reduction_goals"], legacy: ["behavior_goals"] },
  caregiver_goals: { current: ["caregiver_training_goals"], legacy: ["caregiver"] },
  generalization_to_caregivers: {
    current: ["caregiver_training_goals", "generalization_maintenance"],
    legacy: ["caregiver"],
  },
  generalization_strategies: { current: ["generalization_maintenance"], legacy: ["transition"] },
  coordination_of_care: { current: ["coordination_of_care"], legacy: ["coordination"] },
  care_coordination: { current: ["coordination_of_care"], legacy: ["coordination"] },
  transition_plan: { current: ["transition_fade_plan"], legacy: ["transition"] },
  transition_fade_plan_tied_to_goals: { current: ["transition_fade_plan"], legacy: ["transition"] },
  gradual_tapering_of_intensity: { current: ["transition_fade_plan"], legacy: ["transition"] },
  titration_criteria: { current: ["transition_fade_plan"], legacy: ["transition"] },
  discharge_criteria: { current: ["discharge_criteria"], legacy: ["transition"] },
  discharge_plan: { current: ["discharge_criteria"], legacy: ["transition"] },
  crisis_plan: { current: ["crisis_plan"], legacy: ["crisis"] },
  telehealth_readiness: { current: ["telehealth_readiness"], legacy: [] },
  /** Where reauthorization progress summaries are written. */
  progress_summary: { current: ["skill_acquisition_goals"], legacy: ["skill_goals"] },
  behavior_progress_summary: { current: ["behavior_reduction_goals"], legacy: ["behavior_goals"] },
};

/** Sections that cover a topic in this plan's structure; undefined when the topic is unknown. */
export function sectionsForTopic(topic: string, planSectionKeys: string[]): string[] | undefined {
  const t = PLAN_TOPICS[topic];
  if (!t) return undefined;
  const keys = isLegacyPlan(planSectionKeys) ? t.legacy : t.current;
  // No section covers it in this structure: unknown, so callers fall back to a manual check.
  return keys.length ? keys : undefined;
}
