import { describe, expect, it } from "vitest";
import {
  agoFrom,
  bytes,
  duration,
  inFrom,
  meterLevel,
  percentOf,
  sparkline,
  tokens,
  workerShare,
} from "./model";

describe("System window model", () => {
  it("colours meters: accent below 75%, amber from 75%, red from 90%", () => {
    expect(meterLevel(0)).toBe("ok");
    expect(meterLevel(74.9)).toBe("ok");
    expect(meterLevel(75)).toBe("amber");
    expect(meterLevel(89.9)).toBe("amber");
    expect(meterLevel(90)).toBe("red");
    expect(meterLevel(100)).toBe("red");
  });

  it("works out percentages, clamped, and none without a limit", () => {
    expect(percentOf(6, 30)).toBe(20);
    expect(percentOf(40, 30)).toBe(100);
    expect(percentOf(5, null)).toBeNull();
    expect(percentOf(null, 10)).toBeNull();
    expect(percentOf(5, 0)).toBeNull();
  });

  it("formats bytes, tokens and durations", () => {
    expect(bytes(412 * 2 ** 20)).toBe("412 MB");
    expect(bytes(1.5 * 2 ** 30)).toBe("1.5 GB");
    expect(bytes(null)).toBe("—");
    expect(tokens(980)).toBe("980");
    expect(tokens(1_240)).toBe("1.2k");
    expect(tokens(412_800)).toBe("413k");
    expect(tokens(2_300_000)).toBe("2.3M");
    expect(duration(45_000)).toBe("45 s");
    expect(duration(12 * 60_000)).toBe("12 min");
    expect(duration(130 * 60_000)).toBe("2 h 10 min");
    expect(duration(120 * 60_000)).toBe("2 h");
    expect(duration((3 * 24 + 15) * 3_600_000)).toBe("3 d 15 h");
  });

  it("measures relative times from the server's checkedAt", () => {
    const now = "2026-10-14T08:20:00Z";
    expect(inFrom("2026-10-14T10:30:00Z", now)).toBe("in 2 h 10 min");
    expect(inFrom("2026-10-14T08:00:00Z", now)).toBe("now");
    expect(inFrom(undefined, now)).toBeUndefined();
    expect(agoFrom("2026-10-14T08:19:30Z", now)).toBe("just now");
    expect(agoFrom("2026-10-14T08:16:00Z", now)).toBe("4 min ago");
    expect(agoFrom(undefined, now)).toBe("never");
  });

  it("splits today's tokens between worker and chat", () => {
    const u = (tokens: number) => ({ replies: 1, tokens, turns: 1, ms: 1 });
    expect(workerShare(u(300), u(100))).toBe(25);
    expect(workerShare(u(0), u(0))).toBe(0);
  });

  it("draws a sparkline over known values, scaled to their range", () => {
    const s = sparkline([10, null, 20, 30], 300, 44)!;
    expect(s.min).toBe(10);
    expect(s.max).toBe(30);
    expect(s.points).toBe("0.0,42.0 200.0,22.0 300.0,2.0");
    expect(sparkline([5], 300, 44)).toBeUndefined();
    expect(sparkline([null, null], 300, 44)).toBeUndefined();
  });
});
