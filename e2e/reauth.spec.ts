import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { api, login, openClient } from "./helpers";

test("Client 2 reauth: AI draft with source links, letter upload, export blocked until approved and audited", async ({
  page,
}) => {
  await login(page, "bcba@sample-practice.test");
  const clientId = await openClient(page, "Bravo Testchild");
  await page.getByTestId("new-reauth-plan").click();
  await page.waitForURL(/\/plans\//);
  const planId = page.url().split("/plans/")[1]!;

  // Draft one section with the (mocked) LLM, approve it, and see the source link on a number.
  const assessment = page.getByTestId("section-assessment");
  await assessment.getByTestId("draft-assessment").click();
  await expect(assessment.getByTestId("state-assessment")).toHaveText("draft");
  const total = assessment.locator('a.sourced[data-key="score.total.admin2"]');
  await expect(total).toBeVisible();
  await expect(total).toHaveAttribute(
    "title",
    /VB-MAPP Milestones total, administration 2\. Source: VB-MAPP administration 2 \(recomputed from the grid\)/,
  );
  await expect(total).toHaveAttribute("href", `/clients/${clientId}/vbmapp#admin-2`);
  // Approval is blocked while required items are open.
  await assessment.getByTestId("approve-assessment").click();
  await expect(assessment.getByTestId("error-assessment")).toContainText("Required items");
  const items = assessment.locator("tr").filter({ has: page.locator("input[type=radio]") });
  const n = await items.count();
  for (let i = 0; i < n; i++) {
    const row = items.nth(i);
    if (!(await row.locator("input[type=radio]:checked").count())) {
      await row.getByLabel("Addressed").check();
      await expect(row.locator("input[type=radio]:checked")).toHaveCount(1);
    }
  }
  await assessment.getByTestId("approve-assessment").click();
  await expect(assessment.getByTestId("state-assessment")).toHaveText("approved");
  await total.click();
  await expect(page).toHaveURL(new RegExp(`/clients/${clientId}/vbmapp#admin-2$`));

  // Packet: upload and confirm the payor letter; export is blocked.
  await page.goto(`/plans/${planId}/packet`);
  await page
    .getByTestId("letter-upload")
    .locator("input[type=file]")
    .setInputFiles({
      name: "client2_cigna_approval.txt",
      mimeType: "text/plain",
      buffer: readFileSync("fixtures/letters/client2_cigna_approval.txt"),
    });
  await page.getByTestId("letter-upload").getByRole("button", { name: "Upload" }).click();
  const review = page.getByTestId("letter-review");
  await expect(review.getByTestId("letter-class")).toHaveValue("approval");
  await expect(review).toContainText("640 per month");
  await review.getByTestId("confirm-letter").click();
  await expect(review).toContainText("confirmed by BCBA");
  await expect(
    page.getByText("Letter requirement: A transition and fade plan tied to each goal"),
  ).toBeVisible();
  await expect(page.getByTestId("export-blocked")).toBeVisible();
  await expect(page.getByTestId("export-pdf")).toBeDisabled();
  expect((await page.request.post(`/api/plans/${planId}/export`)).status()).toBe(409);

  // Finish the plan: draft, document progress, explain the flat goal, approve goals and each section one at a time.
  const view = await page.request.get(`/plans/${planId}`);
  expect(view.ok()).toBeTruthy();
  const keys = [
    "identifying",
    "background",
    "behavior",
    "behavior_goals",
    "caregiver",
    "services",
    "coordination",
    "crisis",
    "transition",
  ];
  for (const k of keys) await api(page, "POST", `/api/plans/${planId}/sections/${k}/draft`);
  const summary = [1, 2, 3, 4, 5, 7]
    .map((g) => `Goal ${g}: from {{goal.${g}.baseline_pct}} to {{goal.${g}.current_pct}}.`)
    .concat(["Goal 6: from {{goal.6.baseline_rate}} to {{goal.6.current_rate}}."])
    .join("\n");
  await api(page, "PUT", `/api/plans/${planId}/sections/skill_goals`, { content: summary });
  await page.goto(`/clients/${clientId}/goals`);
  const flatBox = page.locator("textarea[data-testid^=flat-explanation-]");
  await flatBox.fill("Plateau after a curriculum change; added visual supports and increased trials.");
  await page.getByRole("button", { name: "Save explanation" }).click();
  await expect(page.getByText("Saved")).toBeVisible();
  for (let g = 1; g <= 9; g++) {
    await page.getByTestId(`approve-goal-${g}`).click();
    await expect(page.getByTestId(`approve-goal-${g}`)).toHaveCount(0);
  }
  await page.goto(`/plans/${planId}`);
  for (const k of [...keys, "skill_goals"]) {
    const section = page.getByTestId(`section-${k}`);
    const rows = section.locator("tr").filter({ has: page.locator("input[type=radio]") });
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      if (!(await row.locator("input[type=radio]:checked").count())) {
        await row.getByLabel("Addressed").check();
        await expect(row.locator("input[type=radio]:checked")).toHaveCount(1);
      }
    }
    await section.getByTestId(`approve-${k}`).click();
    await expect(section.getByTestId(`state-${k}`)).toHaveText("approved");
  }
  // No approve-all control exists.
  await expect(page.getByRole("button", { name: /approve all/i })).toHaveCount(0);

  // Export now succeeds.
  await page.goto(`/plans/${planId}/packet`);
  await expect(page.getByTestId("export-blocked")).toHaveCount(0);
  const download = page.waitForEvent("download");
  await page.getByTestId("export-pdf").click();
  const file = await (await download).path();
  expect(readFileSync(file).subarray(0, 5).toString()).toBe("%PDF-");
  await page.reload();
  await expect(page.getByTestId("packet-status")).toHaveText("ready");
  await page.getByTestId("mark-submitted").click();
  await expect(page.getByTestId("packet-status")).toHaveText("submitted");
});
