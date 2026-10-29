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
    .map((s) => s.trim().replace(/^(section|sec\.?|§)\s*/i, ""))
    .filter(Boolean);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function contains(outer: string, inner: string) {
  const a = norm(outer);
  const b = norm(inner);
  return a === b || b.startsWith(`${a}.`);
}

export function sectionsOverlap(cited: string | null | undefined, changed: string): boolean {
  return splitSections(cited).some((c) => contains(c, changed) || contains(changed, c));
}
