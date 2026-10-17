// CI for the agent graph's PRs (JD-57): GitHub's PR (state, head) and the check runs on its head.
// Read every 30 s while any check is queued or running, else every 5 min; a PR once merged or closed
// keeps its last read. GITHUB_TOKEN (read-only Checks, Pull requests, Contents) is optional: public
// repos answer without it, rate-limited. The token is only ever a header; it is never logged.

import type { AgentCheck, AgentCi, AgentPr, CiState } from "@jarvis/shared";
import type { PrStatus } from "./graph.js";

export const CI_ACTIVE_MS = 30_000;
export const CI_IDLE_MS = 5 * 60_000;
const API = "https://api.github.com";
/** PRs read at once. */
const CONCURRENCY = 4;

type Json = Record<string, unknown>;

const FAILED = ["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"];

/** One check run's state: completed → passed or failed; in progress → running; anything else → queued. */
export function checkState(status: string, conclusion?: string | null): CiState {
  if (status === "completed") return conclusion && FAILED.includes(conclusion) ? "failed" : "passed";
  if (status === "in_progress") return "running";
  return "queued";
}

/** The PR's CI: failed beats running beats queued beats passed. No checks at all → undefined. */
export function ciState(checks: AgentCheck[]): CiState | undefined {
  if (!checks.length) return undefined;
  for (const s of ["failed", "running", "queued"] as const) if (checks.some((c) => c.state === s)) return s;
  return "passed";
}

export function parseCheckRuns(body: unknown): AgentCheck[] {
  const runs = ((body as Json | undefined)?.check_runs as Json[] | undefined) ?? [];
  // A re-run leaves the old run in the list; keep the newest per name.
  const newest = new Map<string, Json>();
  for (const r of runs) {
    const name = String(r.name ?? "check");
    const seen = newest.get(name);
    if (!seen || String(r.started_at ?? "") >= String(seen.started_at ?? "")) newest.set(name, r);
  }
  return [...newest.values()]
    .map((r) => {
      const status = String(r.status ?? "queued");
      const conclusion = typeof r.conclusion === "string" ? r.conclusion : undefined;
      const url = typeof r.html_url === "string" ? r.html_url : typeof r.details_url === "string" ? r.details_url : undefined;
      return { name: String(r.name ?? "check"), status, ...(conclusion ? { conclusion } : {}), ...(url ? { url } : {}), state: checkState(status, conclusion) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

interface Entry {
  status?: PrStatus;
  at?: number;
}

export interface CiOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class CiPoller {
  private readonly entries = new Map<string, Entry>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly token?: string;
  /** The last read's problem, if any (for the response's warnings). */
  lastError?: string;

  constructor(opts: CiOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.token = opts.token;
  }

  /** How long until open PRs are read again: 30 s while any check is queued or running, else 5 min. */
  get interval(): number {
    for (const e of this.entries.values()) {
      const s = e.status?.ci?.state;
      if (e.status?.state === "open" && (s === "running" || s === "queued")) return CI_ACTIVE_MS;
    }
    return CI_IDLE_MS;
  }

  /** The status of each PR, reading the ones that are due. */
  async refresh(prs: AgentPr[]): Promise<Map<string, PrStatus>> {
    const now = this.now();
    const interval = this.interval;
    const due = prs.filter((pr) => {
      const e = this.entries.get(pr.url);
      if (!e?.at) return true;
      if (e.status && e.status.state !== "open") return false;
      return now - e.at >= interval;
    });
    this.lastError = undefined;
    let next = 0;
    const worker = async () => {
      while (next < due.length) await this.read(due[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker));
    const out = new Map<string, PrStatus>();
    for (const pr of prs) {
      const status = this.entries.get(pr.url)?.status;
      if (status) out.set(pr.url, status);
    }
    return out;
  }

  private async get(path: string): Promise<Json | undefined> {
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "jarvis", "x-github-api-version": "2022-11-28" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    try {
      const res = await this.fetchImpl(`${API}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        this.lastError = `GitHub answered HTTP ${res.status} for ${path.split("/").slice(2, 4).join("/")}${res.status === 404 && !this.token ? " (private repo? set GITHUB_TOKEN)" : ""}`;
        return undefined;
      }
      return (await res.json()) as Json;
    } catch (err) {
      this.lastError = `GitHub unreachable: ${(err as Error).message.slice(0, 120)}`;
      return undefined;
    }
  }

  /** On a failure the last good status stays, and the PR is tried again after the interval. */
  private async read(pr: AgentPr): Promise<void> {
    const e = this.entries.get(pr.url) ?? {};
    this.entries.set(pr.url, e);
    e.at = this.now();
    const body = await this.get(`/repos/${pr.repo}/pulls/${pr.number}`);
    if (!body) return;
    const state: PrStatus["state"] = body.merged_at || body.merged === true ? "merged" : body.state === "closed" ? "closed" : "open";
    const sha = String(((body.head as Json | undefined)?.sha as string | undefined) ?? "");
    let ci: AgentCi | undefined = e.status?.ci;
    if (sha) {
      const runs = await this.get(`/repos/${pr.repo}/commits/${sha}/check-runs?per_page=100`);
      if (runs) {
        const checks = parseCheckRuns(runs);
        const s = ciState(checks);
        ci = s ? { state: s, checks, headSha: sha, checkedAt: new Date(this.now()).toISOString() } : undefined;
      }
    }
    e.status = { state, ...(typeof body.title === "string" ? { title: body.title } : {}), ...(ci ? { ci } : {}) };
  }
}
