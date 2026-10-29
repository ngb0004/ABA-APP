-- Row-level security, append-only audit log, and the synthetic-data guard.
-- The app connects as aba_app, which neither owns these tables nor bypasses RLS.
-- FORCE ROW LEVEL SECURITY makes the policies apply to the owner as well.

CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.current_org', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.current_user', true), '')::uuid $$;

-- Rule 1: v1.0 holds synthetic clients only.
ALTER TABLE "client" ADD CONSTRAINT client_is_synthetic_only CHECK (is_synthetic = true);

-- Standard org isolation for every org-scoped table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'client','diagnosis','client_payor','attachment','authorization','authorization_unit',
    'service_session','intake','vbmapp_import','vbmapp_administration','milestone_score',
    'payor','payor_document','payor_rule','goal_template','goal','goal_data_point',
    'goal_phase_change','plan','plan_section','plan_section_revision','payor_letter','packet'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())', t);
  END LOOP;
END $$;

-- org: visible when it is the session org or one the current user belongs to.
ALTER TABLE "org" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_self ON "org"
  USING (id = app_current_org() OR id IN (SELECT org_id FROM "membership" WHERE "userId" = app_current_user()))
  WITH CHECK (id = app_current_org());

-- membership: the session org's rows, plus the current user's own rows (needed at login).
ALTER TABLE "membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "membership" FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_isolation ON "membership"
  USING (org_id = app_current_org() OR "userId" = app_current_user())
  WITH CHECK (org_id = app_current_org());

-- audit_event: read within org; insert for the session org (or org-less auth events).
ALTER TABLE "audit_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON "audit_event" FOR SELECT USING (org_id = app_current_org());
CREATE POLICY audit_insert ON "audit_event" FOR INSERT
  WITH CHECK (org_id IS NULL OR org_id = app_current_org());

CREATE OR REPLACE FUNCTION audit_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only (% rejected)', TG_OP;
END $$;
-- Statement-level, so it fires even when RLS hides every row from the caller.
CREATE TRIGGER audit_event_no_update BEFORE UPDATE OR DELETE ON "audit_event"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_append_only();
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON "audit_event"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_append_only();

-- Privileges for the application role.
GRANT USAGE ON SCHEMA public TO aba_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aba_app;
REVOKE ALL ON "_prisma_migrations" FROM aba_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_event" FROM aba_app;
ALTER DEFAULT PRIVILEGES FOR ROLE aba_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aba_app;
