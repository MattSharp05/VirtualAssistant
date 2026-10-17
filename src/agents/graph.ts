// The agent graph (JD-57) as a pure function: what the sources say in, the Desk's tree out.
// Sources, merged in this order (an earlier one wins, a later one only fills gaps):
//   1. session tags: project:, role:orchestrator|builder, orchestrator:<id>, ticket:<ID>, run:<page id>
//   2. lineage: a session started by another hangs under it
//   3. the run page's "## Builders" table (adds sub-agents, which no session API sees)
//   4. the projects' Tickets data sources (In Progress / In Review / QA Pending): Sessions, PR, Branch
//   5. a session titled "<ID>: …" belongs to that ticket
// The tag and table formats are the dev-workflow's (claude-workflow: dev-workflow/reference/run-state.md).
// Sessions that no source ties to a project are left out (the Sessions window still has them).

import type {
  AgentBuilder,
  AgentCi,
  AgentMetrics,
  AgentOrchestrator,
  AgentPr,
  AgentProject,
  AgentRun,
  AgentSession,
  AgentSource,
  AgentTicket,
  AgentsResponse,
} from "@jarvis/shared";
import type { ProjectSetting } from "../config.js";
import { type BlockNode, propertyText, titleOf } from "../notion.js";
import { normalizeId } from "../notionWrite.js";

type Json = Record<string, unknown>;

/** Finished runs older than this fold into their project. */
export const FOLD_AFTER_MS = 7 * 24 * 60 * 60_000;
/** Ticket statuses read from a project's Tickets data source. */
export const IN_FLIGHT = ["In Progress", "In Review", "QA Pending"];
/** Tickets in these statuses get a node even when no session or run page row works on them. */
const SHOW_ALONE = ["In Progress", "In Review"];

/** A cloud session with its JD-53 metrics (tags and lineage ride on them). */
export type GraphSession = AgentSession;

/** One row of the run page's Builders table. */
export interface BuilderRow {
  ticket?: string;
  kind: "cloud" | "sub-agent";
  /** The Session / worktree cell: a session id (maybe cut short with …), a link or a worktree path. */
  who: string;
  state?: string;
  pr?: string;
  started?: string;
  updated?: string;
}

export interface RunPage {
  id: string;
  url: string;
  title?: string;
  status?: string;
  /** The run's day (YYYY-MM-DD, from the title), for the table's HH:MM times. */
  date?: string;
  builders: BuilderRow[];
}

/** One in-flight ticket from a project's Tickets data source. */
export interface TicketRow {
  id: string;
  title?: string;
  status?: string;
  url?: string;
  /** Session ids from the Sessions field. */
  sessions: string[];
  pr?: string;
  branch?: string;
}

/** What GitHub says about a PR (github.ts). */
export interface PrStatus {
  state: AgentPr["state"];
  title?: string;
  ci?: AgentCi;
}

export interface GraphInput {
  sessions: GraphSession[];
  projects: ProjectSetting[];
  /** Run pages by id (32 hex). */
  runs: Map<string, RunPage>;
  /** In-flight tickets by project slug. */
  tickets: Map<string, TicketRow[]>;
  /** GitHub's view of each PR, by URL. */
  prs?: Map<string, PrStatus>;
  now: number;
  /** Keep finished runs older than 7 days (GET /agents?all=1). */
  all?: boolean;
  warnings?: string[];
}

// ── Parsers ──

export interface SessionTags {
  project?: string;
  role?: string;
  orchestrator?: string;
  ticket?: string;
  run?: string;
}

/** `key:value` tags, lower-case keys, values as written (run: normalised to 32 hex). */
export function parseTags(tags: readonly string[] | undefined): SessionTags {
  const out: SessionTags = {};
  for (const tag of tags ?? []) {
    const i = tag.indexOf(":");
    if (i <= 0) continue;
    const key = tag.slice(0, i).trim().toLowerCase();
    const value = tag.slice(i + 1).trim();
    if (!value) continue;
    if (key === "project" || key === "role" || key === "orchestrator" || key === "ticket") out[key] ??= key === "role" ? value.toLowerCase() : value;
    else if (key === "run") out.run ??= normalizeId(value);
  }
  return out;
}

const SESSION_REF = /(?:session|cse)_[A-Za-z0-9_-]+(…|\.\.\.)?/g;

/** Session ids named in text (ids, claude.ai links); a cut-short one ("session_01Ab…") matches by prefix. */
export function sessionRefs(text: string, known: Iterable<string>): string[] {
  const ids = [...known];
  const out: string[] = [];
  for (const m of text.matchAll(SESSION_REF)) {
    const cut = Boolean(m[1]);
    const raw = cut ? m[0].slice(0, -m[1].length) : m[0];
    const hit = cut ? ids.filter((id) => id.startsWith(raw)) : ids.filter((id) => id === raw);
    const id = hit.length === 1 ? hit[0] : cut ? undefined : raw;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;

/** A PR from a URL, or from "#63" / "63" with the project's repo. */
export function parsePr(text: string | undefined, repo?: string): AgentPr | undefined {
  if (!text) return undefined;
  const m = PR_URL.exec(text);
  if (m) return { number: Number(m[2]), url: `https://github.com/${m[1]}/pull/${m[2]}`, repo: m[1], state: "open" };
  const n = /(?:^|\s|#)(\d+)\b/.exec(text.trim());
  if (n && repo) return { number: Number(n[1]), url: `https://github.com/${repo}/pull/${n[1]}`, repo, state: "open" };
  return undefined;
}

function plain(rich: unknown): string {
  return Array.isArray(rich) ? rich.map((r) => String((r as Json).plain_text ?? "")).join("") : "";
}

/** A block's text (headings, paragraphs, callouts…). */
function blockPlain(block: Json): string {
  const body = (block[String(block.type)] ?? {}) as Json;
  return plain(body.rich_text).trim();
}

/**
 * The run page's callout Status and its Builders table: the first table after a heading titled
 * "Builders", with the columns Ticket | Kind | Session / worktree | State | PR | Started | Updated.
 */
export function parseRunBlocks(nodes: BlockNode[]): { status?: string; builders: BuilderRow[] } {
  let status: string | undefined;
  let inBuilders = false;
  let rows: string[][] | undefined;
  for (const { block, children } of nodes) {
    const type = String(block.type);
    if (type === "callout" && !status) status = /Status:\s*([^·|\n]+)/i.exec(blockPlain(block))?.[1].trim();
    if (/^heading_\d$/.test(type)) inBuilders = /^builders$/i.test(blockPlain(block));
    else if (type === "table" && inBuilders && !rows) {
      rows = children.filter((c) => c.block.type === "table_row").map((c) => (((c.block.table_row as Json)?.cells as unknown[]) ?? []).map((cell) => plain(cell).trim()));
    }
  }
  if (!rows?.length) return { status, builders: [] };
  const header = rows[0].map((h) => h.toLowerCase());
  const hasHeader = header.includes("ticket") && header.includes("kind");
  const col = (name: string, fallback: number) => {
    const i = header.findIndex((h) => h.startsWith(name));
    return hasHeader && i >= 0 ? i : fallback;
  };
  const c = { ticket: col("ticket", 0), kind: col("kind", 1), who: col("session", 2), state: col("state", 3), pr: col("pr", 4), started: col("started", 5), updated: col("updated", 6) };
  const cell = (row: string[], i: number) => row[i]?.trim() || undefined;
  const builders = (hasHeader ? rows.slice(1) : rows)
    .map((row): BuilderRow | undefined => {
      const who = cell(row, c.who);
      const ticket = cell(row, c.ticket);
      if (!who && !ticket) return undefined;
      return prune<BuilderRow>({
        ticket,
        kind: /sub/i.test(cell(row, c.kind) ?? "") ? "sub-agent" : "cloud",
        who: who ?? "",
        state: cell(row, c.state)?.toLowerCase(),
        pr: cell(row, c.pr),
        started: cell(row, c.started),
        updated: cell(row, c.updated),
      });
    })
    .filter((r): r is BuilderRow => r !== undefined);
  return { status, builders };
}

/** A run page from its page JSON and blocks. */
export function parseRunPage(id: string, page: Json, nodes: BlockNode[]): RunPage {
  const title = titleOf(page);
  const { status, builders } = parseRunBlocks(nodes);
  return prune({
    id: normalizeId(id),
    url: String(page.url ?? `https://www.notion.so/${normalizeId(id)}`),
    title: title === "Untitled" ? undefined : title,
    status,
    date: /\((\d{4}-\d{2}-\d{2})\)/.exec(title)?.[1],
    builders,
  });
}

/** A Tickets row: the ID (unique_id, e.g. JD-57), title, Status, Sessions, PR and Branch. */
export function parseTicketRow(row: Json): TicketRow | undefined {
  const props = (row.properties ?? {}) as Record<string, Json>;
  const entries = Object.entries(props);
  const named = (name: string) => entries.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  const idProp = named("Ticket ID") ?? entries.find(([, p]) => p.type === "unique_id")?.[1];
  let id: string | undefined;
  if (idProp?.type === "unique_id") {
    const u = (idProp.unique_id ?? {}) as Json;
    if (u.number !== null && u.number !== undefined) id = u.prefix ? `${String(u.prefix)}-${String(u.number)}` : String(u.number);
  } else if (idProp) id = propertyText(idProp) || undefined;
  if (!id) return undefined;
  const text = (name: string) => {
    const p = named(name);
    return p ? propertyText(p).trim() || undefined : undefined;
  };
  const title = titleOf(row);
  const sessions = text("Sessions") ?? "";
  return prune({
    id,
    title: title === "Untitled" ? undefined : title,
    status: text("Status"),
    url: row.url ? String(row.url) : undefined,
    sessions: [...sessions.matchAll(SESSION_REF)].map((m) => m[0]),
    pr: text("PR"),
    branch: text("Branch"),
  });
}

/** "03:10" on the run's day as ISO (UTC, as the table's times are). */
function hhmm(text: string | undefined, date: string | undefined): string | undefined {
  const m = text && /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m || !date) return undefined;
  const at = Date.parse(`${date}T${m[1].padStart(2, "0")}:${m[2]}:00Z`);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

function prune<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

// ── The tree ──

interface Draft {
  key: string;
  kind: AgentBuilder["kind"];
  session?: GraphSession;
  worktree?: string;
  state?: string;
  ticketId?: string;
  prText?: string;
  started?: string;
  updated?: string;
  project?: string;
  /** The orchestrator's session id. */
  parent?: string;
  /** A run: tag with no orchestrator: tag yet. */
  run?: string;
  sources: Set<AgentSource>;
}

interface OrchDraft {
  session: GraphSession;
  project?: string;
  run?: string;
  sources: Set<AgentSource>;
}

const TITLE_TICKET = /^\s*([A-Z][A-Z0-9]*-\d+)\s*[:：]/;
const sessionUrl = (id: string) => `https://claude.ai/code/${id}`;
const ticketPrefix = (id: string) => /^([A-Za-z][A-Za-z0-9]*)-\d+$/.exec(id)?.[1].toUpperCase();

/** Natural order for ticket ids: JD-9 before JD-10. */
function byTicket(a: AgentBuilder, b: AgentBuilder): number {
  const ka = a.ticket?.id;
  const kb = b.ticket?.id;
  // Builders without a ticket go last.
  if (!ka || !kb) return Number(!ka) - Number(!kb) || a.id.localeCompare(b.id);
  return ka.localeCompare(kb, undefined, { numeric: true }) || a.id.localeCompare(b.id);
}

const lastSeen = (s: GraphSession) => s.lastActivity ?? s.metrics?.updatedAt ?? s.metrics?.createdAt ?? "";

export function buildGraph(input: GraphInput): AgentsResponse {
  const { sessions, projects, runs, tickets, now } = input;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const settings = new Map(projects.map((p) => [p.slug, p]));
  const byPrefix = new Map(projects.filter((p) => p.prefix).map((p) => [p.prefix!.toUpperCase(), p.slug]));
  const tags = new Map(sessions.map((s) => [s.id, parseTags(s.metrics?.tags)]));
  const orchs = new Map<string, OrchDraft>();
  const drafts = new Map<string, Draft>();

  const orch = (id: string, source: AgentSource): OrchDraft => {
    let o = orchs.get(id);
    if (!o) {
      o = { session: byId.get(id) ?? { id, title: id, url: sessionUrl(id) }, sources: new Set() };
      orchs.set(id, o);
      // A session that was a builder draft becomes an orchestrator once others hang under it.
      drafts.delete(`session:${id}`);
    }
    o.sources.add(source);
    return o;
  };
  const draftFor = (id: string, source: AgentSource): Draft => {
    const key = `session:${id}`;
    let d = drafts.get(key);
    if (!d) drafts.set(key, (d = { key, kind: "cloud", session: byId.get(id) ?? { id, title: id, url: sessionUrl(id) }, sources: new Set() }));
    d.sources.add(source);
    return d;
  };

  // 1. Tags.
  for (const s of sessions) {
    const t = tags.get(s.id)!;
    if (t.role === "orchestrator") {
      const o = orch(s.id, "tags");
      o.project ??= t.project;
      o.run ??= t.run;
    }
  }
  for (const s of sessions) {
    const t = tags.get(s.id)!;
    if (t.role === "orchestrator" || orchs.has(s.id)) continue;
    if (!t.project && !t.orchestrator && !t.ticket && t.role !== "builder") continue;
    const d = draftFor(s.id, "tags");
    d.project ??= t.project;
    d.ticketId ??= t.ticket;
    d.run ??= t.run;
    if (t.orchestrator && t.orchestrator !== s.id) {
      d.parent ??= t.orchestrator;
      orch(t.orchestrator, "tags").project ??= t.project;
    }
  }

  // 2. Lineage.
  for (const s of sessions) {
    const parentId = s.metrics?.parentId;
    if (!parentId || orchs.has(s.id) || parentId === s.id) continue;
    const existing = drafts.get(`session:${s.id}`);
    if (existing?.parent) continue;
    if (!byId.has(parentId) && !orchs.has(parentId)) continue;
    const parentDraft = drafts.get(`session:${parentId}`);
    const d = draftFor(s.id, "lineage");
    if (parentDraft) {
      // Started by a builder: it works for that builder's orchestrator.
      d.parent ??= parentDraft.parent;
      d.project ??= parentDraft.project;
    } else {
      d.parent ??= parentId;
      orch(parentId, "lineage");
    }
  }

  // Builders tagged with a run but no orchestrator join the orchestrator of that run; an untagged
  // orchestrator takes its builders' run.
  for (const d of drafts.values()) {
    if (!d.run) continue;
    if (!d.parent) d.parent = [...orchs.entries()].find(([, o]) => o.run === d.run)?.[0];
    if (d.parent) orchs.get(d.parent)!.run ??= d.run;
  }

  // 3. Run pages.
  const knownIds = () => new Set([...byId.keys(), ...orchs.keys()]);
  for (const [orchId, o] of orchs) {
    const run = o.run ? runs.get(o.run) : undefined;
    if (!run) continue;
    o.sources.add("run-page");
    const date = run.date ?? o.session.metrics?.createdAt?.slice(0, 10);
    for (const row of run.builders) {
      const [sessionId] = row.kind === "cloud" ? sessionRefs(row.who, knownIds()) : [];
      let d: Draft;
      if (sessionId && byId.has(sessionId) && !orchs.has(sessionId)) d = draftFor(sessionId, "run-page");
      else {
        const key = `sub:${run.id}:${row.ticket ?? row.who}`;
        d = drafts.get(key) ?? { key, kind: row.kind, sources: new Set(["run-page"]) };
        drafts.set(key, d);
        if (sessionId) d.session ??= { id: sessionId, title: row.ticket ?? sessionId, url: sessionUrl(sessionId) };
        else d.worktree ??= row.who || undefined;
      }
      d.parent ??= orchId;
      d.ticketId ??= row.ticket;
      d.state ??= row.state;
      d.prText ??= row.pr;
      d.started ??= hhmm(row.started, date);
      d.updated ??= hhmm(row.updated, date);
    }
  }

  // 4. Ticket pages: their Sessions field.
  const ticketIndex = new Map<string, { row: TicketRow; slug: string }>();
  for (const [slug, rows] of tickets) for (const row of rows) ticketIndex.set(row.id, { row, slug });
  for (const { row, slug } of ticketIndex.values()) {
    for (const id of sessionRefs(row.sessions.join(" "), knownIds())) {
      if (orchs.has(id) || !byId.has(id)) continue;
      const d = draftFor(id, "ticket");
      d.ticketId ??= row.id;
      d.project ??= slug;
    }
  }

  // 5. Titles: "JD-57: Agent graph…".
  const projectOfTicket = (id: string | undefined) => (id ? (ticketIndex.get(id)?.slug ?? byPrefix.get(ticketPrefix(id) ?? "")) : undefined);
  for (const s of sessions) {
    if (orchs.has(s.id)) continue;
    const id = TITLE_TICKET.exec(s.title)?.[1];
    if (!id) continue;
    const existing = drafts.get(`session:${s.id}`);
    if (existing) {
      if (!existing.ticketId) {
        existing.ticketId = id;
        existing.sources.add("title");
      }
    } else if (projectOfTicket(id)) draftFor(s.id, "title").ticketId = id;
  }

  // 4 again: in-flight tickets nothing above accounts for.
  const covered = new Set([...drafts.values()].map((d) => d.ticketId).filter(Boolean));
  for (const { row, slug } of ticketIndex.values()) {
    if (covered.has(row.id) || !SHOW_ALONE.includes(row.status ?? "")) continue;
    drafts.set(`ticket:${row.id}`, { key: `ticket:${row.id}`, kind: "ticket", ticketId: row.id, project: slug, prText: row.pr, sources: new Set(["ticket"]) });
  }

  // Projects: own tag, then the ticket's, then the orchestrator's (and an orchestrator its builders').
  for (const d of drafts.values()) d.project ??= projectOfTicket(d.ticketId);
  for (const [id, o] of orchs) {
    if (o.project) continue;
    const counts = new Map<string, number>();
    for (const d of drafts.values()) if (d.parent === id && d.project) counts.set(d.project, (counts.get(d.project) ?? 0) + 1);
    o.project = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  }
  for (const d of drafts.values()) if (d.parent) d.project ??= orchs.get(d.parent)?.project;

  // Assemble.
  const prs = input.prs ?? new Map<string, PrStatus>();
  const toBuilder = (d: Draft): AgentBuilder => {
    const t = d.ticketId ? ticketIndex.get(d.ticketId)?.row : undefined;
    const ticket: AgentTicket | undefined = d.ticketId ? prune({ id: d.ticketId, title: t?.title, status: t?.status, url: t?.url }) : undefined;
    const repo = d.project ? settings.get(d.project)?.repo : undefined;
    let pr = parsePr(d.prText, repo) ?? parsePr(t?.pr, repo);
    const gh = pr ? prs.get(pr.url) : undefined;
    if (pr && gh) pr = prune({ ...pr, state: gh.state, title: gh.title });
    return prune({
      id: d.key,
      kind: d.kind,
      session: d.session,
      worktree: d.worktree,
      state: d.state,
      ticket,
      pr,
      ci: gh?.ci,
      startedAt: d.started,
      updatedAt: d.updated,
      sources: [...d.sources],
    });
  };

  const slugs = new Set<string>(projects.map((p) => p.slug));
  for (const o of orchs.values()) if (o.project) slugs.add(o.project);
  for (const d of drafts.values()) if (d.project) slugs.add(d.project);

  const out: AgentProject[] = [];
  for (const slug of slugs) {
    const setting = settings.get(slug);
    const all: AgentOrchestrator[] = [];
    for (const [id, o] of orchs) {
      if (o.project !== slug) continue;
      const builders = [...drafts.values()].filter((d) => d.parent === id).map(toBuilder).sort(byTicket);
      const run = o.run ? runs.get(o.run) : undefined;
      const runRef: AgentRun | undefined = run ? prune({ id: run.id, url: run.url, title: run.title, status: run.status }) : undefined;
      const finished = Boolean(o.session.metrics?.finished) || /finished/i.test(run?.status ?? "");
      all.push(prune({ id: `session:${id}`, session: o.session, metrics: metricsOf([o.session], builders), run: runRef, finished, builders }));
    }
    const loose = [...drafts.values()].filter((d) => d.project === slug && (!d.parent || orchs.get(d.parent)?.project !== slug)).map(toBuilder).sort(byTicket);
    const old = (o: AgentOrchestrator) => o.finished && now - Date.parse(lastSeen(o.session) || new Date(now).toISOString()) > FOLD_AFTER_MS;
    const shown = input.all ? all : all.filter((o) => !old(o));
    shown.sort((a, b) => Number(a.finished) - Number(b.finished) || lastSeen(b.session).localeCompare(lastSeen(a.session)));
    out.push(
      prune({
        id: `project:${slug}`,
        slug,
        name: setting?.name ?? slug,
        notionUrl: setting?.notionUrl,
        repo: setting?.repo,
        metrics: sumMetrics([...all.map((o) => o.metrics), metricsOf([], loose)]),
        orchestrators: shown,
        loose,
        folded: all.length - shown.length,
      }),
    );
  }
  // Configured projects first, in their order; then the ones only tags name.
  const order = (slug: string) => {
    const i = projects.findIndex((p) => p.slug === slug);
    return i < 0 ? projects.length : i;
  };
  out.sort((a, b) => order(a.slug) - order(b.slug) || a.slug.localeCompare(b.slug));
  return { projects: out, warnings: input.warnings ?? [], checkedAt: new Date(now).toISOString() };
}

const DONE_STATES = ["merged", "stopped"];

function isActive(b: AgentBuilder): boolean {
  if (b.state && DONE_STATES.includes(b.state)) return false;
  if (b.session?.metrics?.finished) return false;
  if (b.kind === "ticket") return b.ticket?.status === "In Progress";
  return true;
}

function metricsOf(own: GraphSession[], builders: AgentBuilder[]): AgentMetrics {
  const sessions = [...own, ...builders.flatMap((b) => (b.session ? [b.session] : []))];
  const sum = (pick: (s: GraphSession) => number | undefined) => {
    const known = sessions.map(pick).filter((v): v is number => v !== undefined);
    return known.length ? known.reduce((a, b) => a + b, 0) : undefined;
  };
  const cost = sum((s) => s.metrics?.costUsd);
  return prune({
    sessions: sessions.length,
    builders: builders.length,
    active: builders.filter(isActive).length,
    costUsd: cost === undefined ? undefined : Math.round(cost * 100) / 100,
    totalTokens: sum((s) => s.metrics?.totalTokens),
  });
}

function sumMetrics(list: AgentMetrics[]): AgentMetrics {
  const add = (pick: (m: AgentMetrics) => number | undefined) => {
    const known = list.map(pick).filter((v): v is number => v !== undefined);
    return known.length ? known.reduce((a, b) => a + b, 0) : undefined;
  };
  const cost = add((m) => m.costUsd);
  return prune({
    sessions: add((m) => m.sessions) ?? 0,
    builders: add((m) => m.builders) ?? 0,
    active: add((m) => m.active) ?? 0,
    costUsd: cost === undefined ? undefined : Math.round(cost * 100) / 100,
    totalTokens: add((m) => m.totalTokens),
  });
}

// ── Changes: what agents.changed reports ──

/**
 * What counts as a change for each node: statuses, CI, PR state, who is under whom. Tokens, cost
 * and times move on every poll and don't count.
 */
export function signatures(tree: AgentsResponse): Map<string, string> {
  const out = new Map<string, string>();
  const sessionSig = (s?: AgentSession) => (s ? [s.title, s.status, s.metrics?.statusBucket, s.metrics?.finished] : []);
  const builderSig = (b: AgentBuilder) =>
    JSON.stringify([
      b.kind,
      sessionSig(b.session),
      b.state,
      b.ticket?.status,
      b.ticket?.title,
      b.pr?.url,
      b.pr?.state,
      b.ci?.state,
      b.ci?.headSha,
      b.ci?.checks.map((c) => [c.name, c.status, c.conclusion]),
    ]);
  for (const p of tree.projects) {
    out.set(p.id, JSON.stringify([p.name, p.orchestrators.map((o) => o.id), p.loose.map((b) => b.id), p.folded]));
    for (const o of p.orchestrators) {
      out.set(o.id, JSON.stringify([sessionSig(o.session), o.run?.status, o.finished, o.builders.map((b) => b.id)]));
      for (const b of o.builders) out.set(b.id, builderSig(b));
    }
    for (const b of p.loose) out.set(b.id, builderSig(b));
  }
  return out;
}

/** Node ids added, removed or changed between two trees' signatures. */
export function changedIds(before: Map<string, string>, after: Map<string, string>): string[] {
  const ids = new Set<string>();
  for (const [id, sig] of after) if (before.get(id) !== sig) ids.add(id);
  for (const id of before.keys()) if (!after.has(id)) ids.add(id);
  return [...ids].sort();
}

/** Every PR in the tree (for the CI poller). */
export function prsOf(tree: AgentsResponse): AgentPr[] {
  const out = new Map<string, AgentPr>();
  for (const p of tree.projects) for (const b of [...p.orchestrators.flatMap((o) => o.builders), ...p.loose]) if (b.pr) out.set(b.pr.url, b.pr);
  return [...out.values()];
}
