import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { countClaudeProcesses, readCgroup, SystemMonitor } from "../src/system.js";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-sys-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

test("reads cgroup v2 (Docker Desktop on Mac)", () => {
  const root = tree({
    "memory.current": "209715200\n",
    "memory.max": "536870912\n",
    "memory.peak": "314572800\n",
    "memory.stat": "anon 100\ninactive_file 52428800\nactive_file 1\n",
    "cpu.stat": "usage_usec 5000000\nuser_usec 1\n",
  });
  assert.deepEqual(readCgroup(root), {
    usage: 209715200, inactiveFile: 52428800, limit: 536870912, peak: 314572800, cpuMicros: 5000000,
  });
  assert.equal(readCgroup(tree({ "memory.current": "1", "memory.max": "max" })).limit, null);
});

test("reads cgroup v1 and treats the huge number as no limit", () => {
  const root = tree({
    "memory/memory.usage_in_bytes": "5472256",
    "memory/memory.limit_in_bytes": "9223372036854771712",
    "memory/memory.max_usage_in_bytes": "6344704",
    "memory/memory.stat": "cache 1\ntotal_inactive_file 1232896\n",
    "cpuacct/cpuacct.usage": "120601130",
  });
  const raw = readCgroup(root);
  assert.equal(raw.usage, 5472256);
  assert.equal(raw.limit, null);
  assert.equal(raw.inactiveFile, 1232896);
  assert.equal(raw.cpuMicros, 120601.13);
});

test("counts claude CLI processes from /proc", () => {
  const proc = tree({
    "1/cmdline": "node\0dist/src/index.js\0",
    "20/cmdline": "node\0/usr/local/bin/claude\0-p\0--cloud\0",
    "21/cmdline": "claude\0auth\0status\0",
    "22/cmdline": "sh\0-c\0echo claude\0",
    "self/cmdline": "x",
  });
  assert.equal(countClaudeProcesses(proc), 2);
});

test("monitor reports memory without file cache, CPU between samples, and keeps history", () => {
  const root = tree({
    "memory.current": "209715200",
    "memory.max": "536870912",
    "memory.stat": "inactive_file 52428800\n",
    "cpu.stat": "usage_usec 1000000\n",
  });
  const monitor = new SystemMonitor(root, tree({}));
  writeFileSync(join(root, "cpu.stat"), "usage_usec 1500000\n"); // +0.5s of CPU
  const start = Date.now();
  while (Date.now() - start < 50) { /* let wall time pass */ }
  monitor.record();
  const { current, history } = monitor.stats();
  assert.equal(history.length, 1);
  assert.equal(current.memoryUsed, 157286400);
  assert.equal(current.memoryLimit, 536870912);
  assert.ok((history[0].cpuPercent ?? 0) > 100, "0.5s CPU in ~50ms wall is several cores' worth");
});
