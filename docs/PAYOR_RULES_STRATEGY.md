# Keeping payor rules current, for good

Strategy from a research and design review on 2026-10-29: four web researchers, three independent designs, and an adversarial judge. Facts below carry their sources; items marked *unconfirmed* could not be checked directly. This extends `docs/ROADMAP.md`.

## The problem, proven on our own data

- The Georgia Medicaid ABA manual our rules cite (Q3, July 2026) now returns **404**. Georgia re-posts the manual quarterly under a new file name.
- The current manual (Q4, effective **10/1/2026**) lists, in its own revision record: a new in-person supervision provision (601.3.1), an updated treatment plan template (Appendix F), a new licensure requirement (601.1, 601.1.1), an updated required checklist (Appendix D), added skill-acquisition guidance (803.10), and expanded progress-note guidelines (602.3.3). Several of our seeded Georgia rules are therefore stale. Source: [GA ASD manual Q4 2026](https://www.mmis.georgia.gov/portal/Portals/0/StaticContent/Public/ALL/Handbooks/Autism%20Spectrum%20Disorder%20Q4-October%202026%2020261001130506.pdf) (checked directly).
- Of the 63 seeded rules, 40 come from one practice's internal checklist, 22 cite an official document, 1 has no source.
- Payor policy pages change constantly: in one vendor's sample, about 57% of ~2,170 payer policy pages changed at least once within 93 days ([Visualping](https://visualping.io/blog/track-prior-authorization-changes); vendor sample, not representative). A monthly check is too slow.

## Thesis

Treat every payor rule as a **claim that must carry evidence and expires on a schedule**, never as a fact someone typed in. Rules repair themselves from four channels, ranked by trust:

1. **Official documents** now, watched continuously through the changelogs payors already publish; and, from 2027, the **CMS-0057-F Prior Authorization APIs** for the Medicaid lines.
2. **Written payor correspondence**: letters, portal secure messages, provider-relations email with a named responder or reference number.
3. **Outcome signals**: denials and remittance reason codes, once real data is allowed (HIPAA phase).
4. **Targeted questions to payors**, only where 1–3 can't settle something.

## What the research found

**Regulation helps, but only partly.**
- CMS-0057-F covers Medicare Advantage, Medicaid/CHIP fee-for-service and managed care, and federal-exchange plans. Since Jan 2026 it requires 72-hour/7-day decisions, specific denial reasons, and public approval metrics. By **Jan 2027** these payers must run a Prior Authorization API that lists covered services and their documentation requirements. CMS recommends (does not mandate) HL7 Da Vinci CRD/DTR/PAS. ([CMS fact sheet](https://www.cms.gov/newsroom/fact-sheets/cms-interoperability-and-prior-authorization-final-rule-cms-0057-f), [CMS standards page](https://www.cms.gov/interoperability/implementation-guides-and-standards/application-programming-interfaces-apis-and-relevant-standards-and-implementation-guides-igs))
- It does **not** cover employer self-funded plans or ordinary commercial group plans. TRICARE is a DoD program and almost certainly outside it (*unconfirmed from an official source*). Most commercial ABA volume (Aetna, Cigna, UMR, Anthem group plans) stays outside regulation.
- No payor was confirmed to publish ABA rules through CRD/DTR yet.
- Georgia SB 80 requires insurers to post prior-auth requirements publicly, for fully insured plans only ([LegiScan](https://legiscan.com/GA/bill/SB80/2021)).

**Payors already publish change signals; nobody stitches them together for ABA.**
- Georgia: quarterly manuals with a Policy Revision Record; DCH press releases and GAMMIS banners.
- Aetna Clinical Policy Bulletins show "Last Review" and "Next Review" dates (e.g., [CPB 0648](https://www.aetna.com/cpb/medical/data/600_699/0648.html)).
- Cigna publishes monthly policy-update listings; UMR posts monthly bulletins; Lucet's ABA policy is annual (Jan–Dec).
- TRICARE's Autism Care Demonstration lives in the TRICARE Operations Manual, which is versioned by "as of" date; TriWest offers provider email subscriptions.
- Estimated 55–75 sources to watch for the 10 Georgia payors.

**Phone answers and AI calling are weak foundations.**
- A GAO study found only 4% of 300 test calls to Medicare carriers got policy answers that were both correct and complete ([GAO-04-669](https://www.gao.gov/products/gao-04-669); old, but the pattern is widely reported).
- Provider manuals state that contracts and benefit plans supersede them, and reps' answers are non-binding.
- Payors are blocking generic AI-agent calls ([Infinitus](https://www.infinitus.ai/blog/payors-are-blocking-ai-agent-calls-what-does-that-mean-for-infinitus/)); some require providers to name AI calling vendors and supply a BAA.
- Availity's terms ban scraping and bots (3(n)) and bar using it to build a competitive product (3(h)); its "Message This Payer" feature offers written secure messaging.
- No evidence was found that payors reliably answer policy questions by email. That needs an experiment.

**The market.**
- Horizontal payer-policy intelligence is being funded: e.g., Penelope Health partnered with Ensemble Health (Sept 2026, [HIT Consultant](https://hitconsultant.net/2026/09/24/ensemble-health-partners-penelope-health-real-time-payer-policy-intelligence-rcm/)); reported ~$100M funding *unconfirmed*.
- Prior-auth requirement libraries exist for enterprises, with reported inaccuracies.
- ABA-specific: Silna does ABA authorizations as a service with internal payer knowledge; ABA EHRs (CentralReach, Rethink, Motivity) leave payer-rule setup to billing teams or customers.
- **The gap:** a sourced, continuously verified library of ABA/behavioral-health *operational* rules (supervision, credentials, reauth timing, plan content, outcome measures) that feeds directly into the plan and packet the BCBA submits, with a citation on every requirement.

## How a rule earns and keeps trust

| Tier | Evidence |
|---|---|
| T1 | Current official document matched by locator, version, section, and text fingerprint; or a payor API answer |
| T2 | Written payor correspondence with a named responder or reference number |
| T3 | Portal chat transcript |
| T4 | Phone answer with a reference number (without one: hearsay) |
| T5 | Secondary sources: practice checklists, newsletters, forum posts |
| O | Outcome signals (denials): can contradict a rule or raise priority, never verify it |

- Only T1, or T2 consistent with T1, plus a named human reviewer, can mark a rule verified. A second reviewer is required when the rule contains a number, and every number must trace to a quote.
- Nothing an AI proposes counts as evidence on its own. Payor silence never counts as confirmation.
- **Decay:** a rule's "verified until" is the source's next scheduled revision (next quarter for Georgia, the CPB "Next Review" date for Aetna, 12/31 for Lucet), capped at 90 days for T2 and 180 days for T1 without a published cadence. A changed or broken source makes rules stale immediately.
- Unverified, stale, or conflicting rules show as warnings in the plan and packet, never hard blocks.

## The outreach agent

Yes, but not a monthly email blast. Three layers:
1. **Passive:** subscribe a per-practice intake inbox to every payor bulletin list; watch public sources weekly, plus extra runs at month and quarter starts. Most changes are caught here without contacting anyone.
2. **Event-triggered written questions:** only when a source breaks, sources conflict, a high-impact rule has only checklist evidence, a rule is coming due with no document to re-verify it, or a denial contradicts a rule. The agent drafts one PHI-free question citing the document and section in doubt and asking the payor to name the governing document and give a reference number. The BCBA approves and sends it from the practice's own mailbox or a portal secure message. The reply becomes T2 evidence after a human accepts it.
3. **Phone and chat:** human-initiated only, logged with a required reference number; never verifies a rule.

The agent never: drives payor portals with bots, places autonomous AI voice calls, sends PHI, sends in bulk from our domain, edits a rule from a reply, or treats silence as confirmation.

**First experiment:** with 3–5 design-partner practices, send 5–10 questions to Georgia payors and measure written response rate, speed, and how often replies cite a document. If replies are rare, outreach stays limited to gaps and conflicts.

## Build plan

Each step is useful on its own.

**Status (2026-10-30):** the core of steps 1 and 3 is built: rule evidence (append-only, tiers T1–T5), computed trust status with decay, lineage so inherited copies share evidence, the payor library sync, source snapshots and health, the Georgia manual watcher (finds the current file by title and parses the revision record), Aetna review dates, quote-verified verification, same-topic alerts for checklist-only rules, and a daily check on the demo site. Verification is done only by Yoma's platform curators; practices see rules read-only and "Report a problem" when a rule doesn't match their letter, denial, or benefits check. Live result on the first run: 9 Georgia rules (plus inherited copies) flagged by the October manual, and the TRICARE manual site reported as broken (HTTP 503). Not yet built: line-of-business keys, bitemporal rule versions, the impact-ranked review queue, and the watchers in step 4.

1. **Provenance retrofit and seed triage (~2 weeks).** Rule status, evidence tier, "verified until", effective dates, line of business; source and evidence tables. Re-point the Georgia rules to the Q4 manual as a new version; mark rules citing changed sections stale; add the CMS-0057-F decision-time rules for Georgia Medicaid. Show source, quote, and status on every rule in the plan and packet. *Proves: the dead Georgia link and Q4 changes are visible to a BCBA before submission, not through a denial.*
2. **Legal check (in parallel).** Can we store extracted text of public payor documents internally for diffing, or only fingerprints and short excerpts? Availity terms. Cross-practice sharing. *Decides steps 3–5.*
3. **One hard watcher end to end: the Georgia manual (~2 weeks).** Find the current file from the index page by title (not a fixed URL), fingerprint its text, parse the revision record, treat 404s/empty responses/redirects as "broken", never "unchanged". Replay test on the Q3 and Q4 versions must flag exactly the affected rules.
4. **Watchers for the rest of Georgia (~3–4 weeks)**, using each payor's own changelog, plus the intake inbox. *Proves real changes are caught within 7 days, and measures the weekly review workload.*
5. **AI extractor and verification queue (~3–4 weeks).** The AI proposes rule changes from document diffs, each with a verbatim quote that code verifies; numbers must appear in the quote; humans review one rule at a time, ranked by impact. *Measures reviewer minutes per change: can two founders plus one contract specialist keep Georgia current?*
6. **Evidence ledger and outreach experiment (~3 weeks).**
7. **Shared library across practices** (when the second paying practice arrives): canonical rules read-only to tenants, per-practice contract overlays, no cross-tenant leakage.
8. **Outcome signals:** denials tagged to rules (synthetic now, real after the HIPAA phase).
9. **2027: payor API connector** for Georgia Medicaid's Prior Authorization APIs, reconciled against document-derived rules.
10. **Rules API pilot** with one ABA EHR or billing company: the first test of "payor rules as a service".

## Business model

- **Near term:** rule freshness is part of the plan-and-reauth subscription. "Every requirement in your packet is cited, dated, and watched, and you're warned before submission if it changed."
- **Mid term:** license a cited ABA/behavioral-health rules API to ABA EHRs and billing/authorization services, which today re-derive rules by hand. The moat is the evidence ledger and verification history, not the crawler.
- **Long term:** adjacent therapy lines (speech, OT, PT) and more states; partner rather than compete on horizontal medical policy.
- Main cost is human verification (ABA authorization specialists advertise around $26–28/hour); crawling and AI costs are small.

## What not to build

- A calendar-driven "email every payor" blast, or bulk sending from our domain.
- Autonomous AI voice calling.
- Bots on Availity or payor portals under practice credentials.
- Auto-applying any rule change from an AI summary, a rep's reply, a denial pattern, or a forum post.
- Hard blocks on export from unverified rules.
- Member-specific benefit checks or cross-practice denial aggregation before the HIPAA phase.
- A horizontal all-of-healthcare policy library before leading the ABA vertical.

## Biggest risks

- Legal limits on storing payor text could weaken diffing and quote matching (settle in step 2).
- Verification workload: without impact ranking and a reviewer, rules go stale and BCBAs learn to ignore warnings.
- Bot protection and site churn can break watchers silently; every anomaly must read as "broken".
- Program shocks can invalidate whole rule families at once (e.g., TRICARE ABA program changes, Georgia's proposed "high-risk" ABA changes).
- Over-trust: a "verified" badge on a wrong rule invites reliance; always show the evidence and date.
- Scope creep: own Georgia ABA before expanding.
