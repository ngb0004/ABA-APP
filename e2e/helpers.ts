import { expect, type Page } from "@playwright/test";
import { authenticator } from "otplib";
import { buildDataset, DEMO_PASSWORD } from "../seed/synthetic/dataset";

const users = buildDataset("2000-01-01").orgs.flatMap((o) => o.users);

export async function login(page: Page, email: string) {
  const u = users.find((x) => x.email === email)!;
  await page.goto("/login");
  await page.fill("#email", email);
  await page.fill("#password", DEMO_PASSWORD);
  await page.click("button:has-text('Continue')");
  await page.fill("#code", authenticator.generate(u.totpSecret));
  await page.click("button:has-text('Verify')");
  await expect(page.getByRole("heading", { name: "Caseload" })).toBeVisible();
}

export async function openClient(page: Page, lastFirst: string) {
  await page.goto("/clients");
  await page.getByRole("link", { name: lastFirst }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(lastFirst);
  return page.url().split("/clients/")[1]!;
}

export async function api(page: Page, method: "POST" | "PUT" | "PATCH", url: string, data: unknown = {}) {
  const res = await page.request.fetch(url, { method, data });
  if (!res.ok()) throw new Error(`${method} ${url} -> ${res.status()} ${await res.text()}`);
  return res.json();
}
