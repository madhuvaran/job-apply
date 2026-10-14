/**
 * Regression tests for the current-resume export flow (Prompt 20 follow-up).
 *
 * The bug being locked down: one PDF action used to tailor TWICE (once inside
 * `generateAndDownloadResume`, then again to populate the component's cached
 * result). These tests exercise the flow through its injected steps, so
 * "tailor once, reuse everywhere" is asserted by behaviour rather than by
 * reading source text.
 *
 * Synthetic fixtures only; no network.
 */
import { describe, expect, it, vi } from 'vitest';
import { jobPostingSchema } from '../job-posting';
import { profileSchema } from '../profile';
import { exportCurrentResume, type CurrentExportDeps } from './current-export';
import { downloadResumeDocx } from './docx';
import { downloadTailoredResumePdf } from './pdf';
import { baseResume } from './pdf/test-support';
import type { SaveResumeVersionInput } from './history-service';
import { prepareFailureMessage, prepareTailoredResume } from './prepare';
import type { TailoredResume } from './schemas';
import type { TailorResult } from './tailor';

const job = jobPostingSchema.parse({
  id: 'job-1',
  title: 'Senior Backend Engineer',
  company: 'Acme Fake Co',
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

const snapshot = baseResume();

/** A tailoring engine that always succeeds with `snapshot`, counting calls. */
function okTailor() {
  return vi.fn((): TailorResult => ({ kind: 'ok', resume: snapshot }));
}

function pdfOk(pageCount = 1) {
  return vi.fn(async (_resume: TailoredResume) => ({
    ok: true as const,
    pageCount,
    filename: 'resume-x-tailored.pdf',
  }));
}

function docxOk() {
  return vi.fn(async (_resume: TailoredResume) => ({
    ok: true as const,
    filename: 'resume-x-tailored.docx',
  }));
}

function saveOk() {
  return vi.fn(async (_input: SaveResumeVersionInput) => ({ ok: true as const, data: {} as never }));
}

/** Deps with all four steps injected (nothing touches the real browser/storage). */
function deps(overrides: CurrentExportDeps = {}): CurrentExportDeps {
  return {
    tailor: okTailor(),
    downloadPdf: pdfOk(),
    downloadDocx: docxOk(),
    saveVersion: saveOk(),
    ...overrides,
  };
}

describe('exportCurrentResume — one snapshot for the whole flow', () => {
  it('tailors exactly ONCE per PDF generation action', async () => {
    const tailor = okTailor();
    const d = deps({ tailor });
    const outcome = await exportCurrentResume('pdf', { profile, job }, d);
    expect(outcome.ok).toBe(true);
    expect(tailor).toHaveBeenCalledTimes(1);
    expect(tailor).toHaveBeenCalledWith(profile, job);
  });

  it('does not re-tailor the Word export or the save when a snapshot already exists', async () => {
    const tailor = okTailor();
    const downloadPdf = pdfOk();
    const downloadDocx = docxOk();
    const saveVersion = saveOk();
    const d = deps({ tailor, downloadPdf, downloadDocx, saveVersion });

    const pdf = await exportCurrentResume('pdf', { profile, job }, d);
    expect(pdf.ok).toBe(true);
    if (!pdf.ok) return;

    const docx = await exportCurrentResume('docx', { profile, job, current: pdf.resume }, d);
    const save = await exportCurrentResume('save', { profile, job, current: pdf.resume }, d);

    expect(docx.ok && save.ok).toBe(true);
    // Tailored once for the whole PDF → DOCX → Save sequence.
    expect(tailor).toHaveBeenCalledTimes(1);
  });

  it('passes the exact same snapshot object to the PDF and DOCX renderers', async () => {
    const downloadPdf = pdfOk();
    const downloadDocx = docxOk();
    const d = deps({ downloadPdf, downloadDocx });

    const pdf = await exportCurrentResume('pdf', { profile, job }, d);
    expect(pdf.ok).toBe(true);
    if (!pdf.ok) return;
    const docx = await exportCurrentResume('docx', { profile, job, current: pdf.resume }, d);
    expect(docx.ok).toBe(true);

    expect(downloadPdf).toHaveBeenCalledTimes(1);
    expect(downloadDocx).toHaveBeenCalledTimes(1);
    const pdfResume = downloadPdf.mock.calls[0]![0];
    const docxResume = downloadDocx.mock.calls[0]![0];
    expect(pdfResume).toBe(snapshot);
    expect(docxResume).toBe(pdfResume); // identity, not a deep copy
    // Only the snapshot is handed over — no profile, no posting.
    expect(downloadPdf.mock.calls[0]!).toHaveLength(1);
    expect(downloadDocx.mock.calls[0]!).toHaveLength(1);
  });

  it('saves the exact snapshot that was generated, with the job label copied', async () => {
    const saveVersion = saveOk();
    const d = deps({ saveVersion });

    const pdf = await exportCurrentResume('pdf', { profile, job }, d);
    expect(pdf.ok).toBe(true);
    if (!pdf.ok) return;
    const saved = await exportCurrentResume('save', { profile, job, current: pdf.resume }, d);
    expect(saved.ok).toBe(true);

    expect(saveVersion).toHaveBeenCalledTimes(1);
    const input = saveVersion.mock.calls[0]![0];
    expect(input.resume).toBe(pdf.resume);
    expect(input.job).toEqual({ id: 'job-1', title: 'Senior Backend Engineer', company: 'Acme Fake Co' });
  });

  it('uses a cached snapshot even when the profile/job inputs are gone (no re-read)', async () => {
    const tailor = okTailor();
    const downloadPdf = pdfOk();
    const d = deps({ tailor, downloadPdf });

    // A saved/generated snapshot must remain exportable with no profile and a
    // different posting in scope — snapshot-only, exactly like history.
    const otherJob = jobPostingSchema.parse({
      id: 'job-2',
      title: 'Platform Engineer',
      rawDescription: 'Something else.',
      capturedAt: '2026-10-12T00:00:00.000Z',
    });
    const outcome = await exportCurrentResume('pdf', { profile: null, job: otherJob, current: snapshot }, d);
    expect(outcome.ok).toBe(true);
    expect(tailor).not.toHaveBeenCalled();
    expect(downloadPdf.mock.calls[0]![0]).toBe(snapshot);
  });

  it('treats `current: null` and an absent `current` the same (tailors then)', async () => {
    const tailor = okTailor();
    const d = deps({ tailor });
    const a = await exportCurrentResume('docx', { profile, job, current: null }, d);
    const b = await exportCurrentResume('docx', { profile, job }, d);
    expect(a.ok && b.ok).toBe(true);
    expect(tailor).toHaveBeenCalledTimes(2);
  });

  it('reports the notice for each action (page count singular + plural)', async () => {
    const one = await exportCurrentResume('pdf', { profile, job }, deps({ downloadPdf: pdfOk(1) }));
    const many = await exportCurrentResume('pdf', { profile, job }, deps({ downloadPdf: pdfOk(2) }));
    const docx = await exportCurrentResume('docx', { profile, job }, deps());
    const save = await exportCurrentResume('save', { profile, job }, deps());

    expect(one.ok && one.notice).toBe('Resume PDF generated (1 page). Check your downloads.');
    expect(many.ok && many.notice).toBe('Resume PDF generated (2 pages). Check your downloads.');
    expect(docx.ok && docx.notice).toBe('Word document generated. Check your downloads.');
    expect(save.ok && save.notice).toBe('Resume version saved to local history. Only this browser stores it.');
  });

  it('always returns the snapshot it used so the caller can cache it', async () => {
    const tailored = await exportCurrentResume('pdf', { profile, job }, deps());
    expect(tailored.ok && tailored.resume).toBe(snapshot);

    const cached = await exportCurrentResume('save', { profile, job, current: snapshot }, deps());
    expect(cached.ok && cached.resume).toBe(snapshot);
  });
});

describe('exportCurrentResume — typed, safe failures', () => {
  it('reports a missing profile without tailoring or rendering', async () => {
    const tailor = okTailor();
    const downloadPdf = pdfOk();
    const outcome = await exportCurrentResume('pdf', { profile: null, job }, deps({ tailor, downloadPdf }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toBe(prepareFailureMessage('no-profile', 'generated'));
    expect(outcome.message).toBe('No saved profile is available yet — add your profile, then try again.');
    expect(tailor).not.toHaveBeenCalled();
    expect(downloadPdf).not.toHaveBeenCalled();
  });

  it('keeps the action-specific wording for insufficient and invalid inputs', async () => {
    const insufficient = deps({ tailor: vi.fn((): TailorResult => ({ kind: 'insufficient', reasons: [] })) });
    const invalid = deps({ tailor: vi.fn((): TailorResult => ({ kind: 'invalid', issues: [] })) });

    const gen = await exportCurrentResume('pdf', { profile, job }, insufficient);
    const saved = await exportCurrentResume('save', { profile, job }, insufficient);
    const badGen = await exportCurrentResume('docx', { profile, job }, invalid);
    const badSaved = await exportCurrentResume('save', { profile, job }, invalid);

    expect(gen.ok ? '' : gen.message).toContain('Nothing was generated.');
    expect(saved.ok ? '' : saved.message).toContain('Nothing was saved.');
    expect(badGen.ok ? '' : badGen.message).toBe(
      'The saved profile or job posting could not be validated, so no resume was generated.',
    );
    expect(badSaved.ok ? '' : badSaved.message).toBe(
      'The saved profile or job posting could not be validated, so no version was saved.',
    );
  });

  it('surfaces a failed render/download verbatim and never claims success', async () => {
    const downloadPdf = vi.fn(async (_resume: TailoredResume) => ({
      ok: false as const,
      reason: 'download-unavailable' as const,
      message: 'The browser blocked starting the download.',
    }));
    const outcome = await exportCurrentResume('pdf', { profile, job }, deps({ downloadPdf }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toBe('The browser blocked starting the download.');
  });

  it('surfaces a failed history save verbatim', async () => {
    const saveVersion = vi.fn(async (_input: SaveResumeVersionInput) => ({
      ok: false as const,
      reason: 'limit-reached' as const,
      message: 'The version limit was reached, so nothing was saved.',
    }));
    const outcome = await exportCurrentResume('save', { profile, job }, deps({ saveVersion }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toBe('The version limit was reached, so nothing was saved.');
  });

  it('makes no network calls', async () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    Object.assign(globalThis, { fetch: fetchSpy });
    try {
      await exportCurrentResume('pdf', { profile, job }, deps());
      await exportCurrentResume('docx', { profile, job }, deps());
      await exportCurrentResume('save', { profile, job }, deps());
    } finally {
      Object.assign(globalThis, { fetch: original });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('exportCurrentResume — real engines, one snapshot (integration)', () => {
  it('tailors once and renders the SAME payload as the PDF and the Word file', async () => {
    const seen: TailoredResume[] = [];
    const pdfBlobs: Blob[] = [];
    const docxBlobs: Blob[] = [];

    // Real renderers; only the final browser download is stubbed out.
    const downloadPdf = (resume: TailoredResume) => {
      seen.push(resume);
      return downloadTailoredResumePdf(resume, {
        download: (blob) => {
          pdfBlobs.push(blob);
          return { ok: true };
        },
      });
    };
    const downloadDocx = (resume: TailoredResume) => {
      seen.push(resume);
      return downloadResumeDocx(resume, {
        download: (blob) => {
          docxBlobs.push(blob);
          return { ok: true };
        },
      });
    };
    const deps = { downloadPdf, downloadDocx };

    const pdf = await exportCurrentResume('pdf', { profile, job }, deps);
    expect(pdf.ok).toBe(true);
    if (!pdf.ok) return;
    const docx = await exportCurrentResume('docx', { profile, job, current: pdf.resume }, deps);
    expect(docx.ok).toBe(true);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(pdf.resume);
    expect(seen[1]).toBe(pdf.resume); // identity: rendered from the cached snapshot
    expect(pdfBlobs).toHaveLength(1);
    expect(docxBlobs).toHaveLength(1);
    expect(pdfBlobs[0]!.type).toBe('application/pdf');
    expect(pdfBlobs[0]!.size).toBeGreaterThan(0);
    expect(docxBlobs[0]!.type).toMatch(/wordprocessingml/);
    expect(docxBlobs[0]!.size).toBeGreaterThan(0);
  });
});

describe('prepareTailoredResume', () => {
  it('maps each tailoring result to a typed reason without tailoring again', () => {
    const tailor = okTailor();
    const prepared = prepareTailoredResume(profile, job, tailor);
    expect(prepared).toEqual({ ok: true, resume: snapshot });
    expect(tailor).toHaveBeenCalledTimes(1);

    expect(prepareTailoredResume(null, job, tailor)).toEqual({ ok: false, reason: 'no-profile' });
    expect(tailor).toHaveBeenCalledTimes(1); // a missing profile never tailors
  });

  it('produces fixed, content-free failure messages for both wordings', () => {
    for (const word of ['generated', 'saved'] as const) {
      const message = prepareFailureMessage('insufficient', word);
      expect(message).not.toContain(profile.displayName ?? '');
      expect(message).not.toContain(job.title);
    }
  });
});
