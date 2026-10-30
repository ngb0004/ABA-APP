-- Assessments of any type from the catalog (seed/assessments.yaml): Vineland-3, SRS-2, PDDBI,
-- PSI-4, SIPA, ABLLS-R, AFLS, PEAK, EFL, and "other". VB-MAPP keeps its own tables.
-- Scores and names only (rule 9): no item wording or report text.

-- CreateTable
CREATE TABLE "assessment" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "typeKey" TEXT NOT NULL,
    "module" TEXT,
    "form" TEXT,
    "respondent" TEXT,
    "customName" TEXT,
    "administeredOn" DATE NOT NULL,
    "administeredBy" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "importId" UUID,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "reviewerId" UUID,
    "reviewedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assessment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "assessment_type_key_check" CHECK ("typeKey" ~ '^[a-z][a-z0-9_]{0,47}$'),
    CONSTRAINT "assessment_source_check" CHECK ("source" IN ('manual', 'import', 'vbmapp_import')),
    CONSTRAINT "assessment_status_check" CHECK ("status" IN ('draft', 'confirmed')),
    -- A confirmed assessment always says which BCBA confirmed it, and when.
    CONSTRAINT "assessment_confirmed_reviewer_check"
      CHECK ("status" <> 'confirmed' OR ("reviewerId" IS NOT NULL AND "reviewedAt" IS NOT NULL)),
    -- Initials or a staff code, never a name.
    CONSTRAINT "assessment_administered_by_check"
      CHECK ("administeredBy" ~ '^[A-Za-z0-9][A-Za-z0-9.-]{0,23}$'),
    CONSTRAINT "assessment_custom_name_length_check"
      CHECK ("customName" IS NULL OR char_length("customName") <= 120),
    CONSTRAINT "assessment_notes_length_check" CHECK ("notes" IS NULL OR char_length("notes") <= 1000),
    CONSTRAINT "assessment_date_check" CHECK ("administeredOn" >= DATE '2000-01-01')
);

-- CreateTable
CREATE TABLE "assessment_score" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "assessmentId" UUID NOT NULL,
    "scaleKey" TEXT NOT NULL,
    "scaleName" TEXT,
    "scaleKind" TEXT,
    "value" DOUBLE PRECISION NOT NULL,
    "possible" DOUBLE PRECISION,
    "provenance" JSONB,

    CONSTRAINT "assessment_score_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "assessment_score_scale_key_check" CHECK ("scaleKey" ~ '^[a-z][a-z0-9_]{0,59}$'),
    CONSTRAINT "assessment_score_kind_check" CHECK ("scaleKind" IS NULL OR "scaleKind" IN
      ('score_of_possible', 'standard', 't_score', 'percentile', 'raw', 'percent', 'age_equivalent_months')),
    CONSTRAINT "assessment_score_name_length_check"
      CHECK ("scaleName" IS NULL OR char_length("scaleName") <= 80),
    CONSTRAINT "assessment_score_value_check" CHECK ("value" >= 0),
    CONSTRAINT "assessment_score_possible_check"
      CHECK ("possible" IS NULL OR ("possible" > 0 AND "value" <= "possible"))
);

-- CreateIndex
CREATE INDEX "assessment_clientId_administeredOn_idx" ON "assessment"("clientId", "administeredOn");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_score_assessmentId_scaleKey_key" ON "assessment_score"("assessmentId", "scaleKey");

-- AddForeignKey
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_score" ADD CONSTRAINT "assessment_score_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security: a practice's assessments are its own.
ALTER TABLE "assessment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assessment" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "assessment"
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE "assessment_score" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assessment_score" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "assessment_score"
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- Drafts are edited and deleted; the service locks confirmed rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON "assessment" TO aba_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "assessment_score" TO aba_app;
