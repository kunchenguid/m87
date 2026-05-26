import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { controlAddress } from "../../src/cli/state.js";
import { createControlServer, sendControl } from "../../src/core/control.js";

// The control channel is the daemon's cross-platform IPC: a Unix domain socket
// on POSIX, a named pipe on Windows. These tests exercise the transport on
// whichever platform they run on, so the same contract is verified everywhere.
describe("core/control IPC channel", () => {
  let dir;
  let address;
  let server;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "firstpass-ctl-"));
    address = controlAddress(dir);
  });

  afterEach(async () => {
    if (server) await new Promise((r) => server.close(r));
    server = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a command and its reply", async () => {
    const seen = [];
    server = await createControlServer(address, (msg) => {
      seen.push(msg);
      return { ok: true, echo: msg.cmd };
    });

    const reply = await sendControl(address, { cmd: "ping" });

    expect(reply).toEqual({ ok: true, echo: "ping" });
    expect(seen).toEqual([{ cmd: "ping" }]);
  });

  it("invokes the handler once per command, in order", async () => {
    const calls = [];
    server = await createControlServer(address, async (msg) => {
      calls.push(msg.cmd);
      return { ok: true };
    });

    expect(await sendControl(address, { cmd: "sync" })).toEqual({ ok: true });
    expect(await sendControl(address, { cmd: "stop" })).toEqual({ ok: true });
    expect(calls).toEqual(["sync", "stop"]);
  });

  it("reports a handler error back to the caller without crashing the server", async () => {
    server = await createControlServer(address, (msg) => {
      if (msg.cmd === "boom") throw new Error("kaboom");
      return { ok: true };
    });

    const failed = await sendControl(address, { cmd: "boom" });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("kaboom");

    // The server is still up and serving after a handler throw.
    expect(await sendControl(address, { cmd: "ping" })).toEqual({ ok: true });
  });

  it("rejects when no daemon is listening", async () => {
    await expect(
      sendControl(address, { cmd: "sync" }, { timeoutMs: 500 }),
    ).rejects.toThrow();
  });

  it("rebinds after a prior server left a stale socket file (POSIX)", async () => {
    if (process.platform === "win32") return; // named pipes are released by the OS
    const first = await createControlServer(address, () => ({ ok: true }));
    // Simulate a crash: drop the reference without an orderly close so the
    // socket file can linger.
    first.unref();
    expect(existsSync(address)).toBe(true);
    await new Promise((r) => first.close(r));

    // A fresh daemon must be able to bind the same address.
    server = await createControlServer(address, () => ({ ok: true }));
    expect(await sendControl(address, { cmd: "ping" })).toEqual({ ok: true });
  });
});
