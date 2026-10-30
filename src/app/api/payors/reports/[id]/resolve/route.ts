import { api, readJson } from "@/lib/server/api";
import { resolveRuleReport, ResolveInput } from "@/lib/services/rule-reports";

/** A platform curator closes a rule problem report. */
export const POST = api<{ id: string }>(async (req, ctx, { id }) =>
  resolveRuleReport(ctx, id, await readJson(req, ResolveInput)),
);
