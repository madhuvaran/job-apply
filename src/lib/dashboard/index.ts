/**
 * Public surface of the local dashboard overview (Prompt 30).
 *
 * Pure, deterministic, local: `buildDashboardSnapshot()` reuses the existing
 * schemas, match estimates and prioritization result and adds NO scoring of its
 * own. It reads no storage, uses no clock and makes no network/AI call — the
 * Options panel performs the (single) storage read and hands the records in.
 */
export * from './schemas';
export {
  buildDashboardSnapshot,
  type DashboardInput,
  type DashboardOutcome,
} from './snapshot';
