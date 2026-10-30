-- Goal editors autosave: each save names the version it edited (optimistic concurrency), so a
-- save based on an older version is refused instead of overwriting another change.
ALTER TABLE "goal" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
