import { expect, test, type Locator } from "@playwright/test";
import { api, login } from "./helpers";

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
  await pick(ins, "Plan type", "Commercial, self-funded employer (ERISA)");
  await pick(ins, "State plan was issued in", "GA");
  await ins.getByTestId("insurance-form-submit").click();
  await expect(page.getByTestId("records-insurance")).toContainText("SYN-CIG-404040");
  await expect(page.getByTestId("records-insurance")).toContainText(
    "Commercial, self-funded employer (ERISA) · issued in GA",
  );

  // A benefits check is recorded from the insurance row's ⋯ menu (no extra buttons on the row).
  const insPanel = page.getByTestId("records-insurance");
  await expect(insPanel.getByTestId("benefits-checked")).toHaveText("Benefits not checked yet");
  await insPanel.getByRole("button", { name: "Actions for insurance" }).click();
  await insPanel.getByRole("menuitem", { name: "Record benefits check" }).click();
  const bc = page.getByTestId("benefits-check-form");
  await pick(bc, "How", "Payor portal");
  await fill(bc, "Reference number", "REF-4040");
  await pick(bc, "ABA covered", "Yes");
  await pick(bc, "Prior authorization required", "Yes");
  await fill(bc, "Visit or hour limits", "Up to 40 hours per week");
  await bc.getByTestId("benefits-check-form-submit").click();
  // Identifiers are synthetic in v1.0, call references included.
  await expect(bc.getByRole("alert")).toContainText("SYN-");
  await fill(bc, "Reference number", "SYN-REF-4040");
  await bc.getByTestId("benefits-check-form-submit").click();
  await expect(insPanel.getByTestId("benefits-checked")).toContainText("Benefits last checked");
  await expect(insPanel.getByTestId("benefits-checked")).toContainText("(payor portal)");

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
  // Start times use the 12-hour clock (the form starts at 9:00 AM).
  await expect(page.getByTestId("records-sessions")).toContainText("9:00 AM");
  await expect(page.getByTestId("records-sessions")).not.toContainText("09:00");

  // The client page now shows the authorization and evaluates the payor's rules against it.
  await page.getByRole("link", { name: /Delta Testchild/ }).click();
  await expect(page.locator("#authorization")).toContainText("SYN-AUTH-4040");

  // The client's payor requirements: the insurance, its plan, the check history, and the rules.
  await page.getByTestId("requirements-link").click();
  await page.waitForURL(/\/requirements$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Payor requirements");
  const req = page.getByTestId("requirements-insurance");
  await expect(req).toHaveCount(1);
  await expect(req.getByRole("heading", { level: 2 })).toContainText("Cigna / Evernorth");
  await expect(req.getByTestId("requirements-plan-type")).toHaveText(
    "Commercial, self-funded employer (ERISA)",
  );
  const history = req.getByTestId("benefits-history");
  await expect(history).toContainText("SYN-REF-4040");
  await expect(history).toContainText("Up to 40 hours per week");
  await expect(history).toContainText("payor portal");
  await expect(req.getByTestId("requirement-status").first()).toBeVisible();
  await expect(req.getByTestId("rule-quote").first()).not.toHaveAttribute("open", "");
  await expect(page.getByTestId("requirements-letters")).toContainText(
    "No requirements from confirmed payor letters",
  );
});

/** No sideways page scroll, and the element (when given) fits inside the viewport. */
async function fitsPhone(page: import("@playwright/test").Page, what: string, el?: Locator) {
  const { scroll, inner } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(scroll, `${what}: page scrolls sideways`).toBeLessThanOrEqual(inner);
  if (el) {
    const box = (await el.boundingBox())!;
    expect(box.x, `${what}: left edge`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${what}: right edge`).toBeLessThanOrEqual(inner);
  }
}

test("payor requirements: no insurance, a funding conflict, rule terms in Details, and phone width", async ({
  page,
}) => {
  await login(page, "bcba@sample-practice.test");
  const c = await api(page, "POST", "/api/clients", {
    firstName: "Echo",
    lastName: "Phonechild",
    dob: "2021-07-08",
    serviceAddress: { line1: "5 Fiction Way", city: "Example City", state: "GA", zip: "30000" },
    fictional: true,
  });
  await page.goto(`/clients/${c.id}/requirements`);
  await expect(page.getByText("No insurance on file")).toBeVisible();
  await expect(page.getByTestId("requirements-insurance")).toHaveCount(0);

  await page.goto(`/clients/${c.id}/records`);
  await page.getByTestId("add-insurance").click();
  const ins = page.getByTestId("insurance-form");
  await pick(ins, "Payor", "Cigna / Evernorth");
  await fill(ins, "Member ID", "SYN-CIG-505050");
  await ins.getByTestId("insurance-form-submit").click();
  const insPanel = page.getByTestId("records-insurance");
  // Blank plan type: the row says what is missing.
  await expect(insPanel.getByTestId("plan-type")).toHaveText("Plan type: Not recorded");
  await insPanel.getByRole("button", { name: "Actions for insurance" }).click();
  await insPanel.getByRole("menuitem", { name: "Edit" }).click();
  const edit = page.getByRole("dialog");
  await edit.getByLabel("Plan type", { exact: true }).selectOption({ label: "Commercial, fully insured" });
  await edit.getByRole("button", { name: /Save/ }).click();
  await expect(insPanel.getByTestId("plan-type")).toHaveText("Plan type: Commercial, fully insured");

  // Phone width: the benefits check dialog fits on screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await fitsPhone(page, "records");
  await insPanel.getByRole("button", { name: "Actions for insurance" }).click();
  await insPanel.getByRole("menuitem", { name: "Record benefits check" }).click();
  const bc = page.getByTestId("benefits-check-form");
  await fitsPhone(page, "benefits check dialog", page.getByRole("dialog"));
  await pick(bc, "How", "Payor portal");
  await pick(bc, "ABA covered", "Yes");
  await pick(bc, "Prior authorization required", "Yes");
  await pick(bc, "Plan funding", "Self-funded employer (ERISA)");
  await bc.getByTestId("benefits-check-form-submit").click();
  await expect(insPanel.getByTestId("benefits-checked")).toContainText("Benefits last checked");

  await page.goto(`/clients/${c.id}/requirements`);
  await fitsPhone(page, "requirements");
  const req = page.getByTestId("requirements-insurance");
  await expect(req).toContainText("The latest benefits check disagrees with the plan type on record");
  // The rule's raw terms are behind Details; the row leads with what it means for this client.
  const row = req
    .locator("[data-rule]")
    .filter({ has: page.locator(".params-list") })
    .first();
  await expect(row.locator(".params-list")).toBeHidden();
  await row.getByTestId("requirement-details").locator("summary").click();
  await expect(row.locator(".params-list")).toBeVisible();

  // The Payor rules page and its report dialog fit on a phone too.
  await page.goto("/payors");
  await fitsPhone(page, "payor rules");
  const ga = page.locator('[data-payor="ga_medicaid"]');
  if (!(await ga.evaluate((el) => (el as HTMLDetailsElement).open)))
    await ga.locator("summary").first().click();
  const rule = ga.locator("[data-rule]").first();
  await rule.getByRole("button", { name: /^Actions for rule/ }).click();
  await rule.getByRole("menuitem", { name: "Report a problem" }).click();
  await fitsPhone(page, "report dialog", page.getByRole("dialog"));
  await expect(page.getByRole("dialog").getByLabel("What's wrong?")).toBeInViewport();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
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
  // Times across the app show in the practice's zone: Eastern until chosen.
  await expect(s.getByLabel(/^Time zone/)).toHaveValue("America/New_York");
  // States served default to the office states (GA): chips with full names, not a wall of checkboxes.
  const picked = s.getByTestId("picked-statesServed");
  await expect(picked).toHaveText(/Georgia \(GA\)/);
  await expect(s.locator('input[type="checkbox"]')).toHaveCount(0);
  await s.getByLabel(/^Add to: States we serve/).selectOption("SC");
  await expect(picked).toContainText("South Carolina (SC)");
  await s.getByTestId("settings-form-submit").click();
  await page.reload();
  await expect(page.getByTestId("settings-form").getByLabel(/Submit reauths/)).toHaveValue("28");
  await expect(page.getByTestId("picked-statesServed")).toContainText("South Carolina (SC)");
  await page.goto("/payors");
  await expect(page.getByTestId("state-filter")).toContainText("GA, SC");
  await expect(page.locator('[data-state-group="SC"]')).toContainText("No payor rules for this state yet");
  // Clearing every state sticks (it does not come back as GA after a reload).
  await page.goto("/settings");
  const s2 = page.getByTestId("settings-form");
  await s2.getByRole("button", { name: "Remove Georgia (GA)" }).click();
  await s2.getByRole("button", { name: "Remove South Carolina (SC)" }).click();
  await expect(s2.getByTestId("picked-statesServed")).toHaveText("None chosen");
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/settings") && r.request().method() === "PUT"),
    s2.getByTestId("settings-form-submit").click(),
  ]);
  await page.reload();
  await expect(page.getByTestId("picked-statesServed")).toHaveText("None chosen");
  // Put Georgia back for the other tests.
  await page
    .getByTestId("settings-form")
    .getByLabel(/^Add to: States we serve/)
    .selectOption("GA");
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/settings") && r.request().method() === "PUT"),
    page.getByTestId("settings-form").getByTestId("settings-form-submit").click(),
  ]);
  await page.reload();
  await expect(page.getByTestId("picked-statesServed")).toHaveText(/Georgia \(GA\)/);
  await page.goto("/settings");

  await page.getByTestId("add-member").click();
  const m = page.getByTestId("member-form");
  await m.getByLabel("Name").fill("Echo Newhire");
  await m.getByLabel("Email").fill("echo.newhire@sample-practice.test");
  await m.getByLabel("Role").selectOption("RBT");
  await m.getByLabel("Temporary password").fill("temporary-pass-1234");
  await m.getByTestId("member-form-submit").click();
  await expect(page.getByTestId("team")).toContainText("echo.newhire@sample-practice.test");

  // Roles change through one dropdown per person, not a row of buttons.
  const row = page.locator('[data-member="echo.newhire@sample-practice.test"]');
  await expect(row.getByRole("button", { name: /^Make / })).toHaveCount(0);
  page.once("dialog", (d) => void d.accept());
  await row.getByLabel("Role for Echo Newhire").selectOption("BCaBA");
  await expect(row.getByLabel("Role for Echo Newhire")).toHaveValue("BCaBA");
  await page.reload();
  await expect(row.getByLabel("Role for Echo Newhire")).toHaveValue("BCaBA");
  // Parent accounts are never offered a staff role.
  await expect(page.locator('[data-member="parent@sample-practice.test"] select')).toHaveCount(0);
  page.once("dialog", (d) => void d.accept());
  await row.getByRole("button", { name: "Actions for Echo Newhire" }).click();
  await row.getByRole("menuitem", { name: "Remove from practice" }).click();
  await expect(page.getByTestId("team")).not.toContainText("echo.newhire@sample-practice.test");
});

test("a BCBA removes a goal added by mistake and discontinues a goal with data, from the goal's one menu", async ({
  page,
}) => {
  await login(page, "bcba@sample-practice.test");
  const client = await api(page, "POST", "/api/clients", {
    firstName: "Echo",
    lastName: "Testchild",
    dob: "2021-03-04",
    serviceAddress: { line1: "5 Fiction Way", city: "Example City", state: "GA", zip: "30000" },
    guardians: [{ name: "Sam Testchild", relationship: "father", legalCustody: true, canSign: true }],
    fictional: true,
  });
  await page.goto(`/clients/${client.id}/goals`);
  await page.getByText(/Browse 18 domains/).click();
  const library = page.getByRole("button", { name: "Add", exact: true });
  await library.nth(0).click();
  await expect(page.getByTestId("goal-menu-1")).toBeVisible();
  await library.nth(1).click();
  await expect(page.getByTestId("goal-menu-2")).toBeVisible();

  // One menu per goal card; no loose Edit button.
  await expect(page.getByRole("button", { name: "Edit goal" })).toHaveCount(0);

  // Goal 1 gets data, so it can only be discontinued.
  const box = page.getByTestId("goal-data-1");
  await box.locator("summary").click();
  const form = page.getByTestId("data-form-1");
  await form.getByLabel("Date").fill("2026-10-20");
  await form.getByLabel(/Percent correct|Count per session|Minutes/).fill("40");
  await form.getByTestId("data-form-1-submit").click();
  await expect(box).toContainText("2026-10-20");
  await page.getByRole("button", { name: "Actions for Goal 1" }).click();
  await expect(page.getByRole("menuitem", { name: "Remove", exact: true })).toHaveCount(0);
  // "Remove…" says why it can't be removed instead of deleting.
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  const why = page.getByRole("dialog", { name: "Goal 1 can't be removed" });
  await expect(why).toContainText("This goal has data, so it can't be removed. Discontinue it instead.");
  await why.getByRole("button", { name: "OK" }).click();
  await page.getByRole("button", { name: "Actions for Goal 1" }).click();
  await page.getByRole("menuitem", { name: "Discontinue…" }).click();
  const dialog = page.getByRole("dialog", { name: "Discontinue Goal 1" });
  await dialog.getByLabel(/^Reason/).fill("Family asked to focus on other goals.");
  await dialog.getByLabel("Date discontinued").fill("2026-10-21");
  await dialog.getByRole("button", { name: "Discontinue goal" }).click();
  await expect(page.getByTestId("discontinued-1")).toContainText("discontinued 2026-10-21");
  await expect(page.getByTestId("discontinued-reason-1")).toContainText(
    "Family asked to focus on other goals.",
  );
  // The data stays.
  await expect(page.getByTestId("goal-data-1")).toContainText("1 points");

  // Goal 2 was added by mistake: Remove, after a confirm.
  page.once("dialog", (d) => {
    expect(d.message()).toBe("Remove this goal? It was added by mistake and has no data.");
    void d.accept();
  });
  await page.getByRole("button", { name: "Actions for Goal 2" }).click();
  await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
  await expect(page.getByTestId("goal-menu-2")).toHaveCount(0);

  // Resume puts goal 1 back in progress.
  await page.getByRole("button", { name: "Actions for Goal 1" }).click();
  await page.getByRole("menuitem", { name: "Resume" }).click();
  await page
    .getByRole("dialog", { name: "Resume Goal 1?" })
    .getByRole("button", { name: "Resume goal" })
    .click();
  await expect(page.getByTestId("discontinued-1")).toHaveCount(0);
});
