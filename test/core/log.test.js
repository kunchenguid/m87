import { describe, expect, it } from "vitest";

import { createLogger, noopLogger } from "../../src/core/log.js";

describe("core/log", () => {
  const sink = () => {
    const chunks = [];
    return { chunks, write: (s) => chunks.push(s) };
  };

  it("writes one line per call with a fixed-clock timestamp and level", () => {
    const out = sink();
    const log = createLogger({
      stream: out,
      clock: () => "2026-05-28T12:00:00.000Z",
    });
    log.info("daemon started", { pid: 42 });

    expect(out.chunks).toHaveLength(1);
    const line = out.chunks[0];
    expect(line.endsWith("\n")).toBe(true);
    expect(line).toContain("2026-05-28T12:00:00.000Z");
    expect(line).toContain("INFO");
    expect(line).toContain("daemon started");
    expect(line).toContain("pid=42");
  });

  it("renders warn/error levels", () => {
    const out = sink();
    const log = createLogger({ stream: out, clock: () => "t" });
    log.warn("uh oh");
    log.error("boom", { code: "X" });
    expect(out.chunks[0]).toContain("WARN");
    expect(out.chunks[1]).toContain("ERROR");
    expect(out.chunks[1]).toContain("code=X");
  });

  it("noopLogger is callable and writes nothing", () => {
    expect(() => {
      noopLogger.info("x");
      noopLogger.warn("y", { a: 1 });
      noopLogger.error("z");
    }).not.toThrow();
  });
});
