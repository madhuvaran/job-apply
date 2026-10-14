# Autofill Compatibility (deterministic engine)

This document characterizes what the current **deterministic** autofill engine
(`src/lib/autofill/`) does with common job-application form patterns, using
synthetic HTML fixtures and the existing Vitest/jsdom tests. It is a discovery
record, **not** a Workday adapter and **not** a claim of site-specific support.

> **No claim of universal support.** We have not logged into Workday, scraped
> authenticated pages, or collected any real application data. Nothing here
> asserts that "all Workday sites work" or that any particular site matches
> these fixtures.

## Evidence boundary

| Kind of claim | Basis |
|---|---|
| **Demonstrated** | Shown by our own synthetic fixtures and Vitest/jsdom tests (file names below). |
| **Inferred** | Follows from standard HTML/ARIA form semantics, not from a real site. |
| **Unverified Workday behavior** | Requires a permitted real Workday test environment; **not** established here. |

Fixtures and tests live in `src/lib/autofill/workday.test.ts` and
`src/lib/autofill/detection.test.ts` (plus the earlier `classify.test.ts`,
`plan.test.ts`, `execute.test.ts`, `hardening.test.ts`, `page.test.ts`,
`session.test.ts`, `boundaries.test.ts`).

## Interaction invariants (unchanged)

- The user explicitly triggers the scan from the popup; nothing runs on load.
- The user reviews a plan split into *Will fill* / *Needs manual input*.
- **Explicit confirmation is required** before any write; Cancel writes nothing.
- No form submission, navigation, or application progression; no CAPTCHA
  handling or bypass; no hidden-field filling.
- No network requests, AI provider calls, telemetry, or external services.
- No new host or manifest permissions; content-script matches unchanged
  (`storage`, `activeTab`, `scripting` only).
- Password/authentication controls are excluded by their own `type=password`
  **and** by label/name/placeholder text (Prompt 22), so an innocuous label can
  never make a password box fillable.
- Sensitive answers stay separate from AI-safe profile data.
- Errors/reports never contain saved answers or current field values.
- Multi-select controls remain unsupported.
- **A control that already contains a value is never overwritten** (Prompt 22):
  typed text/textarea content, a real (non-placeholder) selected option, or an
  already-answered radio group is left exactly as it is and reported
  `already-filled` — no write, no events.

## Status matrix

| # | Pattern | Status | Synthetic fixture | Confirmation required |
|---|---|---|---|---|
| 1 | Standard text input with visible `<label for>` | **Supported** | `standardTextInput` | Yes |
| 2 | Textarea (summary/skills) | **Supported** | (see `execute.test.ts`) | Yes |
| 3 | Field labelled only via `aria-label` | **Supported** | `ariaLabel` | Yes |
| 4 | Field labelled via `aria-labelledby` | **Supported** | `ariaLabelledby` | Yes |
| 5 | Combobox as a native `<select>` | **Supported** (for mapped categories) | `nativeSelect` | Yes |
| 6 | Custom combobox (`role="combobox"` / `aria-haspopup="listbox"`) | **Unsupported** (manual) | `customCombobox`, `ariaHasPopupWidget` | n/a (not planned) |
| 7 | Radio group with a visible group label | **Supported** (choice categories) | `radioGroup` | Yes |
| 8 | Checkbox with a descriptive label | **Partially supported** (only mapped categories; otherwise manual) | `checkboxDescriptive`, `checkboxConsent` | Yes |
| 9 | Required field + inline validation message | **Partially supported** (value + browser constraint checked; inline text not parsed) | `requiredWithValidation` | Yes |
| 10 | Field replaced during a rerender | **Supported** (safe refusal, no re-resolution) | `rerenderHost` | Yes |
| 11 | Multi-select `<select multiple>` | **Unsupported** (manual) | `multiSelect` | n/a (not planned) |
| 12 | `<div role="combobox">` widget with no native control | **Unsupported** (not scanned) | — (not scanned by design) | n/a |
| 13 | `<input list="…">` datalist combobox | **Partially supported / inferred** (treated as plain text; popup not driven) | — | Yes |
| 14 | Site-specific JS / framework validation | **Unverified** | — | Yes |
| 15 | `label[for]` / nested label / duplicate labels for one control | **Supported** | `detection.test.ts` | Yes |
| 16 | `aria-labelledby` listing several ids (incl. duplicates/commas/missing ids) | **Supported** (malformed ids are skipped, never fatal) | `detection.test.ts` | Yes |
| 17 | Explicit ARIA name **plus** a native `<label>` | **Supported** (both are captured; a conflict → ambiguous/manual) | `detection.test.ts` | Yes |
| 18 | Control labelled only by its `fieldset`/`legend` group (incl. nested groups) | **Supported** (last-resort group context) | `detection.test.ts` | Yes |
| 19 | Real label + a contradictory `placeholder` | **Supported** (placeholder is only a lower-confidence fallback) | `detection.test.ts` | Yes |
| 20 | Control that already contains a value (text, textarea, select, radio) | **Not modified** — `already-filled`, nothing written | `detection.test.ts` | n/a (skipped) |

## Per-pattern detail

### 1–2. Text inputs and textareas — Supported
The classifier maps `first name`/`last name`/`email`/`phone`/`city`/`linkedin`/
`portfolio`/`skills`/`summary` to saved answers. Values are written through the
**native prototype value setter** with bubbling `input`+`change` events, then
verified. Disabled, read-only, hidden, `inert` and disconnected controls are
skipped. *Limitation:* values are verified against the immediate post-write
state; a framework that later reverts them is not re-checked.

### 3–4. ARIA labels — Supported
- `aria-label` is used as the accessible name fallback.
- `aria-labelledby` is resolved to the referenced element(s) text (previously it
  was ignored — a real defect fixed in Prompt 16).
- **Prompt 22:** every id in the list is used (duplicates de-duplicated), tokens
  are split on whitespace *and* commas, unresolvable/malformed ids are skipped
  and the result is capped — a broken `aria-labelledby` degrades to "no ARIA
  name", never to a crash.
- **Prompt 22:** the ARIA name is captured even when a native `<label>` also
  exists (it was previously discarded). `labelText` (visible label) and
  `ariaLabel` (explicit ARIA name) are separate descriptor fields, so the
  classifier sees **both**: agreement classifies normally, a conflict yields two
  categories → **ambiguous → manual** (never a guess).
*Limitation:* a label whose text lives outside the scanned document/frame is
not resolved.

### 5. Native single `<select>` — Supported
Options are matched unambiguously by value or text; **placeholder options**
(`Select one`, empty value, disabled/hidden options) never count as answers and
the first option is never chosen just because it exists. Post-fill the selected
option node and constraint validity are verified. *Limitation:* a select whose
real choices are loaded asynchronously may be empty at scan time → `no-match`.

### 6. Custom ARIA combobox — Unsupported (manual)
A control with an explicit `role="combobox"`/`role="listbox"` or
`aria-haspopup="listbox|tree|grid"` is classified **ambiguous** and excluded from
the plan, because the deterministic engine cannot open a popup or pick an option
without clicking arbitrary page elements. Native `<select>` elements are
unaffected (this check ignores `kind: 'select'`). `aria-haspopup="menu"` is a
menu, not an option picker, and is not treated as a combobox.
*Inferred:* ARIA-compliant comboboxes follow these roles; verified only against
our fixtures.

### 7. Radio groups — Supported (choice categories)
Radio buttons sharing a `(form, name)` pair become one descriptor carrying the
fieldset legend, so unrelated questions that share option labels (`Yes`/`No`) are
not cross-selected. Filling requires a unique label/value match; an
already-selected option is left untouched. *Limitation:* a group with duplicate
option labels → `no-match` (manual).

### 8. Checkboxes — Partially supported
A checkbox is filled only when its own label/value uniquely matches a mapped
answer; an already-checked box is not toggled. Descriptors whose label maps to a
supported category (e.g. sponsorship) are planned; descriptive-but-unmapped
checkboxes (e.g. "I am willing to relocate") and legal/consent checkboxes are
left manual. *Limitation:* required checkbox groups and custom-valve checkboxes
are not handled.

### 9. Required fields + inline validation — Partially supported
After writing, the executor checks the browser's **constraint validity**
(`validity.valid`): a `required`/`pattern`/`type` constraint the saved value does
not satisfy yields `verify-failed`, the control is **restored** to its previous
value, and no events fire. Inline "this field is invalid" messages are **not**
parsed, and site-specific JavaScript validation is not detected.
*Limitation:* an inline error rendered by the site is invisible to the engine.

### 10. Dynamic / rerendered fields — Supported (safe refusal)
Element references are held in memory for one scan→fill round trip and never
re-resolved by selector. A field removed, replaced, disabled, hidden or made
read-only after scanning yields `disconnected`/`disabled`/`hidden`/`read-only`
and is not filled; a replacement element with the same `id` is **not** written.

### 11. Multi-select — Unsupported
`<select multiple>` returns `unsupported-element`; every selected option is left
unchanged (the plan carries a single string answer). Preserved from Prompt 15.

### 15–19. Label resolution order — Supported
The descriptor carries a bounded, value-free string for each available source:
visible `<label>` (`label[for]`, nested wrapper, `.labels`), explicit ARIA name
(`aria-labelledby` → every referenced id, else `aria-label`), `placeholder`, and
the nearest ancestor `fieldset`/`legend` (`groupLabel`). Precedence:

1. `labelText` / `ariaLabel` — a real label always wins.
2. `placeholder` — used for category detection **only** when there is no label
   or ARIA name (it is still always consulted by the safety exclusions).
3. `groupLabel` — the nearest ancestor legend, walking outward past a fieldset
   that has no legend of its own and never picking up a nested group's legend;
   used only when the control has no label, ARIA name or placeholder.

*Demonstrated:* all of the above by `detection.test.ts` (synthetic fixtures).
*Limitation:* group context can only identify a control when the group question
names the field; a legend like "My Information" stays unsupported (manual).

### 20. Existing values — never overwritten
A control that already holds a value is **left exactly as it is** and reported
`already-filled` (no write, no events): typed text/textarea content, a real
(non-placeholder) selected `<select>` option, or a radio group with another
option already chosen. Ambiguity/absence is still decided first, so an unmatched
field keeps reporting the more specific `no-match`.
*Limitation:* a dropdown or group whose page-supplied default is a real answer is
reported `already-filled` rather than replaced — change it manually.

### 12–14. Remaining gaps
`<div role="combobox">` widgets that contain no native `input`/`select`/`textarea`
are never scanned, so they cannot be filled (safe). Datalist inputs are treated
as plain text. **Actual Workday behavior for all of the above is unverified** —
establishing it would require a permitted, authenticated test environment, which
this task deliberately did not use. Custom-combobox interaction (clicking popup
options, keyboard driving) is intentionally out of scope.

## AI-assisted semantic mapping (opt-in, Prompt 17)

For fields the deterministic classifier leaves **ambiguous/unsupported**, an
optional layer can ask a configured provider to suggest which **saved answer
category** a field maps to. This never changes the deterministic rows above and
never produces an answer or a DOM action.

| Aspect | Behavior |
|---|---|
| Default | **Off** (`aiEnabled:false`) — zero provider/network calls. |
| Trigger | Explicit **"Suggest field mappings with AI"** in the popup; never on scan/load. |
| Request contents | Per eligible field: opaque `fieldId`, short normalized `label`, control `kind`, plus the names of the categories the user has saved answers for. The `label` is page-derived and may contain text supplied by the website. **Nothing else.** |
| Never sent | Field values, full page text/HTML/DOM, URLs, job description, profile data, saved answers, settings, page content beyond the selected eligible fields' normalized labels, sensitive/legal/compensation data, API keys. (The field `label` is the only page-derived data — see Request contents.) |
| Eligible | Ambiguous/unsupported, interactable, single-valued, non-sensitive label, not a custom combobox. |
| Never eligible/mapped | Password/auth, OTP, payment/bank, CAPTCHA, legal/consent, compensation, EEO/voluntary, **work authorization / sponsorship**, multi-select, hidden/disabled/read-only. |
| Response | Fixed category enum + bounded confidence (0–1) + fixed reason code (strict schema). |
| Confidence | Suggestions `< 0.7` stay manual; model confidence is a hint, not proof. |
| Approval | Per-field user approval; approved mappings re-enter the **same planner/executor** and still need **Confirm & fill**. |
| Failure modes | disabled / unavailable / no-eligible / no-saved-answers / timeout / rate-limit / invalid-response → typed results, fields stay manual, no retry with a bigger payload. |
| Integration | Documented blocker: no backend AI endpoint is configurable in this build, so the popup action reports "unavailable" and stays manual. |
| Evidence | Demonstrated by `src/lib/autofill/mapping.test.ts` (28 tests, jsdom). **Unverified:** a real browser and a live provider. |
