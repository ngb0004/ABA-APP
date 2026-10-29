# ABA Plan Assistant (v1.0, synthetic data only)

A web app for BCBAs that turns VB-MAPP scores, parent intake answers, and payor rules into ABA treatment plans and reauthorization packets. The AI drafts sections; the BCBA edits and approves each one. Built from the brief in `docs/` (see `CLAUDE.md` for the non-negotiable rules).

> **Synthetic data only.** v1.0 runs locally. The database rejects any client that is not `is_synthetic = true`. See `docs/HIPAA_DEPLOYMENT.md` before any real use.

## Quick start

Requirements: Node 22, pnpm 10, and PostgreSQL 16 (via Docker, or installed locally).

```bash
pnpm install
cp .env.example .env
pnpm db:reset      # starts Postgres, applies migrations (incl. RLS), seeds 3 synthetic clients
pnpm dev           # http://localhost:3000
```

`pnpm db:up` uses `docker compose` when a Docker daemon is available and otherwise starts a local Postgres 16 cluster. It creates two roles: `aba_owner` (migrations) and `aba_app` (the app; cannot bypass row-level security).

Sign in with a demo account (password `synthetic-demo-only` for all), then enter the code from `pnpm totp <email>`:

| Role                         | Email                              |
| ---------------------------- | ---------------------------------- |
| BCBA                         | `bcba@sample-practice.test`        |
| RBT                          | `rbt@sample-practice.test`         |
| Auth coordinator             | `coordinator@sample-practice.test` |
| Parent                       | `parent@sample-practice.test`      |
| BCBA, second org (isolation) | `bcba@other-practice.test`         |

The AI runs on a deterministic mock by default (`LLM_PROVIDER=mock`). To draft with Claude on synthetic data, set `LLM_PROVIDER=anthropic`, `LLM_MODEL`, and `ANTHROPIC_API_KEY` in `.env`.

## Hosted demo

To put the fictional-client demo online (e.g., to try it from a phone), follow `docs/DEMO_DEPLOY.md`. Demo mode requires a private password, has each user set up an authenticator app on first sign-in, and only accepts the bundled sample files as uploads.

## Commands

| Command                        | What it does                                                       |
| ------------------------------ | ------------------------------------------------------------------ |
| `pnpm dev`                     | Run the app                                                        |
| `pnpm db:up` / `pnpm db:reset` | Start the database / reset and reseed synthetic data               |
| `pnpm test`                    | Unit and integration tests (uses the separate `aba_test` database) |
| `pnpm test:e2e`                | Playwright end-to-end tests (builds and serves against `aba_e2e`)  |
| `pnpm lint` / `pnpm typecheck` | Must pass before a phase is done                                   |
| `pnpm totp [email]`            | Current TOTP code for a demo user                                  |

## How it fits together

- `src/lib/db.ts`: every client-data query runs inside `withOrg()`, which sets `app.current_org` for Postgres RLS and writes an audit row for each read and write.
- `src/lib/vbmapp/`: Milestones Grid import (SheetJS, data only, never macros); totals always recomputed; validation flags; carry-forward; our own SVG grid.
- `src/lib/payors/`: payor rules as data (`seed/payors.yaml`), one evaluator per rule type; unverified rules can only warn.
- `src/lib/intake/`: typed intake schema with sensitivity tags, safety flags, custody signers, availability fit, and the minimum-necessary AI payload.
- `src/lib/firewall/` and `src/lib/ai/`: the numeric firewall and the single AI module (pseudonymize, filter restricted fields, privacy guard, validate, retry once, audit).
- `src/lib/plan/`: sections, sourced values, graphs, progress checks, and the pre-submission audit.
- `src/lib/services/`: the operations behind the UI and API routes, each with a permission check.

Open clinical questions and the defaults chosen: `docs/QUESTIONS_FOR_BCBA.md`. Build status: `docs/BUILD_PLAN.md`. Where the product goes next: `docs/ROADMAP.md`.
