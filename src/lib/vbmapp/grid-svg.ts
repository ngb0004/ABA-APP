/**
 * Our own Milestones grid drawing (server-rendered SVG). Shows domain names,
 * milestone numbers, and scores only. Each administration has its own color;
 * a half score fills the lower half of the cell.
 */
import { LEVELS } from "./layout";
import type { GridScore } from "./carry-forward";

export const ADMIN_COLORS = ["#2563eb", "#16a34a", "#ea580c", "#9333ea"];

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function renderMilestonesGridSvg(
  scores: GridScore[],
  legend: { adminNumber: number; label: string }[] = [],
): string {
  const cw = 46;
  const ch = 22;
  const left = 64;
  const top = 12;
  const levelGap = 34;
  const maxCols = Math.max(...LEVELS.map((l) => l.domains.length));
  const byKey = new Map(scores.map((s) => [`${s.level}|${s.domain}|${s.milestone}`, s]));
  const parts: string[] = [];
  let y = top;
  // Level 3 at the top, as on the paper grid.
  for (const level of [...LEVELS].reverse()) {
    parts.push(`<text x="4" y="${y + 14}" font-size="12" font-weight="bold">Level ${level.level}</text>`);
    level.domains.forEach((d, i) => {
      parts.push(
        `<text x="${left + i * cw + cw / 2}" y="${y + 14}" font-size="9" text-anchor="middle">${esc(d.name)}</text>`,
      );
    });
    y += 20;
    for (let m = level.topMilestone; m >= level.bottomMilestone; m--) {
      parts.push(`<text x="${left - 8}" y="${y + ch / 2 + 4}" font-size="10" text-anchor="end">${m}</text>`);
      level.domains.forEach((d, i) => {
        const x = left + i * cw;
        const s = byKey.get(`${level.level}|${d.name}|${m}`);
        parts.push(
          `<rect x="${x}" y="${y}" width="${cw - 2}" height="${ch - 2}" fill="#fff" stroke="#94a3b8"/>`,
        );
        if (s) {
          const color = ADMIN_COLORS[(s.firstAdmin - 1) % ADMIN_COLORS.length];
          const h = s.score === 1 ? ch - 2 : (ch - 2) / 2;
          const yy = s.score === 1 ? y : y + (ch - 2) / 2;
          parts.push(
            `<rect x="${x}" y="${yy}" width="${cw - 2}" height="${h}" fill="${color}" ${s.carriedForward ? 'fill-opacity="0.55"' : ""} data-score="${s.score}" data-key="L${level.level}.${esc(d.name)}.${m}"/>`,
          );
        }
      });
      y += ch;
    }
    y += levelGap - 20;
  }
  let lx = left;
  for (const l of legend) {
    const color = ADMIN_COLORS[(l.adminNumber - 1) % ADMIN_COLORS.length];
    parts.push(`<rect x="${lx}" y="${y}" width="12" height="12" fill="${color}"/>`);
    parts.push(`<text x="${lx + 16}" y="${y + 10}" font-size="10">${esc(l.label)}</text>`);
    lx += 150;
  }
  const width = left + maxCols * cw + 10;
  const height = y + (legend.length ? 22 : 4);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Helvetica, Arial, sans-serif" role="img" aria-label="VB-MAPP Milestones grid">${parts.join("")}</svg>`;
}
