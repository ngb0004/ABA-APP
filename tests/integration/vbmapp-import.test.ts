import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { withOrg } from "@/lib/db";
import { carryForward } from "@/lib/vbmapp/carry-forward";
import { confirmImport, importReview, uploadVbmapp } from "@/lib/services/vbmapp";
import { clientId, ctxAs } from "../helpers/ctx";

const bcba = ctxAs("BCBA");
const fixture = (f: string) => readFileSync(`fixtures/vbmapp/${f}`);

describe("VB-MAPP import workflow", () => {
  it("stores the import pending review, then saves recomputed totals with the reviewer and time", async () => {
    const up = await uploadVbmapp(
      bcba,
      clientId("client1"),
      "sample_A_level2.xlsm",
      fixture("sample_A_level2.xlsm"),
    );
    expect(up.administrations[0]!.totals.total).toBe(77.5);
    const review = await importReview(bcba, up.importId);
    expect(review.import.status).toBe("pending");
    expect(JSON.stringify(review.parsed)).not.toMatch(/"H6"|"H7"/);
    await expect(confirmImport(ctxAs("RBT"), up.importId, { stripPhi: false })).rejects.toMatchObject({
      status: 403,
    });
    const res = await confirmImport(bcba, up.importId, { stripPhi: false });
    const adm = await withOrg(bcba, (tx) =>
      tx.vbmappAdministration.findUniqueOrThrow({ where: { id: res.administrations[0]! } }),
    );
    expect((adm.totals as { total: number }).total).toBe(77.5);
    expect(adm.reviewerId).toBe(bcba.userId);
    expect(adm.reviewedAt).toBeInstanceOf(Date);
    expect((adm.flags as { code: string }[]).map((f) => f.code)).toEqual(
      expect.arrayContaining(["totals_mismatch", "bad_date"]),
    );
    await expect(confirmImport(bcba, up.importId, { stripPhi: false })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("requires confirming PHI stripping when name or DOB cells are filled", async () => {
    const wb = XLSX.read(fixture("blank_template.xlsm"), { type: "buffer", cellFormula: true });
    const ws = wb.Sheets["Milestones Grid"]!;
    ws["H6"] = { t: "s", v: "Fake Testname" };
    ws["D58"] = { t: "n", v: 1 };
    ws["D59"] = { t: "n", v: 1 };
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const up = await uploadVbmapp(bcba, clientId("client1"), "with_name.xlsx", buf);
    expect(up.flags.map((f) => f.code)).toContain("phi_present");
    expect(JSON.stringify(up)).not.toContain("Fake Testname");
    await expect(confirmImport(bcba, up.importId, { stripPhi: false })).rejects.toMatchObject({
      status: 422,
    });
    await confirmImport(bcba, up.importId, { stripPhi: true });
    const imp = await withOrg(bcba, (tx) =>
      tx.vbmappImport.findUniqueOrThrow({ where: { id: up.importId } }),
    );
    expect(imp.phiStripped).toBe(true);
    expect(JSON.stringify(imp.parsed)).not.toContain("Fake Testname");
  });

  it("rejects non-workbook uploads", async () => {
    await expect(
      uploadVbmapp(bcba, clientId("client1"), "evil.xlsm", Buffer.from("MZ not a zip")),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      uploadVbmapp(bcba, clientId("client1"), "notes.docx", fixture("blank_template.xlsm")),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("carry-forward", () => {
  it("pre-fills milestones mastered in prior administrations, keeping the earliest administration", () => {
    const prior = [
      [
        { level: 1, domain: "Mand", milestone: 1, score: 1 as const, firstAdmin: 1 },
        { level: 1, domain: "Mand", milestone: 2, score: 0.5 as const, firstAdmin: 1 },
      ],
    ];
    const next = [
      { level: 1, domain: "Mand", milestone: 2, score: 1 as const, firstAdmin: 2 },
      { level: 1, domain: "Tact", milestone: 1, score: 0.5 as const, firstAdmin: 2 },
    ];
    const out = carryForward(prior, next);
    expect(out).toEqual([
      { level: 1, domain: "Mand", milestone: 1, score: 1, firstAdmin: 1, carriedForward: true },
      { level: 1, domain: "Mand", milestone: 2, score: 1, firstAdmin: 2, carriedForward: false },
      { level: 1, domain: "Tact", milestone: 1, score: 0.5, firstAdmin: 2, carriedForward: false },
    ]);
  });
});
