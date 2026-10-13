/**
 * Deterministic autofill foundation (Prompt 14) — public surface.
 *
 * Separated by responsibility so each can be tested independently:
 * - `schemas.ts`   strict descriptors / plan / report contracts
 * - `classify.ts`  deterministic, value-free field classification
 * - `plan.ts`      mapping to explicitly supported saved answers
 * - `execute.ts`   isolated executor for a validated plan
 * - `page.ts`      value-free DOM scanning + messaging glue
 *
 * Offline and local-only: no AI provider, no network, no sensitive data in any
 * AI payload, no new permissions. Workday-specific handling and AI-assisted
 * semantic mapping are intentionally NOT implemented here.
 */
export * from './schemas';
export { classifyField, normalizeText } from './classify';
export {
  buildFillPlan,
  type BuildPlanInput,
  type BuildPlanResult,
  type PlanDecision,
  type PlanReviewEntry,
} from './plan';
export { executeFillPlan, type ExecuteResult, type FillTarget } from './execute';
export {
  AUTOFILL_FILL_REQUEST_TYPE,
  AUTOFILL_SCAN_REQUEST_TYPE,
  autofillFillRequestSchema,
  autofillFillResponseSchema,
  autofillScanRequestSchema,
  autofillScanResponseSchema,
  collectFieldDescriptors,
  createAutofillSession,
  validateFillResponse,
  validateScanResponse,
  type AutofillFillResponse,
  type AutofillResponse,
  type AutofillScanResponse,
  type AutofillSession,
  type ScanResult,
} from './page';
