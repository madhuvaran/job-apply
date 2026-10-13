/**
 * Pure, framework-free editor logic for the profile options page.
 *
 * The React components in entrypoints/options/ are thin views over this
 * module; everything meaningful (loading, dirty tracking, validation,
 * item add/remove, migration) is unit-testable without a DOM.
 *
 * Rules honored here:
 * - Sample data is NEVER auto-applied as real profile data. The sample button
 *   is an explicit user action (applySampleToDraft) that merely seeds the
 *   draft; it is clearly labeled fake in the UI and only persisted if the
 *   user then clicks Save (their deliberate choice — e.g. to explore the
 *   editor). No silent population.
 * - No invention: drafts only ever carry the values the user typed.
 * - Validation happens through the same zod schemas storage uses; invalid
 *   drafts are never written (save returns the storage result, and the UI
 *   shows per-field messages derived from zod issues).
 */
import { z } from 'zod';
import {
  profileSchema,
  type Certification,
  type Education,
  type Experience,
  type Profile,
  type Project,
} from './profile';
import { getLegacyProfile, loadProfile, migrateLegacyProfile, resetSensitiveProfile, saveProfile, type StorageResult } from './storage';

/* ------------------------------------------------------------------ */
/* Draft / dirty state                                                  */
/* ------------------------------------------------------------------ */

/** A Profile without the server-side managed fields. */
export type ProfileDraft = Omit<Profile, 'schemaVersion' | 'updatedAt'>;

export function emptyDraft(): ProfileDraft {
  const p = profileSchema.parse({});
  // strip schemaVersion/updatedAt; keep only user-editable content
  const { schemaVersion: _sv, updatedAt: _ua, ...rest } = p;
  return rest;
}

export function profileToDraft(p: Profile): ProfileDraft {
  const { schemaVersion: _sv, updatedAt: _ua, ...rest } = p;
  return rest;
}

export function applySampleToDraft(sample: Profile): ProfileDraft {
  return profileToDraft(sample);
}

/** Structural dirty check (stable key order via toEqual semantics). */
export function draftsDiffer(a: ProfileDraft, b: ProfileDraft): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/* ------------------------------------------------------------------ */
/* Load / save                                                          */
/* ------------------------------------------------------------------ */

export type EditorLoadState =
  | { kind: 'empty' } // nothing stored yet — onboarding view
  | { kind: 'ready'; profile: Profile } // loaded fine
  | { kind: 'malformed'; raw: unknown; message: string } // recoverable corrupt
  | { kind: 'unavailable'; message: string };

export async function loadEditorState(): Promise<EditorLoadState> {
  const res = await loadProfile();
  if (res.ok) {
    return Object.keys(profileToDraft(res.data)).some((k) => {
      const v = (res.data as Record<string, unknown>)[k];
      if (v === undefined) return false;
      if (Array.isArray(v)) return v.length > 0;
      return true;
    })
      ? { kind: 'ready', profile: res.data }
      : { kind: 'ready', profile: res.data };
  }
  if (res.reason === 'absent') return { kind: 'empty' };
  if (res.reason === 'malformed') {
    return { kind: 'malformed', raw: res.raw, message: res.message };
  }
  return { kind: 'unavailable', message: res.message };
}

/** True when an editor state represents a stored profile with zero user content. */
export function isEmptyProfileState(state: EditorLoadState): boolean {
  if (state.kind !== 'ready') return false;
  return !draftsDiffer(profileToDraft(state.profile), emptyDraft());
}

export async function saveDraft(draft: ProfileDraft): Promise<StorageResult<Profile> | null> {
  const candidate: Profile = {
    ...draft,
    schemaVersion: '2',
    updatedAt: new Date().toISOString(),
  };
  return saveProfile(candidate);
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                   */
/* ------------------------------------------------------------------ */

/** Returns per-issue messages for the whole draft (empty array = valid). */
export function validateDraft(draft: ProfileDraft): string[] {
  const candidate: Profile = { ...draft, schemaVersion: '2' };
  const check = profileSchema.safeParse(candidate);
  if (check.success) return [];
  return check.error.issues.map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`);
}

const urlPattern = /^https?:\/\/\S+$/;
/** Client-side URL check mirroring the schema, minus permissive edge cases. */
export function isValidHttpUrl(value: string): boolean {
  return urlPattern.test(value);
}

/* ------------------------------------------------------------------ */
/* Repeatable-item helpers (pure)                                       */
/* ------------------------------------------------------------------ */

export type WithId = { id: string };

function makeId(): string {
  // crypto.randomUUID is available in extension pages; fallback keeps tests simple.
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export function newItemExperience(): Experience {
  return {
    id: makeId(),
    company: '',
    title: '',
    dates: { start: '', end: null },
    bullets: [''],
  };
}

export function newItemEducation(): Education {
  return {
    id: makeId(),
    institution: '',
    dates: { start: '', end: null },
    inProgress: false,
  };
}

export function newItemCertification(): Certification {
  return { id: makeId(), name: '' };
}

export function newItemProject(): Project {
  return { id: makeId(), name: '', description: '', links: [], skills: [] };
}

export function addItem<T extends WithId>(items: T[], item: T): T[] {
  return [...items, item];
}

export function removeItem<T extends WithId>(items: T[], id: string): T[] {
  return items.filter((it) => it.id !== id);
}

export function updateItem<T extends WithId>(items: T[], id: string, patch: Partial<T>): T[] {
  return items.map((it) => (it.id === id ? { ...it, ...patch } : it));
}

/* ------------------------------------------------------------------ */
/* Date-field bridging (YYYY-MM <-> month inputs)                       */
/* ------------------------------------------------------------------ */

export interface DateFields {
  start: string;
  /** '' = ongoing schema-null. */
  end: string;
  /** Whether the item is "ongoing" (schema end = null). */
  ongoing: boolean;
}

export function dateRangeToFields(dr: Experience['dates']): DateFields {
  return {
    start: dr.start === '' ? '' : dr.start,
    end: dr.end ?? '',
    ongoing: dr.end === null,
  };
}

export function fieldsToDateRange(f: DateFields): Experience['dates'] {
  return {
    start: f.start,
    end: f.ongoing ? null : f.end === '' ? null : f.end,
  };
}

/* ------------------------------------------------------------------ */
/* Bullets bridging (textarea <-> array)                                */
/* ------------------------------------------------------------------ */

export function bulletsToLines(bullets: string[]): string {
  return bullets.join('\n');
}

/** Empty lines are content-free and dropped; the schema requires >= 1 bullet. */
export function linesToBullets(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

/* ------------------------------------------------------------------ */
/* Migration (uses storage service; kept here for one-call UI wiring)    */
/* ------------------------------------------------------------------ */

export { migrateLegacyProfile, getLegacyProfile, resetSensitiveProfile };
