# Roadmap

Where the product is going after v1.0, and in what order. Everything here is a proposal until Amoy (our BCBA) and early users confirm it. Open questions for her are collected at the end.

## Vision

One app for an ABA practice: assessments, treatment plans, authorizations, scheduling, RBT data collection, session notes, supervision, and billing, all in one place, with every number traceable to its source and every action audit-logged. "No real questions about what's going on."

The big incumbents (CentralReach, Rethink, Motivity, Raven, Theralytics) prove practices pay for this, and they have years of head start. We win by being built from inside the job and by being AI-native from the start, not by building everything at once.

## Principles (carry over from v1.0)

1. **The AI talks; it doesn't invent.** Facts, numbers, schedules, and claims come from stored data and deterministic code. The AI drafts, reads, and converses on top of that.
2. **A human approves anything that leaves the building.** Plans, schedule changes, claims, messages to families: a person signs off, at least until a workflow has earned automation.
3. **Every action is audit-logged, every number is sourced.**
4. **Minimum necessary.** Least data to the AI, least data in texts and logs.
5. **Payor rules are data,** cited and verified, never hard-coded.
6. **Each phase is sellable on its own.** Charge from phase 1; let real users choose phase 2.

## Status today (v1.0, synthetic data only)

Built and tested: VB-MAPP import, parent intake, goal library and suggestions, payor rules engine (10 Georgia payors, all unverified), AI section drafting behind the numeric firewall, per-section BCBA approval, pre-submission audit, payor letter reading, reauth packet PDF, utilization and supervision tracking, caseload calendar and alerts, multi-tenant security, and audit log. 115 unit/integration and 6 end-to-end tests. See `docs/BUILD_PLAN.md`.

Not yet usable with real clients: no data-entry screens, the real AI has never been run, and nothing is hosted.

## Phase 1: Make plan writing usable (next)

Goal: Amoy can write a real reauth faster than by hand.

| # | Item | Notes |
|---|---|---|
| 1.1 | Demo site with the synthetic clients | Hosted link for phones and laptops. Synthetic data only. |
| 1.2 | Data-entry screens | Clients, insurance, authorizations, diagnoses, real file uploads, users and MFA enrollment, practice settings. |
| 1.3 | Session data import | From whatever data-collection software Amoy uses (CSV/export first). Re-typing data would erase the time savings. |
| 1.4 | Real AI testing and tuning | Run with an API key on synthetic clients; tune drafts until they read like a BCBA wrote them; measure firewall retry rate. |
| 1.5 | AI spend and time tracking | Tokens and cost per call, per user, per month; time spent per plan. Feeds pricing and the "4–6 hours → ~1 hour" pitch. |
| 1.6 | Replace provisional plan structure | Use `docs/SPEC.md` once available; answer `docs/QUESTIONS_FOR_BCBA.md`. |

## Payor rules: keeping them current

The strategy for watching payor documents, evidence-based verification, the outreach agent, and a shared rules library is in `docs/PAYOR_RULES_STRATEGY.md`. Its step 1 (provenance retrofit and fixing the stale Georgia rules) should run alongside Phase 1.

## Phase 2: Go live (HIPAA)

Goal: real clients, safely. Follow `docs/HIPAA_DEPLOYMENT.md`: AWS BAA, Bedrock instead of the direct API, Cognito login, encrypted database and file storage, logging and backups. Verify the payor rules that will be relied on. Remove the synthetic-only database constraint last, after sign-off.

## Phase 3: Make plans clearly better than by hand

| # | Item |
|---|---|
| 3.1 | Functional behavior assessment (FBA) support |
| 3.2 | More assessments as scored data: Vineland-3, ABLLS-R, AFLS, PEAK, TRICARE outcome measures; VB-MAPP Barrier and Transition grids |
| 3.3 | Reassessment comparison: automatic before/after of assessments and goal progress |
| 3.4 | More documents from the same data: letter of medical necessity, mid-authorization progress report, school/coordination summaries, peer-to-peer and appeal talking points |
| 3.5 | Payor request form auto-fill |
| 3.6 | Parent e-signature (uses the existing custody logic) |
| 3.7 | "Write like me": the BCBA saves her best approved sections as style examples |
| 3.8 | Team review: BCaBA or junior BCBA drafts, senior BCBA approves |
| 3.9 | Phone-friendly layout for alerts and approvals |
| 3.10 | Payors beyond Georgia; a workflow to update rules when payors change requirements |

## Phase 4: AI scheduling

Scheduling wastes a lot of time, and the worst part is the changes: call-outs, cancellations, makeup sessions. Missed sessions are lost therapy and lost revenue, which makes this easy to sell on ROI ("recover X billable hours a month").

### What it needs to respect
- Family availability (already captured in the intake availability grid)
- RBT availability, location, and drive time
- Approved hours per week per authorization (already tracked)
- Payor rules: technician credentials, daily caps, no concurrent billing (already in the rules engine)
- BCBA supervision visits overlapping RBT sessions (already measured per month)

### Design
1. **Scheduling engine (deterministic code, not AI).** Builds the recurring weekly schedule and finds every valid option for a change. It can never book something that breaks a payor rule or exceeds approved hours.
2. **Texting assistant (AI).** Texts families and RBTs ("Are you available Thursday 3–6?"), reads messy replies ("can't Thursday, Friday after 4 works"), and turns them into facts for the engine.
3. **Human approval.** The scheduler or BCBA approves new schedules and swaps before they go out. Routine changes can be automated later.
4. **Call-out mode.** An RBT texts "sick today" → the app finds qualified, available RBTs, texts them, books the first yes, notifies the family, logs everything. Minutes instead of a morning of calls.
5. **Reporting.** Hours recovered, cancellation rates, and utilization against authorizations, using the utilization tracking already built.

### Requirements
- **Texting compliance:** opt-in consent for automated texts (TCPA) and carrier registration (10DLC).
- **HIPAA:** the SMS provider signs a BAA (Twilio offers one on certain plans); texts carry the minimum, e.g. "Session Tuesday 3–6pm at the usual location — can you confirm?", with no diagnoses or full names.
- **People can opt out of AI texting:** messages come from the practice's number, are labeled automated, honor STOP, and can always reach a human.

## Phase 5: RBT data collection and session notes

| # | Item |
|---|---|
| 5.1 | Tablet/phone data collection during sessions, working offline in clients' homes |
| 5.2 | Session notes tied to the session data, signed by the RBT (and parent where required) |
| 5.3 | AI-drafted session notes from the session data, RBT reviews and signs |
| 5.4 | Supervision tracking: BACB-required supervision, credential expirations, competency checks |

Owning data collection removes the import step from phase 1 and makes plans better.

## Phase 6: Billing and insurance

The hardest phase; practices switch billing last, once they trust everything else.

| # | Item |
|---|---|
| 6.1 | Eligibility and benefits checks through a clearinghouse |
| 6.2 | Claims built from signed session notes (codes, units), checked against authorizations |
| 6.3 | Payments, remittance matching, denials and resubmission |
| 6.4 | Electronic visit verification where Medicaid requires it; payroll export |

## Session recordings (policy)

High value for supervision and training, but the riskiest feature: recording children, often at home; the most sensitive health data; recordings can become evidence in disputes; staff may experience it as surveillance.

Default if built: **optional, consent-based short clips** ("record a 5-minute sample for your BCBA") for supervision and training, encrypted, with automatic deletion after review. Later, possibly AI-drafted notes from a clip, only with consent and strong safeguards. No continuous recording.

## Pricing inputs

- Measured prompt size: ~16–22k input tokens per fully drafted plan; letters under 1k.
- Estimated AI cost on Claude Opus 5.5: about $0.75–1.30 per plan with redrafting; roughly **$2–5 per BCBA per month** at typical volume. Replace with measured numbers after 1.4/1.5.
- Hosting for HIPAA-grade infrastructure likely costs more than AI (a fixed monthly floor before any users). Price on hosting, support, and time saved, not AI usage.

## Questions for Amoy

**About her work**
- Which software does she use for sessions, data, scheduling, and billing? Can it export data?
- Which three payors does she deal with most, and which gives the most trouble?
- What part of a reauth takes longest?
- Most common reasons for denials or requests for more information?
- Does she write FBAs? How often does she do initial assessments versus reauths?
- Could she share a de-identified plan she's proud of, as a format reference?

**About scheduling**
- Who does scheduling at her practice: her, an office scheduler, or the RBTs?
- How often does the schedule change in a normal week?
- What happens today when an RBT calls out?
- How many RBTs and clients does one scheduler juggle?

**About the product**
- Would her practice pay for plan writing alone? What would it be worth per BCBA per month?
- Which of phases 3–6 would she want first?
