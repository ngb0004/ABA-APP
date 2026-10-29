# ABA App: v1.0 Build Brief

How to use this:

1. Create an empty folder for the project and copy everything in this brief into it.
2. **One manual step:** open the "ABA HIPAA-Compliant AI App — Spec" doc, download it as Markdown, and save it as `docs/SPEC.md`.
3. Open the folder in Claude Code and start with:

   > Read CLAUDE.md and docs/BUILD_PLAN.md, then start Phase 0. Stop at the end of each phase, show me the acceptance tests passing, and wait for my go-ahead before the next phase.

What's in here:
- `CLAUDE.md`: rules and stack Claude Code follows every session
- `docs/BUILD_PLAN.md`: 12 phases (0–11), each with acceptance criteria
- `docs/VBMAPP_WORKBOOK_MAP.md`: exact cell map of the VB-MAPP Excel workbook, plus the known errors in the samples, used as tests
- `docs/GOAL_FORMAT.md` + `docs/reference/GOAL_BANK.md`: goal structure and content library
- `seed/payors.yaml`: rules for 10 payors, every rule cited and marked unverified
- `fixtures/vbmapp/`: the three de-identified VB-MAPP workbooks, used as test fixtures

Not included on purpose: employer templates, forms, or checklists. Only the payor rules extracted from them are here, each cited and marked unverified. There is no real client data anywhere.
