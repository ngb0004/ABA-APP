/** Goal validation: placeholders, required categories, duplicate rationales, medical necessity links. */
import type { GoalCategory } from "./bank";

/**
 * [Client] resolves to the client's preferred name and [Caregiver] to the guardian's
 * relationship (e.g., "Mother") at render time. Every other bracket must be filled.
 */
export const AUTO_PLACEHOLDERS = new Set(["[Client]", "[Caregiver]"]);

export function unresolvedPlaceholders(...texts: (string | null | undefined)[]): string[] {
  const found = new Set<string>();
  for (const t of texts)
    for (const m of (t ?? "").matchAll(/\[[^\]\n]{1,120}\]/g))
      if (!AUTO_PLACEHOLDERS.has(m[0])) found.add(m[0]);
  return [...found];
}

export type GoalLike = {
  id: string;
  ordinal?: number;
  category: GoalCategory | string;
  objective: string;
  rationale: string;
  replacementForGoalId?: string | null;
  diagnosisId?: string | null;
  deficitArea?: string | null;
};

export type CategoryCheck = {
  category: string;
  required: number;
  found: number;
  ok: boolean;
  message: string;
};

export function requiredCategoryChecks(goals: GoalLike[]): CategoryCheck[] {
  const count = (c: string) => goals.filter((g) => g.category === c).length;
  const reductions = goals.filter((g) => g.category === "behavior_reduction");
  const unpaired = reductions.filter(
    (r) => !goals.some((g) => g.category === "replacement" && g.replacementForGoalId === r.id),
  );
  return [
    {
      category: "communication",
      required: 1,
      found: count("communication"),
      ok: count("communication") >= 1,
      message: "At least one communication goal",
    },
    {
      category: "social_play",
      required: 1,
      found: count("social_play"),
      ok: count("social_play") >= 1,
      message: "At least one social/play goal",
    },
    {
      category: "behavior_reduction",
      required: 1,
      found: reductions.length,
      ok: reductions.length >= 1 && unpaired.length === 0,
      message: unpaired.length
        ? `Behavior reduction goal(s) without a paired replacement behavior: ${unpaired.length}`
        : "Behavior reduction paired with a replacement behavior",
    },
    {
      category: "caregiver",
      required: 2,
      found: count("caregiver"),
      ok: count("caregiver") >= 2,
      message: "At least two caregiver goals",
    },
  ];
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/\{\{[^}]+\}\}|\[[^\]]+\]/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

function shingles(s: string, n = 3): Set<string> {
  const w = words(s);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

export function similarity(a: string, b: string): number {
  const A = shingles(a);
  const B = shingles(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export const DUPLICATE_RATIONALE_THRESHOLD = 0.5;

export function duplicateRationales(goals: GoalLike[], threshold = DUPLICATE_RATIONALE_THRESHOLD) {
  const pairs: { a: string; b: string; similarity: number }[] = [];
  for (let i = 0; i < goals.length; i++)
    for (let j = i + 1; j < goals.length; j++) {
      const s = similarity(goals[i]!.rationale, goals[j]!.rationale);
      if (s >= threshold)
        pairs.push({ a: goals[i]!.id, b: goals[j]!.id, similarity: Math.round(s * 100) / 100 });
    }
  return pairs;
}

export function diagnosisLinkIssues(goals: GoalLike[], diagnoses: { id: string; deficitAreas: string[] }[]) {
  return goals
    .filter((g) => {
      const d = diagnoses.find((x) => x.id === g.diagnosisId);
      return !d || !g.deficitArea || !d.deficitAreas.includes(g.deficitArea);
    })
    .map((g) => g.id);
}
