-- Rules Watch: payor document snapshots, append-only rule evidence, rule lineage.
-- A rule's status is now computed from evidence, so the hand-set "verified" column is dropped.

-- AlterTable
ALTER TABLE "payor_document" ADD COLUMN     "health" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "lastChangedAt" TIMESTAMP(3),
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "locator" JSONB,
ADD COLUMN     "secondary" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "payor_rule" DROP COLUMN "verified",
-- Existing rows get a placeholder; the payor library sync fills real lineage keys.
ADD COLUMN     "lineageKey" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "payor_document_snapshot" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedUrl" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "textSha256" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "versionLabel" TEXT,
    "effectiveDate" DATE,
    "nextRevision" DATE,
    "revisions" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "payor_document_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_evidence" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "lineageKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "documentId" UUID,
    "snapshotId" UUID,
    "section" TEXT,
    "quote" TEXT NOT NULL DEFAULT '',
    "textSha256" TEXT,
    "reference" TEXT,
    "reviewerId" UUID,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payor_document_snapshot_documentId_fetchedAt_idx" ON "payor_document_snapshot"("documentId", "fetchedAt");

-- CreateIndex
CREATE INDEX "rule_evidence_org_id_lineageKey_createdAt_idx" ON "rule_evidence"("org_id", "lineageKey", "createdAt");

-- CreateIndex
CREATE INDEX "payor_rule_org_id_lineageKey_idx" ON "payor_rule"("org_id", "lineageKey");

-- AddForeignKey
ALTER TABLE "payor_document_snapshot" ADD CONSTRAINT "payor_document_snapshot_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "payor_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Row-level security for the new org-scoped tables.
ALTER TABLE "payor_document_snapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payor_document_snapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "payor_document_snapshot"
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE "rule_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rule_evidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_read ON "rule_evidence" FOR SELECT USING (org_id = app_current_org());
CREATE POLICY evidence_insert ON "rule_evidence" FOR INSERT WITH CHECK (org_id = app_current_org());

-- Evidence is append-only, like audit_event: revocations are new rows.
CREATE OR REPLACE FUNCTION rule_evidence_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'rule_evidence is append-only (% rejected)', TG_OP;
END $$;
CREATE TRIGGER rule_evidence_no_update BEFORE UPDATE OR DELETE ON "rule_evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION rule_evidence_append_only();
CREATE TRIGGER rule_evidence_no_truncate BEFORE TRUNCATE ON "rule_evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION rule_evidence_append_only();

GRANT SELECT, INSERT, UPDATE, DELETE ON "payor_document_snapshot" TO aba_app;
GRANT SELECT, INSERT ON "rule_evidence" TO aba_app;

-- Scheduled jobs (the source watcher) need the list of org ids, and nothing else,
-- without an org context. SECURITY DEFINER runs as the owner, which has BYPASSRLS
-- (granted by the bootstrap scripts; the app never connects as the owner).
CREATE OR REPLACE FUNCTION app_org_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT id FROM "org" $$;
REVOKE ALL ON FUNCTION app_org_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_org_ids() TO aba_app;
