import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Upgrade detection for the long-lived daemon. A daemon keeps executing the
// code it loaded at startup, so when a package manager replaces the installed
// files someone has to notice and restart. The installer cannot do that
// reliably - lifecycle scripts are skipped or sandboxed by many setups and
// never run for every package manager - so the daemon polls the installed
// package.json and compares the on-disk version to the one it has in memory.

// Walk up from the running entry file to the package.json that shipped it.
// A source checkout (src/cli/index.js) and the esbuild bundle (dist/cli.js)
// sit at different depths, and the probe must never latch onto an unrelated
// package.json higher up the tree, so the package name has to match.
export function findInstalledPackageJson(entryPath, name) {
  let dir = dirname(entryPath);
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate) && readPackageVersion(candidate, name) !== null) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Version recorded in `packageJsonPath` for the package `name`, or null. A
// global install replaces the package dir file by file, so the probe must
// tolerate a missing, truncated, or half-written file without throwing.
export function readPackageVersion(packageJsonPath, name) {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (!parsed || parsed.name !== name) return null;
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export function upgradeCheckIntervalMs() {
  const raw = Number(process.env.M87_UPGRADE_CHECK_INTERVAL);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/**
 * Poll-based upgrade detector driven by the daemon's tick loop. `check(nowMs)`
 * probes at most once per `intervalMs` and returns the new version only after
 * the same differing version was read on two consecutive probes - a single
 * read can catch an install half-done, but two reads an interval apart with
 * the same answer mean the new files have settled.
 *
 * @param {{ entryPath: string, name: string, currentVersion: string, intervalMs?: number }} options
 */
export function createUpgradeWatcher({
  entryPath,
  name,
  currentVersion,
  intervalMs = upgradeCheckIntervalMs(),
}) {
  const probePath =
    process.env.M87_UPGRADE_PROBE_PATH ||
    findInstalledPackageJson(entryPath, name);
  let lastProbeAt = 0;
  let pendingVersion = null;
  return {
    probePath,
    check(nowMs) {
      if (probePath === null || nowMs - lastProbeAt < intervalMs) return null;
      lastProbeAt = nowMs;
      const seen = readPackageVersion(probePath, name);
      if (seen === null || seen === currentVersion) {
        pendingVersion = null;
        return null;
      }
      if (pendingVersion === seen) return seen;
      pendingVersion = seen;
      return null;
    },
  };
}
