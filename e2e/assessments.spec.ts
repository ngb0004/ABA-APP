import { expect, test, type Page } from "@playwright/test";
import { login, openClient } from "./helpers";

async function noSidewaysScroll(page: Page, what: string) {
  const { scroll, inner } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(scroll, `${what}: page scrolls sideways`).toBeLessThanOrEqual(inner);
}

/** The one "Add assessment" menu, then the assessment inside the dialog. */
async function openAdd(page: Page, mode: "Enter scores" | "Import a file") {
  await page.getByRole("button", { name: /^Add assessment/ }).click();
  await page.getByRole("menuitem", { name: `${mode}…` }).click();
}
async function chooseAdd(page: Page, mode: "Enter scores" | "Import a file", type: string) {
  await openAdd(page, mode);
  await page
    .getByRole("dialog", { name: mode })
    .getByRole("combobox", { name: "Assessment", exact: true })
    .selectOption({ label: type });
}

async function loadSample(page: Page, type: string, file: string) {
  await chooseAdd(page, "Import a file", type);
  const dialog = page.getByRole("dialog", { name: "Import a file" });
  await dialog.getByRole("combobox", { name: /load a fictional sample file/ }).selectOption(file);
  await dialog.getByRole("button", { name: "Load sample" }).click();
  await expect(page).toHaveURL(/\/assessments\/imports\/[0-9a-f-]{36}$/);
  await expect(page).toHaveTitle("Review score import · Yoma");
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

  // Add an SRS-2 teacher rating: one dropdown ("Enter scores" or "Import a file"), then the type.
  await chooseAdd(page, "Enter scores", "SRS-2");
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
  await chooseAdd(page, "Enter scores", "VB-MAPP (import workbook)");
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
  await chooseAdd(page, "Enter scores", "AFLS: Home Skills");
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

test("assessments: import score files (image and PDF samples), check every number, and confirm", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await login(page, "bcba@sample-practice.test");
  const c1 = await openClient(page, "Alpha Testchild");
  await page.goto(`/clients/${c1}/assessments`);

  // The assessment is chosen before any file: one format can hold any assessment.
  await openAdd(page, "Import a file");
  const dialog = page.getByRole("dialog", { name: "Import a file" });
  await expect(dialog.getByTestId("assessment-import")).toContainText("Choose the assessment first");
  // Focus moves into the dialog, stays there on Tab, and returns to the menu button on close.
  await expect(dialog.getByRole("combobox", { name: "Assessment", exact: true })).toBeFocused();
  for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: /^Add assessment/ })).toBeFocused();

  // An image, read with local OCR: every number shows where it was found. Then discard it.
  await loadSample(page, "SRS-2", "srs2_scores.png");
  const total = page.locator("[data-testid=import-score][data-scale=total_t]");
  await expect(total.getByTestId("import-score-source")).toHaveText("Found at OCR line 8");
  await expect(total).toContainText("high confidence");
  await expect(page.locator("#import-total_t-value")).toHaveValue("74");
  await expect(page.locator("#import-total_raw-value")).toHaveValue("98");
  await expect(
    page.locator("[data-testid=import-score][data-scale=total_raw]").getByTestId("import-score-source"),
  ).toHaveText("Found at OCR line 8 as “Total (raw score)”");
  await expect(page.locator("#import-administeredOn")).toHaveValue("2026-04-13");
  await expect(page.locator("#import-form")).toHaveValue("school_age");
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Actions for import" }).click();
  await page.getByRole("menuitem", { name: "Discard import" }).click();
  await expect(page.getByTestId("import-closed")).toContainText("discarded");

  // A PDF: 17 of the 24 Vineland-3 scales are found; the rest stay blank for the BCBA.
  await page.goto(`/clients/${c1}/assessments`);
  await loadSample(page, "Vineland-3", "vineland3_scores.pdf");
  await expect(page.getByTestId("import-scores")).toContainText("17 of 24 found");
  const abc = page.locator("[data-testid=import-score][data-scale=abc]");
  await expect(abc.getByTestId("import-score-source")).toHaveText("Found at page 1, line 8");
  await expect(page.locator("#import-motor-value")).toHaveValue("");
  const confirm = page.getByTestId("confirm-assessment-import");
  await expect(confirm).toBeDisabled();
  await expect(page.getByTestId("import-blockers")).toContainText("17 scores still to check");

  // Out of range shows at once; editing a number counts as checking it.
  await page.locator("#import-abc-value").fill("190");
  await expect(abc.getByTestId("import-score-problem")).toHaveText("out of range (20 to 140)");
  await page.locator("#import-abc-value").fill("71");
  await expect(abc.getByTestId("import-score-problem")).toHaveCount(0);
  await expect(page.locator("#import-abc-checked")).toBeChecked();

  // Each remaining number is checked one by one (there is no "check all").
  const boxes = page.locator("[data-testid=import-score] input[type=checkbox]:not(:checked):not([disabled])");
  await expect(boxes).toHaveCount(16);
  while ((await boxes.count()) > 0) await boxes.first().check();
  await page.locator("#import-administeredBy").fill("AS");
  await expect(page.getByTestId("import-blockers")).toHaveCount(0);

  await page.setViewportSize({ width: 640, height: 900 });
  await noSidewaysScroll(page, "score import review");
  await page.setViewportSize({ width: 1280, height: 900 });

  await confirm.click();
  await expect(page).toHaveURL(new RegExp(`/clients/${c1}/assessments$`));
  const vineland = page
    .getByTestId("assessment-group")
    .filter({ has: page.getByRole("heading", { name: /^Vineland-3/ }) });
  const row = vineland.getByTestId("assessment-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("confirmed");
  await expect(row).toContainText("2026-04-13");
  await expect(row).toContainText("imported from a file");
  await expect(row.getByTestId("assessment-summary")).toContainText("Adaptive Behavior Composite 71");
  await expect(page.getByTestId("pending-imports")).toHaveCount(0);
});

test("assessments in a plan: choose them, the section is flagged for a redraft, and Charlie's Vineland due status", async ({
  page,
}) => {
  await login(page, "bcba@sample-practice.test");
  const c3 = await openClient(page, "Charlie Testchild");
  await page.getByTestId("new-reauth-plan").click();
  await page.waitForURL(/\/plans\//);
  const planId = page.url().split("/plans/")[1]!;

  // A collapsed checklist: confirmed assessments from the six-month window are chosen (Charlie's
  // PSI-4); both Vineland-3 administrations are older (about 200 and 565 days).
  const panel = page.getByTestId("plan-assessments");
  await panel.locator("summary").click();
  await expect(panel.getByTestId("plan-assessments-window")).toContainText("Default window: 6 months");
  const rows = panel.getByTestId("plan-assessment");
  const vineland = rows.filter({ hasText: /^Vineland-3/ });
  await expect(vineland).toHaveCount(2);
  await expect(vineland.nth(0).getByRole("checkbox")).not.toBeChecked();
  await expect(vineland.nth(1).getByRole("checkbox")).not.toBeChecked();
  await expect(
    rows
      .filter({ hasText: /^PSI-4/ })
      .first()
      .getByRole("checkbox"),
  ).toBeChecked();
  // Choose the newer Vineland-3 before drafting.
  await vineland.nth(0).getByRole("checkbox").check();
  await expect(panel.getByTestId("plan-assessments-note")).toHaveText("Saved.");
  const vbmapp = rows.filter({ hasText: "VB-MAPP" }).first().getByRole("checkbox");
  await expect(vbmapp).toBeChecked();
  await expect(vbmapp).toBeDisabled();

  // Draft the assessment section: it names the chosen assessments by token, with source links.
  const section = page.getByTestId("section-assessment_results");
  await section.getByTestId("draft-assessment_results").click();
  await expect(section.getByTestId("state-assessment_results")).toHaveText("draft");
  const named = section.locator('a.sourced[data-key^="assessment."]').first();
  await expect(named).toBeVisible();
  await expect(named).toHaveAttribute("href", new RegExp(`/clients/${c3}/assessments#assessment-`));

  // Adding the older Vineland-3 flags the section for a redraft. Nothing is approved for the BCBA.
  await vineland.nth(1).getByRole("checkbox").check();
  await expect(panel.getByTestId("plan-assessments-note")).toHaveText("Saved. One section needs a redraft.");
  await expect(section.getByTestId("redraft-assessment_results")).toContainText("Needs a redraft");
  await expect(vineland.nth(1).getByRole("checkbox")).toBeChecked();
  await page.reload();
  await page.getByTestId("plan-assessments").locator("summary").click();
  await expect(
    page
      .getByTestId("plan-assessment")
      .filter({ hasText: /^Vineland-3/ })
      .nth(1)
      .getByRole("checkbox"),
  ).toBeChecked();
  await expect(page.getByTestId("audit-panel")).toContainText("need a redraft");

  // 640px wide: the checklist fits.
  await page.setViewportSize({ width: 640, height: 900 });
  await noSidewaysScroll(page, "plan assessments");
  await page.setViewportSize({ width: 1280, height: 900 });

  // Redrafting clears the flag.
  await section.getByTestId("draft-assessment_results").click();
  await expect(section.getByTestId("redraft-assessment_results")).toHaveCount(0);

  // Reset to default goes back to the six-month window (and flags the section again).
  await page.getByTestId("plan-assessments-reset").click();
  await expect(page.getByTestId("plan-assessments-note")).toHaveText("Saved. One section needs a redraft.");
  await expect(vineland.nth(0).getByRole("checkbox")).not.toBeChecked();
  await expect(vineland.nth(1).getByRole("checkbox")).not.toBeChecked();

  // Requirements: TRICARE outcome measures come from the confirmed assessments. Charlie's
  // authorization ends in eleven days: the PDDBI parent form (six-monthly, about 200 days ago)
  // was due 30 days before it ends; the Vineland-3 (yearly) lasts into the next authorization.
  await page.goto(`/clients/${c3}/requirements`);
  const schedule = page.getByTestId("requirements-insurance").first().getByTestId("requirement-schedule");
  const D = "\\d{4}-\\d{2}-\\d{2}";
  await expect(
    schedule
      .filter({
        hasText: new RegExp(
          `^PDDBI parent last given ${D} · overdue since ${D} \\(30 days before the authorization ends ${D}\\)$`,
        ),
      })
      .first(),
  ).toBeVisible();
  await expect(
    schedule
      .filter({
        hasText: new RegExp(
          `^Vineland-3 last given ${D} · next due ${D}, after the authorization ends ${D}$`,
        ),
      })
      .first(),
  ).toBeVisible();
  // The packet checklist shows the same lines.
  await page.goto(`/plans/${planId}/packet`);
  await expect(
    page
      .getByTestId("checklist-note")
      .filter({
        hasText: /^PDDBI parent last given .+ · overdue since .+ \(30 days before the authorization ends /,
      })
      .first(),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("checklist-note")
      .filter({ hasText: /^Vineland-3 last given .+ · next due / })
      .first(),
  ).toBeVisible();
});

test("assessments: ABLLS-R goal suggestions, the long entry form at 640px, and an other assessment", async ({
  page,
}) => {
  await login(page, "bcba@sample-practice.test");
  const c1 = await openClient(page, "Alpha Testchild");

  // Alpha's confirmed ABLLS-R suggests goals from its lowest skill areas; "+ Add goal" adds one.
  await page.goto(`/clients/${c1}/goals`);
  const suggestions = page.getByTestId("area-suggestion");
  await expect(suggestions.first()).toBeVisible();
  await expect(suggestions.first()).toContainText("ABLLS-R");
  // Goals are named, never numbered: count the goal cards.
  const goals = page.locator('div.panel[id^="goal-"]');
  const before = await goals.count();
  await suggestions
    .filter({ has: page.getByRole("button", { name: /^Add .* for / }) })
    .first()
    .getByRole("button")
    .click();
  await expect(goals).toHaveCount(before + 1);

  // The ABLLS-R entry form has a row per skill area: at 640px it scrolls down, never sideways.
  await page.goto(`/clients/${c1}/assessments`);
  await page.setViewportSize({ width: 640, height: 900 });
  await chooseAdd(page, "Enter scores", "ABLLS-R");
  const form = page.getByRole("dialog", { name: "Add ABLLS-R" });
  await expect(form.locator("[id$='-scores-0-possible']")).toBeVisible();
  await noSidewaysScroll(page, "ABLLS-R entry form");
  expect(await form.evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(true);
  await form.getByRole("button", { name: "Close" }).click();
  // Standard scores never ask for possible points.
  await chooseAdd(page, "Enter scores", "Vineland-3");
  const vin = page.getByRole("dialog", { name: "Add Vineland-3" });
  await expect(vin.locator("[id$='-scores-0-value']")).toBeVisible();
  await expect(vin.locator("[id$='-scores-0-possible']")).toHaveCount(0);
  await vin.getByRole("button", { name: "Close" }).click();
  await page.setViewportSize({ width: 1280, height: 900 });

  // An assessment not in the catalog: the BCBA names it and its scores.
  await chooseAdd(page, "Enter scores", "Other assessment");
  const other = page.getByRole("dialog", { name: "Add Other assessment" });
  await other.locator("#assessment-form-customName").fill("ADOS-2");
  await other.locator("#assessment-form-administeredOn").fill("2026-10-22");
  await other.locator("#assessment-form-administeredBy").fill("AS");
  await other.locator("#assessment-form-customScales-0-name").fill("Overall total");
  await other.locator("#assessment-form-customScales-0-kind").selectOption({ label: "raw score" });
  await other.locator("#assessment-form-customScales-0-value").fill("14");
  await other.getByTestId("assessment-form-submit").click();
  await expect(other).toHaveCount(0);
  const ados = page.getByTestId("assessment-group").filter({ hasText: "ADOS-2" });
  await expect(ados.getByTestId("assessment-row")).toContainText("draft");
  page.once("dialog", (d) => void d.accept());
  await ados.getByRole("button", { name: "Actions for assessment" }).click();
  await ados.getByRole("menuitem", { name: "Delete" }).click();
  await expect(ados).toHaveCount(0);

  // VB-MAPP rows need no ⋯ menu: the date opens the grid.
  const vbmapp = page.getByTestId("assessment-group").filter({ hasText: "VB-MAPP" });
  await expect(vbmapp.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
});

test("assessments: empty states on the list and in a plan", async ({ page }) => {
  await login(page, "bcba@other-practice.test");
  const c = await openClient(page, "Delta Otherorg");
  await page.goto(`/clients/${c}/assessments`);
  await expect(page.getByText("No assessments yet.")).toBeVisible();
  await page.goto(`/clients/${c}`);
  await page.getByTestId("new-initial-plan").click();
  await page.waitForURL(/\/plans\//);
  const panel = page.getByTestId("plan-assessments");
  await panel.locator("summary").click();
  await expect(panel).toContainText("No assessments on record.");
  await expect(panel.getByRole("link", { name: "Add one" })).toHaveAttribute(
    "href",
    `/clients/${c}/assessments`,
  );
});
