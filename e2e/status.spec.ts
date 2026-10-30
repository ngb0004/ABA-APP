import { expect, test } from "@playwright/test";
import { login, openClient } from "./helpers";

const alertsPanel = (page: import("@playwright/test").Page) =>
  page.locator(".panel").filter({ has: page.getByRole("heading", { name: "Alerts", exact: true }) });

test("mark a client inactive from the ⋯ menu, find it on the Inactive tab, then reactivate it", async ({
  page,
  browser,
}) => {
  await login(page, "bcba@sample-practice.test");
  // Golf (seeded inactive) never shows on the caseload; Charlie has alerts while active.
  await expect(page.getByRole("link", { name: /Golf Testchild/ })).toHaveCount(0);
  await expect(alertsPanel(page).getByRole("link", { name: "Charlie Testchild" })).toBeVisible();

  const id = await openClient(page, "Charlie Testchild");
  await expect(page.getByTestId("client-alert").first()).toBeVisible();
  await page.getByRole("button", { name: "Actions for client" }).click();
  await page.getByRole("menuitem", { name: "Mark inactive…" }).click();
  const dialog = page.getByRole("dialog", { name: "Mark client inactive" });
  await expect(dialog).toContainText("Alerts and due dates stop");
  await expect(dialog.getByLabel("Inactive since")).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await dialog.getByLabel("Reason").selectOption({ label: "Transferred to another provider" });
  await dialog.getByRole("button", { name: "Mark inactive" }).click();

  await expect(page.getByTestId("inactive-banner")).toContainText(
    /Inactive since \d{4}-\d{2}-\d{2}: Transferred to another provider/,
  );
  await expect(page.getByTestId("client-alert")).toHaveCount(0);
  await expect(page.getByTestId("new-reauth-plan")).toHaveCount(0);
  const res = await page.request.post(`/api/clients/${id}/plans`, { data: { type: "reauth" } });
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toContain("Reactivate the client first");
  // Records stay readable, with the banner.
  await page.goto(`/clients/${id}/records`);
  await expect(page.getByTestId("inactive-banner")).toBeVisible();

  // The separate folder: the Inactive tab.
  await page.goto("/clients");
  await expect(
    page.getByTestId("clients-table").getByRole("link", { name: "Charlie Testchild" }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: /^Inactive \(\d+\)$/ }).click();
  await expect(page).toHaveURL(/\?status=inactive$/);
  const row = page.getByRole("row").filter({ hasText: "Charlie Testchild" });
  await expect(row).toContainText("Transferred to another provider");
  await expect(page.getByRole("row").filter({ hasText: "Golf Testchild" })).toBeVisible();

  // Gone from the caseload's alerts and due dates.
  await page.goto("/");
  await expect(alertsPanel(page).getByRole("link", { name: "Charlie Testchild" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Charlie" })).toHaveCount(0);

  // Only a BCBA sees the menu.
  const rbt = await browser.newPage();
  await login(rbt, "rbt@sample-practice.test");
  await rbt.goto(`/clients/${id}`);
  await expect(rbt.getByTestId("inactive-banner")).toBeVisible();
  await expect(rbt.getByRole("button", { name: "Actions for client" })).toHaveCount(0);
  await rbt.close();

  // Reactivate from the same menu.
  await page.goto("/clients?status=inactive");
  await page.getByRole("link", { name: "Charlie Testchild" }).click();
  await page.getByRole("button", { name: "Actions for client" }).click();
  await page.getByRole("menuitem", { name: "Reactivate" }).click();
  await page
    .getByRole("dialog", { name: "Reactivate client" })
    .getByRole("button", { name: "Reactivate client" })
    .click();
  await expect(page.getByTestId("inactive-banner")).toHaveCount(0);
  await expect(page.getByTestId("client-alert").first()).toBeVisible();
  await page.goto("/");
  await expect(alertsPanel(page).getByRole("link", { name: "Charlie Testchild" })).toBeVisible();
});
