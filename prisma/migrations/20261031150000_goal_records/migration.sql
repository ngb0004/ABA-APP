-- Goal records carry the dates, status, locked baseline, barriers, and settings payors ask for.
ALTER TABLE "goal" ADD COLUMN "introducedAt" DATE;
ALTER TABLE "goal" ADD COLUMN "projectedMasteryDate" DATE;
ALTER TABLE "goal" ADD COLUMN "progressStatus" TEXT NOT NULL DEFAULT 'in_progress';
ALTER TABLE "goal" ADD COLUMN "baselineValue" DOUBLE PRECISION;
ALTER TABLE "goal" ADD COLUMN "baselineDate" DATE;
ALTER TABLE "goal" ADD COLUMN "baselineLockedAt" TIMESTAMP(3);
ALTER TABLE "goal" ADD COLUMN "baselineLockedById" UUID;
ALTER TABLE "goal" ADD COLUMN "barriers" TEXT NOT NULL DEFAULT '';
ALTER TABLE "goal" ADD COLUMN "settings" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "goal" ADD CONSTRAINT "goal_progress_status_check"
  CHECK ("progressStatus" IN ('new', 'in_progress', 'mastered', 'on_hold', 'discontinued'));
ALTER TABLE "goal" ADD CONSTRAINT "goal_baseline_complete_check"
  CHECK (("baselineLockedAt" IS NULL) = ("baselineValue" IS NULL) AND ("baselineLockedAt" IS NULL) = ("baselineDate" IS NULL));

-- A locked baseline is permanent, even for the table owner.
CREATE OR REPLACE FUNCTION goal_baseline_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."baselineLockedAt" IS NOT NULL AND (
       NEW."baselineValue" IS DISTINCT FROM OLD."baselineValue"
    OR NEW."baselineDate" IS DISTINCT FROM OLD."baselineDate"
    OR NEW."baselineLockedAt" IS DISTINCT FROM OLD."baselineLockedAt"
    OR NEW."baselineLockedById" IS DISTINCT FROM OLD."baselineLockedById") THEN
    RAISE EXCEPTION 'goal baseline is locked';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER goal_baseline_immutable BEFORE UPDATE ON "goal"
  FOR EACH ROW EXECUTE FUNCTION goal_baseline_immutable();
