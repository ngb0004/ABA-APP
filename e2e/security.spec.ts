import { expect, test } from "@playwright/test";
import { DEMO_PASSWORD } from "../seed/synthetic/dataset";
import { ageSessions, e2eDb } from "./db";
import { login } from "./helpers";

const GENERIC =
  "Email, password, or code is incorrect, or the account is temporarily locked. Try again later.";
const BCBA = "bcba@sample-practice.test";

test("five wrong passwords lock the account; the right one then gets the same message", async ({ page }) => {
  // An account no other test signs in with.
  const email = "coordinator@sample-practice.test";
  const tryPassword = async (password: string) => {
    await page.fill("#email", email);
    await page.fill("#password", password);
    const res = page.waitForResponse("**/api/auth/login");
    await page.click("button:has-text('Continue')");
    expect((await res).status()).toBe(401);
    await expect(page.locator(".error[role=alert]")).toHaveText(GENERIC);
  };
  try {
    await page.goto("/login");
    for (let i = 0; i < 5; i++) await tryPassword("not-the-password");
    await tryPassword(DEMO_PASSWORD);
    await expect(page.locator("#code")).toHaveCount(0);
    const u = await e2eDb().user.findUniqueOrThrow({ where: { email } });
    expect(u.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    // An unknown email reads exactly the same.
    await page.fill("#email", "nobody@sample-practice.test");
    await page.fill("#password", DEMO_PASSWORD);
    await page.click("button:has-text('Continue')");
    await expect(page.locator(".error[role=alert]")).toHaveText(GENERIC);
  } finally {
    await e2eDb().user.update({ where: { email }, data: { lockedUntil: null, failedLoginCount: 0 } });
  }
});

test("after thirty idle minutes the next page lands on sign-in with the reason", async ({ page }) => {
  await login(page, BCBA);
  await ageSessions(BCBA, 31);
  await page.goto("/clients");
  await expect(page).toHaveURL(/\/login\?reason=idle$/);
  await expect(page.getByTestId("login-notice")).toHaveText(
    "You were signed out after 30 minutes of inactivity.",
  );
  // The session is gone on the server, not just hidden.
  expect((await page.request.get("/api/auth/session")).status()).toBe(401);
});

test("a warning two minutes before idle sign-out; Stay signed in keeps the session", async ({ page }) => {
  await login(page, BCBA);
  await page.clock.install();
  await page.goto("/clients");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // Server side: 28.5 idle minutes. Browser side: run the clock to the warning.
  await ageSessions(BCBA, 28.5);
  await page.clock.fastForward("28:30");
  const warning = page.getByTestId("idle-warning");
  await expect(warning).toContainText("You will be signed out in about 2 minutes because of inactivity.");
  await warning.getByRole("button", { name: "Stay signed in" }).click();
  await expect(warning).toHaveCount(0);
  const status = await (await page.request.get("/api/auth/session")).json();
  expect(status.idleRemainingSeconds).toBeGreaterThan(29 * 60);
  // Left alone past the deadline: the page signs itself out and says why.
  await ageSessions(BCBA, 31);
  await page.clock.fastForward("30:00");
  await expect(page).toHaveURL(/\/login\?reason=idle$/);
  await expect(page.getByTestId("login-notice")).toContainText("inactivity");
});
