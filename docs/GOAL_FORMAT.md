# Goal Format

A content reference with 18 domains × 3 tiers, medical necessity rationales, and an audit checklist is in `docs/reference/GOAL_BANK.md`. Use it to seed the goal library. All goal text is a template: brackets must be filled from sourced client data before approval.

## Standard goal sentence
> [Client] will [target behavior with specific criteria] in 80% of opportunities with accuracy and independence across 5 consecutive sessions with 2 people within the six-month authorization period.

The mastery numbers (80%, 5 sessions, 2 people) are defaults, editable per goal, and stored as structured fields, not just text.

## Goal record fields
| Field | Notes |
|---|---|
| Domain, tier | From the library (e.g., Listener Responding, Tier 1) |
| Linked VB-MAPP milestones | e.g., Level 1 Listener 1–2. Drives suggestions. |
| Initiation window | e.g., Months 1–3 or Months 4–6. Plans typically run 8–10 active goals and start the next level's goals as earlier ones reach mastery. |
| Objective | The standard sentence, filled in |
| Discriminative stimulus (SD) | What the instructor presents |
| Target behavior | Operational definition, including what does not count |
| Data collection | Measure (% correct, frequency, duration), minimum trials per session, prompt-level codes |
| Prompting and fading | Hierarchy, prompt delay, transfer trials |
| Teaching procedure | DTT, NET, interrupted chain, etc., plus reinforcement and error correction |
| Phases | Usually 4 phases, each with its own criterion |
| Mastery criteria | Structured: accuracy %, consecutive sessions, number of instructors, number of settings |
| Generalization and maintenance | People, settings, exemplars, probe schedule |
| Baseline | **Sourced value** from session or assessment data. Never typed into AI text. |
| Medical necessity rationale | Pattern A or B (below) |

## Rationale patterns
- **Pattern A (goal-first, 3 sentences):** what the goal targets → baseline data (sourced) → benefit and generalization. Use when acquisition is the argument.
- **Pattern B (skill-first, 2 sentences):** the skill and its function → the risk or consequence if the skill stays absent. Use for safety, behavior reduction, and prerequisites.

Vary patterns and wording across goals in one plan. Duplicated rationale language is a known audit finding, so add a similarity check.

## Required goal categories per plan
Communication; social and play; behavior reduction paired with replacement behaviors; caregiver goals (**minimum 2**).

## Assessment summary paragraph
The goals section opens with a summary of the VB-MAPP profile: strengths, the lowest domains, and why targets were prioritized. Include a note asking the BCBA to verify any isolated scores the importer flagged.
