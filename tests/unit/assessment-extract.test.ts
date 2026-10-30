import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { catalogType, loadAssessmentCatalog, parseAssessmentCatalog } from "@/lib/assessments/catalog";
import { detectFormat, MAX_IMPORT_BYTES } from "@/lib/assessments/extract/detect";
import { extractAssessmentFile, type Proposal } from "@/lib/assessments/extract";
import {
  parseDay,
  parseNumber,
  parseOfPossible,
  splitCells,
  textLine,
  type Line,
} from "@/lib/assessments/extract/lines";
import { aliasIndex, headerKind, matchLabel, proposeScores } from "@/lib/assessments/extract/match";
import { detectPhi } from "@/lib/assessments/extract/phi";
import {
  docxHtmlLines,
  ocrLangPath,
  ocrLineCells,
  pdfPageLines,
  sheetLines,
} from "@/lib/assessments/extract/read";
import { scalesFor } from "@/lib/assessments/catalog";

const catalog = loadAssessmentCatalog();
const AS_OF = "2026-10-30";
const fixture = (f: string) => readFileSync(`fixtures/assessments/${f}`);
const typeOf = (k: string) => catalogType(catalog, k)!;

async function extract(file: string, typeKey: string, module: string | null = null) {
  const { file: f, proposal } = await extractAssessmentFile({
    filename: file,
    data: fixture(file),
    catalog,
    type: typeOf(typeKey),
    module,
    asOf: AS_OF,
  });
  return { format: f.format, mime: f.mime, p: proposal };
}
/** scaleKey → [value, possible, location] for compact exact comparisons. */
const table = (p: Proposal) =>
  Object.fromEntries(p.scores.map((s) => [s.scaleKey, [s.value, s.possible, s.location]]));
const textLines = (text: string): Line[] =>
  text
    .split("\n")
    .map((t, i) => textLine(t, `line ${i + 1}`, "text"))
    .filter((l): l is Line => l !== null);
const propose = (typeKey: string, text: string, module: string | null = null) =>
  proposeScores({
    catalog,
    type: typeOf(typeKey),
    module,
    format: "txt",
    lines: textLines(text),
    asOf: AS_OF,
  });

describe("score file fixtures: exact values and locations", () => {
  it("Vineland-3 PDF (text layer): domains with percentiles, subdomain v-scales, date, form, respondent", async () => {
    const { format, mime, p } = await extract("vineland3_scores.pdf", "vineland_3");
    expect([format, mime]).toEqual(["pdf", "application/pdf"]);
    expect(table(p)).toEqual({
      abc: [71, null, "page 1, line 8"],
      abc_pct: [3, null, "page 1, line 8"],
      communication: [69, null, "page 1, line 9"],
      communication_pct: [2, null, "page 1, line 9"],
      daily_living: [76, null, "page 1, line 10"],
      daily_living_pct: [5, null, "page 1, line 10"],
      socialization: [66, null, "page 1, line 11"],
      socialization_pct: [1, null, "page 1, line 11"],
      receptive: [9, null, "page 1, line 13"],
      expressive: [8, null, "page 1, line 14"],
      written: [10, null, "page 1, line 15"],
      personal: [11, null, "page 1, line 16"],
      domestic: [10, null, "page 1, line 17"],
      community: [9, null, "page 1, line 18"],
      interpersonal: [8, null, "page 1, line 19"],
      play_leisure: [7, null, "page 1, line 20"],
      coping: [9, null, "page 1, line 21"],
    });
    // Motor Skills is not in the file: left blank for the BCBA.
    expect(p.scores.find((s) => s.scaleKey === "motor")).toBeUndefined();
    expect(p.scores.find((s) => s.scaleKey === "abc")).toMatchObject({
      matchedLabel: "Adaptive Behavior Composite",
      confidence: "high",
      flags: [],
    });
    expect(p.scores.find((s) => s.scaleKey === "daily_living")!.matchedLabel).toBe("Daily Living Skills");
    expect(p.administeredOn).toEqual({ value: "2026-04-13", location: "page 1, line 6" });
    expect(p.form).toEqual({ key: "comprehensive_interview", location: "page 1, line 4" });
    expect(p.respondent).toEqual({ key: "parent_caregiver", location: "page 1, line 5" });
    expect(p.phi).toEqual({ name: false, dob: false, memberId: false });
    expect(p.flags).toEqual([]);
  });

  it("SRS-2 PNG (local OCR): T-scores, the total's raw score, and nothing for raw columns without a scale", async () => {
    const { format, mime, p } = await extract("srs2_scores.png", "srs_2");
    expect([format, mime]).toEqual(["image", "image/png"]);
    expect(table(p)).toEqual({
      total_t: [74, null, "OCR line 8"],
      total_raw: [98, null, "OCR line 8"],
      sci: [73, null, "OCR line 9"],
      rrb: [77, null, "OCR line 10"],
      social_awareness: [70, null, "OCR line 11"],
      social_cognition: [72, null, "OCR line 12"],
      social_communication: [73, null, "OCR line 13"],
      social_motivation: [67, null, "OCR line 14"],
    });
    expect(p.administeredOn).toEqual({ value: "2026-04-13", location: "OCR line 6" });
    expect(p.form?.key).toBe("school_age");
    expect(p.respondent?.key).toBe("parent_caregiver");
  }, 60_000);

  it("ABLLS-R workbook: score and possible columns, and a date cell", async () => {
    const { format, p } = await extract("ablls_r_areas.xlsx", "ablls_r");
    expect(format).toBe("xlsx");
    expect(p.scores).toHaveLength(15);
    expect(table(p)).toMatchObject({
      cooperation: [10, 38, "Skill areas!B2"],
      receptive_language: [9, 102, "Skill areas!B4"],
      intraverbals: [0, 108, "Skill areas!B9"],
      fine_motor: [10, 34, "Skill areas!B16"],
    });
    expect(p.scores.every((s) => s.confidence === "high")).toBe(true);
    expect(p.administeredOn).toEqual({ value: "2026-10-08", location: "About!B3" });
  });

  it("AFLS CSV: 'x of y' cells", async () => {
    const { format, mime, p } = await extract("afls_basic_living.csv", "afls", "basic_living");
    expect([format, mime]).toEqual(["csv", "text/csv"]);
    expect(p.scores).toHaveLength(10);
    expect(table(p)).toMatchObject({
      self_management: [14, 32, "cell B6"],
      basic_communication: [30, 58, "cell B7"],
      nighttime_routines: [8, 16, "cell B15"],
    });
    expect(p.scores[0]!.matchedLabel).toBe("Self-Management");
    expect(p.administeredOn).toEqual({ value: "2026-10-12", location: "cell B3" });
  });

  it("PDDBI text: dot leaders and a one-line T-score heading; the name and birth date are flagged, never kept", async () => {
    const { format, p } = await extract("pddbi_parent.txt", "pddbi");
    expect(format).toBe("txt");
    expect(table(p)).toEqual({
      autism_composite: [63, null, "line 11"],
      ritualisms: [66, null, "line 12"],
      social_approach: [38, null, "line 13"],
      expressive_language: [41, null, "line 14"],
    });
    expect(p.scores.every((s) => s.confidence === "high")).toBe(true);
    expect(p.phi).toEqual({ name: true, dob: true, memberId: false });
    expect(p.flags[0]).toMatchObject({ code: "phi_present", locations: ["line 6", "line 7"] });
    // The labelled rating date is used, never the birth date.
    expect(p.administeredOn).toEqual({ value: "2026-04-13", location: "line 8" });
    expect(p.form?.key).toBe("parent");
    const json = JSON.stringify(p);
    for (const s of ["Charlie", "Testchild", "2019", "01/15"]) expect(json).not.toContain(s);
  });

  it("PSI-4 Word file: a table with raw and percentile columns", async () => {
    const { format, p } = await extract("psi4_scores.docx", "psi_4");
    expect(format).toBe("docx");
    expect(table(p)).toEqual({
      total_stress_pct: [85, null, "table 1, row 2"],
      total_stress_raw: [262, null, "table 1, row 2"],
      child_domain_pct: [90, null, "table 1, row 3"],
      parent_domain_pct: [72, null, "table 1, row 4"],
    });
    expect(p.administeredOn).toEqual({ value: "2026-05-18", location: "paragraph 6" });
    expect(p.form?.key).toBe("full_length");
  });

  it("the proposal never holds the file's own text", async () => {
    const { p } = await extract("vineland3_scores.pdf", "vineland_3");
    const json = JSON.stringify(p);
    expect(json).not.toContain("synthetic sample");
    expect(json).not.toContain("Adaptive Behavior Composite (ABC)");
  });
});

describe("cells, numbers, x of y, and dates", () => {
  it("splits on tabs, pipes, wide spaces, dot leaders, and label colons", () => {
    expect(splitCells("Total\t98\t74")).toEqual(["Total", "98", "74"]);
    expect(splitCells("Total | 98 | 74")).toEqual(["Total", "98", "74"]);
    expect(splitCells("Autism Composite ........ 63")).toEqual(["Autism Composite", "63"]);
    expect(splitCells("Date administered: 04/13/2026")).toEqual(["Date administered", "04/13/2026"]);
    expect(splitCells("Social Awareness    12    70")).toEqual(["Social Awareness", "12", "70"]);
  });
  it("reads plain numbers only", () => {
    expect(parseNumber("71")).toBe(71);
    expect(parseNumber("71.5")).toBe(71.5);
    expect(parseNumber("85%")).toBe(85);
    expect(parseNumber("<1")).toBeNull();
    expect(parseNumber("60-72")).toBeNull();
    expect(parseNumber("4/13/2026")).toBeNull();
    expect(parseNumber("Total")).toBeNull();
  });
  it("reads 'x of y', 'x/y', and 'x out of y'", () => {
    expect(parseOfPossible("14 of 32")).toEqual({ value: 14, possible: 32 });
    expect(parseOfPossible("14/32")).toEqual({ value: 14, possible: 32 });
    expect(parseOfPossible("14 out of 32 points")).toEqual({ value: 14, possible: 32 });
    expect(parseOfPossible("4/13/2026")).toBeNull();
    expect(parseOfPossible("14")).toBeNull();
  });
  it("reads common date forms and rejects impossible dates", () => {
    expect(parseDay("2026-04-13")).toBe("2026-04-13");
    expect(parseDay("04/13/2026")).toBe("2026-04-13");
    expect(parseDay("4/13/26")).toBe("2026-04-13");
    expect(parseDay("May 18, 2026")).toBe("2026-05-18");
    expect(parseDay("18 May 2026")).toBe("2026-05-18");
    expect(parseDay("02/30/2026")).toBeNull();
    expect(parseDay("13/04/2026")).toBeNull();
  });
  it("classifies column headings", () => {
    expect(headerKind("Standard score")).toBe("standard");
    expect(headerKind("v-scale")).toBe("standard");
    expect(headerKind("T-score")).toBe("t_score");
    expect(headerKind("%ile")).toBe("percentile");
    expect(headerKind("Percentile rank")).toBe("percentile");
    expect(headerKind("Raw score")).toBe("raw");
    expect(headerKind("Possible")).toBe("possible");
    expect(headerKind("Score")).toBe("score");
    expect(headerKind("90% Confidence interval")).toBe("ignore");
    expect(headerKind("Domain")).toBeNull();
  });
});

describe("label and alias matching", () => {
  const vineland = aliasIndex(scalesFor(typeOf("vineland_3"), null));
  const key = (t: string) => matchLabel(t, vineland)?.alias.key ?? null;
  it("matches names, catalog aliases, parentheticals, and common suffixes", () => {
    expect(key("ABC")).toBe("abc");
    expect(key("Adaptive Behavior Composite")).toBe("abc");
    expect(key("Adaptive Behavior Composite (ABC)")).toBe("abc");
    expect(key("DLS")).toBe("daily_living");
    expect(key("Daily Living Skills")).toBe("daily_living");
    expect(key("Daily-Living Skills Domain")).toBe("daily_living");
    expect(key("Receptive")).toBe("receptive");
    expect(key("Play & Leisure")).toBe("play_leisure");
    expect(key("Coping")).toBeNull();
    expect(key("Social")).toBeNull();
  });
  it("a kind suffix points at the companion scale", () => {
    expect(matchLabel("ABC percentile", vineland)).toMatchObject({
      alias: { key: "abc" },
      impliedKind: "percentile",
    });
    const p = propose("vineland_3", "ABC percentile: 7\nABC standard score: 78");
    expect(table(p)).toEqual({ abc_pct: [7, null, "line 1"], abc: [78, null, "line 2"] });
  });
  it("the catalog rejects an alias that names two scales", () => {
    const doc = {
      version: 1,
      assessments: [
        {
          key: "x",
          name: "X",
          group: "standardized",
          scales: [
            { key: "a", name: "Alpha", kind: "raw", aliases: ["AB"] },
            { key: "b", name: "Beta", kind: "raw", aliases: ["ab"] },
          ],
        },
      ],
    };
    expect(() => parseAssessmentCatalog(doc)).toThrow(/"ab" names both "a" and "b"/);
  });
});

describe("proposals from text", () => {
  it("without a column heading, a single number is proposed at medium confidence", () => {
    const p = propose("vineland_3", "Communication 69");
    expect(p.scores[0]).toMatchObject({ scaleKey: "communication", value: 69, confidence: "medium" });
    expect(p.scores[0]!.flags).toEqual(["no_column_header"]);
  });
  it("several numbers without a heading: the first, at low confidence", () => {
    const p = propose("vineland_3", "Communication  69  2  60-78");
    expect(p.scores[0]).toMatchObject({ value: 69, confidence: "low" });
    expect(p.scores[0]!.flags).toContain("several_numbers");
  });
  it("flags out-of-range values and scores above possible, at low confidence", () => {
    const v = propose("vineland_3", "Domain | Standard score\nABC | 190");
    expect(v.scores[0]).toMatchObject({
      scaleKey: "abc",
      value: 190,
      confidence: "low",
      flags: ["out_of_range"],
    });
    const a = propose("afls", "Toileting: 40 of 36", "basic_living");
    expect(a.scores[0]).toMatchObject({
      value: 40,
      possible: 36,
      confidence: "low",
      flags: ["over_possible"],
    });
    const t = propose("srs_2", "Total T-score: 74");
    expect(t.scores[0]).toMatchObject({ scaleKey: "total_t", value: 74, confidence: "high", flags: [] });
  });
  it("a score of possible without its possible is proposed with the possible missing", () => {
    const p = propose("ablls_r", "Imitation  6");
    expect(p.scores[0]).toMatchObject({ scaleKey: "imitation", value: 6, possible: null, confidence: "low" });
    expect(p.scores[0]!.flags).toContain("possible_missing");
  });
  it("two numbers with no heading on a score-of-possible area: score and possible", () => {
    const p = propose("ablls_r", "Imitation  6  34");
    expect(p.scores[0]).toMatchObject({ value: 6, possible: 34, confidence: "medium" });
  });
  it("a repeated scale with different numbers keeps the first and flags it", () => {
    const p = propose("srs_2", "Total: 74\nTotal: 71");
    expect(p.scores).toHaveLength(1);
    expect(p.flags.map((f) => f.code)).toContain("duplicate_scale");
  });
  it("bounded percentiles are not stored as numbers", () => {
    const p = propose("vineland_3", "Domain | Standard score | Percentile\nSocialization | 55 | <1");
    expect(table(p)).toEqual({ socialization: [55, null, "line 2"] });
    expect(p.flags.map((f) => f.code)).toContain("bounded_value");
  });
  it("a future date is not used; a type named in the file that differs from the chosen one is flagged", () => {
    const p = propose("vineland_3", "Assessment: SRS-2\nDate administered: 2027-01-05\nCommunication 69");
    expect(p.administeredOn).toBeNull();
    expect(p.flags.map((f) => f.code)).toEqual(expect.arrayContaining(["date_in_future", "type_mismatch"]));
  });
  it("nothing found: a flag, and every scale left blank", () => {
    const p = propose("psi_4", "Nothing to see here\nJust words");
    expect(p.scores).toEqual([]);
    expect(p.flags.map((f) => f.code)).toEqual(["no_scores_found"]);
  });
  it("a column heading does not carry into another table", () => {
    const lines: Line[] = [
      {
        where: "A!row 1",
        group: "A",
        cells: [
          { text: "Scale", where: "A!A1" },
          { text: "Percentile", where: "A!B1" },
        ],
      },
      {
        where: "B!row 1",
        group: "B",
        cells: [
          { text: "Communication", where: "B!A1" },
          { text: "69", where: "B!B1" },
        ],
      },
    ];
    const p = proposeScores({
      catalog,
      type: typeOf("vineland_3"),
      module: null,
      format: "xlsx",
      lines,
      asOf: AS_OF,
    });
    expect(table(p)).toEqual({ communication: [69, null, "B!B1"] });
  });
});

describe("PHI detection: flags only, never values", () => {
  it("finds labelled names, birth dates, and IDs and skips those lines", () => {
    const lines = textLines(
      [
        "Examinee: Jamie Example",
        "DOB: 03/04/2019",
        "Member ID: SYN-123456",
        "Name: ____",
        "Child Domain: 90",
        "Age: 7",
      ].join("\n"),
    );
    const r = detectPhi(lines);
    expect(r.phi).toEqual({ name: true, dob: true, memberId: true });
    expect([...r.lines]).toEqual([0, 1, 2]);
    const p = proposeScores({
      catalog,
      type: typeOf("psi_4"),
      module: null,
      format: "txt",
      lines,
      asOf: AS_OF,
    });
    const json = JSON.stringify(p);
    for (const s of ["Jamie", "Example", "03/04", "2019", "123456"]) expect(json).not.toContain(s);
    expect(p.flags[0]!.message).toBe(
      "The file contains a name, a date of birth and an ID number. They were not read or stored; those lines were skipped.",
    );
    expect(table(p)).toEqual({ child_domain_pct: [90, null, "line 5"] });
  });
  it("a birth date is never taken as the administration date", () => {
    const p = propose("srs_2", "Date of birth: 2019-02-01\nTotal: 74");
    expect(p.administeredOn).toBeNull();
    expect(p.phi.dob).toBe(true);
  });
  it("a workbook sheet named like a person is shown by number", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Total", 74]]), "Jamie Example");
    const lines = sheetLines(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer, "xlsx");
    expect(lines[0]!.cells.map((c) => c.where)).toEqual(["Sheet 1!A1", "Sheet 1!B1"]);
  });
});

describe("file type checks (magic bytes)", () => {
  it("accepts each fixture as its own type", () => {
    expect(detectFormat("a.pdf", fixture("vineland3_scores.pdf")).format).toBe("pdf");
    expect(detectFormat("a.PNG", fixture("srs2_scores.png")).format).toBe("image");
    expect(detectFormat("a.xlsx", fixture("ablls_r_areas.xlsx")).format).toBe("xlsx");
    expect(detectFormat("a.csv", fixture("afls_basic_living.csv")).format).toBe("csv");
    expect(detectFormat("a.txt", fixture("pddbi_parent.txt")).format).toBe("txt");
    expect(detectFormat("a.docx", fixture("psi4_scores.docx")).format).toBe("docx");
    expect(detectFormat("a.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])).mime).toBe("image/jpeg");
    expect(detectFormat("a.webp", Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1")).mime).toBe("image/webp");
    expect(
      detectFormat("a.xls", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])).format,
    ).toBe("xls");
  });
  it("rejects contents that do not match the name", () => {
    expect(() => detectFormat("scores.png", fixture("vineland3_scores.pdf"))).toThrow(
      /do not match its .png/,
    );
    expect(() => detectFormat("scores.pdf", Buffer.from("MZ\x90\0binary", "latin1"))).toThrow(/do not match/);
    expect(() => detectFormat("scores.docx", fixture("ablls_r_areas.xlsx"))).toThrow(/do not match/);
    expect(() => detectFormat("scores.xlsx", fixture("psi4_scores.docx"))).toThrow(/do not match/);
    expect(() => detectFormat("scores.txt", Buffer.from([0x41, 0x00, 0x42]))).toThrow(/do not match/);
    expect(() => detectFormat("scores.csv", fixture("srs2_scores.png"))).toThrow(/do not match/);
  });
  it("rejects unsupported types, empty files, and files over 15 MB", () => {
    expect(() => detectFormat("macro.xlsm", fixture("ablls_r_areas.xlsx"))).toThrow(/Upload an Excel/);
    expect(() => detectFormat("x.exe", Buffer.from("MZ"))).toThrow(/Upload an Excel/);
    expect(() => detectFormat("a.txt", Buffer.alloc(0))).toThrow(/empty/);
    try {
      detectFormat("big.txt", Buffer.alloc(MAX_IMPORT_BYTES + 1, 0x41));
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ status: 413 });
    }
  });
});

describe("readers", () => {
  it("OCR uses the English data bundled in node_modules (nothing is fetched)", () => {
    expect(ocrLangPath()).toMatch(/node_modules\/@tesseract\.js-data\/eng\/4\.0\.0_best_int$/);
    expect(existsSync(`${ocrLangPath()}/eng.traineddata.gz`)).toBe(true);
  });
  it("groups PDF text items into lines and cells", () => {
    const it = (str: string, x: number, y: number, w: number) => ({ str, x, y, w, h: 12 });
    const lines = pdfPageLines(
      [
        it("Total", 24, 700, 30),
        it(" ", 54, 700, 100),
        it("98", 200, 700.5, 12),
        it("74", 300, 700, 12),
        it("Next", 24, 680, 30),
      ],
      2,
    );
    expect(lines.map((l) => [l.where, l.cells.map((c) => c.text)])).toEqual([
      ["page 2, line 1", ["Total", "98", "74"]],
      ["page 2, line 2", ["Next"]],
    ]);
  });
  it("splits OCR words into cells at wide gaps and keeps the lowest word confidence", () => {
    const w = (text: string, x0: number, x1: number, confidence = 95) => ({
      text,
      confidence,
      bbox: { x0, x1, y0: 0, y1: 14 },
    });
    const cells = ocrLineCells(
      [w("Social", 30, 75), w("Awareness", 80, 157), w("12", 385, 401), w("70", 505, 521, 61)],
      "OCR line 3",
    );
    expect(cells.map((c) => [c.text, c.conf])).toEqual([
      ["Social Awareness", 95],
      ["12", 95],
      ["70", 61],
    ]);
  });
  it("reads Word paragraphs and table rows", () => {
    const lines = docxHtmlLines(
      "<p>Form: Short Form</p><table><tr><td><p>Total Stress</p></td><td><p>85</p></td></tr></table><p>After</p>",
    );
    expect(lines.map((l) => [l.where, l.cells.map((c) => c.text)])).toEqual([
      ["paragraph 1", ["Form", "Short Form"]],
      ["table 1, row 1", ["Total Stress", "85"]],
      ["paragraph 2", ["After"]],
    ]);
  });
  it("reads workbooks as values only: formulas are not evaluated or kept", () => {
    const ws = XLSX.utils.aoa_to_sheet([["Total", 74]]);
    ws["B1"] = { t: "n", v: 74, f: "SUM(Z1:Z9)" };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Scores");
    const lines = sheetLines(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer, "xlsx");
    expect(lines[0]!.cells).toEqual([
      { text: "Total", where: "Scores!A1" },
      { text: "74", where: "Scores!B1", num: 74 },
    ]);
  });
  it("a PDF with no text layer asks for an image or hand entry", async () => {
    // A minimal one-page PDF with no text.
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
      "latin1",
    );
    await expect(
      extractAssessmentFile({
        filename: "scan.pdf",
        data: pdf,
        catalog,
        type: typeOf("srs_2"),
        module: null,
        asOf: AS_OF,
      }),
    ).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/No text found in this PDF/) });
  });
});
