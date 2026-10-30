import { api, readJson } from "@/lib/server/api";
import { reportRuleProblem, ReportInput } from "@/lib/services/rule-reports";

/** Anyone who can read the payor rules can report a problem with one. */
export const POST = api<{ id: string }>(async (req, ctx, { id }) => {
  const r = await reportRuleProblem(ctx, id, await readJson(req, ReportInput));
  return { reportId: r.id };
});
