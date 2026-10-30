import type { Role } from "@prisma/client";
import { dataset } from "./synthetic-eval";

export const org = dataset.orgs[0]!;
export const userOf = (role: Role) => org.users.find((u) => u.role === role)!;
export const ctxAs = (role: Role) => ({ orgId: org.id, userId: userOf(role).id, role });
export const clientId = (k: "client1" | "client2" | "client3") => org.clients.find((c) => c.key === k)!.id;
/** The synthetic platform curator: a BCBA member of the sample practice with the curator flag. */
export const curatorUser = org.users.find((u) => u.platformCurator)!;
export const curatorCtx = { orgId: org.id, userId: curatorUser.id, role: "BCBA" as const };
