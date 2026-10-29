/**
 * Section matching between a rule's cited section ("802/803", "Appendix D",
 * "602.3.4") and a changed section from a payor change log ("803.10").
 * A change touches a rule when either section contains the other at a
 * numbering boundary: "803" covers "803.10", but not "8031".
 */
export function splitSections(cited: string | null | undefined): string[] {
  if (!cited) return [];
  return cited
    .split(/[\/,;&]|\band\b/i)
    .map((s) =>
      s
        .trim()
        .replace(/^(section|sec\.?|§)\s*/i, "")
        // A sub-item belongs to its section: "803.4(b)" -> "803.4", "Appendix E(B)(vii)" -> "Appendix E".
        .replace(/\s*\(.*$/, "")
        .replace(/\s*[\u2013-]\s*[A-Za-z].*$/, ""),
    )
    .filter(Boolean);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function contains(outer: string, inner: string) {
  const a = norm(outer);
  const b = norm(inner);
  return a === b || b.startsWith(`${a}.`);
}

/** True when any cited section and any changed section contain one another. A null changed section touches everything. */
export function sectionsOverlap(cited: string | null | undefined, changed: string | null): boolean {
  if (changed === null) return splitSections(cited).length > 0;
  const changedParts = splitSections(changed);
  return splitSections(cited).some((c) => changedParts.some((x) => contains(c, x) || contains(x, c)));
}
