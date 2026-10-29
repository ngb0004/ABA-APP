-- A BCBA can upload the official copy of a payor document that has no public URL.
ALTER TABLE "payor_document_snapshot" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'fetch';
ALTER TABLE "payor_document_snapshot" ADD COLUMN "uploadedById" UUID;
ALTER TABLE "payor_document_snapshot" ADD CONSTRAINT "payor_document_snapshot_origin_check" CHECK ("origin" IN ('fetch', 'upload'));
