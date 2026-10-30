/**
 * Generates the synthetic assessment score files in fixtures/assessments/, used by the tests and
 * offered as demo samples. Every file uses Yoma's own plain layout (a title, a few labelled
 * fields, a score table): never a publisher's report form, item wording, or protocol text
 * (CLAUDE.md rule 9). All scores are fictional and match the synthetic seed where sensible.
 *
 *   pnpm exec tsx scripts/build-assessment-fixtures.ts
 *
 * Rerunning changes the PDF's bytes (it carries a creation time), so commit the regenerated files
 * together. The files are kept read-only (chmod 444) like fixtures/vbmapp.
 */
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import * as XLSX from "xlsx";

const DIR = path.join(process.cwd(), "fixtures/assessments");
const NOTICE = "Yoma synthetic sample: fictional scores for testing, not a real report";

const esc = (s: string | number) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function page(
  title: string,
  fields: [string, string][],
  tables: { head: string[]; rows: (string | number)[][] }[],
) {
  const table = (t: { head: string[]; rows: (string | number)[][] }) => `
    <table>
      <thead><tr>${t.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${t.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody>
    </table>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: Arial, Helvetica, sans-serif; font-size: 16px; color: #111; background: #fff; margin: 32px; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    .notice { font-size: 13px; color: #444; margin-bottom: 18px; }
    p { margin: 4px 0; }
    table { border-collapse: collapse; margin-top: 18px; }
    th, td { text-align: left; padding: 6px 40px 6px 0; }
    th { border-bottom: 2px solid #111; }
  </style></head><body>
    <h1>${esc(title)}</h1>
    <div class="notice">${esc(NOTICE)}</div>
    ${fields.map(([k, v]) => `<p>${esc(k)}: ${esc(v)}</p>`).join("")}
    ${tables.map(table).join("")}
  </body></html>`;
}

// Charlie's second Vineland-3 in the seed (Motor Skills not reported, so it stays blank on review).
const vineland = page(
  "Adaptive behavior scores",
  [
    ["Assessment", "Vineland-3"],
    ["Form", "Comprehensive Interview Form"],
    ["Respondent", "Parent or caregiver"],
    ["Date administered", "04/13/2026"],
  ],
  [
    {
      head: ["Domain", "Standard score", "Percentile"],
      rows: [
        ["Adaptive Behavior Composite (ABC)", 71, 3],
        ["Communication", 69, 2],
        ["Daily Living Skills (DLS)", 76, 5],
        ["Socialization", 66, 1],
      ],
    },
    {
      head: ["Subdomain", "v-scale"],
      rows: [
        ["Receptive", 9],
        ["Expressive", 8],
        ["Written", 10],
        ["Personal", 11],
        ["Domestic", 10],
        ["Community", 9],
        ["Interpersonal Relationships", 8],
        ["Play and Leisure", 7],
        ["Coping Skills", 9],
      ],
    },
  ],
);

// Charlie's SRS-2 in the seed. Only the total has a stored raw score; other raw columns are ignored.
const srs = page(
  "Social responsiveness scores",
  [
    ["Assessment", "SRS-2"],
    ["Form", "School-Age Form"],
    ["Respondent", "Parent"],
    ["Date administered", "2026-04-13"],
  ],
  [
    {
      head: ["Scale", "Raw score", "T-score"],
      rows: [
        ["Total", 98, 74],
        ["Social Communication and Interaction", 80, 73],
        ["Restricted Interests and Repetitive Behavior", 18, 77],
        ["Social Awareness", 12, 70],
        ["Social Cognition", 17, 72],
        ["Social Communication", 30, 73],
        ["Social Motivation", 14, 67],
      ],
    },
  ],
);

// Alpha's ABLLS-R in the seed: score and possible points in separate columns.
function ablls(): Buffer {
  const wb = XLSX.utils.book_new();
  const about = XLSX.utils.aoa_to_sheet([
    [NOTICE],
    ["Assessment", "ABLLS-R"],
    ["Assessment date", new Date(Date.UTC(2026, 9, 8))],
    ["Administered by", "AS"],
  ]);
  XLSX.utils.book_append_sheet(wb, about, "About");
  const areas = XLSX.utils.aoa_to_sheet([
    ["Skill area", "Score", "Possible"],
    ["Cooperation and Reinforcer Effectiveness", 10, 38],
    ["Visual Performance", 12, 54],
    ["Receptive Language", 9, 102],
    ["Imitation", 6, 34],
    ["Vocal Imitation", 4, 26],
    ["Requests", 8, 54],
    ["Labeling", 5, 92],
    ["Intraverbals", 0, 108],
    ["Play and Leisure", 4, 26],
    ["Social Interaction", 3, 68],
    ["Dressing", 2, 26],
    ["Eating", 12, 30],
    ["Toileting", 0, 18],
    ["Gross Motor", 14, 44],
    ["Fine Motor", 10, 34],
  ]);
  XLSX.utils.book_append_sheet(wb, areas, "Skill areas");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
}

// Bravo's AFLS Basic Living Skills draft in the seed, written as "x of y".
const afls = [
  `"${NOTICE}"`,
  "Assessment,AFLS Basic Living Skills",
  "Date administered,2026-10-12",
  "",
  "Skill area,Points",
  "Self Management,14 of 32",
  "Basic Communication,30 of 58",
  "Dressing,22 of 48",
  "Eating,36 of 60",
  "Grooming,12 of 40",
  "Bathing,6 of 26",
  "Toileting,18 of 36",
  "Health,4 of 22",
  "Safety,6 of 32",
  "Nighttime Routines,8 of 16",
  "",
].join("\r\n");

// Charlie's PDDBI parent form in the seed. The fictional name and birth date show the PHI check:
// they are detected and flagged, never stored.
const pddbi = [
  NOTICE,
  "",
  "Assessment: PDDBI",
  "Form: Parent Form",
  "Respondent: Parent",
  "Name: Charlie Testchild",
  "Date of birth: 01/15/2019",
  "Rating date: 2026-04-13",
  "",
  "Domain T-scores",
  "Autism Composite ............ 63",
  "Ritualisms/Resistance to Change ............ 66",
  "Social Approach Behaviors ............ 38",
  "Expressive Language ............ 41",
  "",
].join("\n");

// Charlie's PSI-4 in the seed, as a Word table.
function psiDocx(): Buffer {
  const p = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
  const cell = (t: string | number) => `<w:tc>${p(String(t))}</w:tc>`;
  const row = (cells: (string | number)[]) => `<w:tr>${cells.map(cell).join("")}</w:tr>`;
  const body = [
    p("Parenting stress scores"),
    p(NOTICE),
    p("Assessment: PSI-4"),
    p("Form: Full-Length Form"),
    p("Respondent: Parent or caregiver"),
    p("Date of administration: May 18, 2026"),
    `<w:tbl>${[
      row(["Scale", "Raw score", "Percentile"]),
      row(["Total Stress", 262, 85]),
      row(["Child Domain", 140, 90]),
      row(["Parent Domain", 122, 72]),
    ].join("")}</w:tbl>`,
  ].join("");
  const files: Record<string, string> = {
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  };
  const CFB = XLSX.CFB;
  const zip = CFB.utils.cfb_new();
  for (const [name, text] of Object.entries(files)) CFB.utils.cfb_add(zip, name, Buffer.from(text, "utf8"));
  // cfb_new adds a placeholder entry; zip output only carries the files added above.
  return Buffer.from(CFB.write(zip, { fileType: "zip", type: "buffer" }) as Uint8Array);
}

function save(name: string, data: Buffer | string) {
  const file = path.join(DIR, name);
  if (existsSync(file)) {
    chmodSync(file, 0o644);
    unlinkSync(file);
  }
  writeFileSync(file, data);
  chmodSync(file, 0o444);
  console.log(`wrote fixtures/assessments/${name}`);
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    const pdfPage = await browser.newPage();
    await pdfPage.setContent(vineland);
    save("vineland3_scores.pdf", await pdfPage.pdf({ format: "Letter", printBackground: true }));
    const shot = await browser.newPage({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 1 });
    await shot.setContent(srs);
    save("srs2_scores.png", await shot.screenshot({ fullPage: true }));
  } finally {
    await browser.close();
  }
  save("ablls_r_areas.xlsx", ablls());
  save("afls_basic_living.csv", afls);
  save("pddbi_parent.txt", pddbi);
  save("psi4_scores.docx", psiDocx());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
