# CLAUDE.md: ABA Treatment Plan & Reauth Assistant (v1.0 baseline)

## What this is
A HIPAA-ready web app for BCBAs (Board Certified Behavior Analysts). It turns assessment scores, parent intake answers, and payor rules into ABA treatment plans and reauthorization packets. The AI drafts paragraphs and the BCBA reviews and approves them. The target is to cut a 4–6 hour write-up to roughly 30 minutes of generation plus 30–60 minutes of review.

- Full product spec: `docs/SPEC.md`. Read it before starting a phase.
- Build order and acceptance criteria: `docs/BUILD_PLAN.md`. Work one phase at a time, top to bottom.
- VB-MAPP Excel layout: `docs/VBMAPP_WORKBOOK_MAP.md`
- Goal structure: `docs/GOAL_FORMAT.md`. Content reference: `docs/reference/GOAL_BANK.md`
- Payor rules seed: `seed/payors.yaml`

## Non-negotiable rules
1. **No real patient data, ever.** v1.0 runs locally on synthetic data only. Every client record has `is_synthetic = true`. Never add a code path, fixture, log, or test that would accept real PHI before the HIPAA deployment phase. If a file looks like it contains a real person's name, DOB, or member ID, stop and ask.
2. **The AI never creates a number.** Every figure in a generated document (scores, hours, units, percentages, dates, counts) must come from a stored, sourced value. Implement the "numeric firewall" described in `docs/BUILD_PLAN.md` Phase 8: AI text may contain only `{{token}}` references to sourced values. Any raw digit in AI output fails validation and blocks export. Enforce this in code, not just in the prompt.
3. **The BCBA approves every AI-drafted section individually.** Section states are `draft → edited → approved`. Don't build an "approve all" control. Export is blocked until every section is approved and the pre-submission audit passes.
4. **Everything is audit-logged.** There's an append-only `audit_event` table covering who did what to which record and when, including every AI call (prompt hash, model, section, user). Store no PHI in application logs or error messages.
5. **Multi-tenant from day one.** Every table carries `org_id`. Isolation is enforced with Postgres row-level security keyed on the session's org, not just WHERE clauses. A solo BCBA is an org of one.
6. **Minimum necessary for AI calls.** Replace the client's name with `[Client]` before any AI call, and drop DOB and member IDs entirely. Fields tagged `sensitivity: restricted` in the intake schema (abuse, substance use, suicidal behavior, custody/legal, family psychiatric history) are **never** sent to the AI. The BCBA writes those statements, or the AI receives only a boolean.
7. **Payor rules are data, not code.** Every rule records its source (document, version, section) and a `verified` flag. Unverified rules show as warnings, never hard blocks. Never hard-code a payor's requirement in application logic.
8. **Never execute macros.** `.xlsm` uploads are read as data only.
9. **Don't copy third-party clinical content.** Don't reproduce VB-MAPP protocol text or assessment item wording. Store scores, domain names, and milestone numbers only. Draw our own grid.
10. **No employer-derived material.** Don't use another practice's templates, form wording, company names, NPIs, tax IDs, or internal document names. Practice-specific details (NPI, tax ID, addresses, form names, internal policies) are per-org settings. Sample data uses fictional practices only.

## Stack (decided; don't re-litigate)
- TypeScript everywhere, with pnpm
- Next.js (App Router) for the web app and API routes
- PostgreSQL 16 via `docker compose`, and Prisma for schema and migrations. RLS policies go in raw SQL migrations.
- Auth: email + password + TOTP MFA (`otplib`). Put it behind an `AuthProvider` interface so AWS Cognito can replace it later.
- AI: an `LlmProvider` interface with two implementations:
  - `AnthropicProvider` (direct API, local dev, synthetic data only). Model from env `LLM_MODEL`.
  - `BedrockProvider` (stub now; used once AWS and a BAA are in place).

  All AI calls go through one module that applies pseudonymization, the restricted-field filter, the numeric firewall, and audit logging.
- Excel parsing: SheetJS (`xlsx`), reading both cell values and formulas
- PDF: HTML → PDF with Playwright (Chromium is available). Charts and grids are server-rendered SVG.
- Tests: Vitest for unit and integration, Playwright for end-to-end
- Validation: Zod schemas at every boundary

## Commands (keep these working)
- `pnpm dev`: run the app
- `pnpm db:up` / `pnpm db:reset`: start the database, or reset it and reseed synthetic data
- `pnpm test`: unit and integration tests. `pnpm test:e2e`: end-to-end tests.
- `pnpm lint` and `pnpm typecheck` must pass before any phase is called done.

## Working style
- Finish a phase completely (code, tests, and passing acceptance criteria) before starting the next. Update the checklist in `docs/BUILD_PLAN.md` as you go.
- Write tests first for anything that computes a number: score totals, units, utilization, supervision ratios.
- Any open clinical question goes in `docs/QUESTIONS_FOR_BCBA.md`. Pick the safest default and keep going.
- Keep UI plain and functional for v1.0. Correctness first, polish later.
