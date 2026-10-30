-- A client is active or inactive (discontinued). Inactive clients raise no alerts or due dates and take
-- no new records; nothing is deleted. Existing clients stay active.
ALTER TABLE "client" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "client" ADD COLUMN "inactiveSince" DATE;
ALTER TABLE "client" ADD COLUMN "inactiveReason" TEXT;
ALTER TABLE "client" ADD COLUMN "inactiveNote" TEXT;
ALTER TABLE "client" ADD CONSTRAINT "client_status_check" CHECK ("status" IN ('active', 'inactive'));
ALTER TABLE "client" ADD CONSTRAINT "client_inactive_reason_check"
  CHECK ("inactiveReason" IS NULL OR "inactiveReason" IN
    ('discharged_goals_met', 'transferred', 'insurance_ended', 'family_withdrew', 'other'));
-- Inactive clients carry a date and a reason; active clients carry neither (nor a note).
ALTER TABLE "client" ADD CONSTRAINT "client_inactive_fields_check" CHECK (
  ("status" = 'inactive' AND "inactiveSince" IS NOT NULL AND "inactiveReason" IS NOT NULL)
  OR ("status" = 'active' AND "inactiveSince" IS NULL AND "inactiveReason" IS NULL AND "inactiveNote" IS NULL)
);
ALTER TABLE "client" ADD CONSTRAINT "client_inactive_note_length_check"
  CHECK ("inactiveNote" IS NULL OR char_length("inactiveNote") <= 500);
