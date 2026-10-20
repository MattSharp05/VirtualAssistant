// The agent graph (JD-57) as the Agents window shows it (JD-58): the tree of projects → orchestrators
// → builders, filtered (active only, one project, a ticket search) and collapsed, plus the labels,
// tones and number formats the cards and the side panel use. Plain functions, so they're testable.
import type {
  AgentBuilder,
  AgentCi,
  AgentOrchestrator,
  AgentProject,
  AgentSession,
  AgentsResponse,
} from "@jarvis/shared";

export type NodeKind = "project" | "orchestrator" | "builder";

/** One card in the tree; children are what's under it before collapsing. */
export interface TreeNode {
  id: string;
  kind: NodeKind;
  children: TreeNode[];
  project: AgentProject;
  orchestrator?: AgentOrchestrator;
  builder?: AgentBuilder;
}

export type ActivityFilter = "all" | "active";

export interface TreeFilter {
  activity: ActivityFilter;
  /** A project id, or undefined for every project. */
  project?: string;
  /** Matched against ticket IDs (and titles); builders that miss it are left out with empty runs. */
  search?: string;
}

const DONE_STATES = ["merged", "stopped"];

/** Still working: what the server counts as active (AgentMetrics.active). */
export function builderActive(b: AgentBuilder): boolean {
  if (b.kind === "ticket") return b.ticket?.status === "In Progress";
  return !DONE_STATES.includes((b.state ?? "").toLowerCase()) && !b.session?.metrics?.finished;
}

export function orchestratorActive(o: AgentOrchestrator): boolean {
  return !o.finished || o.builders.some(builderActive);
}

function matchesSearch(b: AgentBuilder, q: string): boolean {
  const text = [b.ticket?.id, b.ticket?.title, b.session?.title].filter(Boolean).join(" ").toLowerCase();
  return text.includes(q);
}

/** The tree the window draws, before collapsing (collapsing is the layout's job). */
export function buildTree(graph: AgentsResponse, filter: TreeFilter): TreeNode[] {
  const q = filter.search?.trim().toLowerCase() ?? "";
  const keep = (b: AgentBuilder) =>
    (filter.activity === "all" || builderActive(b)) && (!q || matchesSearch(b, q));
  return graph.projects
    .filter((p) => !filter.project || p.id === filter.project)
    .flatMap((p): TreeNode[] => {
      const builderNode = (b: AgentBuilder, o?: AgentOrchestrator): TreeNode => ({
        id: b.id,
        kind: "builder",
        children: [],
        project: p,
        ...(o ? { orchestrator: o } : {}),
        builder: b,
      });
      const orchs = p.orchestrators
        .filter((o) => filter.activity === "all" || orchestratorActive(o))
        .map((o): TreeNode => ({
          id: o.id,
          kind: "orchestrator",
          children: o.builders.filter(keep).map((b) => builderNode(b, o)),
          project: p,
          orchestrator: o,
        }))
        // A search keeps only the runs it found something in.
        .filter((n) => !q || n.children.length > 0);
      const loose = p.loose.filter(keep).map((b) => builderNode(b));
      const children = [...orchs, ...loose];
      if (q && children.length === 0) return [];
      return [{ id: p.id, kind: "project", children, project: p }];
    });
}

/** Every node id in the tree, depth first. */
export function allIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) => [n.id, ...allIds(n.children)]);
}

export function findNode(nodes: TreeNode[], id: string | undefined): TreeNode | undefined {
  if (!id) return undefined;
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * What changed between two fetches, by node id: a node whose own facts differ (status, CI, cost…),
 * or a new one. The window flashes these.
 */
export function changedIds(before: AgentsResponse | undefined, after: AgentsResponse): string[] {
  if (!before) return [];
  const sig = (g: AgentsResponse) => {
    const map = new Map<string, string>();
    for (const p of g.projects) {
      const { orchestrators, loose, ...own } = p;
      map.set(p.id, JSON.stringify({ ...own, metrics: { ...own.metrics } }));
      for (const o of orchestrators) {
        const { builders, ...rest } = o;
        map.set(o.id, JSON.stringify(stripTimes(rest)));
        for (const b of builders) map.set(b.id, JSON.stringify(stripTimes(b)));
      }
      for (const b of loose) map.set(b.id, JSON.stringify(stripTimes(b)));
    }
    return map;
  };
  const a = sig(before);
  const b = sig(after);
  return [...b].filter(([id, s]) => a.get(id) !== s).map(([id]) => id);
}

// checkedAt moves on every read; it isn't a change worth flashing.
function stripTimes<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (k, v) => (k === "checkedAt" ? undefined : v))) as T;
}

// ── Status ──

/** The colour of a status dot or pill. */
export type Tone = "working" | "waiting" | "done" | "failed" | "idle";

export type OrchestratorStatus = "working" | "waiting" | "done" | "failed";

export function orchestratorStatus(o: AgentOrchestrator): OrchestratorStatus {
  const bucket = o.session.metrics?.statusBucket;
  const run = o.run?.status?.toLowerCase() ?? "";
  if (bucket === "failed") return "failed";
  if (o.finished || bucket === "completed" || run === "finished") return "done";
  if (bucket === "blocked" || bucket === "review_ready" || run.startsWith("waiting") || run === "handed over")
    return "waiting";
  return "working";
}

export const STATUS_LABEL: Record<OrchestratorStatus, string> = {
  working: "Working",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
};

/** A builder's status: the run page's State first, then its session, then its ticket. */
export function builderStatus(b: AgentBuilder): { label: string; tone: Tone } {
  const state = b.state?.toLowerCase();
  if (state === "merged") return { label: "Merged", tone: "done" };
  if (state === "stopped") return { label: "Stopped", tone: "idle" };
  if (state === "blocked") return { label: "Blocked", tone: "waiting" };
  if (state === "ci") return { label: "In CI", tone: b.ci?.state === "failed" ? "failed" : "working" };
  if (state === "building") return { label: "Building", tone: "working" };
  const bucket = b.session?.metrics?.statusBucket;
  if (bucket === "failed") return { label: "Failed", tone: "failed" };
  if (bucket === "completed" || b.session?.metrics?.finished) return { label: "Done", tone: "done" };
  if (bucket === "blocked") return { label: "Needs you", tone: "waiting" };
  if (bucket === "review_ready") return { label: "Ready for QA", tone: "waiting" };
  if (bucket === "working") return { label: "Working", tone: "working" };
  if (b.kind === "ticket") return { label: b.ticket?.status ?? "Ticket", tone: "idle" };
  return { label: b.session?.status ?? "Unknown", tone: "idle" };
}

/** A project band's tint: amber if anything waits on Matthew, accent if anything works, else quiet. */
export type BandTone = "waiting" | "working" | "quiet";

export function projectTone(p: AgentProject): BandTone {
  const builders = [...p.orchestrators.flatMap((o) => o.builders), ...p.loose];
  const tones = [
    ...p.orchestrators.map((o) => orchestratorStatus(o)),
    ...builders.map((b) => builderStatus(b).tone),
  ];
  if (tones.includes("waiting")) return "waiting";
  if (tones.includes("working") || p.metrics.active > 0) return "working";
  return "quiet";
}

export const KIND_LABEL: Record<AgentBuilder["kind"], string> = {
  cloud: "session",
  "sub-agent": "sub-agent",
  ticket: "ticket",
};

/** "2/3": checks passed of all of them. */
export function ciCount(ci: AgentCi): { passed: number; failed: number; total: number } {
  return {
    passed: ci.checks.filter((c) => c.state === "passed").length,
    failed: ci.checks.filter((c) => c.state === "failed").length,
    total: ci.checks.length,
  };
}

/** The CI pill's text: "Running 1/2", "Passed 2/2", "Failed 1 of 2", "Queued 0/2". */
export function ciLabel(ci: AgentCi): string {
  const { passed, failed, total } = ciCount(ci);
  if (ci.state === "failed") return `Failed ${failed} of ${total}`;
  const word = { queued: "Queued", running: "Running", passed: "Passed" }[ci.state];
  return `${word} ${passed}/${total}`;
}

/** A builder's card title: "JD-57" (and the ticket title), else the session's title. */
export function builderTitle(b: AgentBuilder): { id?: string; title: string } {
  if (b.ticket) return { id: b.ticket.id, title: b.ticket.title ?? b.session?.title ?? "" };
  return { title: b.session?.title ?? b.worktree ?? b.id };
}

/** "JARVIS batch 13 (2026-10-17)" from "Run: JARVIS batch 13 (2026-10-17)". */
export function runName(o: AgentOrchestrator): string | undefined {
  return o.run?.title?.replace(/^Run:\s*/, "");
}

// ── Numbers ──

const trim = (n: number, digits: number) => n.toFixed(digits).replace(/\.0+$/, "");

/** "812", "6.8 k", "1.2 M"; undefined when unknown. */
export function formatTokens(n: number | undefined): string | undefined {
  if (n === undefined) return undefined;
  const step = (unit: number, suffix: string) => `${trim(n / unit, n / unit < 10 ? 1 : 0)} ${suffix}`;
  if (n >= 1e9) return step(1e9, "B");
  if (n >= 1e6) return step(1e6, "M");
  if (n >= 1e3) return step(1e3, "k");
  return String(n);
}

/** "$0.42", "$1,284"; undefined when unknown. */
export function formatCost(usd: number | undefined): string | undefined {
  if (usd === undefined) return undefined;
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return usd >= 1000
    ? `$${Math.round(usd).toLocaleString("en-US")}`
    : `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "47m", "9h 5m", "2d 3h"; undefined when unknown. */
export function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 === 0 ? `${h}h` : `${h}h ${min % 60}m`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

/** "4m ago" (or "just now"). */
export function ago(iso: string | undefined, now = Date.now()): string | undefined {
  if (!iso) return undefined;
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return ms < 60_000 ? "just now" : `${formatDuration(ms)} ago`;
}

/** The context bar: amber from 70% used, red from 85% (as in the Sessions window). */
export function contextTone(percent: number): "ok" | "amber" | "red" {
  if (percent >= 85) return "red";
  return percent >= 70 ? "amber" : "ok";
}

/** Every session in a project: its orchestrators', their builders' and the loose ones. */
export function projectSessions(p: AgentProject): AgentSession[] {
  return [
    ...p.orchestrators.flatMap((o) => [
      o.session,
      ...o.builders.flatMap((b) => (b.session ? [b.session] : [])),
    ]),
    ...p.loose.flatMap((b) => (b.session ? [b.session] : [])),
  ];
}

/** What the project's sessions active today (local day) have cost; undefined when none report a cost. */
export function todayCost(p: AgentProject, now = new Date()): number | undefined {
  const day = now.toDateString();
  const costs = projectSessions(p)
    .filter((s) => {
      const at = s.metrics?.updatedAt ?? s.lastActivity;
      return at !== undefined && new Date(at).toDateString() === day;
    })
    .flatMap((s) => (s.metrics?.costUsd === undefined ? [] : [s.metrics.costUsd]));
  return costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100 : undefined;
}
