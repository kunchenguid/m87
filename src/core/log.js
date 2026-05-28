// A tiny structured logger for the daemon. Lines go to a stream (the daemon's
// stderr by default), which `firstpass daemon start` now redirects to
// ~/.firstpass/daemon.log so operational events are actually recorded instead
// of discarded. Format is one human-scannable line per event:
//
//   2026-05-28T12:00:00.000Z WARN plugin sync failed plugin=github status=...
//
// Structured fields are appended as key=value so the file stays greppable
// without a JSON parser.

const renderFields = (fields) => {
  if (!fields) return "";
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const raw = typeof v === "string" ? v : JSON.stringify(v);
    // Keep single-line: collapse newlines so one event is always one line.
    parts.push(`${k}=${String(raw).replace(/\s+/g, " ")}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
};

/**
 * @param {{ stream?: { write(s: string): unknown }, clock?: () => string }} [opts]
 */
export function createLogger({
  stream = process.stderr,
  clock = () => new Date().toISOString(),
} = {}) {
  const at = (level) => (msg, fields) =>
    stream.write(`${clock()} ${level} ${msg}${renderFields(fields)}\n`);
  return { info: at("INFO"), warn: at("WARN"), error: at("ERROR") };
}

// A drop-in that discards everything - the default when no logger is wired
// (e.g. one-shot CLI runs and tests that don't assert on logs). Built from
// createLogger so its method signatures match a real logger exactly.
export const noopLogger = createLogger({ stream: { write() {} } });
