import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob, type DownloadEnvironment } from './download';

interface FakeAnchor {
  href: string;
  download: string;
  rel: string;
  style: { display: string };
  click: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function makeEnvironment(): {
  env: DownloadEnvironment;
  createObjectURL: ReturnType<typeof vi.fn>;
  revokeObjectURL: ReturnType<typeof vi.fn>;
  appendChild: ReturnType<typeof vi.fn>;
  anchor: FakeAnchor;
  appended: unknown[];
} {
  const anchor: FakeAnchor = {
    href: '',
    download: '',
    rel: '',
    style: { display: '' },
    click: vi.fn(),
    remove: vi.fn(),
  };
  const appended: unknown[] = [];
  const createObjectURL = vi.fn(() => 'blob:resume-1');
  const revokeObjectURL = vi.fn();
  const appendChild = vi.fn((el: unknown) => appended.push(el));
  const document = {
    createElement: vi.fn(() => anchor),
    body: { appendChild },
  } as unknown as Document;
  return {
    env: { createObjectURL, revokeObjectURL, document },
    createObjectURL,
    revokeObjectURL,
    appendChild,
    anchor,
    appended,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('downloadBlob', () => {
  it('removes the anchor promptly and DEFERS object URL revocation until after the delay', () => {
    const { env, createObjectURL, revokeObjectURL, anchor, appended } = makeEnvironment();
    const blob = new Blob(['%PDF'], { type: 'application/pdf' });
    const result = downloadBlob(blob, 'resume.pdf', env);

    expect(result.ok).toBe(true);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(anchor.href).toBe('blob:resume-1');
    expect(anchor.download).toBe('resume.pdf');
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(appended).toContain(anchor);
    // Anchor cleanup is immediate …
    expect(anchor.remove).toHaveBeenCalledTimes(1);
    // … but the URL is NOT revoked synchronously after the click.
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.runAllTimers();

    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:resume-1');
  });

  it('revokes the object URL immediately (once) when the click throws', () => {
    const { env, revokeObjectURL, anchor } = makeEnvironment();
    anchor.click.mockImplementation(() => {
      throw new Error('blocked');
    });
    const result = downloadBlob(new Blob(['%PDF']), 'resume.pdf', env);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unavailable');
    expect(anchor.remove).toHaveBeenCalledTimes(1);
    // Failed download never started — release at once and schedule nothing.
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('removes the anchor and revokes the URL when DOM setup fails', () => {
    const { env, appendChild, revokeObjectURL, anchor } = makeEnvironment();
    appendChild.mockImplementation(() => {
      throw new Error('detached');
    });
    const result = downloadBlob(new Blob(['%PDF']), 'resume.pdf', env);

    expect(result.ok).toBe(false);
    expect(anchor.click).not.toHaveBeenCalled();
    expect(anchor.remove).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('creates no anchor and revokes nothing when object URL creation fails', () => {
    const { env, createObjectURL, revokeObjectURL, anchor } = makeEnvironment();
    createObjectURL.mockImplementation(() => {
      throw new Error('no url');
    });
    const result = downloadBlob(new Blob(['%PDF']), 'resume.pdf', env);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unavailable');
    expect(anchor.click).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('returns a typed failure when no download environment is available', () => {
    const result = downloadBlob(new Blob(['%PDF']), 'resume.pdf');
    // In the Node test environment there is no browser download API.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unavailable');
  });

  it('never writes to extension storage', () => {
    const { env } = makeEnvironment();
    const storage = { local: { set: vi.fn(), get: vi.fn() } };
    Object.assign(globalThis, { browser: { storage } });
    try {
      downloadBlob(new Blob(['%PDF']), 'resume.pdf', env);
      vi.runAllTimers();
    } finally {
      Object.assign(globalThis, { browser: undefined });
    }
    expect(storage.local.set).not.toHaveBeenCalled();
    expect(storage.local.get).not.toHaveBeenCalled();
  });
});
