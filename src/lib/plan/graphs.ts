/** Server-rendered SVG line graph for one goal, with phase-change lines and the mastery criterion. */
import { diffDays, type Day } from "../dates";

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function goalGraphSvg(input: {
  title: string;
  measure: string;
  points: { date: Day; value: number }[];
  phaseChanges: { date: Day; label: string }[];
  masteryPct?: number | null;
  width?: number;
  height?: number;
}): string {
  const W = input.width ?? 640;
  const H = input.height ?? 240;
  const m = { l: 44, r: 12, t: 26, b: 34 };
  const pts = [...input.points].sort((a, b) => a.date.localeCompare(b.date));
  if (!pts.length)
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 60" width="${W}" height="60"><text x="10" y="35" font-size="13" font-family="Helvetica, Arial, sans-serif">${esc(input.title)}: no data</text></svg>`;
  const t0 = pts[0]!.date;
  const span = Math.max(1, diffDays(pts.at(-1)!.date, t0));
  const yMax =
    input.measure === "percent" ? 100 : Math.max(1, Math.ceil(Math.max(...pts.map((p) => p.value)) * 1.2));
  const x = (d: Day) => m.l + (diffDays(d, t0) / span) * (W - m.l - m.r);
  const y = (v: number) => H - m.b - (v / yMax) * (H - m.t - m.b);
  const parts: string[] = [];
  parts.push(`<text x="${m.l}" y="16" font-size="13" font-weight="bold">${esc(input.title)}</text>`);
  // axes and gridlines
  for (let i = 0; i <= 4; i++) {
    const v = (yMax * i) / 4;
    parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="#e2e8f0"/>`);
    parts.push(
      `<text x="${m.l - 6}" y="${y(v) + 4}" font-size="10" text-anchor="end">${Math.round(v * 10) / 10}${input.measure === "percent" ? "%" : ""}</text>`,
    );
  }
  parts.push(
    `<line x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${H - m.b}" stroke="#334155"/><line x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}" stroke="#334155"/>`,
  );
  parts.push(
    `<text x="${m.l}" y="${H - 8}" font-size="10">${t0}</text><text x="${W - m.r}" y="${H - 8}" font-size="10" text-anchor="end">${pts.at(-1)!.date}</text>`,
  );
  if (input.masteryPct && input.measure === "percent")
    parts.push(
      `<line x1="${m.l}" x2="${W - m.r}" y1="${y(input.masteryPct)}" y2="${y(input.masteryPct)}" stroke="#16a34a" stroke-dasharray="4 3"/><text x="${W - m.r}" y="${y(input.masteryPct) - 4}" font-size="10" text-anchor="end" fill="#16a34a">mastery</text>`,
    );
  // phase-change lines split the data path
  const phases = [...input.phaseChanges].sort((a, b) => a.date.localeCompare(b.date));
  for (const p of phases) {
    if (p.date < t0 || p.date > pts.at(-1)!.date) continue;
    parts.push(
      `<line class="phase-change" x1="${x(p.date)}" x2="${x(p.date)}" y1="${m.t}" y2="${H - m.b}" stroke="#0f172a" stroke-dasharray="6 3"/><text x="${x(p.date) + 4}" y="${m.t + 10}" font-size="10">${esc(p.label)}</text>`,
    );
  }
  const segments: (typeof pts)[] = [[]];
  let pi = 0;
  for (const p of pts) {
    while (pi < phases.length && p.date >= phases[pi]!.date) {
      segments.push([]);
      pi++;
    }
    segments.at(-1)!.push(p);
  }
  for (const seg of segments.filter((s) => s.length)) {
    parts.push(
      `<polyline fill="none" stroke="#2563eb" stroke-width="1.5" points="${seg.map((p) => `${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ")}"/>`,
    );
    for (const p of seg)
      parts.push(
        `<circle cx="${x(p.date).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="2.2" fill="#2563eb"/>`,
      );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Helvetica, Arial, sans-serif" role="img" aria-label="${esc(input.title)} graph">${parts.join("")}</svg>`;
}
