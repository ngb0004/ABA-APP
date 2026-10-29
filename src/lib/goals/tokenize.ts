/**
 * Replace the standard mastery numbers in goal text with tokens for the goal's
 * structured mastery fields, so the stored fields (not the sentence) drive
 * every rendered figure.
 */
export function tokenizeMastery(text: string, ordinal: number): string {
  const k = (f: string) => `{{goal.${ordinal}.${f}}}`;
  return text
    .replace(
      /(?:at least |a minimum of )?\[?(\d{1,3})\]?% (of opportunities|procedural fidelity)/g,
      (_m, _n, what) => `${what === "procedural fidelity" ? "at least " : ""}${k("mastery_pct")} ${what}`,
    )
    .replace(
      /\b(\d+) consecutive (sessions|caregiver training sessions)/g,
      (_m, _n, what) => `${k("mastery_sessions")} consecutive ${what}`,
    )
    .replace(/\bwith (\d+) people\b/g, () => `with ${k("mastery_people")} people`);
}

/** Pull default mastery values from template text before tokenizing. */
export function masteryDefaults(text: string) {
  const pct = /\[?(\d{1,3})\]?% (?:of opportunities|procedural fidelity)/.exec(text);
  const sessions = /\b(\d+) consecutive (?:sessions|caregiver training sessions)/.exec(text);
  const people = /\bwith (\d+) people\b/.exec(text);
  return {
    masteryAccuracyPct: pct ? Number(pct[1]) : 80,
    masteryConsecutiveSessions: sessions ? Number(sessions[1]) : 5,
    masteryInstructors: people ? Number(people[1]) : 2,
  };
}
