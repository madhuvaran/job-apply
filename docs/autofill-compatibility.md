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

Fixtures and tests live in `src/lib/autofill/workday.test.ts` (plus the earlier
`classify.test.ts`, `plan.test.ts`, `execute.test.ts`, `hardening.test.ts`,
`page.test.ts`, `session.test.ts`, `boundaries.test.ts`).

## Interaction invariants (unchanged)

- The user explicitly triggers the scan from the popup; nothing runs on load.
- The user reviews a plan split into *Will fill* / *Needs manual input*.
- **Explicit confirmation is required** before any write; Cancel writes nothing.
- No form submission, navigation, or application progression; no CAPTCHA
  handling or bypass; no hidden-field filling.
- No network requests, AI provider calls, telemetry, or external services.
- No new host or manifest permissions; content-script matches unchanged
  (`storage`, `activeTab`, `scripting` only).
- Sensitive answers stay separate from AI-safe profile data.
- Errors/reports never contain saved answers or current field values.
- Multi-select controls remain unsupported.

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
- `aria-labelledby` is now resolved to the referenced element(s) text and used
  as `labelText` (previously it was ignored — a real defect fixed in Prompt 16).
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
| Request contents | Per eligible field: opaque `fieldId`, short normalized `label`, control `kind`, plus the fixed list of categories the user has saved answers for. **Nothing else.** |
| Never sent | Field values, page text/HTML/DOM, URLs, job description, profile/settings, employer content, sensitive data, API keys. |
| Eligible | Ambiguous/unsupported, interactable, single-valued, non-sensitive label, not a custom combobox. |
| Never eligible/mapped | Password/auth, OTP, payment/bank, CAPTCHA, legal/consent, compensation, EEO/voluntary, **work authorization / sponsorship**, multi-select, hidden/disabled/read-only. |
| Response | Fixed category enum + bounded confidence (0–1) + fixed reason code (strict schema). |
| Confidence | Suggestions `< 0.7` stay manual; model confidence is a hint, not proof. |
| Approval | Per-field user approval; approved mappings re-enter the **same planner/executor** and still need **Confirm & fill**. |
| Failure modes | disabled / unavailable / no-eligible / no-saved-answers / timeout / rate-limit / invalid-response → typed results, fields stay manual, no retry with a bigger payload. |
| Integration | Documented blocker: no backend AI endpoint is configurable in this build, so the popup action reports "unavailable" and stays manual. |
| Evidence | Demonstrated by `src/lib/autofill/mapping.test.ts` (28 tests, jsdom). **Unverified:** a real browser and a live provider. |
