// Live container stats for the dashboard, read from the container's own cgroup and /proc files,
// so JARVIS needs no access to the Docker socket. Handles cgroup v2 (Docker Desktop on Mac, modern
// Linux) and v1 (older hosts). Anything unreadable comes back as null instead of failing.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SystemSample {
  at: string;
  /** Bytes in use, excluding reclaimable file cache (what `docker stats` shows). */
  memoryUsed: number | null;
  /** The container's memory limit in bytes; null when unlimited. */
  memoryLimit: number | null;
  /** Highest usage the kernel has seen for this container. */
  memoryPeak: number | null;
  /** CPU use since the previous sample; 100 = one full core. */
  cpuPercent: number | null;
  /** `claude` CLI processes running right now (sends, usage checks, logins). */
  claudeProcesses: number;
  uptimeSeconds: number;
}

export interface SystemStats {
  current: SystemSample;
  /** Oldest first, one sample every SAMPLE_MS, covering the last hour. */
  history: { at: string; memoryUsed: number | null; cpuPercent: number | null }[];
}

const SAMPLE_MS = 10_000;
const HISTORY = 360;
// cgroup v1 reports "no limit" as a huge number near 2^63.
const UNLIMITED = 2 ** 60;

function readNumber(path: string): number | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    if (text === "max") return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function readStat(path: string, key: string): number | null {
  try {
    const line = readFileSync(path, "utf8").split("\n").find((l) => l.startsWith(key + " "));
    return line ? Number(line.split(" ")[1]) : null;
  } catch {
    return null;
  }
}

interface Raw {
  usage: number | null;
  inactiveFile: number | null;
  limit: number | null;
  peak: number | null;
  /** Total CPU time used, in microseconds. */
  cpuMicros: number | null;
}

export function readCgroup(root = "/sys/fs/cgroup"): Raw {
  const v2 = readNumber(join(root, "memory.current"));
  if (v2 !== null) {
    return {
      usage: v2,
      inactiveFile: readStat(join(root, "memory.stat"), "inactive_file"),
      limit: readNumber(join(root, "memory.max")),
      peak: readNumber(join(root, "memory.peak")),
      cpuMicros: readStat(join(root, "cpu.stat"), "usage_usec"),
    };
  }
  const limit = readNumber(join(root, "memory/memory.limit_in_bytes"));
  const cpuNanos = readNumber(join(root, "cpuacct/cpuacct.usage"));
  return {
    usage: readNumber(join(root, "memory/memory.usage_in_bytes")),
    inactiveFile: readStat(join(root, "memory/memory.stat"), "total_inactive_file"),
    limit: limit !== null && limit < UNLIMITED ? limit : null,
    peak: readNumber(join(root, "memory/memory.max_usage_in_bytes")),
    cpuMicros: cpuNanos === null ? null : cpuNanos / 1000,
  };
}

export function countClaudeProcesses(proc = "/proc"): number {
  let count = 0;
  let pids: string[];
  try {
    pids = readdirSync(proc).filter((p) => /^\d+$/.test(p));
  } catch {
    return 0;
  }
  for (const pid of pids) {
    try {
      const argv = readFileSync(join(proc, pid, "cmdline"), "utf8").split("\0");
      // The CLI runs as `claude …` or `node /…/bin/claude …`.
      if (argv.slice(0, 2).some((a) => a === "claude" || a.endsWith("/claude"))) count++;
    } catch {
      // process exited while we looked
    }
  }
  return count;
}

export class SystemMonitor {
  private last?: { cpuMicros: number; at: number };
  private current: SystemSample;
  private readonly history: SystemStats["history"] = [];
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly cgroupRoot = "/sys/fs/cgroup",
    private readonly procRoot = "/proc",
  ) {
    this.current = this.sample();
  }

  start(): void {
    this.timer = setInterval(() => this.record(), SAMPLE_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** A fresh reading (CPU averaged since the last one) plus the hour of history. */
  stats(): SystemStats {
    this.current = this.sample();
    return { current: this.current, history: this.history };
  }

  record(): void {
    this.current = this.sample();
    this.history.push({ at: this.current.at, memoryUsed: this.current.memoryUsed, cpuPercent: this.current.cpuPercent });
    if (this.history.length > HISTORY) this.history.shift();
  }

  private sample(): SystemSample {
    const raw = readCgroup(this.cgroupRoot);
    const now = Date.now();
    let cpuPercent: number | null = null;
    if (raw.cpuMicros !== null) {
      if (this.last && now > this.last.at) {
        cpuPercent = Math.max(0, ((raw.cpuMicros - this.last.cpuMicros) / ((now - this.last.at) * 1000)) * 100);
      }
      this.last = { cpuMicros: raw.cpuMicros, at: now };
    }
    return {
      at: new Date(now).toISOString(),
      memoryUsed: raw.usage === null ? null : Math.max(0, raw.usage - (raw.inactiveFile ?? 0)),
      memoryLimit: raw.limit,
      memoryPeak: raw.peak,
      cpuPercent: cpuPercent === null ? null : Math.round(cpuPercent * 10) / 10,
      claudeProcesses: countClaudeProcesses(this.procRoot),
      uptimeSeconds: Math.round(process.uptime()),
    };
  }
}
