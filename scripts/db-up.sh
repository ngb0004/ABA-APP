#!/usr/bin/env bash
# Start Postgres 16. Uses docker compose when a Docker daemon is reachable;
# otherwise falls back to a locally installed Postgres 16 cluster.
set -euo pipefail
cd "$(dirname "$0")/.."
if docker info >/dev/null 2>&1; then
  docker compose up -d --wait db
  docker compose exec -T db psql -U postgres -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/00-init.sql >/dev/null
else
  echo "Docker daemon not reachable; using local Postgres 16."
  if ! pg_isready -q -h localhost; then
    (service postgresql start || pg_ctlcluster 16 main start) >/dev/null
  fi
  for _ in $(seq 1 30); do pg_isready -q -h localhost && break; sleep 1; done
  if [ "$(id -u)" = "0" ]; then
    su postgres -c "psql -q -v ON_ERROR_STOP=1 -f -" < scripts/db-init.sql >/dev/null
  else
    psql -q -v ON_ERROR_STOP=1 -h localhost -U postgres -f scripts/db-init.sql >/dev/null
  fi
fi
echo "Postgres is up."
