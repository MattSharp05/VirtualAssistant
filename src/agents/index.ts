// The agent graph service (JD-57): gathers the sources graph.ts merges, keeps the last tree, and
// publishes agents.changed with the changed node ids when a refresh finds a difference (once per
// change, never per poll). index.ts polls it every 30 s while a Desk is connected; GET /agents reads
// the cached tree (refreshed when older than 15 s).
//
// Reads, never writes: session list + metrics (tags, lineage), the run pages and each project's
// Tickets data source through the Notion integration, and GitHub check runs (github.ts, its own
// 30 s / 5 min cadence). A source that fails keeps its last good answer and adds a warning.

import type { AgentsResponse } from "@jarvis/shared";
import type { ProjectSetting } from "../config.js";
import type { EventBus } from "../events.js";
import type { Jarvis } from "../jarvis.js";
import { Notion, type BlockNode } from "../notion.js";
import { CiPoller } from "./github.js";
import { buildGraph, changedIds, IN_FLIGHT, parseRunPage, parseTags, parseTicketRow, prsOf, signatures, type GraphInput, type GraphSession, type RunPage, type TicketRow } from "./graph.js";

type Json = Record<string, unknown>;

/** How long a run page or a project's tickets are reused. */
export const NOTION_MAX_AGE_MS = 60_000;
/** GET /agents refreshes a tree older than this. */
export const TREE_MAX_AGE_MS = 15_000;
/** How often index.ts asks for a refresh (while a Desk is connected). */
export const AGENTS_POLL_MS = 30_000;

/** The Notion calls the graph needs (src/notion.ts; tests pass a fake). */
export interface NotionReader {
  rawPage(id: string): Promise<Json>;
  rawBlocks(id: string): Promise<BlockNode[]>;
  queryRows(source: string, filter: Json, max?: number): Promise<Json[]>;
}

export interface AgentGraphOptions {
  bus: EventBus;
  projects: ProjectSetting[];
  /** Cloud sessions with their metrics (tags, parentId); throws or warns when the list can't be read. */
  sessions: () => Promise<{ sessions: GraphSession[]; warning?: string }>;
  notion?: NotionReader;
  ci?: CiPoller;
  now?: () => number;
}

interface Cached<T> {
  value?: T;
  at: number;
}

export class AgentGraph {
  private readonly bus: EventBus;
  private readonly projects: ProjectSetting[];
  private readonly sessions: AgentGraphOptions["sessions"];
  private readonly notion?: NotionReader;
  private readonly ci: CiPoller;
  private readonly now: () => number;
  private readonly runs = new Map<string, Cached<RunPage>>();
  private readonly tickets = new Map<string, Cached<TicketRow[]>>();
  private lastSessions: GraphSession[] = [];
  private input?: GraphInput;
  private at = 0;
  private sigs?: Map<string, string>;
  private pending?: Promise<void>;

  constructor(opts: AgentGraphOptions) {
    this.bus = opts.bus;
    this.projects = opts.projects;
    this.sessions = opts.sessions;
    this.notion = opts.notion;
    this.ci = opts.ci ?? new CiPoller();
    this.now = opts.now ?? Date.now;
  }

  /** The tree; `all` keeps finished runs older than 7 days. */
  async get(all = false): Promise<AgentsResponse> {
    if (!this.input || this.now() - this.at >= TREE_MAX_AGE_MS) await this.refresh();
    return buildGraph({ ...this.input!, now: this.now(), all });
  }

  /** Reads what's due and publishes agents.changed if the tree changed. One refresh at a time. */
  refresh(): Promise<void> {
    this.pending ??= this.read().finally(() => (this.pending = undefined));
    return this.pending;
  }

  private async read(): Promise<void> {
    const warnings: string[] = [];
    let sessions = this.lastSessions;
    try {
      const got = await this.sessions();
      sessions = this.lastSessions = got.sessions;
      if (got.warning) warnings.push(got.warning);
    } catch (err) {
      warnings.push(`Session list: ${(err as Error).message.slice(0, 160)}`);
    }

    const runIds = new Set<string>();
    for (const s of sessions) {
      const run = parseTags(s.metrics?.tags).run;
      if (run) runIds.add(run);
    }
    const runs = new Map<string, RunPage>();
    const tickets = new Map<string, TicketRow[]>();
    if (this.notion) {
      await Promise.all([
        ...[...runIds].map(async (id) => {
          const run = await this.cached(this.runs, id, warnings, `Run page ${id}`, () => this.readRun(id));
          if (run) runs.set(id, run);
        }),
        ...this.projects
          .filter((p) => p.tickets)
          .map(async (p) => {
            const rows = await this.cached(this.tickets, p.slug, warnings, `${p.name} tickets`, () => this.readTickets(p.tickets!));
            if (rows) tickets.set(p.slug, rows);
          }),
      ]);
    } else if (runIds.size || this.projects.some((p) => p.tickets)) {
      warnings.push("Notion is off (NOTION_TOKEN unset): no run pages or tickets.");
    }

    const now = this.now();
    const base: GraphInput = { sessions, projects: this.projects, runs, tickets, now, warnings };
    const prs = await this.ci.refresh(prsOf(buildGraph({ ...base, all: true })));
    if (this.ci.lastError) warnings.push(this.ci.lastError);
    this.input = { ...base, prs };
    this.at = now;

    const sigs = signatures(buildGraph({ ...this.input, all: true }));
    if (this.sigs) {
      const ids = changedIds(this.sigs, sigs);
      if (ids.length) this.bus.publish({ type: "agents.changed", ids });
    }
    this.sigs = sigs;
  }

  /** A cached read: reused for a minute; on a failure the last good value stays (with a warning). */
  private async cached<T>(map: Map<string, Cached<T>>, key: string, warnings: string[], label: string, read: () => Promise<T>): Promise<T | undefined> {
    const hit = map.get(key);
    if (hit && this.now() - hit.at < NOTION_MAX_AGE_MS) return hit.value;
    try {
      const value = await read();
      map.set(key, { value, at: this.now() });
      return value;
    } catch (err) {
      warnings.push(`${label}: ${(err as Error).message.slice(0, 160)}`);
      map.set(key, { value: hit?.value, at: this.now() });
      return hit?.value;
    }
  }

  private async readRun(id: string): Promise<RunPage> {
    const [page, blocks] = await Promise.all([this.notion!.rawPage(id), this.notion!.rawBlocks(id)]);
    return parseRunPage(id, page, blocks);
  }

  /** In-flight tickets; Status is a status property in the workflow's template, a select in older ones. */
  private async readTickets(source: string): Promise<TicketRow[]> {
    const filter = (kind: "status" | "select") => ({ or: IN_FLIGHT.map((equals) => ({ property: "Status", [kind]: { equals } })) });
    let rows: Json[];
    try {
      rows = await this.notion!.queryRows(source, filter("status"));
    } catch (err) {
      if (!/\b400\b/.test((err as Error).message)) throw err;
      rows = await this.notion!.queryRows(source, filter("select"));
    }
    return rows.map(parseTicketRow).filter((r): r is TicketRow => r !== undefined);
  }
}

/** The live sessions with their metrics, from what Jarvis already caches (sessions.ts, sessionMetrics.ts). */
export function jarvisSessions(jarvis: Jarvis): AgentGraphOptions["sessions"] {
  return async () => {
    const list = await jarvis.listSessions();
    const metrics = await jarvis.metrics.summaries(list.sessions.map((s) => s.id));
    return {
      sessions: list.sessions.map((s) => ({
        id: s.id,
        title: s.title,
        url: s.url,
        ...(s.status ? { status: s.status } : {}),
        ...(s.lastActivityAt ? { lastActivity: s.lastActivityAt } : {}),
        ...(metrics.has(s.id) ? { metrics: metrics.get(s.id) } : {}),
      })),
      warning: list.available ? undefined : `Session list unavailable: ${list.reason ?? "unknown"}`,
    };
  };
}

const graphs = new WeakMap<object, AgentGraph>();

export function useAgentGraph(owner: object, graph: AgentGraph): void {
  graphs.set(owner, graph);
}

/** The registered graph, or one made from Jarvis's config on first use. */
export function agentGraphFor(jarvis: Jarvis, bus: EventBus): AgentGraph {
  let graph = graphs.get(jarvis);
  if (!graph) {
    const { config } = jarvis;
    graph = new AgentGraph({
      bus,
      projects: config.projects ?? [],
      sessions: jarvisSessions(jarvis),
      notion: config.notionToken ? new Notion(config.notionToken) : undefined,
      ci: new CiPoller({ token: config.githubToken }),
    });
    graphs.set(jarvis, graph);
  }
  return graph;
}
