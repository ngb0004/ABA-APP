#!/usr/bin/env bash
# Builds and serves the app for Playwright against its own database (aba_e2e),
# freshly reset and seeded with synthetic data, using the deterministic mock LLM.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${1:-3100}"
DB="${E2E_DB:-aba_e2e}"
export DATABASE_URL="postgresql://aba_app:aba_app_dev@localhost:5432/$DB"
export DIRECT_DATABASE_URL="postgresql://aba_owner:aba_owner_dev@localhost:5432/$DB"
export LLM_PROVIDER=mock LLM_MODEL=mock-model SESSION_SECRET=e2e-secret-not-for-production
export NEXT_DIST_DIR=.next-e2e NODE_ENV=production
bash scripts/db-up.sh
pnpm exec tsx scripts/db-reset-schema.ts
pnpm exec tsx seed/synthetic/index.ts
pnpm exec next build
exec pnpm exec next start -p "$PORT"
