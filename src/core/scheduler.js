// Sync scheduling policy. The daemon's scheduler asks this module which plugins
// are due for a sync on each poll tick.
//
// The key invariant (and the fix for the latched-forever bug): a plugin that
// failed a sync - permission_denied, rate_limited, or error - is NOT dropped
// from the rotation. It is parked behind a `next_retry_at` timestamp and
// re-enters the rotation once that elapses, so a transient failure (a flaky
// `gh auth status`, a network blip, a rate-limit window) self-heals instead of
// requiring manual re-activation.

// Capped exponential backoff for consecutive sync failures. Bounded below the
// 5-minute default poll interval at the low end and capped at 30 minutes so a
// genuinely broken plugin retries quietly rather than hammering the source.
export const SYNC_BACKOFF_BASE_MS = 60_000; // 1 minute
export const SYNC_BACKOFF_CAP_MS = 30 * 60_000; // 30 minutes

/**
 * How long to wait before the next sync attempt.
 *
 * @param {number} consecutiveFailures - the failure streak AFTER this failure (>= 1)
 * @param {number} [retryAfterSeconds] - source-supplied hint (e.g. a rate-limit
 *   Retry-After); honored when positive up to the sync backoff cap.
 * @returns {number} delay in milliseconds
 */
export function syncRetryDelayMs(consecutiveFailures, retryAfterSeconds) {
  if (typeof retryAfterSeconds === "number" && retryAfterSeconds > 0) {
    return Math.min(Math.round(retryAfterSeconds * 1000), SYNC_BACKOFF_CAP_MS);
  }
  const n = Math.max(1, consecutiveFailures);
  return Math.min(SYNC_BACKOFF_BASE_MS * 2 ** (n - 1), SYNC_BACKOFF_CAP_MS);
}

/**
 * The plugins due for a sync at `now`: active (or never-synced) plugins, plus
 * any failed plugin whose backoff window has elapsed.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now - ISO timestamp
 * @returns {{ id: string }[]}
 */
export function selectPluginsDueForSync(db, now) {
  return db
    .prepare(
      `select id from plugins
        where status = 'active'
           or status is null
           or (status in ('rate_limited', 'permission_denied', 'error')
               and (next_retry_at is null or next_retry_at <= ?))`,
    )
    .all(now);
}

// PR-recheck backoff for fix jobs parked in waiting_for_pr. A submit path that
// opens the PR asynchronously (no-mistakes) usually lands within a minute or
// two, so the first probe comes quickly and later probes back off toward the
// daemon's poll cadence. There is deliberately NO give-up ceiling: a job keeps
// probing at the cap until the PR appears (or the user closes the job), and the
// host surfaces a warning once the wait turns suspiciously long.
export const PR_CHECK_BASE_MS = 30_000; // 30 seconds
export const PR_CHECK_WARN_AFTER_MS = 24 * 60 * 60_000; // 24 hours

/**
 * How long to wait before the next PR probe.
 *
 * @param {number} checkAttempts - probes already made (>= 0)
 * @param {number} capMs - ceiling, normally the daemon's poll interval
 * @returns {number} delay in milliseconds
 */
export function prCheckDelayMs(checkAttempts, capMs) {
  const cap = Math.max(PR_CHECK_BASE_MS, capMs);
  const n = Math.max(0, checkAttempts);
  return Math.min(PR_CHECK_BASE_MS * 2 ** n, cap);
}

/**
 * The fix jobs due for a PR probe at `now`: running jobs parked in
 * waiting_for_pr whose next_check_at has elapsed (or was never set - jobs
 * parked before this policy existed re-enter the rotation immediately).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} now - ISO timestamp
 * @returns {{ id: string, check_attempts: number, started_at: string|null }[]}
 */
export function selectJobsDueForPrCheck(db, now) {
  return db
    .prepare(
      `select id, check_attempts, started_at from jobs
        where status = 'running'
          and phase = 'waiting_for_pr'
          and (next_check_at is null or next_check_at <= ?)`,
    )
    .all(now);
}
