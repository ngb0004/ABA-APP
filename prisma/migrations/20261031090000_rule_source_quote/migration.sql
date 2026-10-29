-- Where each rule was read in its official document.
ALTER TABLE "payor_rule" ADD COLUMN "sourcePage" TEXT;
ALTER TABLE "payor_rule" ADD COLUMN "sourceQuote" TEXT;
