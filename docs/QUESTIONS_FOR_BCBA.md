# Open questions for the BCBA

Each question lists the default the build uses today. Defaults are the safer choice: when unsure, the app warns or asks for a human decision rather than silently passing. Change a default by answering here and updating the code location named.

## Assessment (VB-MAPP import)

1. **Half-point scoring.** A milestone with only the *lower* row filled scores 0.5; both rows score 1. The workbook map says this was inferred from the samples. *Default:* lower row only = 0.5, both = 1, and an upper-row-only entry also counts 0.5 (that is what the workbook's own formulas do). Is upper-row-only ever valid? (`src/lib/vbmapp/parse.ts`)
2. **What counts as an "isolated score"?** *Default:* flag a milestone when (a) the lowest milestone of that domain *within the same level* is unscored, or (b) it is a Level 2/3 score while Level 1 is not fully scored. A gap in the middle of a domain (for example, L1 Tact 4 scored with Tact 3 unscored, as in sample B) is **not** flagged. Should mid-domain gaps also be flagged? (`isolatedScoreFlags` in `src/lib/vbmapp/parse.ts`)
3. **Echoic cells typed over the EESA formula.** *Default:* treat the typed value as the BCBA's score, and show an info note. Deleted echoic formulas are treated as unscored.
4. **Carry-forward.** *Default:* only milestones with a full point (mastered) carry forward; half points do not. Carried-forward cells are drawn faded in the grid.

## Goals and progress

5. **Baseline and current values.** *Default:* baseline = mean of the first three data points; current = mean of the last three. Should baseline instead come from the assessment or a defined probe window?
6. **Flat progress.** *Default:* a least-squares trend over the last 8 weeks projecting less than a 5-point gain (percent goals), or less than a 10% decrease (frequency goals). Flat goals block export until the BCBA records an explanation. (`src/lib/plan/progress.ts`)
7. **Data gaps and minimum data.** *Default:* a gap over 7 days between data points is a **warning**, not a block. Fewer than 12 data points is a block on reauthorization plans. Should gaps block when there is no explanation?
8. **Duplicate rationales.** *Default:* word-trigram Jaccard similarity ≥ 0.5 between two goals' rationales blocks export. Tune with real plans. (`DUPLICATE_RATIONALE_THRESHOLD`)
9. **Goals across plans.** *Default:* goals belong to the client; a reauth plan uses the same goal records (and data) as the plan before it. Exported PDFs are hashed, so the submitted version is fixed.
10. **Caregiver placeholder.** *Default:* `[Caregiver]` in library text renders as the custodial guardian's relationship (for example, "Bravo's mother"), never the guardian's name.

## Supervision, utilization, scheduling

11. **Per-technician supervision.** The data model has no explicit "supervised technician" field. *Default:* a 97155 session counts toward a technician when it falls on a day that technician delivered 97153. Should supervision sessions record the technician directly?
12. **Under-delivery threshold.** *Default:* below 80% of approved units in a complete week (or to date) is flagged; per-authorization codes (e.g., 97151) are only flagged for over-delivery.
13. **Reauth target and reassessment timing.** *Default:* target submission 30 days before auth end (never before a payor's submission window opens); reassessment due 45 days before auth end. Both are per-org settings.
14. **Amerigroup 97151 timing on short authorizations.** "Request 97151 three months before auth end" falls *before* a 90-day authorization starts. *Default:* treat it as applying to the next authorization.
15. **Outcome measures.** *Default:* a measure counts as current when an `outcome_measure` attachment with a matching title is dated within the last six months.

## People and permissions

16. **BCaBA permissions.** The brief defines BCBA, RBT, coordinator, and parent scopes but not BCaBA. *Default:* BCaBA may read clients, enter data, and read payor rules; no approving, signing, drafting, or restricted fields.
17. **Joint custody signatures.** *Default:* with joint legal custody, any custodial guardian may sign; with sole custody, guardian, or state custody, only custodial guardians. Do some payors require both parents?

## Payor rules

18. **Unverified rules that would pass.** The brief says unverified rules "can only return warn." *Default:* both would-fail and would-pass results show as **warn** (with "would fail/would pass" shown beside them); not-applicable stays n/a.
19. **GA Medicaid cover-sheet signature.** The seed records a conflict (checklist: wet signature only; manual 602.3.4: secure e-signature allowed, no rubber stamps). *Default:* a manual-check warning. Confirm with DCH/CMO.

## Treatment plan structure

20. **Eleven sections.** `docs/SPEC.md` ("Treatment plan structure") was not in the build brief. *Default:* a provisional structure covering every GA Medicaid `plan_content` topic: identifying information, background, assessment, behavior assessment, skill acquisition goals and progress, behavior reduction and BIP, caregiver training, service recommendations and medical necessity, coordination of care, crisis and safety plan, transition and discharge. Replace with the spec's list. (`src/lib/plan/sections.ts`)

## Payor rule verification (Rules Watch)

21. **Second reviewer for rules with numbers.** The strategy recommends a second person confirm any rule containing a number (hours, percentages, units). *Default:* one BCBA is enough, because a solo practice has no second reviewer; the quote must still contain every number in the rule. Should multi-BCBA practices require two?
22. **How long a verification lasts.** *Default:* until the payor's next scheduled revision (next quarter for Georgia's manual, the "Next Review" date for Aetna policies), and never more than 180 days for an official document (90 days for written payor correspondence).
23. **Same-topic change alerts.** *Default:* a checklist-only rule is flagged "needs re-check" when the payor's official document logs a change on the same topic, for supervision, licensing/credentials, and treatment-plan templates only. Too many or too few alerts?
