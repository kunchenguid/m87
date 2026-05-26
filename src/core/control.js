import { existsSync, unlinkSync } from "node:fs";
import { connect, createServer } from "node:net";

// A tiny line-delimited JSON control channel between the CLI and the running
// daemon. The transport is a local IPC socket - a Unix domain socket on POSIX,
// a named pipe on Windows - so it works identically on every platform Node
// supports, unlike the POSIX-only signals it replaces (SIGUSR1 sync nudge,
// SIGTERM graceful stop). Each connection carries one request line and gets one
// reply line back.

const isWindows = process.platform === "win32";

/**
 * Start a control server at `address`, invoking `onCommand(message)` for each
 * received command and writing its (awaited) return value back as the reply.
 * Resolves with the underlying net.Server once it is listening.
 *
 * @param {string} address - UDS path (POSIX) or named-pipe path (Windows)
 * @param {(message: any) => any | Promise<any>} onCommand
 * @returns {Promise<import("node:net").Server>}
 */
export function createControlServer(address, onCommand) {
  // A daemon that crashed without an orderly close can leave a stale socket
  // file behind, which makes listen() fail with EADDRINUSE. Windows named pipes
  // are released by the OS when the owner dies, so this only applies to UDS.
  if (!isWindows && existsSync(address)) {
    try {
      unlinkSync(address);
    } catch {
      // best-effort; listen() will surface a real conflict below
    }
  }

  const server = createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          sock.write(
            `${JSON.stringify({ ok: false, error: "invalid json" })}\n`,
          );
          continue;
        }
        Promise.resolve()
          .then(() => onCommand(message))
          .then((reply) =>
            sock.write(`${JSON.stringify(reply ?? { ok: true })}\n`),
          )
          .catch((err) =>
            sock.write(
              `${JSON.stringify({ ok: false, error: String(err?.message ?? err) })}\n`,
            ),
          );
      }
    });
    // A client hanging up is normal, not a server fault.
    sock.on("error", () => {});
  });

  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once("error", onError);
    server.listen(address, () => {
      server.removeListener("error", onError);
      resolve(server);
    });
  });
}

/**
 * Connect to a control server, send one command, and resolve with its reply.
 * Rejects if no server is listening, on transport error, or on timeout.
 *
 * @param {string} address
 * @param {any} message
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<any>}
 */
export function sendControl(address, message, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = connect(address);
    let buf = "";
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn(arg);
    };
    const timer = setTimeout(
      () => finish(reject, new Error("control request timed out")),
      timeoutMs,
    );

    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${JSON.stringify(message)}\n`));
    sock.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let reply;
      try {
        reply = JSON.parse(buf.slice(0, nl));
      } catch (err) {
        finish(reject, err);
        return;
      }
      finish(resolve, reply);
    });
    sock.on("error", (err) => finish(reject, err));
    sock.on("close", () =>
      finish(reject, new Error("control connection closed without a reply")),
    );
  });
}
