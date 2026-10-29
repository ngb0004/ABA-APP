/**
 * Parses docs/reference/GOAL_BANK.md into goal templates (18 domains × 3 tiers).
 * Reviewer flags (notes to the BCBA) are dropped; they are never report content.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export type GoalCategory =
  "communication" | "social_play" | "behavior_reduction" | "replacement" | "caregiver" | "other";

export type GoalTemplateSeed = {
  domainNumber: number;
  domainName: string;
  tier: number;
  tierName: string;
  category: GoalCategory;
  goalText: string;
  rationalePattern: "A" | "B";
  rationaleText: string;
  linkedMilestones: { level: number; domain: string }[];
};

/** Goal-bank domain number → VB-MAPP domains it addresses (names only). */
export const DOMAIN_VBMAPP: Record<number, string[]> = {
  1: ["Mand"],
  2: ["Tact"],
  3: ["Listener"],
  4: ["IV"],
  5: ["Echoic"],
  6: ["Imitation"],
  7: ["VP/MTS"],
  8: ["Play"],
  9: ["Social"],
  10: ["Group"],
  14: ["Reading", "Writing", "Math", "LRFFC"],
  17: ["Mand"],
};

export function categoryForDomain(n: number): GoalCategory {
  if ([1, 2, 3, 4, 5, 17].includes(n)) return "communication";
  if ([8, 9, 10].includes(n)) return "social_play";
  if (n === 16) return "behavior_reduction";
  if (n === 18) return "caregiver";
  return "other";
}

const clean = (s: string) =>
  s
    .replace(/\*\*/g, "")
    .replace(/\\([[\]_*~#])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

export function parseGoalBank(markdown: string): GoalTemplateSeed[] {
  const out: GoalTemplateSeed[] = [];
  let domainNumber = 0;
  let domainName = "";
  let tier = 0;
  let tierName = "";
  let goalText: string | null = null;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const dm = /^#\s+\*\*(\d+)\.\s+(.+?)\*\*\s*$/.exec(line);
    if (dm) {
      domainNumber = Number(dm[1]);
      domainName = clean(dm[2]!);
      tier = 0;
      continue;
    }
    if (/^#\s/.test(line)) {
      domainNumber = 0; // non-domain heading (e.g., the audit checklist)
      continue;
    }
    if (!domainNumber) continue;
    const tm = /^\*\*Tier\s+(\d)\s+[—-]\s+(.+?)\*\*/.exec(line);
    if (tm) {
      tier = Number(tm[1]);
      tierName = clean(tm[2]!);
      goalText = null;
      continue;
    }
    const gm = /^\*\*Goal\.\*\*\s*(.+)$/.exec(line);
    if (gm && tier) {
      goalText = clean(gm[1]!);
      continue;
    }
    const rm = /^\*\*Medical necessity \(Pattern ([AB])\)\.\*\*\s*(.+)$/.exec(line);
    if (rm && tier && goalText) {
      const vb = DOMAIN_VBMAPP[domainNumber] ?? [];
      out.push({
        domainNumber,
        domainName,
        tier,
        tierName,
        category: categoryForDomain(domainNumber),
        goalText,
        rationalePattern: rm[1] as "A" | "B",
        rationaleText: clean(rm[2]!),
        linkedMilestones: vb.map((domain) => ({ level: tier, domain })),
      });
      goalText = null;
    }
  }
  return out;
}

export function loadGoalBank(file = path.join(process.cwd(), "docs/reference/GOAL_BANK.md")) {
  return parseGoalBank(readFileSync(file, "utf8"));
}
