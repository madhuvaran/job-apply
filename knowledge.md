# Job Apply Extension
Chrome MV3 extension (WXT + React + TypeScript) that (1) tailors a resume per
job description from a master profile and renders a fixed ATS-safe PDF,
(2) autofills job application forms, (3) logs applications.

## Rules
- Never invent skills, employers, dates or metrics. Tailoring may only select,
  reorder and reword content that exists in the profile.
- Never send phone, email, address, compensation or voluntary disclosures to any LLM.
- Legal/EEO answers come from the saved profile only, never from an LLM.
- The LLM decides WHAT goes in a field; deterministic code does the filling.
- Never auto-submit. Always show a review step first.
- LinkedIn is assist-only: no automated scrolling or applying.
- Fill React-controlled inputs with the native value setter, then dispatch
  input, change and blur events.
- Strict TypeScript. Validate all profile and LLM JSON with zod.
- Small commits: one working step per commit.
- At the end of every task, update PROGRESS.md with what is done, what is broken,
  and what is next. At the start of every task, read knowledge.md and PROGRESS.md.

## Structure
src/lib/profile.ts (zod schema), src/lib/storage.ts, src/lib/llm.ts,
src/lib/resume/, src/lib/filler/, entrypoints/ (background, content, options, popup)
