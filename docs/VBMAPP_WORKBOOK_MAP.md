# VB-MAPP Excel Workbook: Cell Map

This maps the widely shared free VB-MAPP scoring workbook (`.xlsm`). It was derived from the three files in `fixtures/vbmapp/`. Read values and formulas only, and never execute macros.

## Sheets
`Instructions`, `Milestones Grid`, `Barrier Grid`, `Transition Grid`, `Intraverbal 6.0`, `EESA`, `Self-Care`, `TA Chart 1–3`, `Present Level`, and `Collected data` (hidden). v1.0 parses **Milestones Grid** only.

## Header (Milestones Grid)
| Field | Cell(s) | Notes |
|---|---|---|
| Child's name | `H6` (merged H6:AE6) | PHI. Warn if present, and offer to strip. |
| Date of birth | `H7` (merged H7:AE7) | PHI |
| Age at each test | `P8`, `V8`, `AB8` (formulas) | Ignore; recompute |
| Test date, admin 1–4 | `AT6`, `AT7`, `AT8`, `AT9` | Can be a real date, a malformed string, or an accidentally pasted formula. Flag anything that isn't a valid date. |
| Tester initials, admin 1–4 | `BD6`–`BD9` | |
| Workbook total, admin 1–4 | `AO6`–`AO9` | Cumulative. **Only compare against these; never use them.** |

## Grid layout
Each scoring cell is a merged range 4 columns wide (e.g., `D50:G50`). Read the left cell (`D50`).

**Cell value = administration number (1, 2, 3, or 4).** That number drives the cell color. Empty = not scored.

**Each milestone spans two rows.** The **lower row = ½ point**, and **both rows = 1 point**. A milestone with only the lower row filled scores 0.5. *(Inferred from the samples. Confirm with the BCBA.)*

### Level 1: rows 50–59
| Milestone | Rows (upper / lower) |
|---|---|
| 5 | 50 / 51 |
| 4 | 52 / 53 |
| 3 | 54 / 55 |
| 2 | 56 / 57 |
| 1 | 58 / 59 |

Domains (column → name): `D` Mand, `I` Tact, `N` Listener, `S` VP/MTS, `X` Play, `AC` Social, `AH` Imitation, `AM` Echoic, `AR` Vocal.
Workbook domain totals are in row 49, and the level total is in `AW59`.

### Level 2: rows 33–42
Milestone 10 = rows 33/34, 9 = 35/36, 8 = 37/38, 7 = 39/40, 6 = 41/42.
Domains: `D` Mand, `I` Tact, `N` Listener, `S` VP/MTS, `X` Play, `AC` Social, `AH` Imitation, `AM` Echoic, `AR` LRFFC, `AW` IV, `BB` Group, `BG` Linguistics.
Domain totals are in row 32, and the level total is in `BL42`.

### Level 3: rows 16–25
Milestone 15 = rows 16/17, 14 = 18/19, 13 = 20/21, 12 = 22/23, 11 = 24/25.
Domains: `D` Mand, `I` Tact, `N` Listener, `S` VP/MTS, `X` Play, `AC` Social, `AH` Reading, `AM` Writing, `AR` LRFFC, `AW` IV, `BB` Group, `BG` Linguistics, `BL` Math.
Domain totals are in row 15, and the level total is in `BQ25`.

General rule: milestone `m`'s upper row = `(level start row) + 2 × (top milestone − m)`, and the lower row = upper + 1.

## Formula-driven cells
- **Echoic (Level 1 `AM50:AM59`, Level 2 `AM33:AM42`)** are formulas reading the `EESA` sheet. BCBAs often type over them or delete them. Treat a literal value as the BCBA's score, and note it as info.
- **All totals are formulas.** Detect overwritten totals by comparing each cell's formula against the same cell in `blank_template.xlsm`. A literal where the template has a formula means the cell was overwritten.

## Scoring per administration
For administration `k`, a milestone's score counts the scoring cells whose value is `≤ k`. That's cumulative: a milestone scored in admin 1 still counts in admin 2. Domain score = sum of milestone scores. Level score = sum of domains. Total = sum of levels.

## Known issues in fixtures (use as test cases)
| File | Expected |
|---|---|
| `sample_A_level2.xlsm` | Admin 1 recomputed total **77.5** (L1 45, L2 29.5, L3 3). The workbook says **73.5** because cell `N49` (L1 Listener total) was overwritten with `1`. The test date in `AT6` reads `08/204/2026`. Echoic L1 cells are literals. |
| `sample_B_level1.xlsm` | Admin 1 total **27.5** (L1 25.5, L2 1, L3 1). Isolated scores: L2 Play (`X36`, `X40`) and L3 Math (`BL22`, `BL23`) with no supporting milestones. `AT7` contains a formula, not a date. Echoic formulas were deleted in `AM52:AM54`. |
| `blank_template.xlsm` | No administrations. |
