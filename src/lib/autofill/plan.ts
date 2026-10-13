/**
 * Fill planner (Prompt 14).
 *
 * Maps classified fields to EXPLICITLY supported saved answers and produces a
 * reviewable plan. It is pure: it never touches page elements, never reads a
 * field value, never calls the network or the AI provider, and never invents a
 * value (a missing answer produces a manual entry, never "" / false / a guess).
 *
 * Sensitive answers (name, email, phone, city, work authorization, sponsorship)
 * come from the SEPARATE sensitive profile and are tagged `source: 'sensitive'`
 * so they can never be conflated with AI-safe profile data. The planner drops
 * no data into any AI payload — it does not touch the AI layer at all.
 */
import { profileSchema, type Profile } from '../profile';
import { sensitiveProfileSchema, type Legal, type SensitiveProfile } from '../sensitive';
import { classifyField } from './classify';
import {
  fieldDescriptorsSchema,
  fillPlanSchema,
  formatIssues,
  type FillInstruction,
  type FillPlan,
  type FillSource,
  type FieldCategory,
  type FieldDescriptor,
} from './schemas';

/** Deterministic labels for the saved work-authorization enum. */
const WORK_AUTHORIZATION_LABELS: Record<Legal['workAuthorization'], string> = {
  citizen: 'Citizen',
  permanent_resident: 'Permanent resident',
  authorized_needs_sponsorship: 'Authorized to work — requires sponsorship',
  authorized_no_sponsorship: 'Authorized to work — no sponsorship required',
  other: 'Other',
  undisclosed: 'Prefer not to say',
};

/** Categories only ever planned for choice controls (select/radio/checkbox). */
const CHOICE_ONLY = new Set<FieldCategory>(['workAuthorization', 'sponsorship']);

export type PlanDecision = 'fill' | 'manual';

export interface PlanReviewEntry {
  fieldId: string;
  /** Page-provided display label; shown in the UI only, never stored or logged. */
  displayLabel: string;
  classification: 'supported' | 'unsupported' | 'ambiguous' | 'excluded';
  category: FieldCategory | null;
  decision: PlanDecision;
  /** Fixed explanation; never contains a value. */
  reason: string;
  /** Present only when `decision === 'fill'`; shown for review, never logged. */
  proposedValue?: string;
  source?: FillSource;
}

export type BuildPlanResult =
  | { ok: true; plan: FillPlan; review: PlanReviewEntry[] }
  | { ok: false; reason: 'invalid-input'; issues: string[] };

export interface BuildPlanInput {
  descriptors: unknown;
  profile: unknown;
  sensitive: unknown;
}

interface ResolvedValue {
  value: string;
  source: FillSource;
}

/** Resolve a category to an explicitly saved answer (or null when absent). */
function resolveValue(
  category: FieldCategory,
  profile: Profile | null,
  sensitive: SensitiveProfile | null,
): ResolvedValue | null {
  const contact = sensitive?.contact;
  const legal = sensitive?.legal;

  switch (category) {
    case 'firstName':
      return contact !== undefined ? { value: contact.firstName, source: 'sensitive' } : null;
    case 'lastName':
      return contact !== undefined ? { value: contact.lastName, source: 'sensitive' } : null;
    case 'email':
      return contact !== undefined ? { value: contact.email, source: 'sensitive' } : null;
    case 'phone':
      return contact !== undefined ? { value: contact.phone, source: 'sensitive' } : null;
    case 'city':
      return contact?.cityLabel !== undefined
        ? { value: contact.cityLabel, source: 'sensitive' }
        : null;
    case 'state':
    case 'country':
      // The profile schemas contain no explicit state/region or country field —
      // never inferred from free text; reported as a missing answer instead.
      return null;
    case 'linkedin':
      return profile?.linkedin !== undefined ? { value: profile.linkedin, source: 'profile' } : null;
    case 'portfolio':
      return profile?.portfolio !== undefined
        ? { value: profile.portfolio, source: 'profile' }
        : null;
    case 'skills': {
      if (profile === null || profile.skills.length === 0) return null;
      const names = profile.skills.map((s) => s.name).join(', ');
      return names.length > 0 ? { value: names, source: 'profile' } : null;
    }
    case 'summary':
      return profile?.summary !== undefined ? { value: profile.summary, source: 'profile' } : null;
    case 'workAuthorization': {
      if (legal === undefined || legal.workAuthorization === 'undisclosed') return null;
      return { value: WORK_AUTHORIZATION_LABELS[legal.workAuthorization], source: 'sensitive' };
    }
    case 'sponsorship':
      if (legal === undefined) return null;
      return { value: legal.sponsorshipNeeded ? 'Yes' : 'No', source: 'sensitive' };
  }
}

function displayLabelFor(descriptor: FieldDescriptor, index: number): string {
  const label =
    descriptor.labelText ?? descriptor.ariaLabel ?? descriptor.placeholder ?? descriptor.name ?? descriptor.elementId;
  return (label ?? `Field ${index + 1}`).slice(0, 300);
}

/**
 * Build a reviewed plan + a per-field review list. Returns `invalid-input`
 * (with path+message issues only, never values) when any input fails its strict
 * schema. `profile`/`sensitive` may be null (nothing to fill from).
 */
export function buildFillPlan(input: BuildPlanInput): BuildPlanResult {
  const descriptors = fieldDescriptorsSchema.safeParse(input.descriptors);
  if (!descriptors.success) {
    return { ok: false, reason: 'invalid-input', issues: formatIssues(descriptors.error).map((i) => `descriptors.${i}`) };
  }

  let profile: Profile | null = null;
  if (input.profile !== null && input.profile !== undefined) {
    const parsed = profileSchema.safeParse(input.profile);
    if (!parsed.success) {
      return { ok: false, reason: 'invalid-input', issues: formatIssues(parsed.error).map((i) => `profile.${i}`) };
    }
    profile = parsed.data;
  }

  let sensitive: SensitiveProfile | null = null;
  if (input.sensitive !== null && input.sensitive !== undefined) {
    const parsed = sensitiveProfileSchema.safeParse(input.sensitive);
    if (!parsed.success) {
      return { ok: false, reason: 'invalid-input', issues: formatIssues(parsed.error).map((i) => `sensitive.${i}`) };
    }
    sensitive = parsed.data;
  }

  const instructions: FillInstruction[] = [];
  const review: PlanReviewEntry[] = [];

  descriptors.data.forEach((descriptor, index) => {
    const classification = classifyField(descriptor);
    const base = {
      fieldId: descriptor.fieldId,
      displayLabel: displayLabelFor(descriptor, index),
    };

    if (classification.kind !== 'supported') {
      review.push({
        ...base,
        classification: classification.kind,
        category: null,
        decision: 'manual',
        reason: classification.reason,
      });
      return;
    }

    const category = classification.category;

    if (CHOICE_ONLY.has(category) && descriptor.kind !== 'select' && descriptor.kind !== 'radio' && descriptor.kind !== 'checkbox') {
      review.push({
        ...base,
        classification: 'supported',
        category,
        decision: 'manual',
        reason: 'Only choice fields (select/radio/checkbox) are supported for this answer — complete it manually.',
      });
      return;
    }

    const resolved = resolveValue(category, profile, sensitive);
    if (resolved === null || resolved.value.trim().length === 0) {
      review.push({
        ...base,
        classification: 'supported',
        category,
        decision: 'manual',
        reason: 'No saved answer for this field — complete it manually.',
      });
      return;
    }

    const instruction: FillInstruction = {
      fieldId: descriptor.fieldId,
      category,
      value: resolved.value,
      source: resolved.source,
      requiresConfirmation: true,
    };
    instructions.push(instruction);
    review.push({
      ...base,
      classification: 'supported',
      category,
      decision: 'fill',
      reason: 'Will be filled from your saved profile after you confirm.',
      proposedValue: resolved.value,
      source: resolved.source,
    });
  });

  // Invariant: our own construction must satisfy the strict plan schema.
  const plan = fillPlanSchema.parse({ schemaVersion: '1', instructions });
  return { ok: true, plan, review };
}
