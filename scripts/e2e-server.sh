#!/usr/bin/env bash
# Builds and serves the app for Playwright against its own database (aba_e2e),
# freshly reset and seeded with synthetic data, using the deterministic mock LLM.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${1:-3100}"
DB="${E2E_DB:-aba_e2e}"
export DATABASE_URL="postgresql://aba_app:aba_app_dev@localhost:5432/$DB"
export DIRECT_DATABASE_URL="postgresql://aba_owner:aba_owner_dev@localhost:5432/$DB"
export LLM_PROVIDER=mock LLM_MODEL=mock-model SESSION_SECRET=e2e-local-session-secret-0123456789abcdef
export NEXT_DIST_DIR=.next-e2e NODE_ENV=production
# The whole suite signs in from one address, many times: the per-IP sign-in rate limit is tested in
# tests/integration/auth-hardening.test.ts, not here.
export AUTH_RATE_LIMIT_MAX=100000
bash scripts/db-up.sh
pnpm exec tsx scripts/db-reset-schema.ts
pnpm exec tsx seed/synthetic/index.ts
pnpm exec next build
exec pnpm exec next start -p "$PORT"
