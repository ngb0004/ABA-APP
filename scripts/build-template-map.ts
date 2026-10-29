/**
 * Generates src/lib/vbmapp/template-formulas.json: the address → formula map of
 * the blank workbook's Milestones Grid. Used to detect overwritten formulas.
 * Contains cell addresses and spreadsheet formulas only (no assessment text).
 */
import * as XLSX from "xlsx";
import { readFileSync, writeFileSync } from "node:fs";

const wb = XLSX.read(readFileSync("fixtures/vbmapp/blank_template.xlsm"), {
  type: "buffer",
  cellFormula: true,
  bookVBA: false,
  sheets: ["Milestones Grid"],
});
const ws = wb.Sheets["Milestones Grid"]!;
const out: Record<string, string> = {};
for (const [addr, cell] of Object.entries(ws)) {
  if (addr.startsWith("!")) continue;
  const f = (cell as XLSX.CellObject).f;
  if (f) out[addr] = f;
}
const sorted = Object.fromEntries(
  Object.entries(out).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })),
);
writeFileSync("src/lib/vbmapp/template-formulas.json", JSON.stringify(sorted, null, 1) + "\n");
console.log(`wrote ${Object.keys(sorted).length} formula cells`);
