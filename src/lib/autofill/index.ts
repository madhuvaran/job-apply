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
 * Offline and local-only for the DETERMINISTIC engine: no AI provider, no
 * network, no sensitive data in any AI payload, no new permissions.
 * `mapping.ts` (Prompt 17) adds the OPT-IN, off-by-default suggestion layer on
 * top; it never fills fields itself.
 */
export * from './schemas';
export { classifyField, isCustomSelectionWidget, normalizeText } from './classify';
export {
  buildFillPlan,
  categoryOverridesSchema,
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

export {
  AI_MAPPABLE_CATEGORIES,
  MAPPING_CONFIDENCE_THRESHOLD,
  MAPPING_INPUT_KINDS,
  MAPPING_REASONS,
  MAPPING_SCHEMA_VERSION,
  MAPPING_TASK,
  MAX_MAPPING_FIELDS,
  MAX_MAPPING_LABEL_CHARS,
  approveMappings,
  availableMappingCategories,
  buildMappingProposal,
  buildMappingRequest,
  eligibleMappingFields,
  mappingRequestFieldSchema,
  mappingRequestSchema,
  mappingResponseSchema,
  mappingSuggestionSchema,
  requestMappingProposal,
  validateMappingResponse,
  type AiMappableCategory,
  type ApproveMappingsResult,
  type BuildMappingRequestResult,
  type EligibleField,
  type MappingInputKind,
  type MappingProposal,
  type MappingProposalInput,
  type MappingReason,
  type MappingRequest,
  type MappingRequestField,
  type MappingResponse,
  type MappingResponseValidation,
  type MappingRunOptions,
  type MappingRunResult,
  type MappingSuggestion,
  type MappingSuggestionEntry,
} from './mapping';
