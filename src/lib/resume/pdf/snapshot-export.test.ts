/**
 * Snapshot export tests (Prompt 19): a saved version is rendered from its
 * OWN snapshot through the existing `renderResumePdf` — never re-tailored —
 * with the same typed failures as the main export pipeline. Synthetic
 * fixtures only.
 */
import { describe, expect, it, vi } from 'vitest';
import { downloadResumeSnapshot } from './export';
import { renderResumePdf } from './render';
import { extractPdfText } from './test-support';
import type { TailoredResume } from '../schemas';

const snapshot: TailoredResume = {
  schemaVersion: '1',
  source: { jobId: 'job-old', jobTitle: 'Legacy Role', jobCapturedAt: '2026-01-05T00:00:00.000Z' },
  header: { displayName: 'Alex Example', headline: 'Backend engineer' },
  summary: {
    basis: 'profile-summary',
    text: 'Original summary from the day this version was saved.',
    sourceIds: [],
  },
  skills: [{ profileSkillId: 'sk-1', name: 'TypeScript', status: 'claimed', relevance: 'neutral' }],
  experience: [],
  projects: [],
  education: [],
  certifications: [],
  languages: [],
  selectionNotes: [],
};

describe('downloadResumeSnapshot', () => {
  it('renders the snapshot and downloads it once', async () => {
    const download = vi.fn((_blob: Blob, _filename: string) => ({ ok: true as const }));
    const outcome = await downloadResumeSnapshot(snapshot, { download });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.pageCount).toBeGreaterThanOrEqual(1);
    expect(outcome.filename).toMatch(/\.pdf$/);
    expect(download).toHaveBeenCalledTimes(1);
    const [blob, filename] = download.mock.calls[0]!;
    expect(blob.type).toBe('application/pdf');
    expect(filename).toBe(outcome.filename);
  });

  it('produces exactly renderResumePdf(snapshot) — the saved payload, untouched', async () => {
    const download = vi.fn((_blob: Blob, _filename: string) => ({ ok: true as const }));
    const outcome = await downloadResumeSnapshot(snapshot, { download });
    expect(outcome.ok).toBe(true);

    const direct = await renderResumePdf(snapshot);
    expect(direct.ok).toBe(true);
    if (!direct.ok || !outcome.ok) return;

    const exportedBytes = Buffer.from(await download.mock.calls[0]![0].arrayBuffer());
    const directBytes = Buffer.from(await direct.blob.arrayBuffer());
    expect(exportedBytes.equals(directBytes)).toBe(true);
    expect(outcome.filename).toBe(direct.filename);

    const text = await extractPdfText(download.mock.calls[0]![0]);
    expect(text).toContain('Original summary from the day this version was saved.');
    expect(text).toContain('Alex Example');
    expect(text).toContain('TypeScript');
    // Posting provenance is not resume content — still never rendered.
    expect(text).not.toContain('Legacy Role');
  });

  it('takes only the snapshot — profile and job are not required parameters', () => {
    // Only `snapshot` is required (`deps` has a default, so it is optional).
    expect(downloadResumeSnapshot.length).toBe(1);
  });

  it('returns a typed invalid result (no file) for a schema-invalid snapshot', async () => {
    const download = vi.fn(() => ({ ok: true as const }));
    const bad = {} as unknown as TailoredResume;
    const outcome = await downloadResumeSnapshot(bad, { download });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('invalid');
    expect(download).not.toHaveBeenCalled();
  });

  it('refuses unsupported characters instead of emitting a corrupted file', async () => {
    const download = vi.fn(() => ({ ok: true as const }));
    const unicode: TailoredResume = {
      ...snapshot,
      header: { displayName: '\u65E5\u672C\u8A9E' },
    };
    const outcome = await downloadResumeSnapshot(unicode, { download });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('unsupported-characters');
    // Only code points are reported — never the source text.
    expect(outcome.message).not.toContain('\u65E5\u672C\u8A9E');
    expect(download).not.toHaveBeenCalled();
  });

  it('surfaces a failed download as a typed result', async () => {
    const download = vi.fn(() => ({
      ok: false as const,
      reason: 'unavailable' as const,
      message: 'blocked',
    }));
    const outcome = await downloadResumeSnapshot(snapshot, { download });
    expect(outcome).toEqual({ ok: false, reason: 'download-unavailable', message: 'blocked' });
  });

  it('makes no network calls while exporting a snapshot', async () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    Object.assign(globalThis, { fetch: fetchSpy });
    try {
      const outcome = await downloadResumeSnapshot(snapshot, {
        download: () => ({ ok: true as const }),
      });
      expect(outcome.ok).toBe(true);
    } finally {
      Object.assign(globalThis, { fetch: original });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
