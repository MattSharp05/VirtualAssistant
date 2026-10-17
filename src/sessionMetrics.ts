// Per-session metrics (JD-53): what each cloud session has used (tokens, cost, context) and done
// (turns, tool calls, PRs, active time).
//
// UNDOCUMENTED, and contained like the session list (sessions.ts) with the same OAuth login:
//   GET /v1/code/sessions/{id}          detail: external_metadata.usage / context_usage, models,
//                                       status_bucket, tags, lineage, created_at / updated_at
//   GET /v1/code/sessions/{id}/events   transcript events; no cursor = the newest page, before_id
//                                       pages back, after_id reads only what came after an event
// Field names were checked on a live session (2026-10-17) but nothing is promised, so every value
// is read defensively and anything missing stays undefined (unknown), never 0. A failing call keeps
// the last good metrics; a session that has completed is never read again.

import type { SessionMetrics, SessionStatusBucket } from "@jarvis/shared";
import { API_BASE, apiHeaders, readAccessToken, readOrganizationUuid } from "./claudeApi.js";

/** How long a session's metrics are reused before the next read. */
export const METRICS_MAX_AGE_MS = 60_000;
/** Events per page and the most pages one read follows (the rest is read next time). */
const PAGE = 100;
const MAX_PAGES = 50;
/** Detail reads at once when a whole list is filled in. */
const CONCURRENCY = 6;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

function iso(v: unknown): string | undefined {
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return undefined;
}

/** "SESSION_STATUS_BUCKET_REVIEW_READY" → "review_ready". */
export function bucketOf(v: unknown): SessionStatusBucket | undefined {
  const s = str(v);
  return s ? s.replace(/^SESSION_STATUS_BUCKET_/i, "").toLowerCase() : undefined;
}

/** What the detail endpoint says, before wall time (which depends on the clock and the events). */
export type DetailMetrics = Omit<SessionMetrics, "wallMs" | "finished" | "checkedAt" | "turns" | "toolCalls" | "prs" | "activeMs" | "activityPartial">;

export function parseDetail(body: unknown): DetailMetrics {
  const b = obj(body) ?? {};
  const meta = obj(b.external_metadata) ?? {};
  const usage = obj(meta.usage) ?? {};
  const context = obj(meta.context_usage) ?? {};
  const lineage = obj(b.lineage) ?? {};

  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cacheRead = num(usage.cache_read_tokens);
  const cacheWrite = num(usage.cache_write_tokens);
  const used = num(context.used_tokens);
  const max = num(context.max_tokens);
  const tags = Array.isArray(b.tags) ? b.tags.filter((t): t is string => typeof t === "string") : undefined;
  const parent = str(lineage.parent_session_id) ?? str(lineage.parent_id) ?? str(obj(lineage.parent)?.id);

  const served = str(meta.last_served_model);
  const configured = str(b.configured_model);

  const out: DetailMetrics = {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens:
      input !== undefined && output !== undefined && cacheRead !== undefined && cacheWrite !== undefined
        ? input + output + cacheRead + cacheWrite
        : undefined,
    costUsd: num(usage.cost_usd),
    contextUsedTokens: used,
    contextMaxTokens: max,
    contextPercent: used !== undefined && max ? Math.round((used / max) * 1000) / 10 : undefined,
    model: served ?? configured,
    configuredModel: served && configured && served !== configured ? configured : undefined,
    statusBucket: bucketOf(b.status_bucket),
    tags,
    parentId: parent,
    createdAt: iso(b.created_at),
    updatedAt: iso(b.updated_at),
  };
  return prune(out);
}

/** Drops undefined keys so the JSON carries only what is known. */
function prune<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

// ── Activity: counted from events, incrementally ──

export interface Tally {
  /** The newest event read; the next read asks only for what came after it. */
  cursor?: string;
  turns: number;
  toolCalls: number;
  prs: string[];
  /** Closed turns only. */
  activeMs: number;
  /** When the turn in progress started (a user message without its result yet). */
  openTurnAt?: string;
  lastEventAt?: string;
  partial: boolean;
}

export const emptyTally = (): Tally => ({ turns: 0, toolCalls: 0, prs: [], activeMs: 0, partial: false });

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

function blocks(content: unknown): Obj[] {
  return Array.isArray(content) ? content.map(obj).filter((b): b is Obj => b !== undefined) : [];
}

/** Adds one raw event to the tally. Events wrap the transcript entry in `data` or `payload`, or not at all. */
export function countEvent(t: Tally, raw: Obj): void {
  let event = obj(raw.data) ?? obj(raw.payload) ?? raw;
  let type = str(event.type) ?? str(raw.type);
  // Or keyed by its kind: { data: { user: {...} } }.
  const [kind] = Object.keys(event);
  if (!type && kind && obj(event[kind])) [type, event] = [kind, obj(event[kind])!];
  const at = iso(raw.created_at ?? event.timestamp ?? raw.timestamp);
  if (at) t.lastEventAt = at;
  const message = obj(event.message) ?? {};
  const content = message.content ?? event.content;
  const parts = blocks(content);

  if (type === "user") {
    // Tool results come back as user entries; only a real message (text, not synthetic) is a turn.
    const results = parts.filter((b) => b.type === "tool_result");
    for (const r of results) for (const url of JSON.stringify(r.content ?? "").match(PR_URL) ?? []) if (!t.prs.includes(url)) t.prs.push(url);
    const isText = typeof content === "string" ? content.trim() !== "" : parts.some((b) => b.type === "text");
    if (isText && !results.length && event.isSynthetic !== true && raw.isSynthetic !== true) {
      t.turns++;
      t.openTurnAt ??= at;
    }
  } else if (type === "assistant") {
    t.toolCalls += parts.filter((b) => b.type === "tool_use").length;
  } else if (type === "result") {
    const start = t.openTurnAt ? Date.parse(t.openTurnAt) : undefined;
    if (start !== undefined && at) t.activeMs += Math.max(0, Date.parse(at) - start);
    else if (num(event.duration_ms) !== undefined) t.activeMs += num(event.duration_ms)!;
    t.openTurnAt = undefined;
  }
}

interface EventsPage {
  events: Obj[];
  firstId?: string;
  lastId?: string;
  hasMore: boolean;
}

function parsePage(body: unknown): EventsPage {
  const b = obj(body) ?? {};
  const list = (Array.isArray(b.data) ? b.data : Array.isArray(b.events) ? b.events : []).map(obj).filter((e): e is Obj => e !== undefined);
  const id = (e: Obj | undefined) => str(e?.id) ?? str(e?.uuid) ?? str(e?.event_uuid);
  return { events: list, firstId: str(b.first_id) ?? id(list[0]), lastId: str(b.last_id) ?? id(list.at(-1)), hasMore: b.has_more === true };
}

// ── The source: cache, containment, the clock ──

export interface MetricsOptions {
  fetchImpl?: typeof fetch;
  token?: () => string | undefined;
  organizationUuid?: () => string | undefined;
  now?: () => number;
  maxAgeMs?: number;
}

interface Entry {
  detail?: DetailMetrics;
  detailAt?: number;
  /** When the detail was last read successfully (ISO). */
  checkedAt?: string;
  tally?: Tally;
  tallyAt?: number;
  /** Completed: the detail is final and isn't read again. */
  detailDone: boolean;
  /** Completed and its events read after that: nothing is read again. */
  done: boolean;
  pending?: Promise<void>;
}

const FINISHED: SessionStatusBucket[] = ["completed"];

export class SessionMetricsSource {
  private readonly entries = new Map<string, Entry>();
  private readonly fetchImpl: typeof fetch;
  private readonly token: () => string | undefined;
  private readonly org: () => string | undefined;
  private readonly now: () => number;
  private readonly maxAgeMs: number;

  constructor(opts: MetricsOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.token = opts.token ?? (() => readAccessToken());
    this.org = opts.organizationUuid ?? (() => readOrganizationUuid());
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? METRICS_MAX_AGE_MS;
  }

  /** List-row metrics (detail only), or undefined when nothing has ever been read for it. */
  async summary(sessionId: string): Promise<SessionMetrics | undefined> {
    const e = this.entry(sessionId);
    await this.refresh(sessionId, e, false);
    return this.build(e, false);
  }

  /** Detail plus activity from the events. */
  async full(sessionId: string): Promise<SessionMetrics | undefined> {
    const e = this.entry(sessionId);
    await this.refresh(sessionId, e, true);
    return this.build(e, true);
  }

  /** Summaries for many sessions, a few at a time. */
  async summaries(ids: string[]): Promise<Map<string, SessionMetrics>> {
    const out = new Map<string, SessionMetrics>();
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++];
        const m = await this.summary(id).catch(() => undefined);
        if (m) out.set(id, m);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
    return out;
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) this.entries.set(id, (e = { detailDone: false, done: false }));
    return e;
  }

  private async refresh(id: string, e: Entry, withEvents: boolean): Promise<void> {
    // One read per session at a time; a second caller waits for it, then checks freshness again.
    while (e.pending) await e.pending;
    if (e.done) return;
    const t = this.now();
    const needDetail = !e.detailDone && (e.detailAt === undefined || t - e.detailAt >= this.maxAgeMs);
    const needEvents = withEvents && (e.tallyAt === undefined || t - e.tallyAt >= this.maxAgeMs);
    if (!needDetail && !needEvents) return;
    e.pending = (async () => {
      const token = this.token();
      if (!token) return;
      const headers = apiHeaders(token, this.org());
      if (needDetail) await this.readDetail(id, e, headers);
      const finished = e.detail?.statusBucket !== undefined && FINISHED.includes(e.detail.statusBucket);
      if (!needEvents) {
        if (finished) e.detailDone = true;
        return;
      }
      const read = await this.readEvents(id, e, headers);
      // Once complete, one successful events read after that catches the tail, and that's final.
      if (finished && read) e.done = e.detailDone = true;
    })().finally(() => (e.pending = undefined));
    await e.pending;
  }

  private async get(url: string, headers: Record<string, string>): Promise<unknown | undefined> {
    try {
      const res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return undefined;
      return await res.json();
    } catch {
      return undefined;
    }
  }

  private async readDetail(id: string, e: Entry, headers: Record<string, string>): Promise<void> {
    const body = await this.get(`${API_BASE}/v1/code/sessions/${encodeURIComponent(id)}`, headers);
    // On an error keep the last good detail, and try again after maxAge rather than on every call.
    e.detailAt = this.now();
    if (body === undefined) return;
    e.detail = parseDetail(body);
    e.checkedAt = new Date(this.now()).toISOString();
  }

  /** True when the events were read to the newest one. */
  private async readEvents(id: string, e: Entry, headers: Record<string, string>): Promise<boolean> {
    const base = `${API_BASE}/v1/code/sessions/${encodeURIComponent(id)}/events?limit=${PAGE}`;
    e.tallyAt = this.now();
    // Work on a copy so a failure halfway leaves the last good tally (and its cursor) as it was.
    const t: Tally = e.tally ? { ...e.tally, prs: [...e.tally.prs] } : emptyTally();
    const pages: Obj[][] = [];

    if (!t.cursor) {
      // First read: the newest page, then back to the start.
      let page = await this.page(base, headers);
      if (!page) return false;
      pages.unshift(page.events);
      t.cursor = page.lastId;
      let n = 1;
      while (page.hasMore && page.firstId && n < MAX_PAGES) {
        page = await this.page(`${base}&before_id=${encodeURIComponent(page.firstId)}`, headers);
        if (!page) return false;
        pages.unshift(page.events);
        n++;
      }
      // Older history than one read covers isn't counted; say so rather than pretend.
      t.partial = Boolean(page.hasMore);
    } else {
      // Later reads: only what came after the last event seen.
      for (let n = 0; n < MAX_PAGES; n++) {
        const page = await this.page(`${base}&after_id=${encodeURIComponent(t.cursor!)}`, headers);
        if (!page) return false;
        if (!page.events.length) break;
        pages.push(page.events);
        t.cursor = page.lastId ?? t.cursor;
        if (!page.hasMore) break;
      }
    }
    for (const events of pages) for (const raw of events) countEvent(t, raw);
    e.tally = t;
    return true;
  }

  private async page(url: string, headers: Record<string, string>): Promise<EventsPage | undefined> {
    const body = await this.get(url, headers);
    return body === undefined ? undefined : parsePage(body);
  }

  private build(e: Entry, withActivity: boolean): SessionMetrics | undefined {
    if (!e.detail || !e.checkedAt) return undefined;
    const d = e.detail;
    const finished = d.statusBucket !== undefined && FINISHED.includes(d.statusBucket);
    const tally = e.tally;
    const end = finished ? newest(d.updatedAt, tally?.lastEventAt) : new Date(this.now()).toISOString();
    const wallMs = d.createdAt && end ? Math.max(0, Date.parse(end) - Date.parse(d.createdAt)) : undefined;
    const m: SessionMetrics = { ...d, wallMs, finished, checkedAt: e.checkedAt };
    if (withActivity && tally) {
      const open = tally.openTurnAt && !finished ? Math.max(0, this.now() - Date.parse(tally.openTurnAt)) : 0;
      Object.assign(m, {
        turns: tally.turns,
        toolCalls: tally.toolCalls,
        prs: [...tally.prs],
        activeMs: tally.activeMs + open,
        ...(tally.partial ? { activityPartial: true } : {}),
      });
    }
    return prune(m);
  }
}

const newest = (...times: (string | undefined)[]) => times.filter((x): x is string => Boolean(x)).sort().pop();
