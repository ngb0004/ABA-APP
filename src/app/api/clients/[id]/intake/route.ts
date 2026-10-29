import { z } from "zod";
import { api, readJson } from "@/lib/server/api";
import { asOfToday } from "@/lib/server/as-of";
import { saveIntake } from "@/lib/services/misc";

const Body = z.object({ answers: z.record(z.string(), z.unknown()), submit: z.boolean().default(false) });

export const PUT = api<{ id: string }>(async (req, ctx, { id }) => {
  const b = await readJson(req, Body);
  await saveIntake(ctx, id, b.answers, b.submit, asOfToday());
});
