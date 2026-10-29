-- Idempotent bootstrap for local development (synthetic data only).
-- aba_owner owns the schema and runs migrations. aba_app is what the app uses:
-- it does not own tables and cannot bypass RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aba_owner') THEN
    CREATE ROLE aba_owner LOGIN PASSWORD 'aba_owner_dev' CREATEDB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aba_app') THEN
    CREATE ROLE aba_app LOGIN PASSWORD 'aba_app_dev' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
SELECT 'CREATE DATABASE aba OWNER aba_owner' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'aba')\gexec
SELECT 'CREATE DATABASE aba_test OWNER aba_owner' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'aba_test')\gexec
SELECT 'CREATE DATABASE aba_e2e OWNER aba_owner' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'aba_e2e')\gexec
-- The owner stays subject to RLS (FORCE ROW LEVEL SECURITY). Scheduled jobs list org ids through
-- app_org_ids(), owned by this NOLOGIN role with one narrow policy (see the rules_watch_hardening migration).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aba_org_lister') THEN
    CREATE ROLE aba_org_lister NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT aba_org_lister TO aba_owner;
ALTER ROLE aba_owner NOBYPASSRLS;
GRANT CONNECT ON DATABASE aba TO aba_app;
GRANT CONNECT ON DATABASE aba_e2e TO aba_app;
GRANT CONNECT ON DATABASE aba_test TO aba_app;
