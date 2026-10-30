-- Score imports for assessments other than VB-MAPP (Excel, CSV, PDF, image, text, Word).
-- Never the file's bytes or text: its hash, the proposed scores (catalog keys, numbers,
-- locations, confidence), and flags. PHI is only flagged (phiDetected), never stored.

-- CreateTable
CREATE TABLE "assessment_import" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "typeKey" TEXT NOT NULL,
    "module" TEXT,
    "filename" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "phiDetected" BOOLEAN NOT NULL DEFAULT false,
    "phiStripped" BOOLEAN NOT NULL DEFAULT false,
    "parsed" JSONB NOT NULL,
    "flags" JSONB NOT NULL DEFAULT '[]',
    "reviewerId" UUID,
    "reviewedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessment_import_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "assessment_import_type_key_check" CHECK ("typeKey" ~ '^[a-z][a-z0-9_]{0,47}$'),
    CONSTRAINT "assessment_import_status_check" CHECK ("status" IN ('pending', 'confirmed', 'discarded')),
    CONSTRAINT "assessment_import_format_check"
      CHECK ("format" IN ('xlsx', 'xls', 'csv', 'pdf', 'image', 'txt', 'docx')),
    CONSTRAINT "assessment_import_sha_check" CHECK ("fileSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "assessment_import_filename_length_check" CHECK (char_length("filename") <= 120),
    -- A reviewed import always says who reviewed it, and when.
    CONSTRAINT "assessment_import_reviewed_check"
      CHECK ("status" = 'pending' OR ("reviewerId" IS NOT NULL AND "reviewedAt" IS NOT NULL))
);

-- CreateIndex
CREATE INDEX "assessment_import_clientId_createdAt_idx" ON "assessment_import"("clientId", "createdAt");

-- AddForeignKey
ALTER TABLE "assessment_import" ADD CONSTRAINT "assessment_import_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: an imported assessment points at the import it came from.
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_importId_fkey" FOREIGN KEY ("importId") REFERENCES "assessment_import"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security: a practice's imports are its own.
ALTER TABLE "assessment_import" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assessment_import" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "assessment_import"
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- Imports are added, reviewed (status), and kept as history. DELETE stays only so the synthetic
-- seed can reload a practice's data; no app code path deletes an import.
GRANT SELECT, INSERT, UPDATE, DELETE ON "assessment_import" TO aba_app;
