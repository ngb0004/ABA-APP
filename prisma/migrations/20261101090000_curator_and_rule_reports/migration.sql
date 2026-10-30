-- Rule verification is Yoma's content-curation job, not the practice's: a platform-level curator flag
-- (not an org role), and problem reports from practices that curators review.

-- User: the curator flag. Only scripts/set-curator.ts changes it, connected as the table owner. The trigger
-- rejects any other role (the app's aba_app included) inserting a curator or changing the flag, so no app
-- code path can grant it. (Column grants cannot do this: Prisma writes the column's default on every insert.)
ALTER TABLE "user" ADD COLUMN "isPlatformCurator" BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION user_curator_owner_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."isPlatformCurator" IS DISTINCT FROM
       (CASE WHEN TG_OP = 'INSERT' THEN false ELSE OLD."isPlatformCurator" END)
     AND current_user <> (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID) THEN
    RAISE EXCEPTION 'isPlatformCurator can only be changed by scripts/set-curator.ts';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_curator_owner_only BEFORE INSERT OR UPDATE ON "user"
  FOR EACH ROW EXECUTE FUNCTION user_curator_owner_only();

-- CreateTable
CREATE TABLE "rule_report" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "lineageKey" TEXT NOT NULL,
    "ruleId" UUID,
    "reason" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" UUID,
    "resolution" TEXT,

    CONSTRAINT "rule_report_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "rule_report_reason_check"
      CHECK ("reason" IN ('doesnt_match_letter', 'outdated', 'wrong_for_state_plan', 'other')),
    CONSTRAINT "rule_report_note_length_check" CHECK (char_length("note") <= 1000),
    CONSTRAINT "rule_report_resolved_check"
      CHECK (("resolvedAt" IS NULL) = ("resolution" IS NULL) AND ("resolvedAt" IS NULL) = ("resolvedById" IS NULL))
);

-- CreateIndex
CREATE INDEX "rule_report_org_id_resolvedAt_createdAt_idx" ON "rule_report"("org_id", "resolvedAt", "createdAt");

-- Row-level security: a practice's reports are its own.
ALTER TABLE "rule_report" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rule_report" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "rule_report"
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- Reports are resolved, never deleted.
GRANT SELECT, INSERT, UPDATE ON "rule_report" TO aba_app;
REVOKE DELETE ON "rule_report" FROM aba_app;
