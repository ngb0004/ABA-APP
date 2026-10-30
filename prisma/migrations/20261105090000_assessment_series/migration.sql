-- Stable assessment token numbers. A confirmed assessment's token base
-- ("assessment.<series>.<n>") is stored when it is confirmed and never reassigned, so a
-- back-dated administration confirmed later cannot renumber the tokens an approved section or a
-- finalized plan already cites. Rows confirmed before this migration are numbered (by date, as
-- before) the next time an assessment of the same client is confirmed; until then the same
-- order is computed on read (src/lib/assessments/plan.ts seriesNumbers).
--
-- No new table: "assessment" already has org_id, row-level security, and grants.

ALTER TABLE "assessment" ADD COLUMN "seriesKey" TEXT;
ALTER TABLE "assessment" ADD COLUMN "seriesNumber" INTEGER;
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_series_check"
  CHECK (("seriesKey" IS NULL) = ("seriesNumber" IS NULL)
    AND ("seriesNumber" IS NULL OR "seriesNumber" >= 1)
    AND ("seriesKey" IS NULL OR "seriesKey" ~ '^[a-z][a-z0-9_]{0,159}$'));
-- Only a confirmed assessment has a number.
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_series_confirmed_check"
  CHECK ("seriesNumber" IS NULL OR "status" = 'confirmed');
CREATE UNIQUE INDEX "assessment_clientId_seriesKey_seriesNumber_key"
  ON "assessment" ("clientId", "seriesKey", "seriesNumber");

-- One import gives at most one assessment, even when two confirms race.
CREATE UNIQUE INDEX "assessment_importId_unique" ON "assessment" ("importId") WHERE "importId" IS NOT NULL;
