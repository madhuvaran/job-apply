/**
 * DOCX export tests (Prompt 20): the export pipeline renders a provided
 * `TailoredResume` — never re-tailoring, never reading the profile or a job —
 * so current and historical exports share one code path. Privacy/offline
 * boundaries are asserted by source scan, like the PDF renderer tests.
 * Synthetic fixtures only.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { createResumeHistoryEntry } from '../history';
import type { TailoredResume } from '../schemas';
import { downloadResumeDocx } from './export';
import { DOCX_MIME } from './document';
import { renderResumeDocx } from './render';

const ORIGINAL_SUMMARY = 'Original summary from the day this version was saved.';
const EDITED_SUMMARY = 'Edited summary that only exists in the current master profile.';

const snapshot: TailoredResume = {
  schemaVersion: '1',
  source: { jobId: 'job-old', jobTitle: 'Legacy Role', jobCapturedAt: '2026-01-05T00:00:00.000Z' },
  header: { displayName: 'Alex Example', headline: 'Backend engineer' },
  summary: { basis: 'profile-summary', text: ORIGINAL_SUMMARY, sourceIds: [] },
  skills: [{ profileSkillId: 'sk-1', name: 'TypeScript', status: 'claimed', relevance: 'neutral' }],
  experience: [],
  projects: [],
  education: [],
  certifications: [],
  languages: [],
  selectionNotes: [],
};

async function documentTextOf(blob: Blob): Promise<string> {
  const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const xml = strFromU8(entries['word/document.xml'] ?? new Uint8Array());
  return new DOMParser().parseFromString(xml, 'application/xml').documentElement.textContent ?? '';
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

describe('downloadResumeDocx', () => {
  it('renders the snapshot and downloads a .docx exactly once', async () => {
    const download = vi.fn((_blob: Blob, _filename: string) => ({ ok: true as const }));
    const outcome = await downloadResumeDocx(snapshot, { download });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.filename).toMatch(/\.docx$/);
    expect(download).toHaveBeenCalledTimes(1);
    const [blob, filename] = download.mock.calls[0]!;
    expect(blob.type).toBe(DOCX_MIME);
    expect(filename).toBe(outcome.filename);
  });

  it('produces exactly renderResumeDocx(snapshot) — the saved payload, untouched', async () => {
    const download = vi.fn((_blob: Blob, _filename: string) => ({ ok: true as const }));
    const outcome = await downloadResumeDocx(snapshot, { download });
    expect(outcome.ok).toBe(true);

    const direct = await renderResumeDocx(snapshot);
    expect(direct.ok).toBe(true);
    if (!direct.ok || !outcome.ok) return;

    const exportedBytes = Buffer.from(await download.mock.calls[0]![0].arrayBuffer());
    const directBytes = Buffer.from(await direct.blob.arrayBuffer());
    expect(exportedBytes.equals(directBytes)).toBe(true);
    expect(outcome.filename).toBe(direct.filename);

    expect(await documentTextOf(download.mock.calls[0]![0])).toContain(ORIGINAL_SUMMARY);
  });

  it('takes only the snapshot — profile and job are not required parameters', () => {
    // Only `resume` is required (`deps` has a default, so it is optional).
    expect(downloadResumeDocx.length).toBe(1);
  });

  it('returns a typed invalid result (no file) for a schema-invalid snapshot', async () => {
    const download = vi.fn(() => ({ ok: true as const }));
    const outcome = await downloadResumeDocx({} as unknown as TailoredResume, { download });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('invalid');
    expect(download).not.toHaveBeenCalled();
  });

  it('refuses characters XML cannot store instead of emitting a corrupted file', async () => {
    const download = vi.fn(() => ({ ok: true as const }));
    const broken: TailoredResume = {
      ...snapshot,
      summary: { basis: 'profile-summary', text: 'NUL \u0000 here', sourceIds: [] },
    };
    const outcome = await downloadResumeDocx(broken, { download });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('unsupported-characters');
    expect(outcome.message).toContain('U+0000');
    // Only code points are reported — never the source text.
    expect(outcome.message).not.toContain('NUL');
    expect(download).not.toHaveBeenCalled();
  });

  it('surfaces a failed download as a typed result', async () => {
    const download = vi.fn(() => ({
      ok: false as const,
      reason: 'unavailable' as const,
      message: 'blocked',
    }));
    const outcome = await downloadResumeDocx(snapshot, { download });
    expect(outcome).toEqual({ ok: false, reason: 'download-unavailable', message: 'blocked' });
  });

  it('does not mutate the saved snapshot', async () => {
    const frozen = deepFreeze(JSON.parse(JSON.stringify(snapshot)) as TailoredResume);
    const before = JSON.stringify(frozen);
    const outcome = await downloadResumeDocx(frozen, { download: () => ({ ok: true as const }) });
    expect(outcome.ok).toBe(true);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it('historical export uses the saved snapshot even after the master profile changes', async () => {
    const entry = createResumeHistoryEntry(
      snapshot,
      { id: 'job-old', title: 'Legacy Role', company: undefined },
      { now: () => '2026-01-06T00:00:00.000Z', id: () => 'rv-1' },
    );
    // A "current" profile that would tailor to something entirely different.
    const editedMasterProfile = { summary: EDITED_SUMMARY };

    const download = vi.fn((_blob: Blob, _filename: string) => ({ ok: true as const }));
    const outcome = await downloadResumeDocx(entry.snapshot, { download });
    expect(outcome.ok).toBe(true);

    const text = await documentTextOf(download.mock.calls[0]![0]);
    expect(text).toContain(ORIGINAL_SUMMARY);
    expect(text).not.toContain(EDITED_SUMMARY);
    expect(text).not.toContain(editedMasterProfile.summary);
    // The history entry itself is unchanged.
    expect(entry.snapshot.summary?.text).toBe(ORIGINAL_SUMMARY);
  });

  it('historical export works when the associated job posting is missing (orphaned)', async () => {
    // `job-old` exists in no job store; the export must not care.
    const download = vi.fn((_blob: Blob, _filename: string) => ({ ok: true as const }));
    const outcome = await downloadResumeDocx(snapshot, { download });
    expect(outcome.ok).toBe(true);
    const text = await documentTextOf(download.mock.calls[0]![0]);
    // Provenance (posting title/id) is not resume content and is not rendered.
    expect(text).not.toContain('Legacy Role');
    expect(text).not.toContain('job-old');
    expect(text).toContain('Alex Example');
  });

  it('carries no sensitive-profile data into the document', async () => {
    const download = vi.fn((_blob: Blob, _filename: string) => ({ ok: true as const }));
    const outcome = await downloadResumeDocx(snapshot, { download });
    expect(outcome.ok).toBe(true);
    const text = await documentTextOf(download.mock.calls[0]![0]);
    // No contact / legal / voluntary / compensation material can appear: none
    // of those fields exist in the TailoredResume contract.
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/work authorization|sponsorship|gender|veteran|disability|salary/i);

    // And a snapshot carrying an out-of-contract sensitive key is refused.
    const injected = { ...snapshot, sensitive: { email: 'alex@example.com' } };
    const rejected = await downloadResumeDocx(injected as unknown as TailoredResume, {
      download: () => ({ ok: true as const }),
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.reason).toBe('invalid');
    expect(JSON.stringify(rejected)).not.toContain('alex@example.com');
  });

  it('makes no network calls while exporting a snapshot', async () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    Object.assign(globalThis, { fetch: fetchSpy });
    try {
      const outcome = await downloadResumeDocx(snapshot, { download: () => ({ ok: true as const }) });
      expect(outcome.ok).toBe(true);
    } finally {
      Object.assign(globalThis, { fetch: original });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never imports the sensitive profile, tailoring, storage, AI or a network layer', () => {
    const dir = join(process.cwd(), 'src', 'lib', 'resume', 'docx');
    const sources = readdirSync(dir)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => readFileSync(join(dir, file), 'utf8'))
      .join('\n');

    // The DOCX writer must not be able to read a profile, a job, storage or a
    // provider — it only consumes a validated TailoredResume.
    expect(sources).not.toMatch(/from ['"].*sensitive['"]/);
    expect(sources).not.toMatch(/from ['"].*\/tailor['"]/);
    expect(sources).not.toMatch(/from ['"].*storage['"]/);
    expect(sources).not.toMatch(/from ['"].*\/ai\//);
    expect(sources).not.toMatch(/loadSensitiveProfile|loadProfile|loadJobPostings/);
    expect(sources).not.toMatch(/chrome\.storage|browser\.storage/);
    expect(sources).not.toMatch(/\bfetch\s*\(/);
    expect(sources).not.toMatch(/XMLHttpRequest|WebSocket|sendBeacon/);
  });
});
