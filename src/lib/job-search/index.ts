/**
 * Public surface of job discovery (Prompt 27).
 *
 * This is a FOUNDATION only: there is no search UI, no saved search, no alert
 * and no automatic polling in this build. `runJobSearch()` refuses to run until
 * a secure search endpoint is configured (`describeJobSearchAvailability()`),
 * so nothing here makes a network request on its own and the extension never
 * appears to have working live search when it does not.
 *
 * Callers will use `createAdzunaProvider()` (production transport — the
 * project's own server-side proxy holds the Adzuna app id/key) with
 * `createAdzunaAdapter()` and `runJobSearch()`. Tests use a mock provider.
 *
 * Credentials are structurally impossible to configure here: the config schema
 * and the provider options schema are both strict and have no credential field.
 */
export * from './schemas';
export * from './errors';
export * from './provider';
export * from './service';
export * from './candidates';
export * from './ui';
export * from './adzuna';
