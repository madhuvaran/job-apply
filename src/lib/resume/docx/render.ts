/**
 * ATS-friendly resume DOCX renderer (Prompt 20).
 *
 * `renderResumeDocx(input)` validates an untrusted value against the EXISTING
 * strict `tailoredResumeSchema` (Prompt 11 — no competing content schema),
 * builds the minimal WordprocessingML parts (see `./document`) and packages
 * them into a `.docx` (Office Open XML) file.
 *
 * Packaging: `fflate` is used ONLY as the ZIP container writer. It is a small,
 * actively maintained, zero-dependency, browser- and Node-compatible library
 * (MIT). DOCX is a ZIP package and the project has no other way to write one;
 * see PROGRESS.md for why a full DOCX-generation library was not used (it would
 * embed hidden metadata and a generation timestamp, and would hide the OOXML
 * we want to keep explicitly ATS-safe).
 *
 * Presentation layer ONLY — it never invents, paraphrases, summarises or
 * corrects content, and it renders no field outside the schema (no contact
 * details, no evidence ids, no relevance/selection metadata, no job text). The
 * sensitive profile is never imported or read; nothing is fetched.
 *
 * Determinism: identical valid inputs produce byte-identical packages. ZIP
 * entry timestamps are pinned to a fixed constant expressed as a LOCAL date
 * (so the DOS date/time bytes are identical in every timezone — verified), the
 * entries are STORED (no compressor), and no `docProps` metadata is written.
 *
 * Typed results (no throws for expected failures):
 * - `invalid`   — input failed strict schema validation (path+code issues).
 * - `unsupported-characters` — text contains code points XML 1.0 cannot
 *   represent; we refuse rather than emit a corrupted document. Only bare
 *   `U+XXXX` tokens are reported (never the source text).
 * - `render-failed` — an unexpected packaging failure.
 */
import { strToU8, zipSync, type ZipOptions } from 'fflate';
import { formatCodePoints } from '../pdf/text';
import { validateTailoredResume, type TailoredResume } from '../schemas';
import { buildDocxParts, DOCX_MIME, resumeBlockTexts } from './document';
import { findUnsupportedXmlCodePoints } from './xml';

/**
 * Fixed timestamp for every ZIP entry. Constructed from LOCAL components, so
 * the derived DOS date/time is identical regardless of the machine's timezone.
 * Also avoids leaking a "generated at" time into the file.
 */
const ZIP_EPOCH = new Date(1980, 0, 1, 12, 0, 0);

/** Longest job-title slug kept in the filename. */
export const MAX_FILENAME_SLUG = 60;

export type ResumeDocxResult =
  | { ok: true; blob: Blob; filename: string }
  | { ok: false; code: 'invalid'; issues: string[] }
  | { ok: false; code: 'unsupported-characters'; issues: string[] }
  | { ok: false; code: 'render-failed'; issues: string[] };

/**
 * Lowercase ASCII slug for a filename label. Every character outside `[a-z0-9]`
 * (including path separators, dots and control characters) collapses to '-', so
 * the result cannot traverse, hide an extension, or inject a path.
 */
function slugifyLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_FILENAME_SLUG)
    .replace(/-+$/, '');
}

/**
 * `resume-<job-title-slug>-tailored.docx`, with a neutral `resume-tailored.docx`
 * fallback when the (required) job-title label yields no usable characters.
 * No employer or job title is ever invented — the label comes from the
 * snapshot's own provenance.
 */
export function resumeDocxFilename(resume: TailoredResume): string {
  const slug = slugifyLabel(resume.source.jobTitle);
  return slug.length > 0 ? `resume-${slug}-tailored.docx` : 'resume-tailored.docx';
}

/**
 * Render a validated (or untrusted) resume value to a DOCX Blob.
 * Never throws for expected user-data failures.
 */
export async function renderResumeDocx(input: unknown): Promise<ResumeDocxResult> {
  const validation = validateTailoredResume(input);
  if (!validation.ok) return { ok: false, code: 'invalid', issues: validation.issues };
  const resume = validation.resume;

  const unsupported = new Set<number>();
  for (const text of resumeBlockTexts(resume)) {
    for (const codePoint of findUnsupportedXmlCodePoints(text)) unsupported.add(codePoint);
  }
  if (unsupported.size > 0) {
    return {
      ok: false,
      code: 'unsupported-characters',
      issues: formatCodePoints([...unsupported].sort((a, b) => a - b)),
    };
  }

  try {
    const files: Record<string, [Uint8Array, ZipOptions]> = {};
    for (const part of buildDocxParts(resume)) {
      files[part.path] = [strToU8(part.content), { mtime: ZIP_EPOCH, level: 0 }];
    }
    const bytes = zipSync(files, { level: 0, mtime: ZIP_EPOCH });
    return {
      ok: true,
      blob: new Blob([bytes as unknown as BlobPart], { type: DOCX_MIME }),
      filename: resumeDocxFilename(resume),
    };
  } catch (error) {
    // Never surface resume text or library internals that could carry it.
    return {
      ok: false,
      code: 'render-failed',
      issues: [`DOCX packaging failed (${error instanceof Error ? error.name : 'unknown'}).`],
    };
  }
}
