-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('BCBA', 'BCaBA', 'RBT', 'AUTH_COORDINATOR', 'PARENT');

-- CreateTable
CREATE TABLE "org" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "totpSecret" TEXT,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_session" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "org_id" UUID,
    "role" "Role",
    "mfaVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "org_id" UUID,
    "userId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "is_synthetic" BOOLEAN NOT NULL DEFAULT true,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "preferredName" TEXT,
    "dob" DATE NOT NULL,
    "sex" TEXT,
    "serviceAddress" JSONB NOT NULL DEFAULT '{}',
    "guardians" JSONB NOT NULL DEFAULT '[]',
    "hasIep" BOOLEAN NOT NULL DEFAULT false,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnosis" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "dsm5Code" TEXT NOT NULL,
    "dsm5Label" TEXT NOT NULL,
    "icd10Code" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "severity" TEXT,
    "evaluationDate" DATE,
    "deficitAreas" TEXT[],

    CONSTRAINT "diagnosis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_payor" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "payorId" UUID NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'primary',
    "memberId" TEXT NOT NULL,
    "planName" TEXT,
    "secondaryDocsSigned" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "client_payor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachment" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "documentDate" DATE,
    "caregiverSigned" BOOLEAN NOT NULL DEFAULT false,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authorization" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "payorId" UUID NOT NULL,
    "authNumber" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'initial',
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "recommendedHoursPerWeek" DOUBLE PRECISION,

    CONSTRAINT "authorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authorization_unit" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "authorizationId" UUID NOT NULL,
    "cptCode" TEXT NOT NULL,
    "approvedUnits" INTEGER NOT NULL,
    "unitBasis" TEXT NOT NULL,

    CONSTRAINT "authorization_unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_session" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "authorizationId" UUID,
    "cptCode" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startMinute" INTEGER NOT NULL DEFAULT 540,
    "units" INTEGER NOT NULL,
    "providerRole" "Role" NOT NULL,
    "providerId" TEXT,
    "providerCredential" TEXT,
    "inPerson" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "service_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intake" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "submittedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vbmapp_import" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "parsed" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "phiDetected" BOOLEAN NOT NULL DEFAULT false,
    "phiStripped" BOOLEAN NOT NULL DEFAULT false,
    "reviewerId" UUID,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vbmapp_import_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vbmapp_administration" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "importId" UUID,
    "adminNumber" INTEGER NOT NULL,
    "testDate" DATE,
    "testerInitials" TEXT,
    "totals" JSONB NOT NULL,
    "flags" JSONB NOT NULL DEFAULT '[]',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "reviewerId" UUID,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vbmapp_administration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "milestone_score" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "administrationId" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "domain" TEXT NOT NULL,
    "milestone" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "firstAdmin" INTEGER NOT NULL,
    "carriedForward" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "milestone_score_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payor" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "inherits" TEXT,

    CONSTRAINT "payor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payor_document" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "effectiveDate" DATE,
    "url" TEXT,

    CONSTRAINT "payor_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payor_rule" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "payorId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "sourceDocumentId" UUID,
    "sourceSection" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "inheritedFrom" TEXT,
    "ordinal" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "payor_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_template" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "domainNumber" INTEGER NOT NULL,
    "domainName" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "tierName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "goalText" TEXT NOT NULL,
    "rationalePattern" TEXT NOT NULL,
    "rationaleText" TEXT NOT NULL,
    "linkedMilestones" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "goal_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "planId" UUID,
    "templateId" UUID,
    "diagnosisId" UUID,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "domain" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "deficitArea" TEXT,
    "measure" TEXT NOT NULL DEFAULT 'percent',
    "linkedMilestones" JSONB NOT NULL DEFAULT '[]',
    "initiationWindow" TEXT NOT NULL DEFAULT 'Months 1-3',
    "objective" TEXT NOT NULL,
    "sd" TEXT NOT NULL DEFAULT '',
    "targetBehavior" TEXT NOT NULL DEFAULT '',
    "dataCollection" TEXT NOT NULL DEFAULT '',
    "prompting" TEXT NOT NULL DEFAULT '',
    "teachingProcedure" TEXT NOT NULL DEFAULT '',
    "phases" JSONB NOT NULL DEFAULT '[]',
    "masteryAccuracyPct" INTEGER NOT NULL DEFAULT 80,
    "masteryConsecutiveSessions" INTEGER NOT NULL DEFAULT 5,
    "masteryInstructors" INTEGER NOT NULL DEFAULT 2,
    "masterySettings" INTEGER NOT NULL DEFAULT 1,
    "generalization" TEXT NOT NULL DEFAULT '',
    "rationalePattern" TEXT NOT NULL DEFAULT 'A',
    "rationale" TEXT NOT NULL DEFAULT '',
    "baselineSource" JSONB,
    "replacementForGoalId" UUID,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "flatExplanation" TEXT,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_data_point" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "goalId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "trials" INTEGER,

    CONSTRAINT "goal_data_point_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_phase_change" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "goalId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "goal_phase_change_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "authorizationId" UUID,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "payorDocVersions" JSONB NOT NULL DEFAULT '[]',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt" TIMESTAMP(3),

    CONSTRAINT "plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_section" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "aiDraft" TEXT,
    "content" TEXT NOT NULL DEFAULT '',
    "items" JSONB NOT NULL DEFAULT '{}',
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_section_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_section_revision" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "sectionId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "diff" TEXT NOT NULL DEFAULT '',
    "userId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_section_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payor_letter" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "authorizationId" UUID,
    "filename" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "classification" TEXT,
    "extracted" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "confirmedById" UUID,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payor_letter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packet" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "letterId" UUID,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "pdfSha256" TEXT,
    "exportedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),

    CONSTRAINT "packet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "membership_org_id_userId_key" ON "membership"("org_id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_session_tokenHash_key" ON "auth_session"("tokenHash");

-- CreateIndex
CREATE INDEX "audit_event_org_id_createdAt_idx" ON "audit_event"("org_id", "createdAt");

-- CreateIndex
CREATE INDEX "service_session_clientId_date_idx" ON "service_session"("clientId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "payor_org_id_key_key" ON "payor"("org_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "payor_document_org_id_key_key" ON "payor_document"("org_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "goal_template_org_id_domainNumber_tier_key" ON "goal_template"("org_id", "domainNumber", "tier");

-- CreateIndex
CREATE INDEX "goal_data_point_goalId_date_idx" ON "goal_data_point"("goalId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "plan_section_planId_key_key" ON "plan_section"("planId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "packet_planId_key" ON "packet"("planId");

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client" ADD CONSTRAINT "client_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis" ADD CONSTRAINT "diagnosis_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_payor" ADD CONSTRAINT "client_payor_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_payor" ADD CONSTRAINT "client_payor_payorId_fkey" FOREIGN KEY ("payorId") REFERENCES "payor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorization" ADD CONSTRAINT "authorization_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorization" ADD CONSTRAINT "authorization_payorId_fkey" FOREIGN KEY ("payorId") REFERENCES "payor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorization_unit" ADD CONSTRAINT "authorization_unit_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "authorization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_session" ADD CONSTRAINT "service_session_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_session" ADD CONSTRAINT "service_session_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "authorization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake" ADD CONSTRAINT "intake_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vbmapp_import" ADD CONSTRAINT "vbmapp_import_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vbmapp_administration" ADD CONSTRAINT "vbmapp_administration_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vbmapp_administration" ADD CONSTRAINT "vbmapp_administration_importId_fkey" FOREIGN KEY ("importId") REFERENCES "vbmapp_import"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestone_score" ADD CONSTRAINT "milestone_score_administrationId_fkey" FOREIGN KEY ("administrationId") REFERENCES "vbmapp_administration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payor_rule" ADD CONSTRAINT "payor_rule_payorId_fkey" FOREIGN KEY ("payorId") REFERENCES "payor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payor_rule" ADD CONSTRAINT "payor_rule_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "payor_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal" ADD CONSTRAINT "goal_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal" ADD CONSTRAINT "goal_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal" ADD CONSTRAINT "goal_diagnosisId_fkey" FOREIGN KEY ("diagnosisId") REFERENCES "diagnosis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_data_point" ADD CONSTRAINT "goal_data_point_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "goal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_phase_change" ADD CONSTRAINT "goal_phase_change_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "goal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan" ADD CONSTRAINT "plan_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan" ADD CONSTRAINT "plan_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "authorization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_section" ADD CONSTRAINT "plan_section_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_section_revision" ADD CONSTRAINT "plan_section_revision_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "plan_section"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payor_letter" ADD CONSTRAINT "payor_letter_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packet" ADD CONSTRAINT "packet_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

