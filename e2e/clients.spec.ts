import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { login, openClient } from "./helpers";

test("all three synthetic clients: alerts, safety flags, intake, goals, and plans", async ({ page }) => {
  await login(page, "bcba@sample-practice.test");
  await expect(page.getByRole("heading", { name: "Due in the next 60 days" })).toBeVisible();

  const c1 = await openClient(page, "Alpha Testchild");
  await expect(page.getByTestId("safety-flag")).toHaveText([
    "Severe allergy: Peanut",
    "Epi-pen: Kept in the diaper bag",
  ]);
  await page.goto(`/clients/${c1}/intake`);
  await expect(page.getByText("restricted: BCBA only, never sent to AI").first()).toBeVisible();
  await page.getByRole("button", { name: "Submit intake" }).click();
  await expect(page.getByRole("status")).toHaveText("Intake submitted.");

  const c2 = await openClient(page, "Bravo Testchild");
  await expect(page.locator("#authorization")).toContainText("97153");
  await page.goto(`/clients/${c2}/goals`);
  await expect(page.getByText("No improvement over the last 8 weeks.")).toHaveCount(1);
  await expect(page.locator("svg line.phase-change")).toHaveCount(1);

  await openClient(page, "Charlie Testchild");
  await expect(
    page.getByTestId("client-alert").filter({ hasText: "Caregiver training shortfall" }),
  ).toBeVisible();
  await expect(page.getByTestId("safety-flag").first()).toContainText("Bolting");
  await page.getByTestId("new-reauth-plan").click();
  await page.waitForURL(/\/plans\//);
  await expect(page.getByTestId("audit-panel")).toContainText("Caregiver training below payor minimum");
});

test("VB-MAPP import: review recomputed totals and flags, then confirm", async ({ page }) => {
  await login(page, "bcba@sample-practice.test");
  const c1 = await openClient(page, "Alpha Testchild");
  await page.goto(`/clients/${c1}/vbmapp`);
  await page
    .getByTestId("vbmapp-upload")
    .locator("input[type=file]")
    .setInputFiles({
      name: "sample_B_level1.xlsm",
      mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12",
      buffer: readFileSync("fixtures/vbmapp/sample_B_level1.xlsm"),
    });
  await page.getByTestId("vbmapp-upload").getByRole("button", { name: "Upload" }).click();
  await page.waitForURL(/\/vbmapp\/imports\//);
  await expect(page.getByTestId("recomputed-total")).toHaveText("27.5");
  await expect(page.getByTestId("import-flag").filter({ hasText: "isolated score" })).toHaveCount(2);
  await expect(page.getByTestId("import-flag").filter({ hasText: "AT7" })).toHaveCount(1);
  await page.getByTestId("confirm-import").click();
  await page.waitForURL(new RegExp(`/clients/${c1}/vbmapp$`));
  await expect(page.getByText("verified by BCBA")).toBeVisible();
});
