/**
 * Pipeline tests (Prompt 12): tailoring → rendering → download, including all
 * failure paths that must NOT produce a PDF.
 */
import { describe, expect, it, vi } from 'vitest';
import { jobPostingSchema } from '../../job-posting';
import { profileSchema, type Profile } from '../../profile';
import { downloadTailoredResumePdf, generateAndDownloadResume } from './export';
import { baseResume } from './test-support';

const job = jobPostingSchema.parse({
  id: 'job-1',
  title: 'Senior Backend Engineer',
  rawDescription: 'We need TypeScript and Kubernetes experience.',
  requiredQualifications: ['TypeScript'],
  capturedAt: '2026-10-13T00:00:00.000Z',
});

const profile = profileSchema.parse({
  schemaVersion: '2',
  displayName: 'Alex Example',
  summary: 'Backend engineer.',
  skills: [
    { id: 'sk-1', name: 'TypeScript' },
    { id: 'sk-2', name: 'Kubernetes' },
  ],
});

describe('generateAndDownloadResume', () => {
  it('tailors, renders and downloads on the happy path', async () => {
    const download = vi.fn((_blob: Blob, _filename: string) => ({ ok: true as const }));
    const outcome = await generateAndDownloadResume(profile, job, { download });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.pageCount).toBeGreaterThanOrEqual(1);
    expect(outcome.filename).toMatch(/\.pdf$/);
    expect(download).toHaveBeenCalledTimes(1);
    const [blob, filename] = download.mock.calls[0]!;
    expect(blob).toBeInstanceOf(Blob);
    expect((blob as Blob).type).toBe('application/pdf');
    expect(filename).toBe(outcome.filename);
  });

  it('does not download when the client download step fails', async () => {
    const download = vi.fn(() => ({ ok: false as const, reason: 'unavailable' as const, message: 'blocked' }));
    const outcome = await generateAndDownloadResume(profile, job, { download });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('download-unavailable');
    expect(outcome.message).toBe('blocked');
  });

  it('returns an insufficient result (no PDF) for an empty profile', async () => {
    const empty = profileSchema.parse({ schemaVersion: '2' });
    const download = vi.fn(() => ({ ok: true as const }));
    const outcome = await generateAndDownloadResume(empty, job, { download });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('insufficient');
    expect(outcome.message).toContain('no supported resume content');
    expect(download).not.toHaveBeenCalled();
  });

  it('returns invalid (no PDF) for schema-invalid profile data', async () => {
    const bad = { schemaVersion: '9' } as unknown as Profile;
    const download = vi.fn(() => ({ ok: true as const }));
    const outcome = await generateAndDownloadResume(bad, job, { download });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('invalid');
    expect(download).not.toHaveBeenCalled();
  });

  it('returns no-profile (no PDF) when the profile is absent', async () => {
    const download = vi.fn(() => ({ ok: true as const }));
    const outcome = await generateAndDownloadResume(null, job, { download });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('no-profile');
    expect(download).not.toHaveBeenCalled();
  });

  it('surfaces unsupported characters as a safe typed failure (no PDF)', async () => {
    const unicode = profileSchema.parse({
      schemaVersion: '2',
      displayName: '\u65E5\u672C\u8A9E',
      skills: [{ id: 'sk-1', name: 'TypeScript' }],
    });
    const download = vi.fn(() => ({ ok: true as const }));
    const outcome = await generateAndDownloadResume(unicode, job, { download });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('unsupported-characters');
    expect(outcome.message).toContain('U+65E5');
    expect(outcome.message).not.toContain('\u65E5');
    expect(download).not.toHaveBeenCalled();
  });

  it('makes no network calls', async () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    Object.assign(globalThis, { fetch: fetchSpy });
    try {
      await generateAndDownloadResume(profile, job, { download: () => ({ ok: true }) });
    } finally {
      Object.assign(globalThis, { fetch: original });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * Prompt 20 follow-up: the snapshot-based PDF export the current-resume flow
 * uses so one PDF action never tailors twice.
 */
describe('downloadTailoredResumePdf', () => {
  it('renders and downloads the provided snapshot (no tailoring, no re-read)', async () => {
    const download = vi.fn((_blob: Blob, _filename: string) => ({ ok: true as const }));
    const snapshot = baseResume();
    const outcome = await downloadTailoredResumePdf(snapshot, { download });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.pageCount).toBeGreaterThanOrEqual(1);
    expect(outcome.filename).toMatch(/\.pdf$/);
    expect(download).toHaveBeenCalledTimes(1);
    const [blob, filename] = download.mock.calls[0]!;
    expect(blob).toBeInstanceOf(Blob);
    expect(filename).toBe(outcome.filename);
  });

  it('smoke-checks the snapshot payload without mutating it', async () => {
    const snapshot = baseResume();
    const before = JSON.stringify(snapshot);
    const outcome = await downloadTailoredResumePdf(snapshot, { download: () => ({ ok: true }) });
    expect(outcome.ok).toBe(true);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('does not download when the client download step fails', async () => {
    const download = vi.fn(() => ({ ok: false as const, reason: 'unavailable' as const, message: 'blocked' }));
    const outcome = await downloadTailoredResumePdf(baseResume(), { download });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('download-unavailable');
    expect(outcome.message).toBe('blocked');
  });

  it('surfaces characters the PDF font cannot encode as a safe typed failure', async () => {
    const download = vi.fn(() => ({ ok: true as const }));
    const outcome = await downloadTailoredResumePdf(
      baseResume({ header: { displayName: '\u65E5\u672C\u8A9E' } }),
      { download },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('unsupported-characters');
    expect(outcome.message).toContain('U+65E5');
    expect(outcome.message).not.toContain('\u65E5');
    expect(download).not.toHaveBeenCalled();
  });
});
