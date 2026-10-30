-- The assessments a plan uses, and sections flagged for a redraft when they change.
-- Both live on tables that already have org_id, row-level security, and grants (plan,
-- plan_section); no new table, so no new policy.

ALTER TABLE "plan" ADD COLUMN "assessmentIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
ALTER TABLE "plan_section" ADD COLUMN "redraftReason" TEXT;
ALTER TABLE "plan_section" ADD CONSTRAINT "plan_section_redraft_reason_length_check"
  CHECK ("redraftReason" IS NULL OR char_length("redraftReason") <= 300);

-- Existing plans get the default selection (src/lib/assessments/plan.ts): every confirmed
-- assessment of the client administered within twelve months before the plan was created, or
-- since the start of the plan's authorization when that is earlier.
UPDATE "plan" p SET "assessmentIds" = COALESCE((
  SELECT array_agg(a."id" ORDER BY a."administeredOn", a."id")
  FROM "assessment" a
  LEFT JOIN "authorization" au ON au."id" = p."authorizationId"
  WHERE a."clientId" = p."clientId"
    AND a."org_id" = p."org_id"
    AND a."status" = 'confirmed'
    AND a."administeredOn" >= LEAST(
      (p."createdAt" - INTERVAL '12 months')::date,
      COALESCE(au."startDate"::date, (p."createdAt" - INTERVAL '12 months')::date))
), ARRAY[]::UUID[]);
