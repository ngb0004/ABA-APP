/**
 * What readers call a goal. Goals are not numbered in anything a reader sees (the BCBA's decision):
 * a goal is named by its domain ("Manding (Requesting) goal"), and when two goals share a domain,
 * by its category or, failing that, the first words of its objective; goals that still read the
 * same are marked "(duplicate A)", "(duplicate B)". Every goal's name is unique. Never a number.
 *
 * The internal value tokens ({{goal.3.baseline_pct}}) still use the goal's position; readers never
 * see them.
 */

export type NameableGoal = { id: string; domain: string; category: string; objective: string };

const CATEGORY_LABEL: Record<string, string> = {
  communication: "communication",
  social_play: "social and play",
  behavior_reduction: "behavior reduction",
  replacement: "replacement behavior",
  caregiver: "caregiver training",
  other: "skill",
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABEL[category] ?? category.replace(/_/g, " ");
}

/**
 * The objective's words without value references, bracketed fields, digits, or the opening
 * "[Client] will": "independently mand for a preferred item or activity".
 */
export function objectiveWords(objective: string): string[] {
  return objective
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^\p{L}\s'’-]/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^['’-]+|['’-]+$/g, ""))
    .filter(Boolean)
    .filter((w, i) => !(i === 0 && /^will$/i.test(w)));
}

/** A, B, …, Z, AA, AB, …: tells duplicates apart without a number. */
function letter(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const MIN_WORDS = 5;
const MAX_WORDS = 12;

/**
 * Reader-facing names for a client's goals, keyed by goal id: "<domain> goal", disambiguated
 * without numbers when goals share a domain.
 */
export function goalNames(goals: readonly NameableGoal[]): Map<string, string> {
  const names = new Map<string, string>();
  const byDomain = new Map<string, NameableGoal[]>();
  for (const g of goals) {
    const key = g.domain.trim().toLowerCase();
    byDomain.set(key, [...(byDomain.get(key) ?? []), g]);
  }
  for (const group of byDomain.values()) {
    const base = (g: NameableGoal) => `${g.domain} goal`;
    if (group.length === 1) {
      names.set(group[0]!.id, base(group[0]!));
      continue;
    }
    // Goals that share a domain and a category are told apart by the first words of their objective.
    const sameCategory = new Map<string, NameableGoal[]>();
    for (const g of group) sameCategory.set(g.category, [...(sameCategory.get(g.category) ?? []), g]);
    for (const [category, list] of sameCategory) {
      if (list.length === 1) {
        names.set(list[0]!.id, `${base(list[0]!)} (${categoryLabel(category)})`);
        continue;
      }
      const words = list.map((g) => objectiveWords(g.objective));
      let n = MIN_WORDS;
      const phrase = (w: string[], k: number) => w.slice(0, k).join(" ").toLowerCase();
      while (n < MAX_WORDS && new Set(words.map((w) => phrase(w, n))).size < list.length) n++;
      const named = list.map((g, i) => {
        const w = words[i]!;
        const text = w.slice(0, n).join(" ");
        return text ? `${base(g)}: “${text}${w.length > n ? "…" : ""}”` : base(g);
      });
      // Goals whose wording still reads the same (two added from one template, or differing only
      // in figures or bracketed fields) are marked as duplicates with a letter, in the order given:
      // never a number, so nobody reads it as a goal number.
      const seen = new Map<string, number>();
      const total = new Map<string, number>();
      for (const name of named) total.set(name.toLowerCase(), (total.get(name.toLowerCase()) ?? 0) + 1);
      list.forEach((g, i) => {
        const name = named[i]!;
        const key = name.toLowerCase();
        if (total.get(key)! < 2) return names.set(g.id, name);
        const k = seen.get(key) ?? 0;
        seen.set(key, k + 1);
        names.set(g.id, `${name} (duplicate ${letter(k)})`);
      });
    }
  }
  return names;
}

const STABLE_WORDS = 6;

/**
 * A goal's name from its own record alone ("Manding goal: “independently mand for a preferred
 * item…”"), for text that must not change when another goal is added or removed.
 */
export function stableGoalName(goal: NameableGoal): string {
  const w = objectiveWords(goal.objective);
  if (!w.length) return `${goal.domain} goal`;
  return `${goal.domain} goal: “${w.slice(0, STABLE_WORDS).join(" ")}${w.length > STABLE_WORDS ? "…" : ""}”`;
}

/** One goal's name among the client's goals. */
export function goalName(goal: NameableGoal, goals: readonly NameableGoal[]): string {
  return goalNames(goals).get(goal.id) ?? `${goal.domain} goal`;
}
