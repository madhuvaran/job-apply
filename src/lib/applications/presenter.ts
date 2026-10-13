/**
 * Presentation layer for the application log (Prompt 13).
 *
 * Pure view-model: turns application records + the saved job postings into
 * display rows (resolving title/employer, flagging orphaned references) and
 * applies filtering/sorting deterministically. No storage, no DOM, no network.
 */
import type { JobPosting } from '../job-posting';
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_LABELS,
  type Application,
  type ApplicationStatus,
} from './schemas';

export type ApplicationSortKey = 'updated' | 'applicationDate' | 'created';

export const APPLICATION_SORT_KEYS: readonly ApplicationSortKey[] = [
  'updated',
  'applicationDate',
  'created',
];

export const APPLICATION_SORT_LABELS: Record<ApplicationSortKey, string> = {
  updated: 'Last updated',
  applicationDate: 'Application date',
  created: 'Date created',
};

export type ApplicationStatusFilter = 'all' | ApplicationStatus;

export const APPLICATION_FILTER_OPTIONS: ReadonlyArray<{
  value: ApplicationStatusFilter;
  label: string;
}> = [
  { value: 'all', label: 'All statuses' },
  ...APPLICATION_STATUSES.map((s) => ({ value: s as ApplicationStatusFilter, label: APPLICATION_STATUS_LABELS[s] })),
];

/** Fixed, user-facing label when the referenced saved job no longer exists. */
export const ORPHANED_JOB_LABEL = 'Job posting no longer saved';

export interface ApplicationRow {
  id: string;
  jobId: string;
  status: ApplicationStatus;
  statusLabel: string;
  /** Job title when the posting still exists; null when orphaned. */
  jobTitle: string | null;
  employer: string | null;
  /** True when the referenced job posting is no longer in storage. */
  orphaned: boolean;
  applicationDate: string | null;
  followUpDate: string | null;
  createdAt: string;
  updatedAt: string;
  /** Short, display-only "Updated YYYY-MM-DD" label (date part of updatedAt). */
  updatedAtLabel: string;
  notes: string | null;
  /** Original posting URL when available (never invented). */
  jobUrl: string | null;
}

/** Build one display row per application, resolving its job posting if present. */
export function buildApplicationRows(
  applications: readonly Application[],
  postings: readonly JobPosting[],
): ApplicationRow[] {
  const byId = new Map(postings.map((p) => [p.id, p]));
  return applications.map((application) => {
    const job = byId.get(application.jobId);
    return {
      id: application.id,
      jobId: application.jobId,
      status: application.status,
      statusLabel: APPLICATION_STATUS_LABELS[application.status],
      jobTitle: job?.title ?? null,
      employer: job?.company ?? null,
      orphaned: job === undefined,
      applicationDate: application.applicationDate ?? null,
      followUpDate: application.followUpDate ?? null,
      createdAt: application.createdAt,
      updatedAt: application.updatedAt,
      updatedAtLabel: `Updated ${application.updatedAt.slice(0, 10)}`,
      notes: application.notes ?? null,
      jobUrl: job?.originalUrl ?? null,
    };
  });
}

function primaryValue(row: ApplicationRow, sort: ApplicationSortKey): string | null {
  if (sort === 'updated') return row.updatedAt;
  if (sort === 'created') return row.createdAt;
  return row.applicationDate;
}

/**
 * Deterministic ordering: primary date descending (ISO strings sort
 * lexicographically), missing primary dates LAST, then `createdAt` descending,
 * then `id` ascending as a stable tie-break.
 */
export function compareApplicationRows(
  a: ApplicationRow,
  b: ApplicationRow,
  sort: ApplicationSortKey,
): number {
  const av = primaryValue(a, sort);
  const bv = primaryValue(b, sort);
  if (av === null && bv !== null) return 1;
  if (av !== null && bv === null) return -1;
  if (av !== null && bv !== null && av !== bv) return av < bv ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export interface ApplicationSelection {
  status?: ApplicationStatusFilter;
  sort?: ApplicationSortKey;
}

/** Filter by status, then sort deterministically, then build display rows. */
export function selectApplicationRows(
  applications: readonly Application[],
  postings: readonly JobPosting[],
  selection: ApplicationSelection = {},
): ApplicationRow[] {
  const status = selection.status ?? 'all';
  const sort = selection.sort ?? 'updated';
  const filtered =
    status === 'all' ? [...applications] : applications.filter((a) => a.status === status);
  return buildApplicationRows(filtered, postings).sort((a, b) => compareApplicationRows(a, b, sort));
}
