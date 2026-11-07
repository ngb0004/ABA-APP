-- Account lockout covers wrong passwords and wrong authenticator codes alike (replaces the
-- MFA-only counter), TOTP replay protection, and the session idle timeout.
ALTER TABLE "user" ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lockedUntil" TIMESTAMP(3),
  ADD COLUMN "lastTotpStep" INTEGER;
UPDATE "user" SET "lockedUntil" = "mfaLockedUntil" WHERE "mfaLockedUntil" IS NOT NULL;
ALTER TABLE "user" DROP COLUMN "failedMfaCount", DROP COLUMN "mfaLockedUntil";

-- The per-sign-in wrong-code counter is replaced by the account counter above.
ALTER TABLE "auth_session" ADD COLUMN "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  DROP COLUMN "failedMfaAttempts";

-- Uploaded filenames can carry a child's name, DOB, or member ID: keep a neutral display name only.
-- Every stored row is synthetic (client_is_synthetic_only), so rewriting them in place is safe.
UPDATE "vbmapp_import"
  SET "filename" = 'VB-MAPP workbook (.' || COALESCE(NULLIF(lower(substring("filename" from '\.([A-Za-z0-9]{1,5})$')), ''), 'xlsx') || '), uploaded ' || to_char("createdAt", 'YYYY-MM-DD');
UPDATE "payor_letter"
  SET "filename" = 'Payor letter (.' || COALESCE(NULLIF(lower(substring("filename" from '\.([A-Za-z0-9]{1,5})$')), ''), 'txt') || '), uploaded ' || to_char("createdAt", 'YYYY-MM-DD');
