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
    await expect(page).toHaveTitle(/ABA Plan Assistant$/);
  }
});

test("pages have distinct tab titles", async ({ page }) => {
  await login(page, "bcba@sample-practice.test");
  await expect(page).toHaveTitle("Caseload · ABA Plan Assistant");
  const id = await openClient(page, "Alpha Testchild");
  await expect(page).toHaveTitle("Client · ABA Plan Assistant");
  await page.goto(`/clients/${id}/goals`);
  await expect(page).toHaveTitle("Goals · ABA Plan Assistant");
  await page.goto("/payors");
  await expect(page).toHaveTitle("Payor rules · ABA Plan Assistant");
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
