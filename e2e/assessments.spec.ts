import { expect, test, type Page } from "@playwright/test";
import { login, openClient } from "./helpers";

async function noSidewaysScroll(page: Page, what: string) {
  const { scroll, inner } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(scroll, `${what}: page scrolls sideways`).toBeLessThanOrEqual(inner);
}

test("assessments: every type in one list, repeats side by side, add, confirm, and VB-MAPP import", async ({
  page,
}) => {
  await login(page, "bcba@sample-practice.test");
  const c3 = await openClient(page, "Charlie Testchild");
  await page.getByTestId("assessments-link").click();
  await expect(page).toHaveURL(new RegExp(`/clients/${c3}/assessments$`));
  await expect(page).toHaveTitle("Assessments · Yoma");

  const groups = page.getByTestId("assessment-group");
  const vineland = groups.filter({ has: page.getByRole("heading", { name: /^Vineland-3/ }) });
  await expect(vineland.getByTestId("assessment-row")).toHaveCount(2);
  const progress = vineland.getByTestId("assessment-progress");
  await expect(progress.getByRole("row", { name: /Adaptive Behavior Composite/ })).toContainText("+5");
  await expect(groups.filter({ hasText: "PDDBI · Parent Form" })).toHaveCount(1);
  await expect(
    groups.filter({ hasText: "VB-MAPP" }).getByRole("link", { name: /administration 1/ }),
  ).toHaveAttribute("href", `/clients/${c3}/vbmapp#admin-1`);

  // Add an SRS-2 teacher rating: one dropdown, the form opens in a dialog.
  await page.getByRole("combobox", { name: "Add assessment" }).selectOption({ label: "SRS-2" });
  const dialog = page.getByRole("dialog", { name: "Add SRS-2" });
  await dialog.locator("#assessment-form-administeredOn").fill("2026-10-20");
  await dialog.locator("#assessment-form-administeredBy").fill("BCBA-Q");
  await dialog.locator("#assessment-form-form").selectOption({ label: "School-Age Form" });
  await dialog.locator("#assessment-form-respondent").selectOption({ label: "Teacher" });
  // Out of range first: the server explains, nothing is saved.
  await dialog.locator("#assessment-form-scores-0-value").fill("190");
  await dialog.getByTestId("assessment-form-submit").click();
  await expect(dialog.getByRole("alert")).toContainText("Total must be between 0 and 150");
  await dialog.locator("#assessment-form-scores-0-value").fill("71");
  await dialog.getByTestId("assessment-form-submit").click();
  await expect(dialog).toHaveCount(0);

  const srs = groups.filter({ has: page.getByRole("heading", { name: /^SRS-2/ }) });
  const newRow = srs.getByTestId("assessment-row").filter({ hasText: "2026-10-20" });
  await expect(newRow).toContainText("draft");
  await expect(newRow.getByTestId("assessment-summary")).toHaveText("Total T 71");
  await expect(srs.getByTestId("assessment-progress").getByRole("row", { name: /^Total/ })).toContainText(
    "-3",
  );

  // Confirm from the row's ⋯ menu; a confirmed row has no menu left.
  page.once("dialog", (d) => void d.accept());
  await newRow.getByRole("button", { name: "Actions for assessment" }).click();
  await newRow.getByRole("menuitem", { name: "Confirm" }).click();
  await expect(newRow).toContainText("confirmed");
  await expect(newRow.getByRole("button", { name: "Actions for assessment" })).toHaveCount(0);

  // 640px wide: the list still fits.
  await page.setViewportSize({ width: 640, height: 900 });
  await noSidewaysScroll(page, "assessments list");

  // VB-MAPP keeps its workbook import, reached from the same dropdown.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .getByRole("combobox", { name: "Add assessment" })
    .selectOption({ label: "VB-MAPP (import workbook)" });
  await expect(page).toHaveURL(new RegExp(`/clients/${c3}/vbmapp$`));
  await expect(page.getByTestId("vbmapp-upload")).toBeVisible();
  await page.getByRole("link", { name: /← Assessments/ }).click();
  await expect(page).toHaveURL(new RegExp(`/clients/${c3}/assessments$`));
});

test("assessments: a draft can be edited and deleted from its ⋯ menu", async ({ page }) => {
  await login(page, "bcba@sample-practice.test");
  const c2 = await openClient(page, "Bravo Testchild");
  await page.goto(`/clients/${c2}/assessments`);
  const afls = page.getByTestId("assessment-group").filter({ hasText: "AFLS · Basic Living Skills" });
  const row = afls.getByTestId("assessment-row");
  await expect(row).toContainText("draft");
  await expect(row.getByTestId("assessment-summary")).toContainText("Total (10 areas) 156 / 370");

  await row.getByRole("button", { name: "Actions for assessment" }).click();
  await row.getByRole("menuitem", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit assessment" });
  await edit.locator("[id$='-scores-0-value']").fill("16");
  await edit.getByRole("button", { name: "Save draft" }).click();
  await expect(edit).toHaveCount(0);
  await expect(row.getByTestId("assessment-summary")).toContainText("158 / 370");

  // An added draft can be deleted again.
  await page.getByRole("combobox", { name: "Add assessment" }).selectOption({ label: "AFLS: Home Skills" });
  const add = page.getByRole("dialog", { name: "Add AFLS: Home Skills" });
  await add.locator("#assessment-form-administeredOn").fill("2026-10-21");
  await add.locator("#assessment-form-administeredBy").fill("AS");
  await add.getByRole("button", { name: "Add area" }).click();
  await add.locator("#assessment-form-customScales-0-name").fill("Kitchen");
  await add.locator("#assessment-form-customScales-0-kind").selectOption({ label: "score of possible" });
  await add.locator("#assessment-form-customScales-0-value").fill("3");
  await add.locator("#assessment-form-customScales-0-possible").fill("8");
  await add.getByTestId("assessment-form-submit").click();
  await expect(add).toHaveCount(0);
  const home = page.getByTestId("assessment-group").filter({ hasText: "AFLS · Home Skills" });
  await expect(home.getByTestId("assessment-summary")).toHaveText("Total (1 area) 3 / 8");
  page.once("dialog", (d) => void d.accept());
  await home.getByRole("button", { name: "Actions for assessment" }).click();
  await home.getByRole("menuitem", { name: "Delete" }).click();
  await expect(home).toHaveCount(0);
});

test("assessments: an RBT sees the list but no add control or menus", async ({ page }) => {
  await login(page, "rbt@sample-practice.test");
  const c2 = await openClient(page, "Bravo Testchild");
  await page.goto(`/clients/${c2}/assessments`);
  await expect(page.getByTestId("assessment-row").first()).toBeVisible();
  await expect(page.getByTestId("add-assessment")).toHaveCount(0);
  await expect(page.getByTestId("assessment-menu")).toHaveCount(0);
  const res = await page.request.post(`/api/clients/${c2}/assessments`, {
    data: { typeKey: "srs_2", administeredOn: "2026-10-01", administeredBy: "RBT-A" },
  });
  expect(res.status()).toBe(403);
});
