# HIPAA deployment checklist (AWS)

v1.0 runs locally on synthetic data only. **Nothing here is deployed.** This is the checklist to complete, in order, before the app may hold real PHI. Until every item is done and reviewed, keep the `client_is_synthetic_only` database constraint and the synthetic-data banner in place.

## 1. Agreements and accounts
- [ ] Sign the AWS Business Associate Addendum (AWS Artifact) for the production account.
- [ ] Use a dedicated AWS Organization account for PHI workloads; enable SCPs that deny non-HIPAA-eligible services and regions outside the approved list.
- [ ] Confirm every service used is on the AWS HIPAA Eligible Services list.
- [ ] Confirm the model provider terms: Claude on Amazon Bedrock under the AWS BAA. The direct Anthropic API (`AnthropicProvider`) is for synthetic local development only; production requires `LLM_PROVIDER=bedrock`.

## 2. AI provider (Bedrock)
- [ ] Implement `BedrockProvider` (`src/lib/ai/bedrock.ts`) with the Bedrock Mantle client (`@anthropic-ai/bedrock-sdk`) and the `anthropic.`-prefixed model ID; IAM role with `bedrock:InvokeModel` scoped to that model only.
- [ ] Turn off Bedrock model-invocation logging to S3/CloudWatch, or point it at an encrypted, access-restricted bucket covered by the retention policy.
- [ ] Keep the single AI module as the only path to the model: pseudonymization, restricted-field filter, privacy guard, numeric firewall, audit of every call. Add a CI check that nothing else imports a provider.
- [ ] Re-run the AI privacy tests (`tests/integration/plan.test.ts`, `letters-export.test.ts`) against the Bedrock provider in a staging account with synthetic data.

## 3. Identity (Cognito)
- [ ] Implement `CognitoAuthProvider` behind the existing `AuthProvider` interface (`src/lib/auth/provider.ts`).
- [ ] Require TOTP MFA for every user; password policy of at least 12 characters; advanced security (compromised-credential detection). Keep Cognito's own lockout on, or keep the app's.
- [x] Account lockout (in code): wrong passwords and wrong or replayed codes share one per-account counter; 5 in a row lock the account for 15 minutes (`AUTH_MAX_FAILED_ATTEMPTS`, `AUTH_LOCKOUT_MINUTES`), with one generic message for every refusal and `auth:lockout` audit rows. Sign-in endpoints are also rate-limited per client IP (`AUTH_RATE_LIMIT_*`, in memory). Before running more than one app instance: set `TRUSTED_PROXY_COUNT` to the real proxy hops (ALB: 1; CloudFront + ALB: 2) and move the limiter to a shared store, or rely on the WAF rate rule in section 5.
- [x] TOTP replay protection (in code): a code whose time step was already used for that user is refused, at sign-in and at authenticator setup (`user.lastTotpStep`). Confirm a `CognitoAuthProvider` keeps this (Cognito rejects reused codes; test it).
- [x] Session lifetime of 12 hours or less (`SESSION_HOURS`, capped at 12) and an idle timeout of 30 minutes (`SESSION_IDLE_MINUTES`, 1 to 30; activity rules in `src/lib/auth/idle.ts`), with a sign-out warning in the UI. HttpOnly, SameSite=Lax cookies, Secure in production.
- [ ] Cookies over HTTPS only in the deployed environment (HSTS, section 5); review the idle timeout value with the practice's security officer (15 to 30 minutes).
- [ ] Map Cognito groups to `membership.role`; keep the permission matrix in `src/lib/permissions.ts` the single source of truth.

## 4. Data stores and encryption
- [ ] RDS for PostgreSQL 16, Multi-AZ, storage encrypted with a customer-managed KMS key; TLS required (`rds.force_ssl=1`), and `sslmode=verify-full` in `DATABASE_URL`.
- [ ] Two database roles exactly as local: `aba_owner` (migrations only, from CI) and `aba_app` (runtime, `NOBYPASSRLS`, not the table owner). Keep `FORCE ROW LEVEL SECURITY`.
- [ ] Credentials in AWS Secrets Manager with rotation; nothing in environment files or images.
- [x] Uploaded filenames are never stored or logged (they can hold a child's name): uploads keep a neutral name such as "VB-MAPP workbook (.xlsm), uploaded 2026-11-07".
- [x] Untrusted PDFs (score files, payor letters, payor documents) are read in a memory-limited worker thread with size, page, text, unpacked-size, and time limits (`src/lib/pdf/guard.ts`). Give the container enough memory for two concurrent readers (512 MB heap each for payor documents) plus the app.
- [ ] Exported PDFs and uploaded letters/workbooks: S3 with SSE-KMS, Block Public Access, bucket policy requiring TLS, versioning, and object lock for submitted packets. Replace the local `exports/` directory.
- [ ] Do not store raw VB-MAPP workbooks (v1.0 stores parsed scores only; keep it that way) or, if required, store them encrypted with a short retention.

## 5. Network
- [ ] App in private subnets (ECS Fargate or App Runner with VPC connector) behind an ALB with an ACM certificate; TLS 1.2+ only; HSTS.
- [ ] RDS reachable only from the app security group. VPC endpoints for S3, Secrets Manager, KMS, Bedrock, CloudWatch.
- [ ] AWS WAF on the ALB (managed core rules, rate limiting on `/api/auth/*`).
- [ ] Headless Chromium (PDF export) runs with network access blocked (already enforced in code with `page.route("**/*", abort)`).

## 6. Logging, monitoring, audit
- [ ] CloudTrail (all regions, management and S3 data events) to a separate log-archive account with object lock.
- [ ] Application logs to CloudWatch through `src/lib/log.ts` only (scrubs member IDs, dates, emails, and names). Keep the `no-console` lint rule and the log-scan test (`tests/integration/log-scrub.test.ts`) in CI.
- [ ] The `audit_event` table stays append-only (statement-level trigger plus revoked UPDATE/DELETE). Export it daily to the log-archive account; define who reviews it and how often.
- [ ] GuardDuty, Security Hub (HIPAA conformance pack in AWS Config), and alarms on failed logins, 403 spikes, and AI firewall rejections.

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
