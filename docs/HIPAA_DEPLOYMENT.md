# HIPAA deployment checklist (AWS)

v1.0 runs locally on synthetic data only. **Nothing here is deployed.** This is the checklist to complete, in order, before the app may hold real PHI. Until every item is done and reviewed, keep the `client_is_synthetic_only` database constraint and the synthetic-data banner in place.

## 1. Agreements and accounts
- [ ] Sign the AWS Business Associate Addendum (AWS Artifact) for the production account.
- [ ] Use a dedicated AWS Organization account for PHI workloads; enable SCPs that deny non-HIPAA-eligible services and regions outside the approved list.
- [ ] Confirm every service used is on the AWS HIPAA Eligible Services list.
- [ ] Confirm the model provider terms: Claude on Amazon Bedrock under the AWS BAA. The direct Anthropic API (`AnthropicProvider`) is for synthetic local development only; production requires `LLM_PROVIDER=bedrock`.
- [x] Set `DEPLOYMENT=production` on every PHI deployment. At start-up (`src/instrumentation.ts`, `src/lib/env.ts`) the app then refuses: `DEMO_MODE=true`, `LLM_PROVIDER=anthropic`, a `SESSION_SECRET` under 32 characters or the repo placeholder (also refused whenever `NODE_ENV=production`), and a `DATABASE_URL` without verified TLS (section 4). Bundled sample files cannot be imported, and the synthetic seed refuses to run.
- [ ] Never run `pnpm db:seed` against RDS: its accounts' passwords and authenticator secrets are in this repository. The seed refuses a non-local database outside the hosted demo unless `ALLOW_SYNTHETIC_SEED=1`, and always under `DEPLOYMENT=production`; also keep the seed out of the production task definition (CI check).

## 2. AI provider (Bedrock)
- [ ] Implement `BedrockProvider` (`src/lib/ai/bedrock.ts`) with the Bedrock Mantle client (`@anthropic-ai/bedrock-sdk`) and the `anthropic.`-prefixed model ID; IAM role with `bedrock:InvokeModel` scoped to that model only.
- [ ] Turn off Bedrock model-invocation logging to S3/CloudWatch, or point it at an encrypted, access-restricted bucket covered by the retention policy.
- [ ] Keep the single AI module as the only path to the model: pseudonymization, restricted-field filter, privacy guard, numeric firewall, audit of every call. Add a CI check that nothing else imports a provider.
- [ ] Re-run the AI privacy tests (`tests/integration/plan.test.ts`, `letters-export.test.ts`) against the Bedrock provider in a staging account with synthetic data.

## 3. Identity (Cognito)
- [ ] Implement `CognitoAuthProvider` behind the existing `AuthProvider` interface (`src/lib/auth/provider.ts`).
- [ ] Require TOTP MFA for every user; password policy of at least 12 characters; advanced security (compromised-credential detection). Keep Cognito's own lockout on, or keep the app's.
- [x] Account lockout (in code): wrong passwords and wrong or replayed codes share one per-account counter; 5 in a row lock the account for 15 minutes (`AUTH_MAX_FAILED_ATTEMPTS`, `AUTH_LOCKOUT_MINUTES`), doubling with each further lockout before a successful sign-in (capped at 24 hours), with one generic message for every refusal and `auth:lockout` audit rows filed under the person's practice (visible on its audit page). Sign-in endpoints are also rate-limited per client IP (`AUTH_RATE_LIMIT_*`, in memory). Before running more than one app instance: set `TRUSTED_PROXY_COUNT` to the real proxy hops (ALB: 1; CloudFront + ALB: 2) and move the limiter to a shared store, or rely on the WAF rate rule in section 5.
- [x] TOTP replay protection (in code): a code whose time step was already used for that user is refused, at sign-in and at authenticator setup (`user.lastTotpStep`). Confirm a `CognitoAuthProvider` keeps this (Cognito rejects reused codes; test it).
- [x] Session lifetime of 12 hours or less (`SESSION_HOURS`, capped at 12) and an idle timeout of 30 minutes (`SESSION_IDLE_MINUTES`, 1 to 30; activity rules in `src/lib/auth/idle.ts`), with a sign-out warning in the UI. HttpOnly, SameSite=Lax cookies, Secure in production.
- [ ] Cookies over HTTPS only in the deployed environment (HSTS, section 5); review the idle timeout value with the practice's security officer (15 to 30 minutes).
- [ ] Map Cognito groups to `membership.role`; keep the permission matrix in `src/lib/permissions.ts` the single source of truth.
- [x] New members (in code): the admin's temporary password only lets the person choose their own (`user.mustChangePassword`, `auth:password_set`); no authenticator can be set up until then, and other sign-ins with the temporary password end. Cognito keeps this with `AdminCreateUser` (FORCE_CHANGE_PASSWORD). `addMember` never re-keys an account another practice removed, or a platform curator's, and answers the same for any email it cannot add.
- [ ] Replace admin-typed temporary passwords with an emailed, single-use, expiring invite token (stored hashed), so the admin never knows a working credential. Until then the admin can still sign in first with the temporary password; review `auth:password_set` / `auth:mfa_enrolled` rows for new members.
- [ ] Account recovery and emergency access: an audited, owner-run script (like `scripts/set-curator.ts`) or second-BCBA-approved action that resets a member's authenticator and password through the invite flow, an admin unlock, and a written emergency-access procedure (who may invoke it, identity check, time-boxed session, review of the audit rows afterwards).
- [x] The session token is replaced when MFA passes (the pre-MFA token never becomes a full session); sign-out is audited (`auth:logout`) and origin-checked.

## 4. Data stores and encryption
- [ ] RDS for PostgreSQL 16, Multi-AZ, storage encrypted with a customer-managed KMS key; TLS required (`rds.force_ssl=1`). Prisma 6 does not understand `sslmode=verify-full` (it silently falls back to `prefer` without checking the certificate): use `sslmode=require&sslaccept=strict&sslcert=/app/certs/rds-global-bundle.pem` in `DATABASE_URL` and copy the RDS global CA bundle into the image. The app refuses to start under `DEPLOYMENT=production` without these.
- [ ] Encrypt `user.totpSecret` and `auth_session.pendingTotpSecret` with a KMS data key (envelope encryption), or drop them once `CognitoAuthProvider` holds the second factor; add RLS (or a SECURITY DEFINER auth function) so the app role cannot read every tenant's credential columns.
- [ ] Two database roles exactly as local: `aba_owner` (migrations only, from CI) and `aba_app` (runtime, `NOBYPASSRLS`, not the table owner). Keep `FORCE ROW LEVEL SECURITY`.
- [ ] Credentials in AWS Secrets Manager with rotation; nothing in environment files or images.
- [x] Uploaded filenames are never stored or logged (they can hold a child's name): uploads keep a neutral name such as "VB-MAPP workbook (.xlsm), uploaded 2026-11-07".
- [x] Untrusted PDFs (score files, payor letters, payor documents) are read in a memory-limited worker thread with size, page, text, unpacked-size, and time limits (`src/lib/pdf/guard.ts`). Give the container enough memory for two concurrent readers (512 MB heap each for payor documents) plus the app.
- [ ] Exported PDFs and uploaded letters/workbooks: S3 with SSE-KMS, Block Public Access, bucket policy requiring TLS, versioning, and object lock for submitted packets. Replace the local `exports/` directory. (In code already: each export is stored under its own name, plan id plus SHA-256, and never overwritten; it is written only after the export commits; a re-download is checked against the recorded hash (`packet:integrity_failed` otherwise) and audited as `packet:download`; a submitted packet cannot be re-exported and its sections cannot change.)
- [ ] Do not store raw VB-MAPP workbooks (v1.0 stores parsed scores only; keep it that way) or, if required, store them encrypted with a short retention.

## 5. Network
- [ ] App in private subnets (ECS Fargate or App Runner with VPC connector) behind an ALB with an ACM certificate; TLS 1.2+ only; HSTS.
- [ ] RDS reachable only from the app security group. VPC endpoints for S3, Secrets Manager, KMS, Bedrock, CloudWatch.
- [ ] AWS WAF on the ALB (managed core rules, rate limiting on `/api/auth/*`).
- [ ] Headless Chromium (PDF export) runs with network access blocked and JavaScript off (already enforced in code with `page.route("**/*", abort)` and `javaScriptEnabled: false`). Still to do: run it with the Chromium sandbox on (a seccomp profile that allows it) or in a separate low-privilege worker without database credentials.
- [x] Security headers on every response (`src/lib/security-headers.ts`): CSP with `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`; nosniff; `Referrer-Policy: no-referrer`; HSTS in production. Still to do: a nonce-based `script-src` instead of `'unsafe-inline'`.
- [x] The rules-watch fetcher (`src/lib/rules-watch/safe-url.ts`) fetches https only, follows at most 5 redirects by hand, stays on the seed URL's site, and refuses private, loopback and link-local addresses (by name and by DNS answer). Still to do: pin the checked address in an undici connect hook (DNS rebinding), and an egress allowlist for the task.

## 6. Logging, monitoring, audit
- [ ] CloudTrail (all regions, management and S3 data events) to a separate log-archive account with object lock.
- [ ] Application logs to CloudWatch through `src/lib/log.ts` only (scrubs member IDs, dates, emails, phone numbers, SSNs, street addresses, ZIPs, and client, preferred and guardian names). Next.js's own console output is scrubbed too (`src/lib/server/console-scrub.ts`), and page errors are logged as name, digest and route (`onRequestError`). Keep the `no-console` lint rule, the raw-SQL lint rule (raw queries bypass the audit), and the log-scan test (`tests/integration/log-scrub.test.ts`) in CI.
- [x] Refused requests are audited (in code): every 401/403/404 from an API route logs a scrubbed `Access denied` line, and with a signed-in person writes an `access:denied` row (route pattern, target ids, permission, role); page permission refusals the same. Reads and attempted writes made before a failure are kept (`rolledBack` rows), automatic rows record the full row count and every id, and AI privacy-guard trips are audited as `ai:privacy_blocked`. AI-call rows carry the client id and a PHI-free payload manifest (keys, intake field ids, text length).
- [ ] The `audit_event` table stays append-only (statement-level trigger plus revoked UPDATE/DELETE). Export it daily to the log-archive account; define who reviews it and how often.
- [ ] GuardDuty, Security Hub (HIPAA conformance pack in AWS Config), and alarms on failed logins, `Access denied` log lines (403 spikes), AI firewall rejections, and `ai:privacy_blocked` rows.
- [ ] Platform-level review of org-less audit rows (unknown-email sign-ins, IP rate limits, curator grants): a NOLOGIN `aba_audit_reader` role with a narrow SELECT policy for the daily export.
- [ ] Tamper evidence for `audit_event`: a BEFORE INSERT trigger forcing `createdAt` to the server clock and `userId` to `app.current_user`, a per-org hash chain whose head goes into the daily export, and a CI check that fails migrations touching its triggers.

## 7. Backups and recovery
- [ ] RDS automated backups (35 days) plus AWS Backup cross-account copies, encrypted with KMS.
- [ ] Documented RPO/RTO; restore test at least quarterly, recorded.

## 8. Access reviews and operations
- [ ] Quarterly access review of AWS IAM, Cognito users, and org memberships; remove leavers within 24 hours.
- [ ] Break-glass procedure for production database access, logged and reviewed.
- [ ] Dependency audit (`pnpm audit`) and container image scanning in CI; patch cadence defined.
- [ ] Risk analysis and policies (Security Rule administrative safeguards) documented; workforce HIPAA training; incident response and breach notification runbook.

## 9. Before the first real client
- [ ] Every payor rule that will be relied on is verified against its cited document (Payor rules page) with the section recorded.
- [ ] Remove the synthetic-only database constraint in a reviewed migration **only after** sections 1–8 are complete and signed off.
- [ ] Penetration test of the deployed staging environment with synthetic data.
