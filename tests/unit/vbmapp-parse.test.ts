import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseVbmappWorkbook } from "@/lib/vbmapp/parse";

const load = (f: string) => readFileSync(`fixtures/vbmapp/${f}`);
const NOW = new Date("2026-10-29T12:00:00Z");

describe("VB-MAPP import: sample_A_level2.xlsm", () => {
  const r = parseVbmappWorkbook(load("sample_A_level2.xlsm"), { now: NOW });

  it("has one administration with recomputed totals 77.5 (L1 45, L2 29.5, L3 3)", () => {
    expect(r.administrations).toHaveLength(1);
    const a = r.administrations[0]!;
    expect(a.adminNumber).toBe(1);
    expect(a.totals.total).toBe(77.5);
    expect(a.totals.levels).toEqual({ 1: 45, 2: 29.5, 3: 3 });
    expect(a.totals.domains["L1.Listener"]).toBe(5);
    expect(a.workbookTotal).toBe(73.5);
    expect(a.testerInitials).toBe("AW");
  });

  it("flags a totals mismatch pointing at the Level 1 Listener total (N49)", () => {
    const f = r.flags.find((x) => x.code === "totals_mismatch");
    expect(f).toBeDefined();
    expect(f!.workbookValue).toBe(73.5);
    expect(f!.recomputedValue).toBe(77.5);
    expect(f!.cells).toContain("N49");
    expect(f!.message).toMatch(/Level 1 Listener/);
  });

  it("flags N49 as an overwritten formula", () => {
    expect(r.flags.some((x) => x.code === "formula_overwritten" && x.cells.includes("N49"))).toBe(true);
  });

  it("flags the bad test date on administration 1", () => {
    const f = r.flags.find((x) => x.code === "bad_date" && x.admin === 1);
    expect(f).toBeDefined();
    expect(f!.cells).toEqual(["AT6"]);
    expect(r.administrations[0]!.testDate).toBeNull();
  });

  it("notes echoic literals as info, and finds no isolated scores", () => {
    const echoic = r.flags.filter((x) => x.code === "echoic_overwritten");
    expect(echoic.length).toBeGreaterThan(0);
    expect(echoic.every((x) => x.severity === "info")).toBe(true);
    expect(r.flags.filter((x) => x.code === "isolated_score")).toHaveLength(0);
  });

  it("does not report PHI (name/DOB cells are empty)", () => {
    expect(r.phi).toEqual({ name: false, dob: false });
    expect(r.flags.some((x) => x.code === "phi_present")).toBe(false);
  });
});

describe("VB-MAPP import: sample_B_level1.xlsm", () => {
  const r = parseVbmappWorkbook(load("sample_B_level1.xlsm"), { now: NOW });

  it("recomputes 27.5 (L1 25.5, L2 1, L3 1) and matches the workbook", () => {
    expect(r.administrations).toHaveLength(1);
    const a = r.administrations[0]!;
    expect(a.totals.total).toBe(27.5);
    expect(a.totals.levels).toEqual({ 1: 25.5, 2: 1, 3: 1 });
    expect(a.testDate).toBe("2026-07-09");
    expect(r.flags.some((x) => x.code === "totals_mismatch")).toBe(false);
  });

  it("flags isolated scores on L2 Play and L3 Math, and nowhere else", () => {
    const iso = r.flags.filter((x) => x.code === "isolated_score");
    const keys = iso.map((x) => `L${x.level}.${x.domain}`).sort();
    expect(keys).toEqual(["L2.Play", "L3.Math"]);
    const play = iso.find((x) => x.domain === "Play")!;
    expect(play.cells.sort()).toEqual(["X36", "X40"]);
    expect(play.severity).toBe("warn");
    const math = iso.find((x) => x.domain === "Math")!;
    expect(math.cells.sort()).toEqual(["BL22", "BL23"]);
  });

  it("flags the formula in the test date 2 cell (AT7)", () => {
    const f = r.flags.find((x) => x.code === "bad_date" && x.cells.includes("AT7"));
    expect(f).toBeDefined();
    expect(f!.message).toMatch(/formula/i);
  });

  it("notes deleted echoic formulas in AM52:AM54", () => {
    const f = r.flags.filter((x) => x.code === "echoic_overwritten");
    const cells = f.flatMap((x) => x.cells);
    for (const c of ["AM52", "AM53", "AM54"]) expect(cells).toContain(c);
    expect(f.every((x) => x.severity === "info")).toBe(true);
  });

  it("scores lower-row-only milestones as 0.5", () => {
    const s = r.administrations[0]!.scores;
    expect(s.find((x) => x.level === 2 && x.domain === "Play" && x.milestone === 9)?.score).toBe(0.5);
    expect(s.find((x) => x.level === 3 && x.domain === "Math" && x.milestone === 12)?.score).toBe(1);
  });
});

describe("VB-MAPP import: blank_template.xlsm", () => {
  it("imports as zero administrations with no flags", () => {
    const r = parseVbmappWorkbook(load("blank_template.xlsm"), { now: NOW });
    expect(r.administrations).toHaveLength(0);
    expect(r.flags).toEqual([]);
  });
});

describe("VB-MAPP import: input safety", () => {
  it("rejects non-workbook data", () => {
    expect(() => parseVbmappWorkbook(Buffer.from("hello"), { now: NOW })).toThrow(/not an Excel workbook/i);
  });
});
