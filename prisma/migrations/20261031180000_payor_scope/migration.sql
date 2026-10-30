-- Payor rules are scoped by state and plan type: Medicaid is state-run, BCBS companies are
-- separate per state, and state autism mandates bind fully insured commercial plans only.
-- These are new columns on tables that already carry org_id and RLS (see *_rls), so no new policies.

-- Payor: the states its rules apply in (empty = every state) and its line of business.
ALTER TABLE "payor" ADD COLUMN "states" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "payor" ADD COLUMN "lineOfBusiness" TEXT NOT NULL DEFAULT 'other';
ALTER TABLE "payor" ADD CONSTRAINT "payor_line_of_business_check"
  CHECK ("lineOfBusiness" IN ('medicaid', 'medicaid_managed_care', 'commercial', 'tricare', 'other'));
ALTER TABLE "payor" ADD CONSTRAINT "payor_states_check"
  CHECK ("states" <@ ARRAY['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS',
    'KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR',
    'PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','PR','GU','VI','AS','MP']::TEXT[]);

-- Payor rule: the plan types it is limited to (empty = every plan type).
ALTER TABLE "payor_rule" ADD COLUMN "planTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "payor_rule" ADD CONSTRAINT "payor_rule_plan_types_check"
  CHECK ("planTypes" <@ ARRAY['medicaid','medicaid_managed_care','commercial_fully_insured',
    'commercial_self_funded','tricare']::TEXT[]);

-- Client insurance: what kind of plan it is, and the state it was issued in (null = service state).
ALTER TABLE "client_payor" ADD COLUMN "planType" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "client_payor" ADD COLUMN "planState" TEXT;
ALTER TABLE "client_payor" ADD CONSTRAINT "client_payor_plan_type_check"
  CHECK ("planType" IN ('medicaid', 'medicaid_managed_care', 'commercial_fully_insured',
    'commercial_self_funded', 'commercial_unknown', 'tricare', 'unknown'));
ALTER TABLE "client_payor" ADD CONSTRAINT "client_payor_plan_state_check"
  CHECK ("planState" IS NULL OR "planState" ~ '^[A-Z]{2}$');
