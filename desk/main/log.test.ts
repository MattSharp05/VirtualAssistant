// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLog, errorText, logLine, windowSource } from "./log";

const at = new Date("2026-10-17T18:00:00.000Z");

describe("desk.log (JD-63)", () => {
  it("writes one line per entry, creating the folder", () => {
    const file = join(mkdtempSync(join(tmpdir(), "desk-log-")), "Logs", "desk.log");
    const log = createLog({ file, now: () => at });
    log.write("error", "overlay", "TypeError: x is undefined\n    at Orb");
    log.write("warn", "main", "slow");
    expect(readFileSync(file, "utf8")).toBe(
      "2026-10-17T18:00:00.000Z ERROR [overlay] TypeError: x is undefined\n        at Orb\n" +
        "2026-10-17T18:00:00.000Z WARN  [main] slow\n",
    );
  });

  it("moves the log to desk.log.1 when it would pass the limit", () => {
    const file = join(mkdtempSync(join(tmpdir(), "desk-log-")), "desk.log");
    const log = createLog({ file, maxBytes: 200, now: () => at });
    for (let i = 0; i < 5; i++) log.write("info", "main", `entry ${i} ${"x".repeat(40)}`);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readFileSync(file, "utf8").length).toBeLessThanOrEqual(200);
    expect(readFileSync(file, "utf8")).toContain("entry 4");
    expect(readFileSync(`${file}.1`, "utf8")).not.toContain("entry 4");
  });

  it("never throws, even when it can't write", () => {
    const log = createLog({ file: "/dev/null/desk.log" });
    expect(() => log.write("error", "main", "x")).not.toThrow();
  });

  it("names the window from its URL, and turns errors into text", () => {
    expect(windowSource("file:///Applications/JARVIS%20Desk.app/index.html#/overlay")).toBe("overlay");
    expect(windowSource("file:///x/index.html#/settings?x=1")).toBe("settings");
    expect(windowSource("https://claude.ai/code")).toBe("web");
    expect(errorText(new Error("boom"))).toMatch(/^Error: boom/);
    expect(errorText("plain")).toBe("plain");
    expect(errorText({ reason: 1 })).toBe('{"reason":1}');
    expect(logLine(at, "info", "main", "trailing\n")).toBe(
      "2026-10-17T18:00:00.000Z INFO  [main] trailing\n",
    );
  });
});
