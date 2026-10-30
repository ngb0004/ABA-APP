import { expect, test, type Locator } from "@playwright/test";
import { login } from "./helpers";

/** Fill a RecordForm field by its label (inputs carry ids, labels point at them). */
const fill = (form: Locator, label: string, value: string) =>
  form.getByLabel(label, { exact: true }).fill(value);
const pick = (form: Locator, label: string, option: string) =>
  form.getByLabel(label, { exact: true }).selectOption({ label: option });

test("a BCBA enters a fictional client end to end: details, insurance, diagnosis, authorization, attachment, session, goal data", async ({
  page,
}) => {
  await login(page, "bcba@sample-practice.test");
  await page.goto("/clients");
  await page.getByTestId("new-client").click();

  const f = page.getByTestId("new-client-form");
  await fill(f, "First name", "Delta");
  await fill(f, "Last name", "Testchild");
  await fill(f, "Date of birth", "2021-05-06");
  await fill(f, "Service address", "4 Fiction Way");
  await fill(f, "City", "Example City");
  await fill(f, "ZIP", "30000");
  // Without the fictional confirmation the server refuses.
  await f.getByTestId("new-client-form-submit").click();
  await expect(f.getByRole("alert")).toContainText("fictional");
  await f.getByLabel(/This client is fictional/).check();
  await f.getByTestId("new-client-form-submit").click();
  await page.waitForURL(/\/clients\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Delta Testchild");

  await page.getByTestId("records-link").click();
  await page.waitForURL(/\/records$/);

  await page.getByTestId("add-insurance").click();
  const ins = page.getByTestId("insurance-form");
  await pick(ins, "Payor", "Cigna / Evernorth");
  await fill(ins, "Member ID", "W12345");
  await ins.getByTestId("insurance-form-submit").click();
  await expect(ins.getByRole("alert")).toContainText("SYN-");
  await fill(ins, "Member ID", "SYN-CIG-404040");
  await ins.getByTestId("insurance-form-submit").click();
  await expect(page.getByTestId("records-insurance")).toContainText("SYN-CIG-404040");

  await page.getByTestId("add-diagnosis").click();
  const dx = page.getByTestId("diagnosis-form");
  await fill(dx, "ICD-10 code", "F84.0");
  await fill(dx, "DSM-5 code", "299.00");
  await fill(dx, "Diagnosis", "Autism spectrum disorder");
  await fill(dx, "Evaluation date", "2026-02-01");
  await dx.getByLabel("communication", { exact: true }).check();
  await dx.getByTestId("diagnosis-form-submit").click();
  await expect(page.getByTestId("records-diagnoses")).toContainText("F84.0");

  await page.getByTestId("add-authorization").click();
  const au = page.getByTestId("authorization-form");
  await pick(au, "Payor", "Cigna / Evernorth");
  await fill(au, "Authorization number", "SYN-AUTH-4040");
  await fill(au, "Start", "2026-09-01");
  await fill(au, "End", "2027-02-28");
  await au.getByRole("button", { name: "Add code" }).click();
  await au.getByLabel("CPT code", { exact: true }).selectOption("97153");
  await au.getByLabel("Units", { exact: true }).fill("80");
  await au.getByLabel("Per", { exact: true }).selectOption("week");
  await au.getByTestId("authorization-form-submit").click();
  await expect(page.getByTestId("records-authorizations")).toContainText("97153: 80 per week");

  await page.getByTestId("add-attachment").click();
  const at = page.getByTestId("attachment-form");
  await at.getByLabel("Kind").selectOption("diagnostic_evaluation");
  await fill(at, "Title", "Diagnostic evaluation");
  await at.getByTestId("attachment-form-submit").click();
  await expect(page.getByTestId("records-attachments")).toContainText("Diagnostic evaluation");

  await page.getByTestId("add-session").click();
  const se = page.getByTestId("session-form");
  await se.getByLabel("CPT code").selectOption("97153");
  await fill(se, "Date", "2026-09-02");
  await fill(se, "Units (15 min)", "8");
  await fill(se, "Staff code", "RBT-Q");
  await se.getByTestId("session-form-submit").click();
  await expect(page.getByTestId("records-sessions")).toContainText("RBT-Q");

  // The client page now shows the authorization and evaluates the payor's rules against it.
  await page.getByRole("link", { name: /Delta Testchild/ }).click();
  await expect(page.locator("#authorization")).toContainText("SYN-AUTH-4040");
});

test("goal data entry by an RBT, and practice settings and team by a BCBA", async ({ page }) => {
  await login(page, "rbt@sample-practice.test");
  await page.goto("/clients");
  await page.getByRole("link", { name: "Alpha Testchild" }).click();
  await page.getByRole("link", { name: "Goals" }).click();
  const box = page.getByTestId("goal-data-1");
  await box.locator("summary").click();
  const form = page.getByTestId("data-form-1");
  await form.getByLabel("Date").fill("2026-10-27");
  await form.getByLabel(/Percent correct|Count per session|Minutes/).fill("60");
  await form.getByTestId("data-form-1-submit").click();
  await expect(box).toContainText("2026-10-27");
  // RBTs do not see practice settings.
  expect((await page.request.put("/api/settings", { data: {} })).status()).toBe(403);

  await page.context().clearCookies();
  await login(page, "bcba@sample-practice.test");
  await page.getByRole("link", { name: "Settings" }).click();
  const s = page.getByTestId("settings-form");
  await s.getByLabel(/Submit reauths/).fill("28");
  await s.getByTestId("settings-form-submit").click();
  await page.reload();
  await expect(page.getByTestId("settings-form").getByLabel(/Submit reauths/)).toHaveValue("28");

  await page.getByTestId("add-member").click();
  const m = page.getByTestId("member-form");
  await m.getByLabel("Name").fill("Echo Newhire");
  await m.getByLabel("Email").fill("echo.newhire@sample-practice.test");
  await m.getByLabel("Role").selectOption("RBT");
  await m.getByLabel("Temporary password").fill("temporary-pass-1234");
  await m.getByTestId("member-form-submit").click();
  await expect(page.getByTestId("team")).toContainText("echo.newhire@sample-practice.test");
});
