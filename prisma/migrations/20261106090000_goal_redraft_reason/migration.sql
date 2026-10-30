-- Goal removal used to mark sections for redraft with a "_needs_redraft" checklist item.
-- Sections now carry one redraft reason column for every cause; move existing marks over.
UPDATE "plan_section"
SET "redraftReason" = 'A goal this section covered was removed after it was written.',
    "items" = "items" - '_needs_redraft'
WHERE "items" ? '_needs_redraft';
