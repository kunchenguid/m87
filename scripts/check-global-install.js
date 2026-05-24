#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import pkg from "../package.json" with { type: "json" };

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
// On Windows, spawning a .cmd/.bat shim without a shell throws EINVAL since the
// CVE-2024-27980 fix in Node. execFile through the shell is required there.
const shellOption = { shell: isWindows };
const workDir = await mkdtemp(join(tmpdir(), "firstpass-package-check-"));

try {
  const packResult = await execFileAsync(
    npmCommand,
    ["pack", "--pack-destination", workDir],
    { cwd: projectRoot, ...shellOption },
  );
  const tarballName = packResult.stdout.trim().split("\n").at(-1);

  if (typeof tarballName !== "string" || tarballName.length === 0) {
    throw new Error("npm pack did not report a tarball name");
  }

  const prefix = join(workDir, "global");
  const home = join(workDir, "home");
  const tarballPath = join(workDir, tarballName);

  await execFileAsync(
    npmCommand,
    ["install", "--global", "--prefix", prefix, tarballPath],
    {
      env: { ...process.env, HOME: home },
      ...shellOption,
    },
  );

  const firstpassBin = isWindows
    ? join(prefix, "firstpass.cmd")
    : join(prefix, "bin", "firstpass");

  // Assert the installed bin actually RUNS (it is invoked through a symlink,
  // which a naive main-module guard silently no-ops) - not just that it exits 0.
  const { stdout } = await execFileAsync(firstpassBin, ["--version"], {
    env: { ...process.env, HOME: home },
    ...shellOption,
  });
  if (stdout.trim() !== pkg.version) {
    throw new Error(
      `installed firstpass --version printed ${JSON.stringify(stdout)}; expected "${pkg.version}"`,
    );
  }

  process.stdout.write("status: package_check_passed\n");
} finally {
  await rm(workDir, { recursive: true, force: true });
}
