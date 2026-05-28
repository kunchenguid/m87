import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const MOCK = fileURLToPath(
  new URL("../../plugins/mock/firstpass-src-mock.js", import.meta.url),
);

describe("mock source plugin: stdin handling", () => {
  // A stranded plugin whose parent died without closing its stdin must not
  // hang forever waiting for an `end` that never comes - that is how orphaned
  // mock processes used to accumulate and eat memory. It self-terminates via a
  // safety timeout (and resolves on stream close/error), still emitting a valid
  // response for input-independent commands like `manifest`.
  it("self-terminates instead of hanging when stdin never closes", async () => {
    const child = spawn(process.execPath, [MOCK, "manifest"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FIRSTPASS_MOCK_STDIN_TIMEOUT_MS: "200" },
    });

    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));

    // Deliberately leave stdin open: never call child.stdin.end().
    const code = await new Promise((resolve) => child.on("close", resolve));

    expect(code).toBe(0);
    expect(JSON.parse(stdout).plugin.id).toBe("mock");
  });
});
