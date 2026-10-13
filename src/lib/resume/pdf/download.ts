/**
 * Minimal, dependency-free download helper for the rendered resume PDF
 * (Prompt 12).
 *
 * Isolated from the renderer so its lifecycle (temporary object URL creation,
 * anchor click, removal, and revocation) can be unit-tested without a real
 * browser: the browser globals are injectable. It stores nothing — the PDF is
 * handed to the browser's download flow and nothing is written to extension
 * storage.
 *
 * URL lifecycle (reliability fix): a Blob object URL must not be revoked
 * synchronously after `anchor.click()`, because the browser resolves the URL
 * asynchronously and may not have consumed it yet — an immediate revoke can
 * cancel the download. On success the anchor is removed promptly but the URL
 * is revoked after `OBJECT_URL_REVOKE_DELAY_MS`, which is far longer than a
 * local Blob resolution needs while keeping the (small resume) Blob in memory
 * only briefly. On any setup/click failure the download never started, so the
 * URL is revoked immediately and no timer is left pending.
 *
 * No network, no telemetry, no permissions.
 */

/**
 * How long the temporary object URL is kept alive after a successful click
 * before it is revoked. Chosen to comfortably exceed the browser's asynchronous
 * Blob-URL resolution on local (in-memory) data while releasing the Blob
 * promptly; `file-saver` uses a more conservative 40 s for the same reason.
 */
const OBJECT_URL_REVOKE_DELAY_MS = 10_000;

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
 *
 * - Success: the anchor is removed immediately and the temporary object URL is
 *   revoked after `OBJECT_URL_REVOKE_DELAY_MS` (never synchronously).
 * - Failure (URL creation, DOM setup or click): the anchor is removed and any
 *   created object URL is revoked exactly once, immediately — no leak, no
 *   pending timer.
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
  } catch {
    // The download never started: release everything immediately (no leak).
    anchor?.remove();
    if (url !== null) env.revokeObjectURL(url);
    return {
      ok: false,
      reason: 'unavailable',
      message: 'The browser blocked starting the download.',
    };
  }

  // Success: remove the anchor promptly, but keep the object URL alive long
  // enough for the browser to initiate the download before revoking it.
  anchor?.remove();
  const createdUrl = url;
  if (createdUrl !== null) {
    setTimeout(() => {
      env.revokeObjectURL(createdUrl);
    }, OBJECT_URL_REVOKE_DELAY_MS);
  }
  return { ok: true };
}
