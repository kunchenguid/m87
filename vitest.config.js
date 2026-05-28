import { defineConfig } from "vitest/config";

// The heavy end-to-end tests spawn the real CLI as many separate `node`
// processes (init, plugin add, plugin configure, daemon, list, approve, ...) plus a
// mocked ACP target. On a busy machine those legitimately exceed Vitest's
// default 5s per-test budget, so raise it to keep the suite reliably green.
export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 60000,
    // Backstop sweep for any CLI subprocess a hard-killed worker strands (see
    // test/support/global-setup.js). In-worker `process.on("exit")` cleanup in
    // e2e-harness handles the normal path; this catches abnormal worker death.
    globalSetup: ["./test/support/global-setup.js"],
    // Keep agent auto-detection hermetic: tests inherit this empty probe path
    // (via `...process.env`) so a developer's real `claude`/`codex` CLI is not
    // discovered. Tests that exercise detection set FIRSTPASS_AGENT_PROBE_PATH
    // explicitly to a temp directory of fake binaries.
    env: { FIRSTPASS_AGENT_PROBE_PATH: "", FIRSTPASS_SKIP_SHELLENV: "1" },
  },
});
