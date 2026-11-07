# HIPAA readiness audit

**Date:** 2026-11-07 · **Code reviewed:** branch `claude/aba-app-v1` up to commit `04526a1` · **Data in the app:** synthetic only

This report is written for Yoma's founder and its BCBA, and is meant to be usable by a compliance consultant or a penetration tester. It describes how ready the software is to hold real patient information (PHI) under the HIPAA Security Rule, what was fixed during this audit, and what is still missing.

A note on wording: there is no such thing as "HIPAA-certified" software, and no government body approves apps. HIPAA compliance belongs to an organisation (the practice, and Yoma as its business associate), through its risk analysis, policies, signed agreements and day-to-day operation. Software can only make that easier or harder. This report says what the software does and does not support; it does not say the app is "HIPAA compliant".

## 1. Summary verdict

The application code now has most of the technical safeguards HIPAA expects: unique logins with an authenticator app, lockouts, automatic sign-out, per-practice data separation enforced by the database, an append-only audit log, and strict limits on what is sent to the AI. **It is not ready for real clients.** It still runs only on synthetic data, the AWS production environment does not exist yet, several important code gaps remain (listed in section 4), and none of the required written policies, risk analysis or business associate agreements are in place.

## 2. What is in place

The HIPAA Security Rule groups its requirements into three kinds of safeguard. This section lists what the software already does under each. "In code" means it is built and tested; it does not mean the surrounding organisation has met the requirement.

### 2.1 Administrative safeguards (45 CFR 164.308)

| Requirement | What the app does | Where |
|---|---|---|
| Information system activity review, 164.308(a)(1)(ii)(D) | Every create, read, update and delete of client data, every AI call, every sign-in event and every refused request is written to an append-only `audit_event` table. Practice admins can see their own practice's rows on the audit page. | `src/lib/db.ts`, `src/lib/audit.ts`, `src/lib/server/access-denied.ts`, `prisma/migrations/20261029034500_rls/migration.sql` |
| Workforce access, 164.308(a)(3)–(4) | Every person has a role (BCBA, BCaBA, RBT, auth coordinator, admin). One permission matrix decides what each role can do; only the BCBA can approve, sign or finalize, and only the BCBA can see restricted intake history. | `src/lib/permissions.ts`, `src/lib/sensitivity.ts` |
| Log-in monitoring, 164.308(a)(5)(ii)(C) | Failed sign-ins, lockouts, authenticator enrollments and sign-outs are audited and filed under the person's practice. | `src/lib/auth/session.ts` |
| Password management, 164.308(a)(5)(ii)(D) | Passwords are stored as salted scrypt hashes. A new member must replace the admin's temporary password with their own before setting up an authenticator. | `src/lib/auth/local.ts`, `src/app/api/auth/password/route.ts` |
| Security incident detection, 164.308(a)(6) | Blocked attempts to send PHI to the AI (`ai:privacy_blocked`), numeric-firewall rejections, lockouts, IP rate limits and `access:denied` rows give alarms something to watch. The alarms themselves are not built (section 4.2). | `src/lib/ai/index.ts`, `src/lib/auth/rate-limit.ts` |
| Business associate contracts, 164.308(b) | Not a code matter. The code does force the AI to go through AWS Bedrock (covered by the AWS BAA) in production: `DEPLOYMENT=production` refuses the direct AI API. | `src/lib/env.ts` |

### 2.2 Physical safeguards (45 CFR 164.310)

Physical safeguards are mostly about buildings, computers and storage media, so they are met by the hosting provider (AWS data centres, once the account is set up under a BAA) and by each practice's own office and device rules. The software helps in two ways:

- **Device and media controls, 164.310(d).** Uploaded filenames, which can contain a child's name, are never stored or logged; uploads keep a neutral name instead (`src/lib/upload-names.ts`). Raw VB-MAPP workbooks are not stored, only the parsed scores. Macros in `.xlsm` files are never run.
- **Until deployment, no PHI exists to protect physically.** A database constraint (`client_is_synthetic_only`) refuses any client record that is not marked synthetic, and the demo shows a synthetic-data banner.

There is no disposal feature yet (section 4.1).

### 2.3 Technical safeguards (45 CFR 164.312)

| Requirement | What the app does | Where |
|---|---|---|
| Unique user identification, 164.312(a)(2)(i) | Every person has their own account; there are no shared logins. The seed accounts (whose passwords are in the repository) cannot be created on a production deployment. | `src/lib/auth/`, `seed/synthetic/index.ts` |
| Access control and tenant separation, 164.312(a)(1) | Every table carries `org_id`, and Postgres row-level security (forced, with a runtime role that cannot bypass it) keeps each practice's data invisible to others, even if application code has a bug. | `prisma/migrations/20261029034500_rls/migration.sql`, `scripts/db-init.sql`, `tests/integration/tenancy.test.ts` |
| Automatic logoff, 164.312(a)(2)(iii) | Sessions end after 30 minutes without activity (with a two-minute warning) and after 12 hours at most. | `src/lib/auth/idle.ts`, `src/lib/auth/session.ts` |
| Encryption, 164.312(a)(2)(iv) and (e)(2)(ii) | In production the app refuses to start without verified TLS to the database. Encryption of stored data is planned through AWS (KMS on RDS and S3); it is not in place yet. | `src/lib/env.ts`, `docs/HIPAA_DEPLOYMENT.md` section 4 |
| Audit controls, 164.312(b) | See 2.1. The audit table rejects updates and deletes at the database level. Refused requests and reads made before a failed transaction are kept. Logs are scrubbed of names, dates, member IDs, phone numbers, addresses and SSNs. | `src/lib/db.ts`, `src/lib/log.ts`, `src/lib/server/console-scrub.ts` |
| Integrity, 164.312(c) | The BCBA approves each AI-drafted section one by one; export is blocked until all are approved. The AI cannot invent a number: any figure in AI text that is not a reference to a stored, sourced value blocks export. A submitted packet can no longer be changed or re-exported, and every exported PDF is stored under its own SHA-256 hash and checked on download. | `src/lib/firewall/index.ts`, `src/lib/services/packets.ts` |
| Person or entity authentication, 164.312(d) | Password plus authenticator-app code (TOTP) for everyone. Five failures lock the account, with longer lockouts each time; codes cannot be reused; sign-in is rate-limited per IP; the session token is replaced once the second factor passes. | `src/lib/auth/session.ts`, `src/lib/auth/rate-limit.ts` |
| Transmission security, 164.312(e) | Security headers on every response (content security policy, no framing, HSTS in production). The payor-website fetcher only fetches https pages on the payor's own site and refuses internal addresses. The PDF renderer has no network access and runs with JavaScript off. | `src/lib/security-headers.ts`, `src/lib/rules-watch/safe-url.ts`, `src/lib/services/packets.ts` |
| Minimum necessary, 164.502(b) | Before any AI call the client's name (including accented and hyphenated names) becomes `[Client]`; date of birth and member IDs are removed; fields tagged restricted (abuse, substance use, suicidal behaviour, custody, family psychiatric history) are never sent. A final guard refuses the call if any identifier is still present. | `src/lib/ai/index.ts`, `src/lib/privacy/names.ts`, `src/lib/privacy/dates.ts`, `src/lib/intake/derive.ts` |

## 3. What this audit fixed

Two commits on 2026-11-07, both with tests (732 unit and integration tests and 32 browser tests pass):

**`4e5a770`: sign-in hardening and upload limits**

- Account lockout after 5 wrong passwords or codes, with the same refusal message for every case, and a per-IP rate limit on sign-in.
- 30-minute idle sign-out with a warning and a "Stay signed in" button.
- Authenticator codes cannot be replayed.
- Uploaded PDFs are read in an isolated, memory-limited worker with size, page, text, decompression and time limits. Assessment PDFs over 40 pages are now refused.
- Uploaded filenames are replaced by neutral names.

**`04526a1`: fixes from the audit findings**

- **Critical, fixed:** names starting or ending in an accented letter (José, Zoë, Chloé) slipped past both the name replacement and the privacy guard, so they could have been sent to the AI.
- Payor letters lose the date of birth in any format, street address, ZIP and phone numbers before the AI sees them.
- The numeric firewall now also catches fractions, superscripts, Roman numerals, ordinals up to "hundredth", words like "dozens", and month and weekday names.
- Refused requests (401/403/404) and blocked AI calls are audited; AI-call rows record the client and a summary of which fields were sent (never their values), so a breach could be scoped.
- Audit rows are no longer lost when a request fails or when a query ran outside the audit context; the 50-id cap is gone.
- Sign-in events are filed under the person's practice; sign-out is audited.
- New members must choose their own password; an admin can no longer take over another practice's or a platform curator's account through "add member".
- Lockouts double in length each time, up to 24 hours.
- Production start-up refuses demo mode, the direct AI API, a weak session secret and an unverified database connection; the synthetic seed and sample files are refused in production.
- Submitted packets are locked; exports are versioned by hash, checked on download, and every download is audited.
- A verified VB-MAPP administration used by an exported or approved plan cannot be silently replaced.
- Security headers, a safer payor-website fetcher, and scrubbing of Next.js's own error output.

## 4. Remaining gaps

Severity: **Critical** means do not hold PHI until fixed; **High** must be fixed before the first real client; **Medium** should be fixed before or soon after launch; **Low** is hardening.

Owners: **engineering** (whoever writes the code and runs AWS), **founder** (decisions, contracts, policies), **BCBA** (clinical and workflow decisions), **consultant** (HIPAA compliance consultant or security assessor).

### 4.1 Code

| Gap | Severity | Owner | File |
|---|---|---|---|
| **AWS Bedrock AI provider is a stub.** Production cannot generate drafts until it is built and the privacy tests are re-run against it. | High | engineering | `src/lib/ai/bedrock.ts` |
| **Admin knows a working temporary password.** The admin could sign in first, choose the password and enroll their own authenticator. Needs an emailed, single-use, expiring invite link (stored hashed). | High | engineering | `src/lib/services/records.ts` |
| **No account recovery or emergency access.** A lost phone means remove-and-re-add; there is no audited MFA/password reset, no admin unlock, and no break-glass path if the practice's only BCBA is locked out. | High | engineering, founder | `src/lib/services/records.ts`, `src/lib/auth/provider.ts` |
| **Every role sees every client.** RBTs, BCaBAs and auth coordinators see all of the practice's clients with full identifiers. Needs a client-to-staff assignment table (with RLS) and enforcement of `FIELD_SENSITIVITY` per role. The BCBA needs to decide which role sees which fields. | High | engineering, BCBA | `src/lib/services/clients.ts`, `src/lib/sensitivity.ts` |
| **Approved text is filled with live values at export.** If a session or score changes after the BCBA approves a section, the PDF shows the new figure, not the one the BCBA approved. Snapshot the values at approval and block export on a difference. | High | engineering | `src/lib/services/packets.ts` |
| **No right-of-access export.** A family's request for a copy of the record (164.524, 30 days) cannot be met from the app, and an inactive client's plan cannot be exported at all. | High | engineering | `src/lib/services/packets.ts` |
| Restricted-history statement written by the BCBA is shown to every role that can read the plan or packet. | Medium | engineering, BCBA | `src/lib/services/plans.ts` |
| Authenticator secrets are stored in plain text, and the `user` and `auth_session` tables have no row-level security. Encrypt with KMS or move MFA to Cognito. | Medium | engineering | `prisma/schema.prisma` |
| Audit rows can be forged by the app's database role (any user id or time) and have no tamper evidence; org-less rows (unknown-email sign-ins, IP limits, curator changes) can be read by no one. Needs an insert trigger, a hash chain and an `aba_audit_reader` role. | Medium | engineering | `prisma/migrations/20261029034500_rls/migration.sql` |
| Approved sections, confirmed assessments and revision history are protected only in application code; the database role can still change or delete them. | Medium | engineering | `prisma/migrations/20261029034500_rls/migration.sql` |
| An exported but not yet submitted plan can be reopened and exported again (earlier PDFs are kept). Decide whether export should lock the plan behind an explicit "amend" action. | Medium | BCBA, engineering | `src/lib/services/packets.ts` |
| Bulk updates and deletes record a count but not which rows or which client. | Medium | engineering | `src/lib/db.ts` |
| Free-text intake answers and goal text go to the AI with only client and guardian names replaced; third-party names, phone numbers and schools are not scrubbed. | Medium | engineering | `src/lib/intake/derive.ts` |
| No amendment records or field history (164.526); corrections overwrite earlier values. | Medium | engineering | `src/lib/services/misc.ts` |
| No disposal: a misfiled letter, a discarded import or a discharged client's records can never be removed, and there is no retention purge. | Medium | engineering | `src/lib/services/letters.ts` |
| The sign-in rate limiter is in memory; with more than one app server it needs a shared store (or the WAF rule), and `TRUSTED_PROXY_COUNT` must match the real proxy chain. | Medium | engineering | `src/lib/auth/rate-limit.ts` |
| Records loaded through a nested include are logged only under the parent record. | Low | engineering | `src/lib/db.ts` |
| Session id is recorded only on sign-in and sign-out rows; no IP or browser hash on audit rows. | Low | engineering | `src/lib/auth/session.ts` |
| Clinical records are hard-deleted with no copy of what was removed. | Low | engineering | `src/lib/services/records.ts` |
| Content security policy still allows inline scripts (no nonce). | Low | engineering | `src/lib/security-headers.ts` |
| The PDF renderer's Chromium sandbox is off. | Low | engineering | `src/lib/services/packets.ts` |
| The payor-website fetcher does not pin the checked IP address (DNS rebinding). | Low | engineering | `src/lib/rules-watch/fetch.ts` |

### 4.2 Infrastructure (AWS)

None of the production environment exists yet. The full list, in order, is [`docs/HIPAA_DEPLOYMENT.md`](HIPAA_DEPLOYMENT.md) sections 1–8; the most important items:

| Gap | Severity | Owner |
|---|---|---|
| Sign the AWS BAA; dedicated PHI account; only HIPAA-eligible services and approved regions. | Critical | founder, engineering |
| Encrypted RDS (KMS, TLS forced, Multi-AZ) and S3 for exports and uploads (SSE-KMS, versioning, object lock for submitted packets) in place of the local `exports/` folder. | Critical | engineering |
| Secrets (database, session secret) in Secrets Manager with rotation. | High | engineering |
| Private subnets, load balancer with TLS 1.2+, WAF with a sign-in rate rule, VPC endpoints. | High | engineering |
| CloudTrail to a separate log-archive account; database-level audit with pgaudit; daily `audit_event` export; GuardDuty, Security Hub and alarms (failed logins, 403 spikes, firewall rejections, `ai:privacy_blocked`, unusual numbers of clients read by one person). | High | engineering |
| Backups (35 days, cross-account copy) with a quarterly restore test; written RPO/RTO. | High | engineering |
| Rules-watch (payor website fetcher) moved to its own task with an egress allowlist; the web app itself gets no internet access. | Medium | engineering |
| Retention settings on logs, audit exports, S3 and backups that match the written retention schedule. | Medium | engineering, founder |

### 4.3 Policy and administrative

These are required by HIPAA regardless of how good the software is, and none exist yet.

| Gap | Severity | Owner |
|---|---|---|
| **Security risk analysis and risk management plan** (164.308(a)(1)(ii)(A)–(B)), covering Yoma's systems and AWS. This is the foundation document an auditor asks for first. | Critical | founder, consultant |
| **Business associate agreements:** with AWS (and any other vendor that will touch PHI, such as an email provider for invites), and a BAA template that Yoma signs with each practice, which also sets out who handles access, amendment and disposal requests. | Critical | founder, consultant |
| **Named security official and privacy official** (164.308(a)(2)). For a small company this can be the founder. | High | founder |
| Written policies: access control, password and MFA, workforce sanctions, device and workstation use, contingency/backup, and an evaluation schedule (164.308(a)(8)). | High | founder, consultant |
| Incident response and breach notification procedure (who decides, the four-factor risk assessment, 60-day notice). | High | founder, consultant |
| Workforce HIPAA training for everyone at Yoma with production access, recorded. | High | founder |
| Account recovery and emergency access procedure: identity check, who may approve (a Yoma operator or a second BCBA; still to decide), time-boxed access and review afterwards. | High | founder, BCBA |
| Retention schedule (at least 6 years for HIPAA documentation and audit exports; clinical records per state law and payor contracts) and disposal procedure, including how long backups keep purged data. | Medium | founder, consultant |
| Procedures for right-of-access, amendment and misdirected-PHI requests, using the in-app features once they exist. | Medium | founder, BCBA |
| Audit-log review procedure: a named reviewer, a cadence (for example weekly), the queries to run, and a record of each review. | Medium | founder |
| Quarterly access review of AWS, app accounts and practice memberships; leavers removed within 24 hours. | Medium | founder, engineering |
| Each practice's own duties (staff training, office devices, removing their own leavers) explained in onboarding material. | Low | founder, BCBA |

## 5. Before the first real client

Do not enter any real client until every item below is done. The detailed infrastructure steps are in [`docs/HIPAA_DEPLOYMENT.md`](HIPAA_DEPLOYMENT.md); its section 9 is the final gate and is repeated here only by reference.

1. All **Critical** and **High** items in section 4 above are closed (code, infrastructure and policy).
2. Every box in [`docs/HIPAA_DEPLOYMENT.md`](HIPAA_DEPLOYMENT.md) sections 1–8 is ticked and reviewed by someone other than the person who did it.
3. The risk analysis is written and accepts, in writing, any Medium or Low items still open.
4. BAAs are signed: AWS with Yoma, and Yoma with the practice.
5. A penetration test of the staging environment (with synthetic data) is done, and its findings are fixed or formally accepted ([`docs/HIPAA_DEPLOYMENT.md`](HIPAA_DEPLOYMENT.md) section 9).
6. Every payor rule the practice will rely on is verified against its source document ([`docs/HIPAA_DEPLOYMENT.md`](HIPAA_DEPLOYMENT.md) section 9).
7. The BCBA has answered the open questions this audit raised: which role sees which client fields, whether export should lock a plan, whether refusing assessment PDFs over 40 pages is acceptable, and who may run emergency access (also recorded in `docs/QUESTIONS_FOR_BCBA.md` once decided).
8. Only then, in a reviewed migration, remove the `client_is_synthetic_only` constraint and the synthetic-data banner ([`docs/HIPAA_DEPLOYMENT.md`](HIPAA_DEPLOYMENT.md) section 9).

The hosted Railway demo is for synthetic data only and must never hold PHI; Railway is not part of the production plan.
