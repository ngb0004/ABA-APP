-- Discontinuing a goal keeps it (and its data and graph) with the date and the BCBA's reason.
ALTER TABLE "goal" ADD COLUMN "discontinuedOn" DATE;
ALTER TABLE "goal" ADD COLUMN "discontinuedReason" TEXT;
ALTER TABLE "goal" ADD CONSTRAINT "goal_discontinued_complete_check"
  CHECK (("discontinuedOn" IS NULL) = ("discontinuedReason" IS NULL));
ALTER TABLE "goal" ADD CONSTRAINT "goal_discontinued_reason_length_check"
  CHECK ("discontinuedReason" IS NULL OR char_length("discontinuedReason") BETWEEN 1 AND 500);

-- When the goal was added. Goals that existed before this column are treated as the oldest possible
-- (1970), so they count as part of every approved section and exported packet and cannot be removed.
ALTER TABLE "goal" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT '1970-01-01 00:00:00';
ALTER TABLE "goal" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;
