import { expect, test } from "@playwright/test";
import { login, openClient } from "./helpers";

const UNKNOWN = "00000000-0000-0000-0000-000000000000";

test("unknown ids show the normal 404 page with the menu, and the tab still names the app", async ({
  page,
}) => {
  await login(page, "bcba@sample-practice.test");
  for (const url of [
    `/clients/${UNKNOWN}`,
    `/clients/${UNKNOWN}/intake`,
    `/clients/${UNKNOWN}/vbmapp`,
    `/clients/${UNKNOWN}/goals`,
    `/clients/${UNKNOWN}/records`,
    `/plans/${UNKNOWN}`,
    `/plans/${UNKNOWN}/packet`,
    `/vbmapp/imports/${UNKNOWN}`,
    "/clients/not-a-uuid",
    "/does-not-exist",
  ]) {
    const res = await page.goto(url);
    expect(res?.status(), url).toBe(404);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Caseload" }).first()).toBeVisible();
    // Pages that look a record up set their own title before finding nothing; the tab names the app either way.
    await expect(page).toHaveTitle(/Yoma$/);
  }
});

test("pages have distinct tab titles", async ({ page }) => {
  await login(page, "bcba@sample-practice.test");
  await expect(page).toHaveTitle("Caseload · Yoma");
  const id = await openClient(page, "Alpha Testchild");
  await expect(page).toHaveTitle("Client · Yoma");
  await page.goto(`/clients/${id}/goals`);
  await expect(page).toHaveTitle("Goals · Yoma");
  await page.goto("/payors");
  await expect(page).toHaveTitle("Payor rules · Yoma");
});

test("the audit log hides automatic record reads unless asked, and names users", async ({ page }) => {
  await login(page, "bcba@sample-practice.test");
  await page.goto("/audit");
  await expect(page.getByRole("cell", { name: /^Read: / })).toHaveCount(0);
  await expect(page.getByRole("cell", { name: /^Auth: login/ }).first()).toBeVisible();
  await page.getByTestId("audit-show-auto").click();
  await expect(page.getByRole("cell", { name: /^Read: / }).first()).toBeVisible();
});

test("the payor rules page explains statuses and tiers", async ({ page }) => {
  await login(page, "bcba@sample-practice.test");
  await page.goto("/payors");
  await page.getByTestId("payor-legend").locator("summary").click();
  await expect(page.getByTestId("payor-legend")).toContainText("T1");
  await expect(page.getByTestId("payor-legend")).toContainText("needs re-check");
});

test("the payor rules page groups insurers by state, with nationwide payors on their own", async ({
  page,
}) => {
  await login(page, "bcba@sample-practice.test");
  await page.goto("/payors");
  const ga = page.locator('[data-state-group="GA"]');
  const all = page.locator('[data-state-group="ALL"]');
  await expect(ga.getByRole("heading", { level: 2 })).toContainText("Georgia");
  await expect(ga.locator('[data-payor="ga_medicaid"]')).toBeVisible();
  await expect(ga.locator('[data-payor="tricare_east"]')).toHaveCount(0);
  await expect(all.getByRole("heading", { level: 2 })).toContainText("All states");
  await expect(all.locator('[data-payor="tricare_east"]')).toBeVisible();
  await expect(all.locator('[data-payor="cigna_evernorth"]')).toBeVisible();
  // Sources are grouped the same way.
  await expect(page.locator('[data-doc-group="GA"] [data-doc="ga_medicaid_asd_manual"]')).toBeVisible();
  await expect(page.locator('[data-doc-group="ALL"] [data-doc="tricare_tom_c18s3"]')).toBeVisible();
  await page.getByTestId("show-every-state").click();
  await expect(page).toHaveURL(/states=all/);
  await expect(page.getByTestId("state-filter")).toContainText("Showing every state");
});

test("a BCBA sees payor rules read-only and can report a problem; a curator reviews reports and verifies", async ({
  page,
}) => {
  await login(page, "bcba@sample-practice.test");
  await page.goto("/payors");
  await expect(page.getByTestId("payor-intro")).toContainText("Yoma's reviewers have not yet confirmed");
  await expect(page.getByTestId("open-reports")).toHaveCount(0);
  const ga = page.locator('[data-payor="ga_medicaid"]');
  if (!(await ga.evaluate((el) => (el as HTMLDetailsElement).open)))
    await ga.locator("summary").first().click();
  // Read-only: no verify controls, the source sentence collapsed, one action per rule.
  await expect(ga.locator('[data-testid^="verify-"]')).toHaveCount(0);
  await expect(page.getByText("Verify with a quote")).toHaveCount(0);
  const quote = ga.getByTestId("rule-quote").first();
  await expect(quote.locator("blockquote")).toBeHidden();
  await quote.locator("summary").click();
  await expect(quote.locator("blockquote")).toBeVisible();
  const row = ga.locator("[data-rule]").first();
  const ruleId = (await row.getAttribute("data-rule"))!;
  // The verify API refuses a practice BCBA.
  expect(
    (await page.request.post(`/api/payors/rules/${ruleId}/verify`, { data: { quote: "x" } })).status(),
  ).toBe(403);
  await row.getByTestId(`report-${ruleId}`).click();
  const form = row.getByTestId(`report-form-${ruleId}`);
  await expect(form).toContainText("Don't include client names");
  await form.getByLabel("What's wrong?").selectOption("doesnt_match_letter");
  await form.getByLabel("Details (optional)").fill("Denial for client Alpha Testchild says something else");
  await form.getByTestId(`submit-report-${ruleId}`).click();
  await expect(form.getByRole("alert")).toContainText("looks like it has a client's information");
  await form
    .getByLabel("Details (optional)")
    .fill("Our denial letter says reassessments are due every 6 months.");
  await form.getByTestId(`submit-report-${ruleId}`).click();
  await expect(row.getByTestId(`report-sent-${ruleId}`)).toBeVisible();

  // The curator (a BCBA of the sample practice with the platform flag) sees the report and verify controls.
  await page.context().clearCookies();
  await login(page, "curator@yoma-staff.test");
  await page.goto("/payors");
  const reports = page.getByTestId("open-reports");
  await expect(reports).toContainText("Our denial letter says reassessments are due every 6 months.");
  await expect(reports).toContainText("Doesn't match my authorization letter or denial");
  await expect(page.locator(`[data-rule="${ruleId}"] [data-testid="verify-${ruleId}"]`)).toBeAttached();
  await expect(page.locator(`[data-testid="report-${ruleId}"]`)).toHaveCount(0);
  page.once("dialog", (d) => d.accept("Checked against the current manual; no change needed"));
  await reports.locator('[data-testid^="resolve-"]').first().click();
  await expect(reports).toContainText("No open reports");
});
