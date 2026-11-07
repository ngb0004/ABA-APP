import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MockProvider, setLlmProvider } from "@/lib/ai";
import { toDay } from "@/lib/dates";
import { withOrg } from "@/lib/db";
import { uploadLetter } from "@/lib/services/letters";
import { uploadVbmapp } from "@/lib/services/vbmapp";
import { neutralUploadName } from "@/lib/upload-names";
import { clientId, ctxAs } from "../helpers/ctx";

const bcba = ctxAs("BCBA");
afterEach(() => setLlmProvider(null));

// A filename carrying everything it must not: a (synthetic) child's name, DOB, and member ID.
const RISKY = "Testchild_Charlie_DOB_2019-01-15_MBR123456789";

describe("uploaded filenames are never stored", () => {
  it("names an upload by kind, file type, and day only", () => {
    const at = new Date("2026-11-07T12:00:00Z");
    expect(neutralUploadName("VB-MAPP workbook", `${RISKY}.XLSM`, at)).toBe(
      "VB-MAPP workbook (.xlsm), uploaded 2026-11-07",
    );
    expect(neutralUploadName("Payor letter", "no extension", at)).toBe("Payor letter, uploaded 2026-11-07");
  });

  it("VB-MAPP workbook imports store the neutral name", async () => {
    const up = await uploadVbmapp(
      bcba,
      clientId("client1"),
      `${RISKY}.xlsm`,
      readFileSync("fixtures/vbmapp/sample_B_level1.xlsm"),
    );
    const row = await withOrg(bcba, (tx) =>
      tx.vbmappImport.findUniqueOrThrow({ where: { id: up.importId } }),
    );
    expect(row.filename).toBe(`VB-MAPP workbook (.xlsm), uploaded ${toDay(new Date())}`);
    expect(JSON.stringify(row)).not.toMatch(/Testchild|Charlie|2019-01-15|MBR123456789/);
  });

  it("payor letter uploads store the neutral name", async () => {
    setLlmProvider(new MockProvider());
    const r = await uploadLetter(
      bcba,
      clientId("client2"),
      `${RISKY}.txt`,
      readFileSync("fixtures/letters/client2_cigna_approval.txt"),
    );
    const row = await withOrg(bcba, (tx) => tx.payorLetter.findUniqueOrThrow({ where: { id: r.id } }));
    expect(row.filename).toBe(`Payor letter (.txt), uploaded ${toDay(new Date())}`);
    expect(row.filename).not.toMatch(/Testchild|Charlie|2019|MBR/);
  });
});
