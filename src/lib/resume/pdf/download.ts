/**
 * Minimal, dependency-free download helper for the rendered resume PDF
 * (Prompt 12).
 *
 * Isolated from the renderer so its lifecycle (temporary object URL creation,
 * anchor click, removal, and revocation) can be unit-tested without a real
 * browser: the browser globals are injectable. It stores nothing — the PDF is
 * handed to the browser's download flow and the object URL is revoked
 * immediately; nothing is written to extension storage.
 *
 * No network, no telemetry, no permissions.
 */

export interface DownloadEnvironment {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  document: Document;
}

export type DownloadResult =
  | { ok: true }
  | { ok: false; reason: 'unavailable'; message: string };

function defaultEnvironment(): DownloadEnvironment | null {
  const g = globalThis as {
    URL?: { createObjectURL?: (blob: Blob) => string; revokeObjectURL?: (url: string) => void };
    document?: Document;
  };
  const create = g.URL?.createObjectURL;
  const revoke = g.URL?.revokeObjectURL;
  const doc = g.document;
  if (typeof create !== 'function' || typeof revoke !== 'function' || doc === undefined) return null;
  return {
    createObjectURL: create.bind(g.URL),
    revokeObjectURL: revoke.bind(g.URL),
    document: doc,
  };
}

/**
 * Trigger a browser download of `blob`. Returns a typed result; never throws.
 * The temporary object URL is always revoked (in a `finally`), even if the
 * anchor click throws.
 */
export function downloadBlob(
  blob: Blob,
  filename: string,
  environment?: DownloadEnvironment,
): DownloadResult {
  const env = environment ?? defaultEnvironment();
  if (env === null) {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'Downloading is unavailable in this environment.',
    };
  }

  let url: string | null = null;
  let anchor: HTMLAnchorElement | null = null;
  try {
    url = env.createObjectURL(blob);
    anchor = env.document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    env.document.body?.appendChild(anchor);
    anchor.click();
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'The browser blocked starting the download.',
    };
  } finally {
    anchor?.remove();
    if (url !== null) env.revokeObjectURL(url);
  }
}
