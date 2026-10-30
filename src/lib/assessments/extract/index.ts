/**
 * Score import for assessments other than VB-MAPP: check the file's real type, read it into
 * located lines, and propose scores for the chosen assessment type. Deterministic code and
 * local OCR only; no report content ever goes to the AI. The result holds catalog keys,
 * numbers, locations, and flags, never the file's text.
 */
import type { Day } from "../../dates";
import type { Catalog, CatalogType } from "../catalog";
import { detectFormat, type DetectedFile } from "./detect";
import { proposeScores, type Proposal } from "./match";
import { readLines } from "./read";

export { IMPORT_ACCEPT, MAX_IMPORT_BYTES, detectFormat } from "./detect";
export type { Proposal, ProposedScore, ImportFlag, Confidence, ImportFormat } from "./match";

export async function extractAssessmentFile(args: {
  filename: string;
  data: Buffer;
  catalog: Catalog;
  type: CatalogType;
  module: string | null;
  asOf: Day;
}): Promise<{ file: DetectedFile; proposal: Proposal }> {
  const file = detectFormat(args.filename, args.data);
  const lines = await readLines(file.format, args.data);
  const proposal = proposeScores({
    catalog: args.catalog,
    type: args.type,
    module: args.module,
    format: file.format,
    lines,
    asOf: args.asOf,
  });
  return { file, proposal };
}
