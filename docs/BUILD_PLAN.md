# v1.0 Build Plan

Scope: one BCBA user, multi-tenant data model underneath, synthetic data only, running locally. Each phase ends with its acceptance criteria passing as automated tests.

---

## Phase 0: Scaffold
- [x] Next.js + TypeScript + pnpm workspace, ESLint, Prettier, Vitest, Playwright
- [x] `docker-compose.yml` with Postgres 16, Prisma connected
- [x] `.env.example` with `DATABASE_URL`, `LLM_PROVIDER`, `LLM_MODEL`, `ANTHROPIC_API_KEY`
- [x] Commands from CLAUDE.md wired up

**Accept:** `pnpm lint`, `pnpm typecheck`, `pnpm test` all pass on an empty app.

## Phase 1: Tenancy, auth, roles, audit
- [x] Tables: `org`, `user`, `membership(org_id, user_id, role)`. Roles: `BCBA`, `BCaBA`, `RBT`, `AUTH_COORDINATOR`, `PARENT`. Only `BCBA` is used in v1.0, but all roles exist.
- [x] Postgres RLS on every org-scoped table, using `SET app.current_org`. Add a test proving org A can't read org B's rows, even with a raw query.
- [x] Email/password + TOTP MFA, behind an `AuthProvider` interface
- [x] Permission matrix in one file (role × action). Only BCBA can approve, sign, or finalize. RBT can enter data only. Auth coordinator handles documents and packets only. Parent can sign assigned documents only.
- [x] Append-only `audit_event`, with a DB trigger that rejects UPDATE and DELETE. Audit middleware covers every read and write of client data.
- [x] Field-level `sensitivity` tags (`normal`, `sensitive`, `restricted`). Restricted fields are visible to BCBA only.

**Accept:** RLS isolation test; MFA login test; audit rows written for a client read; an RBT session gets 403 on approve.

## Phase 2: Synthetic data generator
- [x] `seed/synthetic/`: a generator producing 3 fictional clients in a fictional practice ("Sample Practice, Peachtree City GA"). Use obviously fake names, fake member IDs with a `SYN-` prefix, and `is_synthetic = true`.
  - **Client 1:** early learner, mostly VB-MAPP Level 1, GA Medicaid (Amerigroup), initial assessment
  - **Client 2:** Level 2, Cigna/Evernorth, first reauth, 40 hrs/week, with a progress history
  - **Client 3:** TRICARE East, reauth with outcome measures due, includes a bolting safety flag
- [x] Each client gets intake answers, VB-MAPP administrations (two for Client 2, to test carry-forward), an authorization with CPT units, 26 weeks of session data per goal (Client 2 has one flat goal and one goal with data gaps), and caregiver training sessions (Client 3 is under the TRICARE minimum).
- [x] `pnpm db:reset` loads all three.

**Accept:** seed runs idempotently; every record has `is_synthetic = true`.

## Phase 3: Clients, authorizations, utilization, caseload calendar
- [x] Client record: demographics, diagnoses (DSM-5 + ICD-10 pairs), payor(s) including secondary, service location address
- [x] Authorization: payor, auth number, start/end dates, approved units per CPT code (97151, 97153, 97155, 97156; extensible), with the unit basis (per week, per month, or per auth)
- [x] Utilization: delivered vs approved per code per week. Flag under-delivery (<80%) and over-delivery.
- [x] Supervision ratio computed per payor rule (Phase 5), shown on the client page
- [x] Caseload calendar: everything due in the next 60 days (auth expirations, reauth submission targets, reassessments, payor-specific request timing such as Amerigroup 97151 at 3 months before expiry, TRICARE outcome measures)
- [x] Alerts at 30, 21, and 14 days before auth end

**Accept:** unit tests for utilization math and calendar date generation; Client 3 shows a caregiver-training shortfall alert.

## Phase 4: VB-MAPP import (Milestones Grid)
See `docs/VBMAPP_WORKBOOK_MAP.md`. Fixtures are in `fixtures/vbmapp/`.
- [x] Parse `.xlsm`/`.xlsx` with SheetJS. Read values and formulas, and never execute macros.
- [x] Extract each administration (1–4): date, tester initials, and per milestone (level, domain, number) a score of 0, 0.5, or 1
- [x] **Recompute all totals from the raw grid.** Never trust workbook totals.
- [x] Validation flags:
  - **Totals mismatch:** the workbook total differs from the recomputed total (an overwritten formula). Show both numbers.
  - **Formula overwritten:** compare formula cells against `fixtures/vbmapp/blank_template.xlsm`
  - **Echoic overwritten:** echoic cells that should be formula-driven from the EESA sheet but are literals or deleted (info only)
  - **Bad date:** test date unparseable or out of range
  - **Isolated score:** a milestone scored while lower milestones in the same domain are unscored, or a Level 2/3 score with Level 1 incomplete. This is a "verify against protocol" warning.
  - **PHI present:** name or DOB cells non-empty. Warn, and offer to strip them on import.
- [x] Review screen: the extracted grid next to the flags. The BCBA confirms before saving and records the reviewer and time.
- [x] Carry-forward: a new administration pre-fills milestones mastered in prior administrations, and each administration is shown in its own color
- [x] SVG grid renderer (our own drawing) for the plan's assessment section
- [x] Barrier and Transition grids: **not yet.** Leave a parser interface and a TODO; this needs scored sample files.

**Accept (fixture tests):**
- `sample_A_level2.xlsm`: recomputed total **77.5**; workbook reports **73.5** → totals-mismatch flag pointing at the Level 1 Listener total; bad-date flag on test date 1 (`08/204/2026`)
- `sample_B_level1.xlsm`: recomputed total **27.5** (L1 25.5, L2 1, L3 1); isolated-score flags on L2 Play and L3 Math; formula found in the test date 2 cell → flag
- `blank_template.xlsm`: imports as zero administrations, no errors

## Phase 5: Payor rules engine
- [x] Tables: `payor`, `payor_document(name, version, effective_date, url)`, `payor_rule(type, params JSON, source_document_id, source_section, verified, notes)`
- [x] Rule types (see `seed/payors.yaml`): `required_document`, `signature_type`, `form_address`, `supervision_ratio`, `daily_cap`, `concurrent_billing`, `min_sessions_per_auth`, `unit_limit`, `unit_basis`, `request_timing`, `outcome_measure_schedule`, `staff_credential`, `event_trigger`, `plan_content`, `submission_channel`
- [x] A rule evaluator that, given a client + authorization + plan, returns `{rule, status: pass|fail|warn|n/a, evidence}`. Unverified rules can only return `warn`.
- [x] Seed loader for `seed/payors.yaml`
- [x] Each plan records the payor document versions it was written against

**Accept:** evaluator unit tests for each rule type against the 3 synthetic clients; unverified rules never return `fail`.

## Phase 6: Parent intake
- [x] Intake schema as typed Zod: yes/no with comment, Likert (never…always), checklists, intensity, frequency/duration, dates, medication and prior-evaluation tables, an availability grid. Each field carries `sensitivity` and `feeds_sections: [...]`.
- [x] Every field also allows an explicit `none / not applicable` answer. Blank is not allowed at submission.
- [x] Age-conditional fields (e.g., 12+ only)
- [x] Automatic safety flags: epi-pen or severe allergy, inhaler, seizures, bolting or overnight wandering, pica, transportation risks → a staff safety summary
- [x] Prior evaluations listed → a document upload checklist
- [x] Custody answers determine which guardian or guardians can sign
- [x] Availability grid compared against recommended hours. Flag when hours don't fit.
- [x] v1.0 entry is manual by the BCBA. Word/PDF extraction of a completed form is a later phase.

**Accept:** schema tests; restricted fields excluded from an AI payload test; safety-flag tests.

## Phase 7: Goals
See `docs/GOAL_FORMAT.md`.
- [x] Goal model: domain, tier, linked VB-MAPP milestones, the standard goal sentence, the full goal description fields, an initiation window, a medical necessity rationale (Pattern A or B), baseline (sourced), mastery criteria
- [x] Goal library seeded from the structure in `docs/reference/GOAL_BANK.md` (18 domains × 3 tiers). Placeholders like `[Client]`, `[X]%` must be filled from sourced data; a goal with an unresolved bracket can't be approved.
- [x] Goal suggestions from verified VB-MAPP results: the lowest-scoring domains and the next unmastered milestones
- [x] Required goal categories per the plan outline: communication, social/play, behavior reduction with replacement behavior, caregiver goals (minimum 2)
- [x] Duplicate-rationale check: flag near-identical rationale text across goals in one plan (a known audit finding)

## Phase 8: Treatment plan builder + numeric firewall
- [x] Plan types: `initial` and `reauth`. Twenty-three sections (three conditional), from the payor documents review; older plans keep the provisional eleven.
- [x] Each section has required items (from the intake schema and payor `plan_content` rules). Each item is answered or explicitly "none."
- [x] **Numeric firewall:**
  1. Build a context of sourced values (`score.L1.mand.admin2`, `auth.97153.units_per_week`, `goal.3.baseline_pct`, …), each with a source pointer.
  2. The prompt tells the model to reference values only as `{{key}}` and never write digits. Context passed to the model contains keys and labels, not raw numbers, wherever possible.
  3. The validator rejects any AI output containing digits outside `{{…}}`, or an unknown key. On failure, retry once, then surface the error to the BCBA.
  4. The renderer substitutes values. The UI shows each number with a hover/click link to its source.
- [x] AI drafting per section through the single LLM module (pseudonymize → filter restricted fields → call → validate → audit)
- [x] Section workflow `draft → edited → approved`, BCBA only, with diffs of AI draft vs final stored for audit
- [x] Graphs: SVG line graphs per goal from session data, with phase-change lines
- [x] Medical necessity check: every goal is linked to a diagnosis deficit area, and every requested hour block is linked to goals and data

**Accept:** firewall unit tests (a digit in the output → rejected; an unknown key → rejected; a valid token → rendered with source); e2e: draft a section for Client 2 with a mocked LLM, approve it, and see the source link on a number.

## Phase 9: Pre-submission audit
- [x] Graphs: missing data points, date gaps over 7 days, fewer than the minimum sessions
- [x] Goals: unlinked to diagnosis or deficits; unresolved placeholders; duplicate rationales
- [x] Flat progress: a goal with no improvement over 8+ weeks requires a BCBA explanation before export
- [x] Caregiver training: 97156 sessions missing, or below payor minimum
- [x] Progress summaries: thin (no data or no baseline comparison)
- [x] All payor rules evaluated (Phase 5)
- [x] Universal checks: caregiver signatures, correct payor form, diagnostic evaluation attached, IEP if applicable, secondary insurance handled, plan and evaluation dates consistent

**Accept:** Client 2's audit flags the flat goal and the data gaps; Client 3's flags caregiver training below the TRICARE minimum.

## Phase 10: Payor letters, reauth packet, export
- [x] Upload a payor letter (PDF/text) → AI classifies it (approval, denial, reduction, request for info, P2P offer) and extracts the decision, dates, units, next-request requirements, and deadlines into a checklist. The BCBA confirms. Test with **synthetic** letters written into `fixtures/letters/`.
- [x] Reauth packet screen: a checklist (payor rules + letter requirements), auto-gathered items, missing-item flags with suggested actions
- [x] Export: one ordered PDF (cover/request form placeholder, plan, graphs, attachments). Hand-off status `ready → submitted`.
- [x] Payor PDF form filling: **later.** For now, a placeholder page naming the official form and a link to it.

**Accept:** e2e: Client 2 reauth from letter upload to PDF export, blocked until the audit passes and all sections are approved.

## Phase 11: Hardening + HIPAA-readiness doc
- [x] Full e2e across all 3 synthetic clients
- [x] `docs/HIPAA_DEPLOYMENT.md`: the AWS checklist for going live (BAA, Bedrock provider, Cognito, KMS, RDS encryption, CloudTrail, backups, log scrubbing, access reviews). Don't deploy; document it.
- [x] Security pass: dependency audit, no secrets in the repo, no PHI-shaped data in logs (add a test that scans log output for `SYN-` IDs and names)

---

## Not in v1.0
Vineland and other assessments, Barrier/Transition grids, parent e-signature, extra roles in the UI, denial/P2P workflow, fax sending, payor PDF form filling, manual-update monitor, intake document extraction, the student tier, states beyond Georgia.

---

## Implementation notes (v1.0 build)

All phases 0–11 are implemented with their acceptance criteria as automated tests (`pnpm test`: unit + integration; `pnpm test:e2e`: Playwright).

| Phase | Acceptance tests |
|---|---|
| 0 | `pnpm lint`, `pnpm typecheck`, `pnpm test` pass |
| 1 | `tests/integration/tenancy.test.ts` (RLS incl. raw queries, audit rows on client read, append-only audit), `auth.test.ts` (MFA login), `e2e/roles.spec.ts` (RBT gets 403 on approve over HTTP) |
| 2 | `tests/integration/seed.test.ts` (idempotent, all synthetic) |
| 3 | `tests/unit/utilization.test.ts`, `calendar.test.ts`; Client 3 caregiver-training alert in `e2e/clients.spec.ts` |
| 4 | `tests/unit/vbmapp-parse.test.ts` (77.5 / 73.5 at N49 / bad date; 27.5 with L2 Play + L3 Math isolated, AT7 formula; blank = 0 admins), `tests/integration/vbmapp-import.test.ts` |
| 5 | `tests/unit/payor-rules.test.ts` (every rule type against the 3 clients; unverified never fail) |
| 6 | `tests/unit/intake.test.ts` (schema, restricted fields excluded from AI payload, safety flags) |
| 7 | `tests/unit/goals.test.ts` |
| 8 | `tests/unit/firewall.test.ts`; `tests/integration/plan.test.ts`; `e2e/reauth.spec.ts` (draft with mocked LLM, approve, source link on a number) |
| 9 | `tests/integration/plan.test.ts` (Client 2 flat goal + data gaps; Client 3 below TRICARE caregiver minimum) |
| 10 | `tests/integration/letters-export.test.ts`; `e2e/reauth.spec.ts` (letter upload → blocked export → approvals → PDF → submitted) |
| 11 | `e2e/*` across all 3 clients; `docs/HIPAA_DEPLOYMENT.md`; `tests/integration/log-scrub.test.ts`; `pnpm audit` clean |

Deviations and notes:
- `docs/SPEC.md` was not in the brief (manual download step). The plan now uses a 23-section structure derived from the payor documents review (`docs/PAYOR_DOCUMENTS_REVIEW.md`); plans created with the provisional eleven sections keep them. See `docs/QUESTIONS_FOR_BCBA.md` #20. Tests: `tests/unit/plan-sections.test.ts`, `tests/integration/plan-structure.test.ts`.
- `pnpm db:up` falls back to a local Postgres 16 when no Docker daemon is running. `pnpm db:reset` drops and recreates the schema itself and refuses any database other than local `aba`, `aba_test`, or `aba_e2e`.
- Barrier/Transition grids: interface and TODO only (`src/lib/vbmapp/other-grids.ts`), as specified.
- Payor PDF form filling: placeholder page naming the official form with its link, as specified.
- AI-call audit rows commit in their own transaction so rejected or failed calls are always recorded.
- Letter extraction: the AI returns verbatim quotes; code verifies each quote exists in the letter and parses dates/units from it, so no figure comes from the model.
- Payor scope (state and plan type): each payor in `seed/payors.yaml` lists `states` (empty = every state) and `line_of_business`; a rule may carry `plan_types` only when its source limits it (none do yet). Client insurance records `planType` and `planState`. The evaluator skips a rule whose plan types exclude the client's known plan type (n/a), and `scopeFindings` adds warnings only: plan type not recorded (commercial payor, or a rule depends on it) and a payor scoped to other states than the plan's. Scope is not part of a rule's fingerprint, so adding it keeps existing evidence. Rules limited to other plan types also add no required plan items, plan document versions, or calendar deadlines (`loadApplicableRules` in `src/lib/services/payors.ts`); the evaluator keeps them so it can show them as n/a. The Payor rules page groups by state, showing the practice's "States we serve" (default until chosen: office states; a cleared list stays cleared; chosen as chips from full state names) plus "All states"; a payor listing several states is shown in full once and its other groups link to it. `pnpm db:migrate` runs the payor library sync after migrating, so an existing database picks up payor states, line of business, and plan types without a reseed. Tests: `tests/unit/payor-scope.test.ts`, `tests/integration/records.test.ts`, `e2e/pages.spec.ts`. See `docs/QUESTIONS_FOR_BCBA.md` #30-31.
- Rule verification is curation, not a practice task. `User.isPlatformCurator` marks Yoma staff who verify rules; it is not an org role. Only `pnpm curator:set <email> [--revoke]` (`scripts/set-curator.ts`, connected as the table owner) changes it, and a database trigger rejects the app role changing it, so no screen or API can grant it. Each run is audit-logged (org-less `curator:grant` / `curator:revoke`, user id only). The verify, revoke, and upload-official-copy services require the flag on top of the `payor:verify` permission (403 otherwise); the flag is read fresh from the user row and exposed on the session context for display. Everyone else sees each rule read-only (status badge, source document with page and link, the sentence it came from, collapsed) and one action, "Report a problem" in the rule's ⋯ menu (the form opens in a dialog): a reason (doesn't match my letter or denial, outdated, wrong for my state or plan, other) and an optional note of at most 1000 characters. Notes that look like client information (`looksLikePhiInNote` in `src/lib/rules-watch/text.ts`: labeled names, dates of birth, member-ID-shaped and long numbers) are rejected and never stored. Reports live in `rule_report` (org_id + RLS, resolved but never deleted), are audit-logged, and curators see the open ones on the Payor rules page and resolve them. A report never changes a rule's status. Synthetic curator: `curator@yoma-staff.test`, a BCBA member of the sample practice (signing in needs an org); not created on the hosted demo. Curation covers every practice: each org keeps its own copy of the library under RLS, so the curator's verify, revoke, and upload run once per org (`forEachOrg` in `src/lib/auth/curator.ts`, org ids from the narrow `app_org_ids()` helper), each write in that org's own RLS scope and audit log as the curator. A verification is recorded in another practice only when its current copy of the document has the same text the quote was checked against; the result counts the practices verified and those with a different copy (left for their next source check). Open reports are listed from every practice (with the practice's name) and resolved in the practice that filed them. Known limit: a practice added later starts with its rules unverified until a curator re-verifies them. Tests: `tests/integration/curator.test.ts`, `tests/integration/rules-watch.test.ts`, `tests/unit/rule-reports.test.ts`, `e2e/pages.spec.ts`.
- Per-client requirements and benefits checks. `/clients/[id]/requirements` (linked from the client page and the Records insurance panel; `client:read`, the permission for viewing plans and packets, so parents never see it) shows, for each insurance, the payor, plan type, effective plan state, scope warnings, the benefits check history, and every rule that applies to that client (rules limited to other plan types are counted, not shown), grouped by topic (`src/lib/payors/categories.ts`), each with its plain-words type, the evaluator's status for this client (the rule's recorded terms are under Details) (met / missing / manual check / not applicable, from the raw result so an unverified missing item still reads "missing" beside its unverified badge), and the source with the sentence collapsed. A secondary insurance is evaluated on its own plan type and state, and against an authorization only when it is from that payor. Requirements from the client's confirmed payor letters are listed with the date the letter was received. Read-only. `benefits_check` (org_id + RLS; the app may insert and read, never update; removing the insurance keeps the check with `clientPayorId` null and its `payorId`), audited like client data. Recorded from the insurance row's ⋯ menu ("Record benefits check", an extra form action on `RowMenu`); the row shows "Benefits last checked <date> (<method>)". Checks are matched to an insurance by both its row and its current payor (`checksForInsurance`), so editing a row's payor never shows the old payor's checks under the new one. A check with a known funding answer sets an unconfirmed commercial plan's type (`commercial_unknown`, or `unknown` on a commercial payor) to fully insured or self-funded, audit-logged as `insurance:plan_type_from_benefits_check`; Medicaid, TRICARE, and confirmed types are never overwritten (`planTypeFromFunding` in `src/lib/payors/benefits.ts`). Pre-submission audit: warnings only (never blocks) when no check for the authorization's payor is dated on or after the authorization start (for an initial authorization, within 90 days before it: `INITIAL_CHECK_LOOKBACK_DAYS`), when the latest says ABA is not covered, or when it leaves prior authorization unknown. Reference numbers are synthetic (SYN-) in v1.0 like every identifier, and notes or limits that look like a name, birth date, or member ID are rejected (`looksLikePhiInNote`). Automation after the HIPAA phase: `docs/INTEGRATIONS.md`; `src/lib/eligibility/provider.ts` is the stub (NotConfigured only, unused). Seed: one check on each synthetic client's primary insurance within the current authorization (SEED_VERSION stays 3, already bumped for plan types in this release). Tests: `tests/unit/benefits.test.ts`, `tests/unit/requirements-display.test.ts`, `tests/integration/benefits.test.ts`, `tests/integration/seed.test.ts`, `e2e/records.spec.ts`. See `docs/QUESTIONS_FOR_BCBA.md` #32.
- Assessments of any type (stage 1: model, catalog, manual entry, Assessments tab). VB-MAPP is now one assessment type among many. The catalog is data: `seed/assessments.yaml` (names of assessments, domains, skill areas, and subscales only; rule 9), validated with Zod plus cross-reference checks in `src/lib/assessments/catalog.ts` and loaded once per process (and at demo boot). Types: VB-MAPP (entry `vbmapp_import`: listed through an adapter from `vbmapp_administration`, whose import and grid are unchanged), ABLLS-R, AFLS (six modules), Vineland-3, SRS-2, PDDBI, PSI-4, SIPA, PEAK, EFL, and "other" (named by the BCBA). Tables `assessment` and `assessment_score` (org_id + RLS + GRANTs, CHECKs for status, source, reviewer on confirm, initials-only "administered by", score <= possible), both on the auto-audit list, plus semantic `assessment:create|update|confirm|delete` events (ids and catalog keys only). Validation (`src/lib/assessments/validate.ts`): known scale keys only (added scales only where the catalog allows, keyed `custom_<slug>`), values within catalog ranges or the kind's bounds, possible required and score <= possible for score-of-possible areas, date no more than one day ahead and not before 2000, notes free of names/DOB/IDs; problems come back one sentence each (`HttpError.issues`). Permissions mirror VB-MAPP: `assessment:write` and `assessment:confirm` (BCBA), list with `client:read` (RBT reads, parent cannot). Confirmed assessments are locked. `/clients/[id]/assessments` (the client page's "Assessments" link) lists everything newest first, grouped by repeats with a progress table (`src/lib/assessments/view.ts`), one "Add assessment" dropdown (Skills / Standardized / Other; VB-MAPP opens its workbook import at `/clients/[id]/vbmapp`, which stays the grid page), and a ⋯ menu per draft (Edit, Confirm, Delete; `RowMenu` gained one-click `request` and `href` items). Seed (SEED_VERSION 4): Charlie gets two Vineland-3s, SRS-2, PDDBI parent (past six months), PSI-4 (due within weeks); Alpha an ABLLS-R; Bravo an AFLS Basic Living draft. Report imports (Excel, PDF, images) and plan tokens come in the next stages. Tests: `tests/unit/assessments.test.ts`, `tests/integration/assessments.test.ts`, `tests/integration/seed.test.ts`, `e2e/assessments.spec.ts`. See `docs/QUESTIONS_FOR_BCBA.md` #33-37.
- Assessment score imports (stage 2: multi-format import). The "Add assessment" dropdown on `/clients/[id]/assessments` offers "Enter scores" or "Import a file"; either dialog asks for the assessment (and AFLS module) first, because any format can hold any assessment (VB-MAPP still opens its workbook import). Accepted: .xlsx and .xls (SheetJS, `bookVBA: false`, no formulas, values only), .csv (all cells as text), .pdf (unpdf text layer; a PDF without one gets "No text found ... try an image or enter by hand"), .png/.jpg/.webp (local OCR with tesseract.js, English LSTM data from `@tesseract.js-data/eng` in node_modules, never fetched; one OCR job at a time with a timeout; Node runtime; `serverExternalPackages`), .txt, and .docx (mammoth to HTML, images dropped). 15 MB max; the real type is checked from magic bytes and must match the extension (`src/lib/assessments/extract/detect.ts`). Reading (`extract/read.ts`) turns a file into lines of cells with locations (`Skill areas!B4`, `cell B6`, `page 1, line 8`, `OCR line 9`, `line 12`, `table 1, row 2`, `paragraph 6`; a sheet name that could be a person's is shown as `Sheet n`). Matching (`extract/match.ts`, pure, no AI) compares the first text cell of each line with the chosen type's scale names, names without parentheticals, parenthetical abbreviations, and catalog `aliases` (new optional field on types, forms, respondents, and scales in `seed/assessments.yaml`; an alias naming two scales fails catalog validation), with trailing words like "domain" and kind suffixes ("ABC percentile") handled; numbers are read under the nearest column heading (standard score, v-scale, T-score, percentile, raw, score, possible; ignored: CI, descriptors, age equivalents) or a one-line heading like "Domain T-scores", so one row fills a scale and its companions (a composite's percentile, a total's raw score); "x of y", "x/y", and "x out of y" give score and possible. Confidence: high (heading or kind known), medium (no heading), low (several numbers, possible missing, OCR word confidence under 60, out of range or above possible). Also detected when labelled: administration date (never a birth date, never a future date), form, respondent; a file naming another assessment is flagged. PHI (`extract/phi.ts`): labelled names, birth dates, and IDs (and ID-shaped numbers) are detected per line, those lines are skipped, and only booleans and line locations are kept. `assessment_import` (org_id + RLS + GRANTs + CHECKs; on the auto-audit list; `assessment_import:upload|confirm|discard` events with keys and counts only) stores the filename, SHA-256, media type, format, status, `phiDetected`, and the proposal (catalog keys, numbers, locations, the catalog label that matched, confidence, flags), never the bytes or text. Review at `/assessments/imports/[id]`: flags and a PHI acknowledgement, administration fields with where each was found, each proposed score with location, confidence, and live range checks, scales not found collapsed and blank, added areas where the catalog allows; each number has its own "Checked" box (editing checks it; no "check all"), and Confirm stays disabled until every entered number is checked, the date and initials are filled, and PHI is acknowledged. The server re-checks all of that (`confirmAssessmentImport`), validates with `validateAssessment`, and creates a confirmed assessment (`source: import`, `importId`, reviewer and time) whose scores carry provenance `{importId, format, location, matchedLabel, confidence, proposed, edited, reviewedBy}` (or `enteredByHand`). Discard is in the review's ⋯ menu. Pending imports are linked on the Assessments page. Demo: only the bundled samples in `fixtures/assessments/` (`DEMO_SAMPLES.assessments`, matched by content hash; the import dialog's SamplePicker shows the samples for the chosen assessment), generated by `scripts/build-assessment-fixtures.ts` in our own layouts with fictional seed scores; read-only. Tests: `tests/unit/assessment-extract.test.ts`, `tests/integration/assessment-imports.test.ts`, `tests/integration/demo.test.ts`, `e2e/assessments.spec.ts`. See `docs/QUESTIONS_FOR_BCBA.md` #38-41.
- Assessments in the rest of the app (stage 3). Plans: `plan.assessmentIds` (migration `20261104090000_plan_assessments`, backfilled with the default) holds the assessments a plan uses; the default (`src/lib/assessments/plan.ts`) is every confirmed assessment from the twelve months before the plan (or since its authorization start). The plan page has a collapsed "Assessments used in this plan" checklist (`src/components/plan-assessments.tsx`, each box saves via `PUT /api/plans/[id]/assessments`; VB-MAPP shown as always used). A change, or confirming a selected draft or a backdated assessment, sets `plan_section.redraftReason` on sections whose value prefixes include `assessment.` (reopening approved ones; approval refused until redrafted or edited; `plan:assessments` audit event). Tokens (`assessmentValues`): `assessment.<series>.<n>.{name,date,administered_by,form,module,respondent,<scale>,<scale>.possible,total,total.possible}`, series = type (+ module, + form where compared per form, + slug for "other"), n = order among all confirmed of the series; labels and facts contain no digits outside tokens (names like Vineland-3 are tokens). VB-MAPP tokens unchanged. The assessment sections' payload gets `assessments` (name/date tokens, form, respondent, scale names, score tokens; no values, notes, or files). Payor rules: `EvalContext.assessments` (confirmed + verified VB-MAPP); `outcome_measure_schedule` maps tool names through catalog `payor_names` (`toolMatches`), computes due by from administeredOn per cadence, falls back to attachments, and returns `schedule` lines ("Vineland-3 last given …: due by …") shown on the requirements page and packet checklist; acceptable-tool `required_document` rules also accept a matching confirmed assessment. Goals: `suggestFromAreas` lists the lowest ABLLS-R/AFLS areas (catalog `suggest_goals`, `goal_domain`) with a template or "no template yet". Audit: `assessmentChecks` warns on no assessments, selected drafts, unreviewed imports, and sections needing a redraft (warnings only, mirroring VB-MAPP). Tests: `tests/unit/plan-assessments.test.ts`, `tests/integration/plan-assessments.test.ts`, `e2e/assessments.spec.ts`. See `docs/QUESTIONS_FOR_BCBA.md` #42-45.
