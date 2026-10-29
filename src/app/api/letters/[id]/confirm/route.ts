import { z } from "zod";
import { api, readJson } from "@/lib/server/api";
import { confirmLetter, LETTER_CLASSES } from "@/lib/services/letters";

const Body = z.object({
  classification: z.enum(LETTER_CLASSES).optional(),
  requirements: z.array(z.string().max(1000)).max(50).optional(),
});

export const POST = api<{ id: string }>(async (req, ctx, { id }) =>
  confirmLetter(ctx, id, await readJson(req, Body)),
);
