/**
 * Name matching for pseudonymization, the AI privacy guard, and log scrubbing.
 *
 * JavaScript's `\b` only treats [A-Za-z0-9_] as word characters, so `\bJosé\b` never matches
 * "José". These patterns use Unicode letter boundaries instead, and match a name with or without
 * its accents ("Jose" for "José") and with either apostrophe ("O'Brien", "O’Brien").
 */

const stripMarks = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "");

function namePattern(name: string): string {
  return [...stripMarks(name.trim())]
    .map((ch) => {
      if (ch === "'" || ch === "’" || ch === "ʼ") return "['’ʼ]";
      if (/\s/.test(ch)) return "\\s+";
      if (ch === "-" || ch === "‐" || ch === "–") return "[-‐–]";
      return ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "\\p{M}*";
    })
    .join("");
}

/** A global, case-insensitive matcher for `name`. Apply it to text.normalize("NFD"). */
export function nameRegex(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${namePattern(name)}(?![\\p{L}\\p{N}_\\p{M}])`, "giu");
}

/** Replaces each name (longest first) with its tag. Returns NFC text. */
export function replaceNames(text: string, pairs: readonly (readonly [string, string])[]): string {
  let out = text.normalize("NFD");
  const usable = pairs.filter(([n]) => n && stripMarks(n).trim().length >= 2);
  for (const [n, tag] of [...usable].sort((a, b) => b[0].length - a[0].length))
    out = out.replace(nameRegex(n), tag);
  return out.normalize("NFC");
}

/** True when `text` contains `name` as a whole word (accent- and case-insensitive). */
export function containsName(text: string, name: string): boolean {
  if (!name || stripMarks(name).trim().length < 2) return false;
  return nameRegex(name).test(text.normalize("NFD"));
}
