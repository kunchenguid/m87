import { execFileSync } from "node:child_process";

// POSIX-only: hydrate PATH from a login shell so GUI-launched daemons can find
// provider CLIs. Disabled with FIRSTPASS_SKIP_SHELLENV, overridable for tests with
// FIRSTPASS_LOGIN_SHELL.
export function applyLoginShellEnv() {
  const skip = process.env.FIRSTPASS_SKIP_SHELLENV;
  if (typeof skip === "string" && skip.length > 0 && skip !== "0") {
    return;
  }
  if (process.platform === "win32") {
    return;
  }
  // Attached to a terminal => we were launched from an interactive shell and
  // already inherited its PATH. Harvesting here is both redundant and harmful:
  // the interactive (`-i`) login shell below grabs the terminal's foreground
  // process group (job control), and when it exits we're left in the
  // background, so the next write to the TTY (e.g. the Ink inbox) gets SIGTTOU
  // ("suspended (tty output)"). Only harvest for the no-TTY case that needs it:
  // a GUI/launchd-launched daemon with a stripped PATH.
  if (process.stdout.isTTY) {
    return;
  }
  const shell =
    process.env.FIRSTPASS_LOGIN_SHELL ||
    (process.env.SHELL && process.env.SHELL.length > 0
      ? process.env.SHELL
      : "/bin/sh");
  try {
    const output = execFileSync(shell, ["-l", "-i", "-c", "env"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of output.split("\n")) {
      const sep = line.indexOf("=");
      if (sep <= 0) {
        continue;
      }
      // Only adopt PATH so we never clobber firstpass's own runtime variables.
      if (line.slice(0, sep) === "PATH") {
        process.env.PATH = line.slice(sep + 1);
      }
    }
  } catch {
    // best-effort
  }
}

export function shouldSkipLoginShellEnv(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    return false;
  }
  return argv.some(
    (a) => a === "-h" || a === "--help" || a === "-V" || a === "--version",
  );
}
