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
- [ ] Require TOTP MFA for every user; password policy of at least 12 characters; account lockout and advanced security (compromised-credential detection).
- [ ] Add TOTP replay protection (reject a code already used in its time step); the local provider does not.
- [ ] Session lifetime of 12 hours or less, with an idle timeout of 15 to 30 minutes; secure, HttpOnly, SameSite cookies over HTTPS only.
- [ ] Map Cognito groups to `membership.role`; keep the permission matrix in `src/lib/permissions.ts` the single source of truth.

## 4. Data stores and encryption
- [ ] RDS for PostgreSQL 16, Multi-AZ, storage encrypted with a customer-managed KMS key; TLS required (`rds.force_ssl=1`), and `sslmode=verify-full` in `DATABASE_URL`.
- [ ] Two database roles exactly as local: `aba_owner` (migrations only, from CI) and `aba_app` (runtime, `NOBYPASSRLS`, not the table owner). Keep `FORCE ROW LEVEL SECURITY`.
- [ ] Credentials in AWS Secrets Manager with rotation; nothing in environment files or images.
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
