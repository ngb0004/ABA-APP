-- Pending authenticator secrets live on the sign-in session; wrong-code counters.
ALTER TABLE "auth_session" ADD COLUMN "pendingTotpSecret" TEXT,
  ADD COLUMN "failedMfaAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "user" ADD COLUMN "failedMfaCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "mfaLockedUntil" TIMESTAMP(3);
