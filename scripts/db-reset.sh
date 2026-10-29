#!/usr/bin/env bash
# Reset the local database and reseed synthetic data. Synthetic data only.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a
bash scripts/db-up.sh
pnpm exec tsx scripts/db-reset-schema.ts
pnpm exec tsx seed/synthetic/index.ts
