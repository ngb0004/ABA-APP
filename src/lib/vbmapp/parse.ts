/**
 * VB-MAPP Milestones Grid importer. Reads cell values and formulas with SheetJS.
 * Macros are never executed: VBA is not even loaded (bookVBA: false), and only
 * the Milestones Grid sheet is parsed. Every total is recomputed from the raw
 * grid; workbook totals are used only for comparison.
 */
import * as XLSX from "xlsx";
import { z } from "zod";
import TEMPLATE_FORMULAS from "./template-formulas.json";
import { HEADER, LEVELS, MAX_ADMINS, isEchoicCell, offsetCol, rowsFor, type LevelLayout } from "./layout";

export const FlagSchema = z.object({
  code: z.enum([
    "totals_mismatch",
    "formula_overwritten",
    "echoic_overwritten",
    "bad_date",
    "isolated_score",
    "phi_present",
    "invalid_cell",
    "unexpected_formula",
  ]),
  severity: z.enum(["error", "warn", "info"]),
  message: z.string(),
  cells: z.array(z.string()),
  admin: z.number().optional(),
  level: z.number().optional(),
  domain: z.string().optional(),
  milestones: z.array(z.number()).optional(),
  workbookValue: z.number().nullable().optional(),
  recomputedValue: z.number().optional(),
});
export type Flag = z.infer<typeof FlagSchema>;

export const ScoreSchema = z.object({
  level: z.number().int().min(1).max(3),
  domain: z.string(),
  milestone: z.number().int().min(1).max(15),
  score: z.union([z.literal(0.5), z.literal(1)]),
  /** Administration in which the milestone first scored. */
  firstAdmin: z.number().int().min(1).max(4),
  cells: z.array(z.string()),
});
export type Score = z.infer<typeof ScoreSchema>;

export type Totals = { total: number; levels: Record<number, number>; domains: Record<string, number> };

export type ParsedAdministration = {
  adminNumber: number;
  testDate: string | null;
  testDateRaw: string | null;
  testerInitials: string | null;
  scores: Score[];
  totals: Totals;
  workbookTotal: number | null;
};

export type ParsedWorkbook = {
  administrations: ParsedAdministration[];
  flags: Flag[];
  phi: { name: boolean; dob: boolean };
};

const SHEET = "Milestones Grid";
const MAX_BYTES = 10 * 1024 * 1024;
const TEMPLATE = TEMPLATE_FORMULAS as Record<string, string>;

type Cell = XLSX.CellObject | undefined;

const isBlank = (c: Cell) => !c || c.t === "z" || c.v === undefined || c.v === null || c.v === "";
const round = (n: number) => Math.round(n * 2) / 2;

/** Value of a scoring cell: 1-4, null when empty, or "invalid". */
function adminValue(c: Cell): number | null | "invalid" {
  if (isBlank(c)) return null;
  const n = typeof c!.v === "number" ? c!.v : Number(String(c!.v).trim());
  return Number.isInteger(n) && n >= 1 && n <= MAX_ADMINS ? n : "invalid";
}

function parseDateCell(
  c: Cell,
  now: Date,
): { iso: string | null; problem: string | null; raw: string | null } {
  if (isBlank(c)) return { iso: null, problem: null, raw: null };
  const raw = c!.w ?? String(c!.v);
  if (c!.f) return { iso: null, problem: `contains a formula (=${c!.f}) instead of a date`, raw };
  let y: number, m: number, d: number;
  if (c!.t === "n" && typeof c!.v === "number") {
    const p = XLSX.SSF.parse_date_code(c!.v);
    if (!p) return { iso: null, problem: "is not a valid date", raw };
    ({ y, m, d } = p);
  } else if (c!.t === "d" && c!.v instanceof Date) {
    y = c!.v.getUTCFullYear();
    m = c!.v.getUTCMonth() + 1;
    d = c!.v.getUTCDate();
  } else {
    const s = String(c!.v).trim();
    const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/.exec(s);
    const isoM = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (us) {
      m = Number(us[1]);
      d = Number(us[2]);
      y = Number(us[3]!.length === 2 ? `20${us[3]}` : us[3]);
    } else if (isoM) {
      y = Number(isoM[1]);
      m = Number(isoM[2]);
      d = Number(isoM[3]);
    } else return { iso: null, problem: `"${s}" is not a recognizable date`, raw };
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d)
    return { iso: null, problem: `"${raw}" is not a valid calendar date`, raw };
  const min = Date.UTC(2000, 0, 1);
  const max = now.getTime() + 86_400_000;
  if (dt.getTime() < min || dt.getTime() > max)
    return { iso: null, problem: `"${raw}" is outside the allowed range (2000 to today)`, raw };
  return { iso: dt.toISOString().slice(0, 10), problem: null, raw };
}

function numericValue(c: Cell): number | null {
  if (isBlank(c)) return null;
  const n = typeof c!.v === "number" ? c!.v : Number(c!.v);
  return Number.isFinite(n) ? n : null;
}

export function readWorkbook(buf: Buffer): XLSX.WorkSheet {
  if (buf.length > MAX_BYTES) throw new Error("File too large (10 MB max)");
  // .xlsx/.xlsm are zip containers ("PK"). Reject anything else before parsing.
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b)
    throw new Error("Not an Excel workbook (.xlsx/.xlsm)");
  const wb = XLSX.read(buf, {
    type: "buffer",
    cellFormula: true,
    cellDates: false,
    bookVBA: false,
    cellHTML: false,
    sheets: [SHEET],
  });
  const ws = wb.Sheets[SHEET];
  if (!ws) throw new Error(`Workbook has no "${SHEET}" sheet`);
  return ws;
}

export function parseVbmappWorkbook(buf: Buffer, opts: { now?: Date } = {}): ParsedWorkbook {
  const now = opts.now ?? new Date();
  const ws = readWorkbook(buf);
  const cell = (a: string): Cell => ws[a] as Cell;
  const flags: Flag[] = [];

  // --- PHI header cells. Never returned, only detected.
  const phi = { name: !isBlank(cell(HEADER.name)), dob: !isBlank(cell(HEADER.dob)) };
  if (phi.name || phi.dob) {
    flags.push({
      code: "phi_present",
      severity: "warn",
      message: `The workbook contains ${[phi.name && "a child's name", phi.dob && "a date of birth"].filter(Boolean).join(" and ")}. These cells are not imported; confirm stripping on import.`,
      cells: [phi.name && HEADER.name, phi.dob && HEADER.dob].filter(Boolean) as string[],
    });
  }

  // --- Raw grid: one entry per milestone with each row's administration number.
  type Raw = {
    level: LevelLayout;
    domain: string;
    col: string;
    milestone: number;
    upper: number | null;
    lower: number | null;
    cells: { upper: string; lower: string };
  };
  const raw: Raw[] = [];
  const invalid: string[] = [];
  const seenAdmins = new Set<number>();
  for (const level of LEVELS) {
    for (const { col, name } of level.domains) {
      for (let m = level.topMilestone; m >= level.bottomMilestone; m--) {
        const { upper, lower } = rowsFor(level, m);
        const ua = `${col}${upper}`;
        const la = `${col}${lower}`;
        const vals = [ua, la].map((a) => {
          const v = adminValue(cell(a));
          if (v === "invalid") {
            invalid.push(a);
            return null;
          }
          if (v !== null) seenAdmins.add(v);
          return v;
        });
        raw.push({
          level,
          domain: name,
          col,
          milestone: m,
          upper: vals[0]!,
          lower: vals[1]!,
          cells: { upper: ua, lower: la },
        });
      }
    }
  }
  if (invalid.length)
    flags.push({
      code: "invalid_cell",
      severity: "warn",
      message: "Scoring cells must hold an administration number (1-4). These cells were ignored.",
      cells: invalid,
    });

  // --- Administrations present: scored cells, initials, or a literal date.
  const dates = HEADER.testDate.map((a) => parseDateCell(cell(a), now));
  const initials = HEADER.initials.map((a) => (isBlank(cell(a)) ? null : String(cell(a)!.v).trim()));
  const present: number[] = [];
  for (let k = 1; k <= MAX_ADMINS; k++) {
    const dateCell = cell(HEADER.testDate[k - 1]!);
    const hasLiteralDate = !isBlank(dateCell) && !dateCell!.f;
    if (seenAdmins.has(k) || initials[k - 1] || hasLiteralDate) present.push(k);
  }

  // Date problems are flagged for every cell, including a formula in an unused admin slot.
  dates.forEach((dt, i) => {
    if (dt.problem)
      flags.push({
        code: "bad_date",
        severity: "warn",
        message: `Test date ${i + 1} (${HEADER.testDate[i]}) ${dt.problem}.`,
        cells: [HEADER.testDate[i]!],
        admin: i + 1,
      });
  });

  // --- Recompute cumulative scores per administration.
  const administrations: ParsedAdministration[] = present.map((k) => {
    const scores: Score[] = [];
    const domains: Record<string, number> = {};
    const levels: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
    for (const r of raw) {
      const halves = [r.upper, r.lower].filter((v): v is number => v !== null && v <= k);
      const key = `L${r.level.level}.${r.domain}`;
      domains[key] ??= 0;
      if (!halves.length) continue;
      const score = halves.length === 2 ? 1 : 0.5;
      domains[key] += score;
      levels[r.level.level]! += score;
      scores.push({
        level: r.level.level,
        domain: r.domain,
        milestone: r.milestone,
        score: score as 0.5 | 1,
        firstAdmin: Math.min(...halves),
        cells: [r.cells.upper, r.cells.lower].filter(
          (_, i) => [r.upper, r.lower][i] !== null && [r.upper, r.lower][i]! <= k,
        ),
      });
    }
    for (const l of Object.keys(levels)) levels[Number(l)] = round(levels[Number(l)]!);
    const total = round(levels[1]! + levels[2]! + levels[3]!);
    return {
      adminNumber: k,
      testDate: dates[k - 1]!.iso,
      testDateRaw: dates[k - 1]!.raw,
      testerInitials: initials[k - 1],
      scores,
      totals: { total, levels, domains },
      workbookTotal: numericValue(cell(HEADER.workbookTotal[k - 1]!)),
    };
  });

  // --- Totals mismatch: compare workbook totals with recomputed, pointing at the cells that differ.
  for (const a of administrations) {
    const k = a.adminNumber;
    const prev = administrations.find((x) => x.adminNumber === k - 1);
    const diffs: { cell: string; label: string; wb: number | null; rc: number }[] = [];
    for (const level of LEVELS) {
      // Workbook domain cells hold the increment scored in admin k (SUMIF = k).
      for (const { col, name } of level.domains) {
        const addr = `${offsetCol(col, k - 1)}${level.domainTotalRow}`;
        const key = `L${level.level}.${name}`;
        const inc = round((a.totals.domains[key] ?? 0) - (prev?.totals.domains[key] ?? 0));
        const wb = numericValue(cell(addr));
        if (wb !== inc) diffs.push({ cell: addr, label: `Level ${level.level} ${name} total`, wb, rc: inc });
      }
      const laddr = `${offsetCol(level.levelTotalCol, k - 1)}${level.levelTotalRow}`;
      const linc = round(a.totals.levels[level.level]! - (prev?.totals.levels[level.level] ?? 0));
      const lwb = numericValue(cell(laddr));
      if (lwb !== linc) diffs.push({ cell: laddr, label: `Level ${level.level} total`, wb: lwb, rc: linc });
    }
    const totalAddr = HEADER.workbookTotal[k - 1]!;
    if (a.workbookTotal !== a.totals.total || diffs.length) {
      // Point first at domain cells (the root cause), then level and grand totals.
      const domainDiffs = diffs.filter((x) => !/^Level \d total$/.test(x.label));
      const shown = domainDiffs.length ? domainDiffs : diffs;
      flags.push({
        code: "totals_mismatch",
        severity: "warn",
        admin: k,
        message:
          `Administration ${k}: workbook total ${a.workbookTotal ?? "missing"} vs recomputed ${a.totals.total}. ` +
          shown
            .map((x) => `${x.label} (${x.cell}): workbook ${x.wb ?? "blank"}, recomputed ${x.rc}`)
            .join("; ") +
          ". Recomputed values are used.",
        cells: [...shown.map((x) => x.cell), totalAddr],
        workbookValue: a.workbookTotal,
        recomputedValue: a.totals.total,
      });
    }
  }

  // --- Formula cells: compare against the blank template.
  const overwritten: { addr: string; value: string }[] = [];
  const echoicLiteral: string[] = [];
  const echoicDeleted: string[] = [];
  for (const [addr, formula] of Object.entries(TEMPLATE)) {
    if (HEADER.ignored.includes(addr)) continue;
    const c = cell(addr);
    if (c?.f) continue; // still a formula
    if (isEchoicCell(addr)) {
      (isBlank(c) ? echoicDeleted : echoicLiteral).push(addr);
      continue;
    }
    void formula;
    overwritten.push({ addr, value: isBlank(c) ? "blank" : String(c!.v) });
  }
  if (overwritten.length)
    flags.push({
      code: "formula_overwritten",
      severity: "warn",
      message: `Formula cells were overwritten or deleted: ${overwritten.map((o) => `${o.addr} = ${o.value}`).join(", ")}. Totals were recomputed from the grid.`,
      cells: overwritten.map((o) => o.addr),
    });
  if (echoicLiteral.length)
    flags.push({
      code: "echoic_overwritten",
      severity: "info",
      message:
        "Echoic scores were typed in directly instead of coming from the EESA sheet. They are used as the BCBA's scores.",
      cells: echoicLiteral,
    });
  if (echoicDeleted.length)
    flags.push({
      code: "echoic_overwritten",
      severity: "info",
      message: "Echoic formula cells were deleted. Those milestones are treated as unscored unless entered.",
      cells: echoicDeleted,
    });

  // Formulas where the template has none (other than the date cells, flagged above).
  const unexpected: string[] = [];
  for (const [addr, c] of Object.entries(ws)) {
    if (addr.startsWith("!") || !(c as XLSX.CellObject).f || TEMPLATE[addr] || HEADER.testDate.includes(addr))
      continue;
    unexpected.push(addr);
  }
  if (unexpected.length)
    flags.push({
      code: "unexpected_formula",
      severity: "info",
      message: "Cells contain formulas that the blank workbook does not have.",
      cells: unexpected,
    });

  // --- Isolated scores ("verify against protocol"). Uses the final administration's scoring.
  flags.push(
    ...isolatedScoreFlags(
      raw.map((r) => ({
        level: r.level,
        domain: r.domain,
        milestone: r.milestone,
        cells: r.cells,
        scored: r.upper !== null || r.lower !== null,
        full: r.upper !== null && r.lower !== null,
        upperSet: r.upper !== null,
        lowerSet: r.lower !== null,
      })),
    ),
  );

  return { administrations, flags, phi };
}

type IsoInput = {
  level: LevelLayout;
  domain: string;
  milestone: number;
  cells: { upper: string; lower: string };
  scored: boolean;
  full: boolean;
  upperSet: boolean;
  lowerSet: boolean;
};

/**
 * A milestone is flagged when (a) the lowest milestone of its domain in that level is
 * unscored (no supporting milestones), or (b) it is a Level 2/3 score while Level 1 is
 * not fully scored. Open question in docs/QUESTIONS_FOR_BCBA.md.
 */
function isolatedScoreFlags(items: IsoInput[]): Flag[] {
  const flags: Flag[] = [];
  const level1Complete = items.filter((i) => i.level.level === 1).every((i) => i.full);
  const groups = new Map<string, IsoInput[]>();
  for (const i of items) {
    const k = `${i.level.level}|${i.domain}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  for (const group of groups.values()) {
    const level = group[0]!.level;
    const base = group.find((g) => g.milestone === level.bottomMilestone)!;
    const scored = group.filter((g) => g.scored);
    if (!scored.length) continue;
    const reasons: string[] = [];
    let hits: IsoInput[] = [];
    if (!base.scored) {
      hits = scored;
      reasons.push(
        `lower milestones in ${level.level === 1 ? "this level" : `Level ${level.level}`} ${group[0]!.domain} are unscored`,
      );
    }
    if (level.level > 1 && !level1Complete) {
      hits = scored;
      reasons.push("Level 1 is not fully scored");
    }
    if (!hits.length) continue;
    const cells = hits.flatMap(
      (h) => [h.upperSet && h.cells.upper, h.lowerSet && h.cells.lower].filter(Boolean) as string[],
    );
    flags.push({
      code: "isolated_score",
      severity: "warn",
      level: level.level,
      domain: group[0]!.domain,
      milestones: hits.map((h) => h.milestone).sort((a, b) => a - b),
      cells,
      message: `Level ${level.level} ${group[0]!.domain} milestone(s) ${hits
        .map((h) => h.milestone)
        .sort((a, b) => a - b)
        .join(", ")} scored while ${reasons.join(" and ")}. Verify against protocol.`,
    });
  }
  return flags;
}
