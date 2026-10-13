/**
 * Public surface of the provider-agnostic AI interface (Prompt 06).
 *
 * Callers (tailoring / match features) use `runAiRequest()` with either
 * `createProxyProvider()` (production, backend-proxy pattern — no API keys in
 * the extension) or `createMockProvider()` (tests/dev). When `aiEnabled` is
 * false — the default — `runAiRequest` returns the local fallback and the
 * provider is never touched.
 */
export * from './schemas';
export * from './errors';
export * from './provider';
export * from './fallback';
export * from './run';
export * from './proxy';
export * from './mock';
