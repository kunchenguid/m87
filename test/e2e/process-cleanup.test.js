import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runFirstpass, waitFor } from "../support/e2e-harness.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SLEEPER = join(
  repoRoot,
  "test",
  "support",
  "fixtures",
  "sleeper-with-child.js",
);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The e2e suite spawns the real CLI as many `node` subprocesses. A wedged
// invocation - or a worker that dies before its `afterEach` runs - used to
// strand those processes (and their plugin grandchildren), where they sat
// eating memory indefinitely. The runner must bound and reap them.
describe("e2e process cleanup", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "firstpass-cleanup-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("kills a hung invocation (and its grandchildren) when it exceeds the timeout", async () => {
    const gcPidFile = join(dir, "grandchild.pid");

    const err = await runFirstpass(SLEEPER, [gcPidFile], process.env, {
      timeoutMs: 500,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.timedOut).toBe(true);

    const gcPid = Number(readFileSync(gcPidFile, "utf8"));
    expect(Number.isInteger(gcPid)).toBe(true);

    // The grandchild must die with the timed-out parent, not linger.
    const reaped = await waitFor(() => !isAlive(gcPid), {
      timeoutMs: 5000,
      intervalMs: 100,
    });
    expect(reaped).toBe(true);
  });
});
