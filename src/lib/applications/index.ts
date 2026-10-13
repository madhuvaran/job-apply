/**
 * Public surface of the local application log (Prompt 13).
 *
 * Split into pure schemas/model (`schemas.ts`), the storage-backed service
 * (`service.ts`) and the pure presenter (`presenter.ts`) so persistence and
 * presentation stay separate — the UI imports this module and never touches
 * `chrome.storage` directly. Local-only, offline, no AI, no sensitive profile.
 */
export * from './schemas';
export {
  listApplications,
  createApplicationForJob,
  startTrackingApplication,
  updateApplication,
  deleteApplication,
  type ApplicationErrorReason,
  type ApplicationOutcome,
  type StartTrackingResult,
} from './service';
export * from './presenter';
