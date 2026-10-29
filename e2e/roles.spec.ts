import { expect, test } from "@playwright/test";
import { login, openClient } from "./helpers";

test("an RBT session gets 403 on approve and sees no plan controls or restricted fields", async ({
  page,
  browser,
}) => {
  // A BCBA creates a plan so there is something to approve.
  const bcba = await browser.newPage();
  await login(bcba, "bcba@sample-practice.test");
  const clientId = await openClient(bcba, "Charlie Testchild");
  const created = await bcba.request.post(`/api/clients/${clientId}/plans`, { data: { type: "reauth" } });
  const { planId } = await created.json();

  await login(page, "rbt@sample-practice.test");
  await openClient(page, "Charlie Testchild");
  await expect(page.getByTestId("new-reauth-plan")).toHaveCount(0);
  const res = await page.request.post(`/api/plans/${planId}/sections/assessment_results/approve`);
  expect(res.status()).toBe(403);
  expect((await page.request.post(`/api/plans/${planId}/sections/assessment_results/draft`)).status()).toBe(
    403,
  );
  await page.goto(`/clients/${clientId}/intake`);
  await expect(page.getByText("restricted: BCBA only")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Audit log" })).toHaveCount(0);
});

test("unauthenticated API calls get 401 and pages redirect to login", async ({ page }) => {
  expect((await page.request.get("/api/plans/00000000-0000-0000-0000-000000000000/export")).status()).toBe(
    401,
  );
  await page.goto("/clients");
  await expect(page).toHaveURL(/\/login$/);
});

test("a wrong TOTP code does not sign in", async ({ page }) => {
  await page.goto("/login");
  await page.fill("#email", "bcba@sample-practice.test");
  await page.fill("#password", "synthetic-demo-only");
  await page.click("button:has-text('Continue')");
  await page.fill("#code", "000000");
  await page.click("button:has-text('Verify')");
  await expect(page.locator(".error[role=alert]")).toHaveText("Invalid code");
  await expect(page).toHaveURL(/\/login$/);
});
