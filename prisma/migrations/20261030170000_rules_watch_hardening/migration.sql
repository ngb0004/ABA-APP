-- Rules Watch hardening.

-- Evidence is append-only at the privilege level too (default privileges had granted UPDATE/DELETE).
REVOKE UPDATE, DELETE, TRUNCATE ON "rule_evidence" FROM aba_app;

-- Scheduled jobs list org ids through app_org_ids(). Instead of letting the owner bypass RLS
-- (which would weaken FORCE ROW LEVEL SECURITY on every table), a NOLOGIN role owns the function
-- and may read org rows through one narrow policy. The bootstrap scripts create the role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aba_org_lister') THEN
    GRANT USAGE ON SCHEMA public TO aba_org_lister;
    GRANT SELECT ON "org" TO aba_org_lister;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'org' AND policyname = 'org_list_ids') THEN
      CREATE POLICY org_list_ids ON "org" FOR SELECT TO aba_org_lister USING (true);
    END IF;
    -- Owning a function needs CREATE on its schema at transfer time only; revoke it right after.
    GRANT CREATE ON SCHEMA public TO aba_org_lister;
    ALTER FUNCTION app_org_ids() OWNER TO aba_org_lister;
    REVOKE CREATE ON SCHEMA public FROM aba_org_lister;
  ELSE
    RAISE WARNING 'Role aba_org_lister is missing: scheduled jobs will see no orgs until the bootstrap script creates it';
  END IF;
END $$;
