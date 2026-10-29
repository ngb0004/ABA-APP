/**
 * Milestones Grid cell layout (see docs/VBMAPP_WORKBOOK_MAP.md).
 * Stores domain names and milestone numbers only; no assessment item wording.
 */
import * as XLSX from "xlsx";

export type LevelLayout = {
  level: 1 | 2 | 3;
  /** Upper row of the top milestone. */
  startRow: number;
  topMilestone: number;
  bottomMilestone: number;
  domains: { col: string; name: string }[];
  /** Row holding per-domain workbook totals (admin 1 in the domain column, admin k offset by k-1). */
  domainTotalRow: number;
  /** Level total for admin 1; admin k is offset by k-1 columns. */
  levelTotalCol: string;
  levelTotalRow: number;
};

const d = (pairs: [string, string][]) => pairs.map(([col, name]) => ({ col, name }));

export const LEVELS: LevelLayout[] = [
  {
    level: 1,
    startRow: 50,
    topMilestone: 5,
    bottomMilestone: 1,
    domains: d([
      ["D", "Mand"],
      ["I", "Tact"],
      ["N", "Listener"],
      ["S", "VP/MTS"],
      ["X", "Play"],
      ["AC", "Social"],
      ["AH", "Imitation"],
      ["AM", "Echoic"],
      ["AR", "Vocal"],
    ]),
    domainTotalRow: 49,
    levelTotalCol: "AW",
    levelTotalRow: 59,
  },
  {
    level: 2,
    startRow: 33,
    topMilestone: 10,
    bottomMilestone: 6,
    domains: d([
      ["D", "Mand"],
      ["I", "Tact"],
      ["N", "Listener"],
      ["S", "VP/MTS"],
      ["X", "Play"],
      ["AC", "Social"],
      ["AH", "Imitation"],
      ["AM", "Echoic"],
      ["AR", "LRFFC"],
      ["AW", "IV"],
      ["BB", "Group"],
      ["BG", "Linguistics"],
    ]),
    domainTotalRow: 32,
    levelTotalCol: "BL",
    levelTotalRow: 42,
  },
  {
    level: 3,
    startRow: 16,
    topMilestone: 15,
    bottomMilestone: 11,
    domains: d([
      ["D", "Mand"],
      ["I", "Tact"],
      ["N", "Listener"],
      ["S", "VP/MTS"],
      ["X", "Play"],
      ["AC", "Social"],
      ["AH", "Reading"],
      ["AM", "Writing"],
      ["AR", "LRFFC"],
      ["AW", "IV"],
      ["BB", "Group"],
      ["BG", "Linguistics"],
      ["BL", "Math"],
    ]),
    domainTotalRow: 15,
    levelTotalCol: "BQ",
    levelTotalRow: 25,
  },
];

export const HEADER = {
  name: "H6",
  dob: "H7",
  testDate: ["AT6", "AT7", "AT8", "AT9"],
  initials: ["BD6", "BD7", "BD8", "BD9"],
  workbookTotal: ["AO6", "AO7", "AO8", "AO9"],
  /** Age-at-test formula cells; ignored (ages are recomputed). */
  ignored: ["P8", "V8", "AB8"],
};

export const MAX_ADMINS = 4;
export const POINTS_PER_LEVEL = (l: LevelLayout) =>
  l.domains.length * (l.topMilestone - l.bottomMilestone + 1);

export function rowsFor(level: LevelLayout, milestone: number): { upper: number; lower: number } {
  const upper = level.startRow + 2 * (level.topMilestone - milestone);
  return { upper, lower: upper + 1 };
}

export function offsetCol(col: string, by: number): string {
  return XLSX.utils.encode_col(XLSX.utils.decode_col(col) + by);
}

/** Echoic scoring cells are formula-driven from the EESA sheet (Level 1 and Level 2). */
export function isEchoicCell(addr: string): boolean {
  const m = /^AM(\d+)$/.exec(addr);
  if (!m) return false;
  const r = Number(m[1]);
  return (r >= 50 && r <= 59) || (r >= 33 && r <= 42);
}

export function milestoneKey(level: number, domain: string, milestone: number) {
  return `L${level}.${domain}.${milestone}`;
}
