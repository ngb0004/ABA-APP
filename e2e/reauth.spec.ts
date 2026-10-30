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
  const assessment = page.getByTestId("section-assessment_results");
  await assessment.getByTestId("draft-assessment_results").click();
  await expect(assessment.getByTestId("state-assessment_results")).toHaveText("draft");
  const total = assessment.locator('a.sourced[data-key="score.total.admin2"]');
  await expect(total).toBeVisible();
  await expect(total).toHaveAttribute(
    "title",
    /VB-MAPP Milestones total, administration 2\. Source: VB-MAPP administration 2 \(recomputed from the grid\)/,
  );
  await expect(total).toHaveAttribute("href", `/clients/${clientId}/vbmapp#admin-2`);
  // Approval is blocked while required items are open.
  await assessment.getByTestId("approve-assessment_results").click();
  await expect(assessment.getByTestId("error-assessment_results")).toContainText("Required items");
  const items = assessment.locator("tr").filter({ has: page.locator("input[type=radio]") });
  const n = await items.count();
  for (let i = 0; i < n; i++) {
    const row = items.nth(i);
    if (!(await row.locator("input[type=radio]:checked").count())) {
      await row.getByLabel("Addressed").check();
      await expect(row.locator("input[type=radio]:checked")).toHaveCount(1);
    }
  }
  await assessment.getByTestId("approve-assessment_results").click();
  await expect(assessment.getByTestId("state-assessment_results")).toHaveText("approved");
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
  // Every section except the ones handled separately: assessment (approved above), the progress
  // summary, the BCBA-written attestation, and the three conditional sections.
  const keys = [
    "client_information",
    "diagnosis_and_referral",
    "biopsychosocial",
    "direct_observation",
    "goal_summary",
    "behavior_intervention_plan",
    "behavior_reduction_goals",
    "caregiver_training_goals",
    "generalization_maintenance",
    "coordination_of_care",
    "transition_fade_plan",
    "discharge_criteria",
    "crisis_plan",
    "barriers_to_treatment",
    "medical_necessity",
    "service_recommendations",
    "anticipated_schedule",
  ];
  for (const k of keys) await api(page, "POST", `/api/plans/${planId}/sections/${k}/draft`);
  await api(page, "PUT", `/api/plans/${planId}/sections/signatures_attestation`, {
    content: "Signed by the supervising BCBA.",
  });
  const summary = [1, 2, 3, 4, 5, 7]
    .map((g) => `Goal ${g}: from {{goal.${g}.baseline_pct}} to {{goal.${g}.current_pct}}.`)
    .concat(["Goal 6: from {{goal.6.baseline_rate}} to {{goal.6.current_rate}}."])
    .join("\n");
  await api(page, "PUT", `/api/plans/${planId}/sections/skill_acquisition_goals`, { content: summary });
  await page.goto(`/clients/${clientId}/goals`);
  const flatBox = page.locator("textarea[data-testid^=flat-explanation-]");
  await flatBox.fill("Plateau after a curriculum change; added visual supports and increased trials.");
  // Saved as it is typed: no Save button.
  await expect(page.getByTestId(/^flat-save-status-/)).toHaveText("Saved");
  for (let g = 1; g <= 9; g++) {
    await page.getByTestId(`approve-goal-${g}`).click();
    await expect(page.getByTestId(`approve-goal-${g}`)).toHaveCount(0);
  }
  await page.goto(`/plans/${planId}`);
  // Conditional sections that do not apply are marked so by the BCBA, with a reason.
  page.on("dialog", (d) => void d.accept("Not requested for this authorization"));
  for (const k of ["group_goals", "school_plan", "telehealth_readiness"]) {
    const section = page.getByTestId(`section-${k}`);
    await section.getByTestId(`na-button-${k}`).click();
    await expect(section.getByTestId(`state-${k}`)).toHaveText("not applicable");
  }
  for (const k of [...keys, "signatures_attestation", "skill_acquisition_goals"]) {
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
