import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MockProvider, setLlmProvider } from "@/lib/ai";
import { confirmLetter, uploadLetter, verifyExtraction } from "@/lib/services/letters";
import { exportPacketPdf, markSubmitted, packetView } from "@/lib/services/packets";
import {
  approveGoal,
  approveSection,
  createPlan,
  draftSection,
  editSection,
  markSectionNotApplicable,
  planView,
  setSectionItem,
  updateGoal,
} from "@/lib/services/plans";
import { AS_OF } from "../helpers/synthetic-eval";
import { clientId, ctxAs } from "../helpers/ctx";

const bcba = ctxAs("BCBA");
const letter = (f: string) => readFileSync(`fixtures/letters/${f}`);
afterEach(() => setLlmProvider(null));

describe("payor letters", () => {
  it("classifies each synthetic letter", async () => {
    setLlmProvider(new MockProvider());
    const expected: Record<string, string> = {
      "client2_cigna_approval.txt": "approval",
      "client3_tricare_rfi.txt": "request_for_info",
      "denial.txt": "denial",
      "reduction.txt": "reduction",
      "p2p_offer.txt": "p2p_offer",
    };
    for (const [f, cls] of Object.entries(expected))
      expect((await uploadLetter(bcba, clientId("client2"), f, letter(f))).classification).toBe(cls);
  });

  it("extracts decision fields from verbatim quotes, parsed by code", async () => {
    const mock = new MockProvider();
    setLlmProvider(mock);
    const r = await uploadLetter(
      bcba,
      clientId("client2"),
      "client2_cigna_approval.pdf",
      letter("client2_cigna_approval.pdf"),
    );
    const f = Object.fromEntries(r.fields.map((x) => [x.field, x]));
    expect(f.start_date).toMatchObject({ verified: true, value: "2026-11-20" });
    expect(f.end_date).toMatchObject({ verified: true, value: "2027-05-19" });
    expect(f["units.97153"]).toMatchObject({ verified: true, value: 640, basis: "month" });
    expect(f.deadline).toMatchObject({ verified: true, value: "2027-04-19" });
    expect(r.requirements).toHaveLength(3);
    const sent = mock.calls.map((c) => c.user).join("");
    expect(sent).not.toMatch(/Bravo|Testchild|SYN-CIG-000202/);
    expect(sent).toContain("[member-id]");
  });

  it("drops a quote that is not in the letter", () => {
    const v = verifyExtraction("97153 approved at 640 units per month", [
      { field: "units.97153", quote: "97153 approved at 999 units per month" },
    ]);
    expect(v[0]).toMatchObject({ verified: false, value: null });
  });
});

describe("reauth packet export", () => {
  it("is blocked until every section is approved and the audit passes, then exports a PDF", async () => {
    setLlmProvider(new MockProvider());
    const cid = clientId("client2");
    const plan = await createPlan(bcba, cid, "reauth");
    const up = await uploadLetter(
      bcba,
      cid,
      "client2_cigna_approval.txt",
      letter("client2_cigna_approval.txt"),
    );
    await confirmLetter(bcba, up.id);
    await expect(exportPacketPdf(bcba, plan.id, AS_OF)).rejects.toMatchObject({ status: 409 });

    let v = await planView(bcba, plan.id, AS_OF);
    expect(v.goals).toHaveLength(9);
    for (const s of v.sections) {
      if (s.key === "skill_acquisition_goals") continue;
      if (s.conditional)
        await markSectionNotApplicable(bcba, plan.id, s.key, "Not requested for this period");
      else if (s.bcbaOnly)
        await editSection(bcba, plan.id, s.key, "Written and signed by the supervising BCBA.", AS_OF);
      else await draftSection(bcba, plan.id, s.key, AS_OF);
    }
    const goals = v.goals;
    const summary = goals
      .filter((g) => g.category !== "caregiver")
      .map(
        (g) =>
          `Goal ${g.ordinal}: from {{goal.${g.ordinal}.baseline_${g.measure === "percent" ? "pct" : "rate"}}} to {{goal.${g.ordinal}.current_${g.measure === "percent" ? "pct" : "rate"}}}.`,
      )
      .join("\n");
    await editSection(bcba, plan.id, "skill_acquisition_goals", summary, AS_OF);
    for (const g of goals) {
      if (g.ordinal === 3)
        await updateGoal(bcba, g.id, { flatExplanation: "Plateau explained; procedure revised." });
      await approveGoal(bcba, g.id);
    }
    v = await planView(bcba, plan.id, AS_OF);
    for (const s of v.sections) {
      if (s.state === "not_applicable") continue;
      for (const i of s.items.filter((x) => x.status === null))
        await setSectionItem(bcba, plan.id, s.key, i.key, "answered");
      // One section approved at a time; there is no approve-all.
      await approveSection(bcba, plan.id, s.key, AS_OF);
    }
    v = await planView(bcba, plan.id, AS_OF);
    expect(v.blockers.map((b) => `${b.id}: ${b.message}`)).toEqual([]);
    const out = await exportPacketPdf(bcba, plan.id, AS_OF);
    expect(out.pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const pv = await packetView(bcba, plan.id, AS_OF);
    expect(pv.packet!.status).toBe("ready");
    expect(pv.checklist.some((i) => i.source === "letter" && /transition and fade plan/i.test(i.label))).toBe(
      true,
    );
    await expect(markSubmitted(ctxAs("RBT"), plan.id)).rejects.toMatchObject({ status: 403 });
    await markSubmitted(ctxAs("AUTH_COORDINATOR"), plan.id);
    expect((await packetView(bcba, plan.id, AS_OF)).packet!.status).toBe("submitted");
  }, 120_000);
});
