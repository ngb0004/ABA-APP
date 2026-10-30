# Getting plan information from insurers automatically

Today a practice learns what a client's plan covers the slow way: someone calls the payor or logs in to its portal (a benefits check, or VOB), reads the payor's prior-authorization form or checklist, and reads the authorization letters and denials that come back. Every insurer, and often every plan, does it differently.

Yoma v1.0 records that work in one place. Each insurance on a client can carry **benefits checks** (`BenefitsCheck`: date, how it was checked, reference number, whether ABA is covered, whether prior authorization is required, whether the plan is fully insured or self-funded, age and visit/hour limits, notes). The client's **Payor requirements** page shows every rule that applies to that client (payor, plan state, plan type), where each one stands, the benefits checks on record, and the requirements read from the client's letters. The pre-submission audit warns when no benefits check has been recorded since the current authorization started, when the latest one says ABA is not covered, or when it leaves prior authorization unanswered.

This document describes how the manual entry will be replaced, or supplemented, by electronic sources once the practice runs on the HIPAA deployment (`docs/HIPAA_DEPLOYMENT.md`).

> **No real patient data before the BAA.** Every source below needs real member identifiers (member ID, name, date of birth) and returns protected health information. None of it is connected in v1.0, which holds synthetic data only. Nothing here may be wired in until a Business Associate Agreement is signed with the vendor and the app runs in the HIPAA environment. The code hook, `src/lib/eligibility/provider.ts`, has one implementation, `NotConfiguredEligibilityProvider`, which refuses every request, and nothing calls it.

## 1. Real-time eligibility (X12 270/271) through a clearinghouse

**What it is.** The HIPAA-standard eligibility inquiry (270) and response (271). A clearinghouse such as Stedi or Availity sends the 270 to the payor and returns the 271, usually in seconds, through an API.

**What it tells us.** Whether coverage is active on a date, the plan name and group number, coverage start and end dates, and sometimes copays, deductibles, and whether the plan is self-funded. Some payors also return a "prior authorization required" flag for a service type.

**What it does not tell us.** There is no ABA-specific service type code in the 270/271. An inquiry can ask about general plan coverage or mental and behavioral health, and the answer is generic: it may say behavioral health is covered without saying whether ABA is, under what age limits, with what hour caps, or with what prior authorization. A person still has to confirm the ABA specifics, by portal or phone.

**What the practice needs.** Its NPI (a per-practice setting, never shared), an account with the clearinghouse, enrollment with each payor where the clearinghouse requires it, and a signed BAA with the clearinghouse.

**How it feeds Yoma.**

- An `EligibilityProvider` implementation (the interface is in `src/lib/eligibility/provider.ts`, mirroring `LlmProvider`) calls the clearinghouse from the server only.
- `benefitsCheckFromEligibility()` maps the 271 into a `BenefitsCheck` with method `electronic_eligibility`: coverage dates and plan name go into the notes, the funding answer (when the payor gives one) goes into `planFunding`, and **ABA coverage and prior authorization stay "unknown"** unless the response clearly says coverage is inactive. Because the latest check then leaves prior authorization unanswered, the audit keeps warning until a person records what the payor said for ABA.
- A known funding answer updates the insurance's plan type exactly as a manual check does: only an unconfirmed commercial plan changes, and Medicaid, TRICARE, and confirmed plan types are never overwritten.
- The clearinghouse trace number becomes the check's reference number once the synthetic-identifier rule is lifted in the HIPAA phase.
- Eligibility responses are member-specific. They are **never** used as evidence for a payor rule: a payor rule applies to every member of a plan, and a single 271 says nothing about the plan's written policy.

## 2. The CMS Prior Authorization API (CMS-0057-F)

**What it is.** The CMS Interoperability and Prior Authorization Final Rule (CMS-0057-F) requires certain payors to offer a FHIR **Prior Authorization API** by **January 1, 2027** (for Medicaid and CHIP managed care, the rating period starting on or after that date; for marketplace plans, the plan year starting on or after it). The API lets provider software ask, for a specific service and patient, whether prior authorization is required and what documentation the payor needs, and then submit the request and get a decision electronically. CMS recommends the HL7 Da Vinci implementation guides:

- **CRD** (Coverage Requirements Discovery): "is prior authorization required for this service for this member, and are there rules I should know?"
- **DTR** (Documentation Templates and Rules): the payor's own questionnaire for the documentation it needs.
- **PAS** (Prior Authorization Support): submitting the request and receiving the decision.

**Who is covered.** Medicare Advantage organizations, state Medicaid and CHIP programs (fee-for-service and managed care), and qualified health plan (QHP) issuers on the federally facilitated ACA marketplaces. **Not covered:** employer and other commercial plans (including self-funded ERISA plans) and TRICARE. For an ABA practice, that means Medicaid is where this arrives first: state fee-for-service Medicaid and CHIP (for example, Georgia DCH's straight Medicaid and Katie Beckett, the `ga_medicaid` payor) by the fixed January 1, 2027 date, and Medicaid managed care (for example, Georgia's care management organizations) from the first rating period on or after it. Most commercial clients will still need the manual route.

**How it feeds Yoma.**

- A CRD answer for a client is a benefits check: prior authorization required yes/no, recorded with method `electronic_eligibility` (or a dedicated method when built) and the payor's response identifier as the reference number.
- A DTR questionnaire is the payor's own statement of what documentation it needs. Its items can be shown on the client's Payor requirements page next to the rules, and a copy can be offered to Yoma's rule reviewers as evidence for the matching payor rule. Reviewers still decide: nothing an API returns verifies a rule automatically, and an unverified rule still only warns.
- PAS submission would replace the "export packet, submit on the portal" step for these payors. The packet stays the same; only the channel changes.

## 3. The voluntary insurer pledge (June 2025)

In June 2025, AHIP and the Blue Cross Blue Shield Association, with many of their member insurers and alongside the U.S. Department of Health and Human Services, announced voluntary commitments to simplify prior authorization. These include standardizing electronic prior authorization (building on the same FHIR standards) across commercial, Medicare Advantage, and Medicaid managed care, and aiming to answer at least 80% of electronic prior-authorization approvals in real time in 2027.

**What it means for us.** It is voluntary and it is not enforced. As of this writing (October 2026) we have not reviewed any public report that measures progress against it, so its progress is not yet verifiable; re-check before relying on it. If it holds, commercial insurers would expose CRD/DTR/PAS-style APIs too, and the same integration as section 2 would cover commercial clients. Yoma plans for it but does not depend on it: the manual benefits check and the letter extraction stay the baseline.

## Order of work (after the HIPAA phase)

1. Clearinghouse eligibility (270/271) behind `EligibilityProvider`, writing `electronic_eligibility` benefits checks. Highest coverage, lowest effort, and it confirms the plan type that decides whether state mandates apply.
2. CRD/DTR for Medicaid payors (fee-for-service and managed care) as their Prior Authorization APIs go live in 2027: prior-authorization answers on benefits checks, DTR items on the requirements page, and DTR copies offered to rule reviewers.
3. PAS submission for the same payors.
4. Commercial payors, as and if they publish the same APIs.

Every step keeps the v1.0 rules: payor rules stay data with a source and a verified flag, unverified rules only warn, every call is audit-logged without PHI in logs, and member identifiers go only to vendors under a BAA.
