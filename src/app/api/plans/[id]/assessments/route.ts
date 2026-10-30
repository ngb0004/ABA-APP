import { z } from "zod";
import { api, readJson } from "@/lib/server/api";
import { setPlanAssessments } from "@/lib/services/plans";

/** The assessments this plan uses: the full selection (assessment ids), replacing the old one. */
export const PUT = api<{ id: string }>(async (req, ctx, { id }) => {
  const { assessmentIds } = await readJson(
    req,
    z.object({ assessmentIds: z.array(z.uuid()).max(200) }).strict(),
  );
  return setPlanAssessments(ctx, id, assessmentIds);
});
