-- Benefits checks (verification of benefits): what the payor said about a client's coverage, recorded
-- per insurance. History: rows are added, never edited.

-- CreateTable
CREATE TABLE "benefits_check" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "clientPayorId" UUID,
    "payorId" UUID NOT NULL,
    "checkedOn" DATE NOT NULL,
    "checkedByUserId" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "referenceNumber" TEXT,
    "abaCovered" TEXT NOT NULL DEFAULT 'unknown',
    "priorAuthRequired" TEXT NOT NULL DEFAULT 'unknown',
    "planFunding" TEXT NOT NULL DEFAULT 'unknown',
    "ageLimitYears" INTEGER,
    "visitOrHourLimits" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benefits_check_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "benefits_check_method_check"
      CHECK ("method" IN ('portal', 'phone', 'electronic_eligibility', 'other')),
    CONSTRAINT "benefits_check_aba_covered_check" CHECK ("abaCovered" IN ('yes', 'no', 'unknown')),
    CONSTRAINT "benefits_check_prior_auth_check" CHECK ("priorAuthRequired" IN ('yes', 'no', 'unknown')),
    CONSTRAINT "benefits_check_plan_funding_check"
      CHECK ("planFunding" IN ('fully_insured', 'self_funded', 'unknown')),
    CONSTRAINT "benefits_check_age_limit_check"
      CHECK ("ageLimitYears" IS NULL OR "ageLimitYears" BETWEEN 1 AND 99),
    CONSTRAINT "benefits_check_reference_check"
      CHECK ("referenceNumber" IS NULL OR char_length("referenceNumber") <= 44),
    CONSTRAINT "benefits_check_limits_length_check"
      CHECK ("visitOrHourLimits" IS NULL OR char_length("visitOrHourLimits") <= 300),
    CONSTRAINT "benefits_check_notes_length_check" CHECK ("notes" IS NULL OR char_length("notes") <= 1000)
);

-- CreateIndex
CREATE INDEX "benefits_check_clientId_checkedOn_idx" ON "benefits_check"("clientId", "checkedOn");

-- AddForeignKey
ALTER TABLE "benefits_check" ADD CONSTRAINT "benefits_check_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: removing the insurance keeps its checks (clientPayorId becomes null; payorId stays).
ALTER TABLE "benefits_check" ADD CONSTRAINT "benefits_check_clientPayorId_fkey" FOREIGN KEY ("clientPayorId") REFERENCES "client_payor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefits_check" ADD CONSTRAINT "benefits_check_payorId_fkey" FOREIGN KEY ("payorId") REFERENCES "payor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security: a practice's checks are its own.
ALTER TABLE "benefits_check" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "benefits_check" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "benefits_check"
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- History: the app adds and reads checks, never edits one. (The SET NULL above runs as the table owner
-- when an insurance is removed.) DELETE stays only so the synthetic seed can reload a practice's data;
-- no app code path deletes a check.
GRANT SELECT, INSERT, DELETE ON "benefits_check" TO aba_app;
REVOKE UPDATE ON "benefits_check" FROM aba_app;
