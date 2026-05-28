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
 *   Retry-After); used verbatim when positive, otherwise we fall back to backoff.
 * @returns {number} delay in milliseconds
 */
export function syncRetryDelayMs(consecutiveFailures, retryAfterSeconds) {
  if (typeof retryAfterSeconds === "number" && retryAfterSeconds > 0) {
    return Math.round(retryAfterSeconds * 1000);
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
