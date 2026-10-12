// How much of the Claude plan's 5-hour and weekly allowance is spent.
//
// UNDOCUMENTED ON PURPOSE, and contained: the CLI answers a `get_usage` control request over its
// stream-json protocol (the same one backtalk uses through the Agent SDK's internals), but no public
// API wraps it. It makes no model call and costs nothing. If the shape changes or the request stops
// working, this returns { available: false } and everything else carries on.

import { spawn } from "node:child_process";

export interface UsageWindow {
  name: "five_hour" | "seven_day";
  /** 0..100 */
  percent: number;
  resetsAt?: string;
}

export interface PlanUsage {
  available: boolean;
  windows: UsageWindow[];
  subscriptionType?: string;
  reason?: string;
  checkedAt: string;
}

const TIMEOUT_MS = 20_000;

export function parseUsageResponse(response: Record<string, unknown>): Omit<PlanUsage, "checkedAt"> {
  const limits = response.rate_limits as Record<string, Record<string, unknown> | undefined> | null | undefined;
  const subscriptionType = typeof response.subscription_type === "string" ? response.subscription_type : undefined;
  if (!limits || response.rate_limits_available === false) {
    return { available: false, windows: [], subscriptionType, reason: "This login doesn't report plan limits." };
  }
  const windows: UsageWindow[] = [];
  for (const name of ["five_hour", "seven_day"] as const) {
    const w = limits[name];
    if (!w) continue;
    // Two spellings seen in the wild; both are percentages.
    const pct = typeof w.utilization === "number" ? w.utilization : w.used_percentage;
    if (typeof pct !== "number") continue;
    const resets = w.resets_at;
    const resetsAt =
      typeof resets === "string"
        ? resets
        : typeof resets === "number"
          ? new Date(resets * (resets < 1e12 ? 1000 : 1)).toISOString()
          : undefined;
    windows.push({ name, percent: Math.max(0, Math.min(100, pct)), resetsAt });
  }
  return windows.length
    ? { available: true, windows, subscriptionType }
    : { available: false, windows, subscriptionType, reason: "No usage windows in the response." };
}

export function planUsage(claudeBin: string): Promise<PlanUsage> {
  const checkedAt = new Date().toISOString();
  const unavailable = (reason: string): PlanUsage => ({ available: false, windows: [], reason, checkedAt });

  return new Promise((resolve) => {
    const child = spawn(claudeBin, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    let done = false;
    const finish = (result: PlanUsage) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(result);
    };
    const timer = setTimeout(() => finish(unavailable("The CLI didn't answer the usage request.")), TIMEOUT_MS);

    child.on("error", (err) => finish(unavailable(err.message)));
    child.on("close", () => finish(unavailable("The CLI exited without answering.")));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const msg = JSON.parse(line) as { type?: string; response?: Record<string, unknown> };
          if (msg.type !== "control_response" || msg.response?.request_id !== "usage") continue;
          if (msg.response.subtype !== "success") {
            finish(unavailable(String(msg.response.error ?? "usage request failed")));
          } else {
            finish({ ...parseUsageResponse((msg.response.response ?? {}) as Record<string, unknown>), checkedAt });
          }
        } catch {
          // not JSON (or not ours); keep reading
        }
      }
    });

    const request = (id: string, subtype: string) =>
      JSON.stringify({ type: "control_request", request_id: id, request: { subtype } }) + "\n";
    child.stdin.on("error", () => {}); // EPIPE if the CLI exits early; "close" above reports it
    child.stdin.write(request("init", "initialize"));
    child.stdin.write(request("usage", "get_usage"));
    child.stdin.end();
  });
}

/** Caches planUsage so dashboard polling doesn't spawn a CLI every few seconds. */
export class UsageCache {
  private last?: PlanUsage;
  private pending?: Promise<PlanUsage>;

  constructor(
    private readonly claudeBin: string,
    private readonly maxAgeMs = 60_000,
  ) {}

  async get(): Promise<PlanUsage> {
    if (this.last && Date.now() - Date.parse(this.last.checkedAt) < this.maxAgeMs) return this.last;
    this.pending ??= planUsage(this.claudeBin).finally(() => (this.pending = undefined));
    this.last = await this.pending;
    return this.last;
  }
}
