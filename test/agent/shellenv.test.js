import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyLoginShellEnv } from "../../src/agent/shellenv.js";

// A fake "login shell" that ignores its args and prints a sentinel PATH, so we
// can observe whether applyLoginShellEnv actually harvested.
const HARVESTED = "/fake/harvested/bin";

describe("agent/shellenv applyLoginShellEnv", () => {
  let dir;
  let fakeShell;
  let savedPath;
  let savedSkip;
  let savedTty;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "firstpass-shellenv-"));
    fakeShell = join(dir, "fake-shell.sh");
    writeFileSync(fakeShell, `#!/bin/sh\necho "PATH=${HARVESTED}"\n`);
    chmodSync(fakeShell, 0o755);

    savedPath = process.env.PATH;
    savedSkip = process.env.FIRSTPASS_SKIP_SHELLENV;
    savedTty = process.stdout.isTTY;

    process.env.PATH = "/original/bin";
    process.env.FIRSTPASS_LOGIN_SHELL = fakeShell;
    delete process.env.FIRSTPASS_SKIP_SHELLENV;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    if (savedSkip === undefined) delete process.env.FIRSTPASS_SKIP_SHELLENV;
    else process.env.FIRSTPASS_SKIP_SHELLENV = savedSkip;
    delete process.env.FIRSTPASS_LOGIN_SHELL;
    process.stdout.isTTY = savedTty;
    rmSync(dir, { recursive: true, force: true });
  });

  // Login-shell PATH harvesting is POSIX-only by design (applyLoginShellEnv
  // no-ops on Windows, which has no login-shell `env` to harvest), and the fake
  // shell is a /bin/sh script that Windows can't run.
  it.skipIf(process.platform === "win32")(
    "harvests PATH from the login shell when not attached to a TTY",
    () => {
      process.stdout.isTTY = false;
      applyLoginShellEnv();
      expect(process.env.PATH).toBe(HARVESTED);
    },
  );

  it("does NOT harvest when stdout is a TTY (PATH is already correct, and harvesting steals the terminal)", () => {
    process.stdout.isTTY = true;
    applyLoginShellEnv();
    expect(process.env.PATH).toBe("/original/bin");
  });

  it("respects FIRSTPASS_SKIP_SHELLENV even without a TTY", () => {
    process.stdout.isTTY = false;
    process.env.FIRSTPASS_SKIP_SHELLENV = "1";
    applyLoginShellEnv();
    expect(process.env.PATH).toBe("/original/bin");
  });
});
