import { describe, expect, it, vi } from 'vitest';
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
  const document = {
    createElement: vi.fn(() => anchor),
    body: { appendChild: vi.fn((el: unknown) => appended.push(el)) },
  } as unknown as Document;
  return {
    env: { createObjectURL, revokeObjectURL, document },
    createObjectURL,
    revokeObjectURL,
    anchor,
    appended,
  };
}

describe('downloadBlob', () => {
  it('creates a temporary object URL, clicks the anchor, then revokes it', () => {
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
    expect(anchor.remove).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:resume-1');
  });

  it('still revokes the object URL when the click throws (typed failure)', () => {
    const { env, revokeObjectURL, anchor } = makeEnvironment();
    anchor.click.mockImplementation(() => {
      throw new Error('blocked');
    });
    const result = downloadBlob(new Blob(['%PDF']), 'resume.pdf', env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unavailable');
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
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
    } finally {
      Object.assign(globalThis, { browser: undefined });
    }
    expect(storage.local.set).not.toHaveBeenCalled();
    expect(storage.local.get).not.toHaveBeenCalled();
  });
});
