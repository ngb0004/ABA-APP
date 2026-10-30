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

20. **Plan structure (answered by the payor documents review).** Plans now have 23 sections built from what GA Medicaid, Cigna/Evernorth, Aetna, TRICARE, and four state templates ask for (`src/lib/plan/sections.ts`). Plans created before the change keep their eleven sections, so nothing already exported changes. *Default:* the group, school, and telehealth sections are conditional: the BCBA marks each one not applicable, with a reason. Export is blocked if the group section is marked not applicable while group codes (97154/97157/97158) are authorized; remote sessions on record raise a warning for telehealth.
20a. **Goal records.** Each goal now records its date introduced, projected mastery date, status (new, in progress, mastered, on hold, discontinued), settings, and barriers. *Default:* the baseline is locked from the mean of the goal's first three data points, dated by the third, and can never change once locked; until it is locked, the computed mean is used and the audit warns. Changing a goal's dates returns it to draft; changing its status or barriers does not. Should the BCBA be able to choose a different baseline window before locking?

## Payor rule verification (Rules Watch)

21. **Second reviewer for rules with numbers.** The strategy recommends a second person confirm any rule containing a number (hours, percentages, units). *Default:* one BCBA is enough, because a solo practice has no second reviewer; the quote must still contain every number in the rule. Should multi-BCBA practices require two?
22. **How long a verification lasts.** *Default:* until the payor's next scheduled revision (next quarter for Georgia's manual, the "Next Review" date for Aetna policies), and never more than 180 days for an official document (90 days for written payor correspondence).
23. **Same-topic change alerts.** *Default:* a checklist-only rule is flagged "needs re-check" when the payor's official document logs a change on the same topic, for supervision, licensing/credentials, and treatment-plan templates only. Too many or too few alerts?

## From the payor documents review (docs/PAYOR_DOCUMENTS_REVIEW.md)

24. **Georgia: separate or consolidated prior authorizations?** The Q4 manual contradicts itself: Appendix E B.iii/iv says assessment and treatment are separate PAs, while B.xiv requires one consolidated PA after the initial assessment. Amerigroup's checklist rule also says 97151 is separate. *Default:* warn, cite both passages, and let the BCBA choose.
25. **Aetna: how to request ABA authorization?** The office manual (6/26) says to call the number on the member's card; the newer GR-69017-4 form (effective 2026-08-01) says initial requests start on Availity. *Default:* unverified warning naming both.
26. **TRICARE technicians: RBT only, or also ABAT/BCAT?** The checklist says RBT; the Humana Military FAQ lists QABA (ABAT) and BICC (BCAT) among accepted boards, subject to the TRICARE Operations Manual and state law. *Default:* warn only.
27. **TRICARE "report due 14 days after assessment".** No official document found states this; the only 14-day figure is the FAQ's window for completing 97151. Is the checklist rule right?
28. **Plan structure:** moved to the 23-section structure (see 20). Payor-specific section order is not implemented yet; every payor gets the same order.

## Uploaded payor documents

29. **How long does a verification against an uploaded document last?** Some official documents have no public copy (the 2026 TRICARE East handbook, the Humana Military FAQ), so a Yoma rule reviewer (platform curator) uploads the PDF and nothing can watch it for changes. *Default:* verifications against an uploaded copy last at most 90 days (180 for a watched document), and uploading a new edition re-checks every quoted sentence. Uploads that look like a client record (a name, date of birth, or member ID) are rejected, and uploads are off on the demo site. (`UNWATCHED_CEILING_DAYS` in `src/lib/rules-watch/status.ts`)

## Payors by state and plan type

30. **Which state is "BCBS via Lucet"?** The seed has one rule for it, taken from a single approval letter, and nothing that names the BCBS plan or state. Lucet manages behavioral health for several BCBS companies, and each BCBS company is separate per state. *Default:* scoped to Georgia (the launch market) as a commercial payor; choosing it for a plan issued in another state shows a warning, never a block. Which BCBS plan(s) does it cover for this practice?
31. **Plan type unknown.** Whether a commercial plan is fully insured or self-funded (ERISA) decides whether Georgia's autism mandate applies, and nobody can tell from the card alone. *Default:* every rule still applies and one warning asks the BCBA to confirm the plan type with the benefits check (VOB). Should a reauth packet ever be blocked on it? (Currently: never.)

## Benefits checks

32. **How fresh must a benefits check be?** Coverage and prior authorization rules can change at a plan year, an employer change, or a new card. *Default:* the pre-submission audit warns (never blocks) when no benefits check for the authorization's payor is dated on or after the current authorization's start (for an initial authorization, which is requested after the benefits check, within 90 days before its start), when the latest check says ABA is not covered, or when it leaves prior authorization unanswered. Should the window be shorter (e.g., within 30 days of submitting), is 90 days before an initial authorization right, and should a secondary insurance need its own current check?

## Assessments (seed/assessments.yaml)

33. **Domain and area lists.** The catalog holds names only (never item wording). Listed where widely documented: the 25 ABLLS-R skill areas, AFLS Basic Living Skills areas, Vineland-3 domains, subdomains (v-scale) and maladaptive indexes, SRS-2 total, DSM-5 compatible and treatment subscales, a minimal PDDBI domain list, PSI-4 and SIPA total stress plus the two domains, the four PEAK modules, and four EFL domains. *Default:* the other five AFLS modules start with no listed areas, and AFLS, PDDBI, PSI-4, SIPA, PEAK, and EFL let the BCBA add any area or scale not listed (name, kind, score, possible). Which areas should be listed for the AFLS Home, Community Participation, School, Vocational, and Independent Living modules, and are the PDDBI, PEAK, and EFL lists the ones this practice reports?
34. **Item counts ("possible" points).** ABLLS-R, AFLS, PEAK, and EFL areas are scored as a score of possible points. *Default:* the BCBA enters "possible" for each area; nothing is hard-coded, and a score above its possible is rejected. Should the catalog carry the possible points per area once confirmed against the protocols?
35. **Score ranges.** *Default:* only well-established ranges are enforced (Vineland-3 standard scores 20-140, v-scale 1-24, percentiles 0-100); T-scores, raw scores, and the rest are checked against wide sanity bounds only. Should SRS-2 and PDDBI T-scores have tighter limits?
36. **Confirmed assessments are locked.** A BCBA confirms each assessment's scores (reviewer and time recorded); after that the scores cannot be edited or deleted, because plans will cite them as sourced values. *Default:* to fix a mistake, the BCBA adds a corrected assessment. Should a BCBA be able to reopen a confirmed assessment (with the change audit-logged), and should confirming need a second reviewer?
37. **Comparing repeats.** *Default:* repeats are grouped by type and module (and by form for the PDDBI, whose parent and teacher forms are not comparable), and the change column is newest minus oldest. Should Vineland-3 or SRS-2 repeats on different forms or respondents also be kept apart?

## Assessment score imports

38. **What counts as "checked"?** Imported scores are proposals: each number shows where it was found and a confidence badge, and the BCBA must tick it (or edit it) before confirming. *Default:* there is no "check all", the date and the BCBA's initials are always entered or confirmed by hand, and editing a number counts as checking it. Is ticking each number the right level of friction, or should low-confidence and out-of-range numbers need a second look while high-confidence ones need only one tick per table?
39. **Percentiles written as bounds ("<1", ">99").** These cannot be stored as numbers. *Default:* they are not proposed; the review screen notes them and the BCBA enters a number by hand (e.g., 0.1 or 99.9) or leaves the scale blank. Which value should a "<1" percentile be recorded as, if any?
40. **Which date is the administration date?** Reports can carry an administration date, a report date, and a scoring date. *Default:* the first date labelled as the administration, test, assessment, evaluation, or rating date is proposed; several different dates are flagged; a birth date is never used; future dates are not used. Should the report date ever be accepted as the administration date?
41. **Who administered it?** Reports name the examiner. *Default:* the examiner is never read from the file (it may be a name); the BCBA enters initials or a staff code on the review screen.

