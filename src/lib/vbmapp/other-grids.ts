/**
 * Barrier and Transition grids: not implemented in v1.0.
 *
 * TODO(phase: post-v1.0): implement once scored sample workbooks for the
 * "Barrier Grid" and "Transition Grid" sheets are available as fixtures. Map the
 * cells in docs/VBMAPP_WORKBOOK_MAP.md first, then write fixture tests (as for
 * the Milestones Grid) before implementing. Store scores and item numbers only,
 * never assessment wording.
 */
import type { WorkSheet } from "xlsx";

export type GridItemScore = { item: number; score: number; adminNumber: number };
export type OtherGridResult = {
  sheet: "Barrier Grid" | "Transition Grid";
  administrations: { adminNumber: number; items: GridItemScore[]; total: number }[];
  flags: { code: string; message: string; cells: string[] }[];
};

export interface OtherGridParser {
  readonly sheet: "Barrier Grid" | "Transition Grid";
  parse(ws: WorkSheet): OtherGridResult;
}

export class NotYetImplementedGridParser implements OtherGridParser {
  constructor(readonly sheet: "Barrier Grid" | "Transition Grid") {}
  parse(): OtherGridResult {
    throw new Error(`${this.sheet} import is not available in v1.0`);
  }
}
