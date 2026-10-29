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
-- The owner runs migrations only; BYPASSRLS lets narrow SECURITY DEFINER helpers (app_org_ids) work.
ALTER ROLE aba_owner BYPASSRLS;
GRANT CONNECT ON DATABASE aba TO aba_app;
GRANT CONNECT ON DATABASE aba_e2e TO aba_app;
GRANT CONNECT ON DATABASE aba_test TO aba_app;
