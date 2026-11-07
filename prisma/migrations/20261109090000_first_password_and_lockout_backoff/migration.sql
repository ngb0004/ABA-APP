-- An account created by a practice admin starts with a temporary password the admin chose; the
-- person must choose their own before setting up an authenticator (mustChangePassword).
ALTER TABLE "user" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
  -- Lockouts since the last successful sign-in: each one doubles the next lock (capped at 24 hours).
  ADD COLUMN "lockoutCount" INTEGER NOT NULL DEFAULT 0;
