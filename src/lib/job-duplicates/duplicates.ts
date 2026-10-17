/**
 * Deterministic duplicate-job detection (Prompt 26) — pure, local, no side
 * effects.
 *
 * `findDuplicateJob({ candidate, savedJobs, externalIds })` answers ONE
 * question: is the posting about to be saved already in the saved list?
 *
 * Conservative rules, applied in this order (first hit wins):
 * 1. **Canonical URL** — validated http(s) URLs compared after removing the
 *    fragment and normalizing only safe, irrelevant differences (URL-standard
 *    scheme/host case folding, a leading `www.`, an explicit non-default port).
 *    The path and every query parameter are PRESERVED verbatim: they can be the
 *    only thing distinguishing two vacancies, and arbitrary parameters are
 *    never stripped or reordered.
 * 2. **Explicit external job identifier** — only identifiers the SOURCE itself
 *    published, and only inside the same source domain (the identifier is
 *    trusted only when it belongs to that saved job's own URL host). Never
 *    invented, never compared across domains.
 * 3. **Normalized company + title** — the weak fallback: case + surrounding and
 *    repeated whitespace only. No fuzzy/partial/stemmed matching, so two
 *    genuinely different vacancies never merge. A hit here is reported as a
 *    POSSIBLE duplicate for the user to review.
 * 4. Otherwise: no duplicate.
 *
 * Several saved records matching the SAME trustworthy identity produce an
 * explicit `ambiguous` result (no winner is chosen, no record is merged).
 *
 * The function is side-effect-free: it never reads storage, never touches the
 * clock, never calls the network, a browser API or an AI provider, never mutates
 * its input and never filters, sorts or rewrites the saved list. Malformed saved
 * records are skipped (and counted) — they are never treated as trustworthy
 * matches. Diagnostics carry fixed literals plus saved job ids/titles only:
 * never page text, never captured field values, never a raw exception.
 */
import { jobPostingSchema, postingUrlSchema, type JobPosting } from '../job-posting';
import {
  DUPLICATE_METHODS,
  DUPLICATE_REASON_EXPLANATIONS,
  DUPLICATE_SCHEMA_VERSION,
  duplicateCandidateSchema,
  MAX_DUPLICATE_MATCHES,
  MIN_IDENTITY_CHARS,
  savedDuplicateIndicationSchema,
  savedExternalIdSchema,
  type DuplicateCandidate,
  type DuplicateCheckOutcome,
  type DuplicateCheckResult,
  type DuplicateMatch,
  type DuplicateMethod,
  type DuplicateReasonCode,
  type SavedDuplicateIndication,
  type SavedExternalId,
} from './schemas';

const NOTE_SKIPPED_SAVED_JOBS =
  'Some saved jobs could not be read and were not compared.';
const NOTE_UNTRUSTED_EXTERNAL_IDS =
  'Some saved job identifiers could not be trusted and were not compared.';
const NOTE_UNSCOPED_EXTERNAL_ID =
  'This posting carries a source job identifier but no URL, so the identifier could not be checked against its source.';

/* ------------------------------------------------------------------ */
/* Normalization (the ONLY differences that may be ignored)            */
/* ------------------------------------------------------------------ */

/**
 * Canonical form of a validated http(s) URL for comparison. Removes the
 * fragment and normalizes only safe, irrelevant differences; the scheme, the
 * path and every query parameter are kept exactly as written (an explicit
 * `https://` and `http://` are therefore NOT the same posting). Returns
 * `undefined` for anything that is not a valid http(s) URL.
 */
export function canonicalJobUrl(url: string): string | undefined {
  const parsed = postingUrlSchema.safeParse(url);
  if (!parsed.success) return undefined;
  let parts: URL;
  try {
    parts = new URL(parsed.data);
  } catch {
    return undefined; // unreachable after validation; fail closed anyway
  }
  // `URL` already lowercases the scheme/host and drops default ports.
  const host = parts.hostname.toLowerCase().replace(/^www\./, '');
  const port = parts.port === '' ? '' : `:${parts.port}`;
  const path = parts.pathname === '' ? '/' : parts.pathname;
  return `${parts.protocol}//${host}${port}${path}${parts.search}`;
}

/** Source domain of a validated http(s) URL (lowercase, `www.` removed). */
export function sourceDomain(url: string): string | undefined {
  const canonical = canonicalJobUrl(url);
  if (canonical === undefined) return undefined;
  try {
    return new URL(canonical).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Company/title comparison key: surrounding whitespace, case and repeated
 * whitespace only. Punctuation and word order are preserved (no fuzzing).
 */
export function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function usableIdentity(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeIdentity(value);
  return normalized.length >= MIN_IDENTITY_CHARS ? normalized : undefined;
}

/* ------------------------------------------------------------------ */
/* Result builders                                                     */
/* ------------------------------------------------------------------ */

function formatIssues(
  prefix: string,
  issues: ReadonlyArray<{ path: PropertyKey[]; code: string }>,
): string[] {
  // Path + zod issue CODE only — never the offending value.
  return issues.map((i) => `${prefix}.${i.path.map(String).join('.') || '(root)'}: ${i.code}`);
}

function base(
  reasonCode: DuplicateReasonCode,
  inspectedJobs: number,
  skippedJobs: number,
  notes: string[],
): Omit<DuplicateCheckResult, 'duplicate' | 'status' | 'method' | 'jobId' | 'ambiguous' | 'matches'> {
  return {
    schemaVersion: DUPLICATE_SCHEMA_VERSION,
    reasonCode,
    explanation: DUPLICATE_REASON_EXPLANATIONS[reasonCode],
    inspectedJobs,
    skippedJobs,
    notes: [...new Set(notes)].slice(0, 4),
  };
}

function matchFrom(job: JobPosting, method: DuplicateMethod): DuplicateMatch {
  return {
    jobId: job.id,
    title: job.title,
    company: job.company ?? null,
    originalUrl: job.originalUrl ?? null,
    method,
  };
}

/** De-duplicate by job id and order by job id (deterministic, input-order free). */
function stableMatches(jobs: readonly JobPosting[], method: DuplicateMethod): DuplicateMatch[] {
  const byId = new Map<string, JobPosting>();
  for (const job of jobs) byId.set(job.id, job);
  return [...byId.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_DUPLICATE_MATCHES)
    .map((id) => matchFrom(byId.get(id) as JobPosting, method));
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export interface DuplicateCheckInput {
  /** The not-yet-saved posting (validated here; invalid input fails typed). */
  candidate: unknown;
  /** Saved posting records (unvalidated; invalid records are skipped). */
  savedJobs: readonly unknown[];
  /** Trusted source identifiers, when the caller has any (optional). */
  externalIds?: readonly unknown[];
}

/**
 * Deterministic duplicate check. Identical validated inputs always produce an
 * identical result; inputs are never mutated.
 */
export function findDuplicateJob(input: DuplicateCheckInput): DuplicateCheckOutcome {
  const candidateParsed = duplicateCandidateSchema.safeParse(input.candidate);
  if (!candidateParsed.success) {
    return { kind: 'invalid', issues: formatIssues('candidate', candidateParsed.error.issues) };
  }
  const candidate: DuplicateCandidate = candidateParsed.data;

  /* --- saved jobs (invalid records are skipped, never trusted) --- */
  const saved: JobPosting[] = [];
  let skippedJobs = 0;
  for (const raw of input.savedJobs) {
    const parsed = jobPostingSchema.safeParse(raw);
    if (parsed.success) saved.push(parsed.data);
    else skippedJobs += 1;
  }

  const notes: string[] = [];
  if (skippedJobs > 0) notes.push(NOTE_SKIPPED_SAVED_JOBS);

  const candidateUrl = candidate.originalUrl;
  const candidateCanonical = candidateUrl === undefined ? undefined : canonicalJobUrl(candidateUrl);
  const candidateDomain = candidateUrl === undefined ? undefined : sourceDomain(candidateUrl);
  const candidateTitle = usableIdentity(candidate.title);
  const candidateCompany = usableIdentity(candidate.company);
  const externalId = candidate.externalId;

  /* --- rule 1: canonical URL --- */
  if (candidateCanonical !== undefined) {
    const hits = saved.filter(
      (job) => job.originalUrl !== undefined && canonicalJobUrl(job.originalUrl) === candidateCanonical,
    );
    const resolved = resolve(hits, 'canonical-url', 'same-canonical-url', 'multiple-url-matches', saved, skippedJobs, notes);
    if (resolved !== null) return { kind: 'valid', result: resolved };
  }

  /* --- rule 2: explicit external identifier, same source domain only --- */
  if (externalId !== undefined && candidateDomain === undefined) {
    // No URL means no source domain, so an identifier could not be scoped.
    notes.push(NOTE_UNSCOPED_EXTERNAL_ID);
  } else if (externalId !== undefined) {
    const savedById = new Map(saved.map((job) => [job.id, job]));
    const usableIds: { job: JobPosting; externalId: string }[] = [];
    let untrusted = 0;
    for (const raw of input.externalIds ?? []) {
      const parsed = savedExternalIdSchema.safeParse(raw);
      if (!parsed.success) {
        untrusted += 1;
        continue;
      }
      const entry: SavedExternalId = parsed.data;
      const job = savedById.get(entry.jobId);
      const jobUrl: string | undefined = job?.originalUrl;
      const jobDomain = jobUrl === undefined ? undefined : sourceDomain(jobUrl);
      // An identifier is trusted only when it belongs to that saved job's OWN
      // source domain; otherwise it could merge two different sites' jobs.
      if (job === undefined || jobDomain === undefined || jobDomain !== entry.domain) {
        untrusted += 1;
        continue;
      }
      // ...and it is only ever COMPARED inside the candidate's own source domain.
      if (entry.domain !== candidateDomain) continue;
      usableIds.push({ job, externalId: entry.externalId });
    }
    if (untrusted > 0) notes.push(NOTE_UNTRUSTED_EXTERNAL_IDS);

    const hits = usableIds
      .filter((entry) => entry.externalId === externalId)
      .map((entry) => entry.job);
    const resolved = resolve(
      hits,
      'external-id',
      'same-external-id',
      'multiple-external-id-matches',
      saved,
      skippedJobs,
      notes,
    );
    if (resolved !== null) return { kind: 'valid', result: resolved };
  }

  /* --- rule 3: normalized company + title (weak, review-only) --- */
  if (candidateCompany !== undefined && candidateTitle !== undefined) {
    const hits = saved.filter(
      (job) =>
        usableIdentity(job.company) === candidateCompany && usableIdentity(job.title) === candidateTitle,
    );
    if (hits.length > 0) {
      const matches = stableMatches(hits, 'company-title');
      return {
        kind: 'valid',
        result: {
          ...base('same-company-and-title', saved.length, skippedJobs, notes),
          duplicate: true,
          status: 'possible',
          method: 'company-title',
          // Only claimed when exactly ONE saved record matched.
          jobId: matches.length === 1 ? matches[0]!.jobId : null,
          ambiguous: matches.length > 1,
          matches,
        },
      };
    }
  }

  /* --- rule 4: nothing matched --- */
  const hadUsableIdentity =
    candidateCanonical !== undefined ||
    (externalId !== undefined && candidateDomain !== undefined) ||
    (candidateCompany !== undefined && candidateTitle !== undefined);
  return {
    kind: 'valid',
    result: {
      ...base(hadUsableIdentity ? 'no-reliable-match' : 'no-usable-identity', saved.length, skippedJobs, notes),
      duplicate: false,
      status: 'none',
      method: null,
      jobId: null,
      ambiguous: false,
      matches: [],
    },
  };
}

/** Confirmed (1 hit) / ambiguous (>1 hits) / `null` when nothing hit. */
function resolve(
  hits: readonly JobPosting[],
  method: DuplicateMethod,
  singleCode: DuplicateReasonCode,
  multipleCode: DuplicateReasonCode,
  saved: readonly JobPosting[],
  skippedJobs: number,
  notes: string[],
): DuplicateCheckResult | null {
  if (hits.length === 0) return null;
  const matches = stableMatches(hits, method);
  if (matches.length === 1) {
    return {
      ...base(singleCode, saved.length, skippedJobs, notes),
      duplicate: true,
      status: 'confirmed',
      method,
      jobId: matches[0]!.jobId,
      ambiguous: false,
      matches,
    };
  }
  return {
    ...base(multipleCode, saved.length, skippedJobs, notes),
    duplicate: true,
    status: 'ambiguous',
    method,
    jobId: null, // several matches: never silently choose one
    ambiguous: true,
    matches,
  };
}

/** The methods, exported for UI copy/tests (documented order). */
export const DUPLICATE_METHOD_ORDER: readonly DuplicateMethod[] = DUPLICATE_METHODS;

/* ------------------------------------------------------------------ */
/* Saved jobs vs saved jobs (Prompt 30)                                */
/* ------------------------------------------------------------------ */

export interface SavedDuplicatesInput {
  /** Saved posting records (unvalidated; invalid records are skipped). */
  savedJobs: readonly unknown[];
}

export type SavedDuplicatesOutcome =
  | {
      kind: 'valid';
      /** One indication per VALID saved job id (never for skipped records). */
      byJobId: ReadonlyMap<string, SavedDuplicateIndication>;
      inspectedJobs: number;
      skippedJobs: number;
    }
  | { kind: 'invalid'; issues: string[] };

const RELATIONSHIP_SEPARATOR = '\u0000';

/** Build an indication through the strict schema (invariant, never trusted). */
function indication(
  status: SavedDuplicateIndication['status'],
  method: DuplicateMethod | null,
  equivalentJobIds: string[],
): SavedDuplicateIndication {
  return savedDuplicateIndicationSchema.parse({ status, method, equivalentJobIds });
}

function addToGroup(groups: Map<string, string[]>, key: string, jobId: string): void {
  const existing = groups.get(key);
  if (existing === undefined) groups.set(key, [jobId]);
  else if (!existing.includes(jobId)) existing.push(jobId);
}

/** Every OTHER job id in the group: de-duplicated, sorted, bounded. */
function otherIds(group: string[] | undefined, selfId: string): string[] {
  if (group === undefined) return [];
  return [...new Set(group)]
    .filter((id) => id !== selfId)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_DUPLICATE_MATCHES);
}

/**
 * Deterministic SAVED-vs-SAVED duplicate indications (Prompt 30).
 *
 * Reuses the detector's own documented rules and helpers — canonical URL,
 * external identifier scoped to the same source domain, then normalized
 * company+title — but compares the saved list with ITSELF instead of with a
 * candidate. First matching rule wins, so the strongest evidence decides.
 *
 * Boundaries (deliberate):
 * - It NEVER reads storage, never writes/merges/deletes a record, never touches
 *   the clock, the DOM, the network or an AI provider, and never mutates input.
 * - Malformed saved records are skipped (never trusted as evidence).
 * - Records are keyed by id, so a repeated id collapses to one entry and the
 *   output is independent of the input order.
 * - Weak company+title hits are ALWAYS `possible`, even when several records
 *   share it — three "Engineer at Acme" postings are a reason to look, not
 *   proof of equivalence.
 * - `equivalentJobIds` carries job ids only (no titles/companies/text).
 */
export function findSavedJobDuplicates(input: SavedDuplicatesInput): SavedDuplicatesOutcome {
  if (input === null || typeof input !== 'object' || !Array.isArray(input.savedJobs)) {
    return { kind: 'invalid', issues: ['savedJobs: invalid_type'] };
  }

  /* --- validate + dedupe by id, then sort by id (order-independent) --- */
  const byId = new Map<string, JobPosting>();
  let skippedJobs = 0;
  for (const raw of input.savedJobs) {
    const parsed = jobPostingSchema.safeParse(raw);
    if (!parsed.success) {
      skippedJobs += 1;
      continue;
    }
    byId.set(parsed.data.id, parsed.data);
  }
  const saved = [...byId.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((id) => byId.get(id) as JobPosting);

  /* --- identity groups (each key is built from normalized values only) --- */
  const byUrl = new Map<string, string[]>();
  const byExternalId = new Map<string, string[]>();
  const byCompanyTitle = new Map<string, string[]>();
  for (const job of saved) {
    const canonical = job.originalUrl === undefined ? undefined : canonicalJobUrl(job.originalUrl);
    if (canonical !== undefined) addToGroup(byUrl, canonical, job.id);

    const domain = job.originalUrl === undefined ? undefined : sourceDomain(job.originalUrl);
    if (domain !== undefined && job.externalId !== undefined) {
      addToGroup(byExternalId, `${domain}${RELATIONSHIP_SEPARATOR}${job.externalId}`, job.id);
    }

    const company = usableIdentity(job.company);
    const title = usableIdentity(job.title);
    if (company !== undefined && title !== undefined) {
      addToGroup(byCompanyTitle, `${company}${RELATIONSHIP_SEPARATOR}${title}`, job.id);
    }
  }

  /* --- first matching rule wins, per job --- */
  const byJobId = new Map<string, SavedDuplicateIndication>();
  for (const job of saved) {
    const canonical = job.originalUrl === undefined ? undefined : canonicalJobUrl(job.originalUrl);
    const urlOthers = otherIds(canonical === undefined ? undefined : byUrl.get(canonical), job.id);
    if (urlOthers.length > 0) {
      byJobId.set(
        job.id,
        indication(urlOthers.length === 1 ? 'confirmed' : 'ambiguous', 'canonical-url', urlOthers),
      );
      continue;
    }

    const domain = job.originalUrl === undefined ? undefined : sourceDomain(job.originalUrl);
    const externalOthers =
      domain === undefined || job.externalId === undefined
        ? []
        : otherIds(
            byExternalId.get(`${domain}${RELATIONSHIP_SEPARATOR}${job.externalId}`),
            job.id,
          );
    if (externalOthers.length > 0) {
      byJobId.set(
        job.id,
        indication(
          externalOthers.length === 1 ? 'confirmed' : 'ambiguous',
          'external-id',
          externalOthers,
        ),
      );
      continue;
    }

    const company = usableIdentity(job.company);
    const title = usableIdentity(job.title);
    const possibleOthers =
      company === undefined || title === undefined
        ? []
        : otherIds(byCompanyTitle.get(`${company}${RELATIONSHIP_SEPARATOR}${title}`), job.id);
    if (possibleOthers.length > 0) {
      byJobId.set(job.id, indication('possible', 'company-title', possibleOthers));
      continue;
    }

    byJobId.set(job.id, indication('none', null, []));
  }

  return { kind: 'valid', byJobId, inspectedJobs: saved.length, skippedJobs };
}
