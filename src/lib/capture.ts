/**
 * Current-page job capture (Prompt 08) — pure library, no side effects.
 *
 * Design rules:
 * - NOTHING is read from the page until the user clicks the capture action;
 *   `handleCaptureRequest()` runs only when the content script receives
 *   `CAPTURE_REQUEST_TYPE` (see entrypoints/content.ts). No page loads, no
 *   timers, no background crawling, no cookies, no network.
 * - NARROW EXTRACTION: only job-related inputs are inspected — JSON-LD
 *   `JobPosting` structured data, `<title>`/`h1`/og: meta tags, a short
 *   allowlist of company/location selectors, and ONE description container
 *   (article / role=main / job-description-ish). The whole body is NEVER
 *   dumped, and unrelated page text (nav, footer, ads) is not collected.
 * - UNTRUSTED INPUT: everything extracted is page-controlled. Messages are
 *   validated with zod on BOTH sides (`captureRequestSchema` in the content
 *   script, `validateCaptureResponse` in the popup). Size caps are enforced
 *   before anything is sent (100k chars description, 200 chars fields).
 * - NO INVENTION: fields the page does not state stay absent (never guessed
 *   from domains, nav text, etc.). The popup preview lets the user correct
 *   every field before saving.
 * - Error messages are fixed literals — they never embed page content.
 *
 * Best-effort capture targets (static-ish job pages with JSON-LD or clear
 * markup): boards.greenhouse.io, jobs.lever.co, www.workdayjobs.com,
 * www.indeed.com, www.linkedin.com/jobs, plus company career pages exposing
 * `<script type="application/ld+json">` with `@type: JobPosting`. JS-heavy
 * shells that render the description after load may yield title-only or
 * "no job content" — use manual intake then.
 */
import { z } from 'zod';
import {
  MAX_RAW_DESCRIPTION_CHARS,
  MAX_TEXT_FIELD_CHARS,
  MAX_TITLE_CHARS,
  postingUrlSchema,
} from './job-posting';

export const CAPTURE_REQUEST_TYPE = 'job-apply/capture-request';

/* ------------------------------------------------------------------ */
/* Message schemas (validated on both sides)                           */
/* ------------------------------------------------------------------ */

/** Request from popup -> content script. Strict: nothing else is accepted. */
export const captureRequestSchema = z
  .object({ type: z.literal(CAPTURE_REQUEST_TYPE) })
  .strict();

/** What the content script may send back (before defaults are applied). */
export const captureCandidateSchema = z
  .object({
    url: postingUrlSchema,
    title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
    company: z.string().trim().min(1).max(MAX_TEXT_FIELD_CHARS).optional(),
    location: z.string().trim().min(1).max(MAX_TEXT_FIELD_CHARS).optional(),
    descriptionText: z.string().max(MAX_RAW_DESCRIPTION_CHARS).default(''),
    descriptionTruncated: z.boolean().default(false),
  })
  .strict();

export type CaptureCandidate = z.infer<typeof captureCandidateSchema>;

export const captureResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok'), candidate: captureCandidateSchema }).strict(),
  z
    .object({
      kind: z.literal('error'),
      code: z.enum(['no-job-content', 'extract-failed']),
      /** Fixed literal from the content script — never page content. */
      message: z.string().min(1).max(300),
    })
    .strict(),
]);

export type CaptureResponse = z.infer<typeof captureResponseSchema>;

export type CaptureValidationResult =
  | { ok: true; value: CaptureResponse }
  | { ok: false; errors: string[] };

/** Validate an untrusted capture response (e.g. crossing the messaging boundary). */
export function validateCaptureResponse(payload: unknown): CaptureValidationResult {
  const parsed = captureResponseSchema.safeParse(payload);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map(
      (iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`,
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Extraction from a page (Document only — never body-wide)            */
/* ------------------------------------------------------------------ */

export type CaptureOutcome =
  | { kind: 'ok'; candidate: CaptureCandidate }
  | { kind: 'error'; code: 'no-job-content' | 'extract-failed'; message: string };

const CONTAINER_SELECTORS = [
  'article',
  '[role="main"]',
  '.job-description',
  '#job-description',
  '[class*="job-description"]',
  '[class*="jobDescription"]',
  '.description',
];

const COMPANY_SELECTORS = [
  '[itemprop="hiringOrganization"]',
  '.company-name',
  '.job-company',
  '[class*="company-name"]',
  '[class*="companyName"]',
  '[data-company]',
];

const LOCATION_SELECTORS = [
  '[itemprop="jobLocation"]',
  '.job-location',
  '[class*="job-location"]',
  '[class*="jobLocation"]',
];

const MIN_DESCRIPTION_CHARS = 80; // below this a container is treated as no content

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'");
}

/** Normalize whitespace while keeping line structure. Never invents content. */
function normalizeText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n')
    .trim();
}

function firstText(doc: Document, selectors: string[]): string | undefined {
  for (const sel of selectors) {
    let el: Element | null = null;
    try {
      el = doc.querySelector(sel);
    } catch {
      continue; // invalid selector on this engine — skip
    }
    const text = el?.textContent ? normalizeText(el.textContent) : '';
    if (text.length > 0) return text.slice(0, MAX_TEXT_FIELD_CHARS);
  }
  return undefined;
}

function largestContainer(doc: Document): Element | undefined {
  let best: Element | undefined;
  let bestLen = 0;
  for (const sel of CONTAINER_SELECTORS) {
    let els: NodeListOf<Element> | [] = [];
    try {
      els = doc.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const el of Array.from(els)) {
      const len = el.textContent?.length ?? 0;
      if (len > bestLen) {
        best = el;
        bestLen = len;
      }
    }
  }
  return best;
}

interface JsonLdJob {
  title?: string;
  company?: string;
  location?: string;
  description?: string;
}

function collectNodes(root: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(root)) {
    for (const item of root) collectNodes(item, out);
    return;
  }
  if (root !== null && typeof root === 'object') {
    const obj = root as Record<string, unknown>;
    if (Array.isArray(obj['@graph'])) collectNodes(obj['@graph'], out);
    out.push(obj);
  }
}

function isJobPostingNode(node: Record<string, unknown>): boolean {
  const t = node['@type'];
  return t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'));
}

/** Best-effort JSON-LD `JobPosting` reader (only structured job data). */
export function readJobPostingJsonLd(doc: Document): JsonLdJob | undefined {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of Array.from(scripts)) {
    const raw = script.textContent ?? '';
    if (!raw.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // broken JSON-LD is common; ignore
    }
    const nodes: Record<string, unknown>[] = [];
    collectNodes(parsed, nodes);
    const job = nodes.find(isJobPostingNode);
    if (!job) continue;

    const org = job['hiringOrganization'];
    const company =
      typeof org === 'string'
        ? org
        : org !== null && typeof org === 'object' && typeof (org as Record<string, unknown>)['name'] === 'string'
          ? ((org as Record<string, unknown>)['name'] as string)
          : undefined;

    const loc = job['jobLocation'];
    let location: string | undefined;
    const firstLoc = Array.isArray(loc) ? loc[0] : loc;
    if (typeof firstLoc === 'string') location = firstLoc;
    else if (firstLoc !== null && typeof firstLoc === 'object') {
      const addr = (firstLoc as Record<string, unknown>)['address'];
      const a = addr !== null && typeof addr === 'object' ? (addr as Record<string, unknown>) : undefined;
      if (a) {
        location = [a['addressLocality'], a['addressRegion'], a['addressCountry']]
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
          .join(', ');
      }
    }

    const title = typeof job['headline'] === 'string' ? (job['headline'] as string) : typeof job['title'] === 'string' ? (job['title'] as string) : undefined;
    const description = typeof job['description'] === 'string' ? (job['description'] as string) : undefined;

    return {
      title: title ? normalizeText(stripHtml(title)).slice(0, MAX_TITLE_CHARS) : undefined,
      company: company ? normalizeText(company).slice(0, MAX_TEXT_FIELD_CHARS) : undefined,
      location: location ? normalizeText(location).slice(0, MAX_TEXT_FIELD_CHARS) : undefined,
      description: description ? normalizeText(stripHtml(description)) : undefined,
    };
  }
  return undefined;
}

function metaContent(doc: Document, selectors: string[]): string | undefined {
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    const content = el?.getAttribute('content')?.trim();
    if (content) return content;
  }
  return undefined;
}

/**
 * Extract a capture candidate from a Document. CONSERVATIVE: title from
 * JSON-LD -> h1 -> og:title -> document.title; company/location only from
 * structured data or an explicit allowlist of job-related selectors (never
 * guessed from the domain); description from JSON-LD or the single largest
 * job-ish container. Unrelated page content (nav/footer/aside) is not read.
 */
export function extractJobCandidate(doc: Document, pageUrl: string): CaptureOutcome {
  try {
    const jsonLd = readJobPostingJsonLd(doc);

    let title =
      jsonLd?.title ??
      firstText(doc, ['h1']) ??
      metaContent(doc, ['meta[property="og:title"]']) ??
      normalizeText(doc.title ?? '');
    title = title.slice(0, MAX_TITLE_CHARS);

    const company = jsonLd?.company ?? firstText(doc, COMPANY_SELECTORS);

    let location = jsonLd?.location ?? firstText(doc, LOCATION_SELECTORS);
    if (location === undefined) {
      // Last resort: a location-ish class INSIDE the job container only.
      const container = largestContainer(doc);
      if (container) {
        const el = container.querySelector('[class*="location"]');
        const text = el?.textContent ? normalizeText(el.textContent) : '';
        if (text) location = text.slice(0, MAX_TEXT_FIELD_CHARS);
      }
    }

    let description = jsonLd?.description;
    if (!description || description.length < MIN_DESCRIPTION_CHARS) {
      const container = largestContainer(doc);
      const text = container?.textContent ? normalizeText(container.textContent) : '';
      const currentLen = description?.length ?? 0;
      if (text.length > currentLen) description = text;
    }
    if (!description) description = '';

    const descriptionTruncated = description.length > MAX_RAW_DESCRIPTION_CHARS;
    const descriptionText = description.slice(0, MAX_RAW_DESCRIPTION_CHARS);

    if (!title || descriptionText.length < MIN_DESCRIPTION_CHARS) {
      return {
        kind: 'error',
        code: 'no-job-content',
        message:
          'No job content found on this page. Try a job listing page, or use manual intake.',
      };
    }

    return {
      kind: 'ok',
      candidate: {
        url: pageUrl,
        title,
        ...(company ? { company } : {}),
        ...(location ? { location } : {}),
        descriptionText,
        descriptionTruncated,
      },
    };
  } catch {
    // Never echo page content in errors (fixed literal only).
    return {
      kind: 'error',
      code: 'extract-failed',
      message: 'Could not read job content from this page. Use manual intake instead.',
    };
  }
}

/* ------------------------------------------------------------------ */
/* Content-script message handler (pure; unit-tested with fixtures)    */
/* ------------------------------------------------------------------ */

/**
 * Handles ONE message from the popup. Returns undefined for any message that
 * is not ours (so other listeners are unaffected). Everything untrusted is
 * zod-validated; the response itself is schema-valid by construction.
 */
export function handleCaptureRequest(
  message: unknown,
  doc: Document,
  pageUrl: string,
): CaptureResponse | undefined {
  const req = captureRequestSchema.safeParse(message);
  if (!req.success) return undefined;
  const outcome = extractJobCandidate(doc, pageUrl);
  if (outcome.kind === 'ok') return { kind: 'ok', candidate: outcome.candidate };
  return { kind: 'error', code: outcome.code, message: outcome.message };
}
