import type { ReactNode } from "react";
import type { SessionMetrics } from "@jarvis/shared";
import {
  UNKNOWN,
  UNKNOWN_HINT,
  contextTone,
  formatCost,
  formatCount,
  formatDuration,
  formatTokens,
  prLabel,
} from "./metrics";

/** A formatted value, or "—" with a tooltip saying the API didn't report it (never a made-up 0). */
export function Value({ text, loading }: { text: string | undefined; loading?: boolean }) {
  if (text !== undefined) return <>{text}</>;
  if (loading) return <span className="sessions-loading">…</span>;
  return (
    <span className="sessions-unknown" title={UNKNOWN_HINT}>
      {UNKNOWN}
      <span className="sessions-sr"> ({UNKNOWN_HINT})</span>
    </span>
  );
}

/** The context bar: cyan, amber from 70%, red from 85%; empty and grey when unknown. */
export function ContextBar({ percent, wide }: { percent: number | undefined; wide?: boolean }) {
  return (
    <span
      className="sessions-bar"
      data-wide={wide || undefined}
      data-tone={percent === undefined ? "unknown" : contextTone(percent)}
      aria-hidden="true"
    >
      <span style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }} />
    </span>
  );
}

const pct = (p: number | undefined) => (p === undefined ? undefined : `${p}%`);

/** The list row's metric line: cost · tokens · wall time · context bar and percent. */
export function RowMetrics({ metrics: m }: { metrics?: SessionMetrics }) {
  return (
    <span className="sessions-row-metrics">
      <span data-metric="cost">
        <Value text={formatCost(m?.costUsd)} />
      </span>
      <span data-metric="tokens">
        <Value text={formatTokens(m?.totalTokens)} />
      </span>
      <span data-metric="wall">
        <Value text={formatDuration(m?.wallMs, true)} />
      </span>
      <span className="sessions-row-context" data-metric="context">
        <ContextBar percent={m?.contextPercent} />
        <Value text={pct(m?.contextPercent)} />
      </span>
    </span>
  );
}

interface MetricsBlockProps {
  metrics?: SessionMetrics;
  /** The detail (turns, tool calls, PRs, active time) is still loading: show "…" there, not "—". */
  loading: boolean;
}

/** The quick view's Metrics block: everything JD-53 reports for one session. */
export function MetricsBlock({ metrics: m, loading }: MetricsBlockProps) {
  const row = (label: string, value: ReactNode, key = label) => (
    <div className="sessions-metric" key={key}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  const tokens = (n: number | undefined) => <Value text={formatTokens(n)} />;
  const detail = (text: string | undefined) => <Value text={text} loading={loading} />;
  const context =
    m?.contextUsedTokens !== undefined || m?.contextMaxTokens !== undefined ? (
      <>
        {tokens(m.contextUsedTokens)} / {tokens(m.contextMaxTokens)}
      </>
    ) : undefined;
  return (
    <section className="sessions-metrics" aria-labelledby="sessions-metrics-title">
      <h3 id="sessions-metrics-title" className="sessions-section-title">
        Metrics
      </h3>
      <dl>
        {row("Cost", <Value text={formatCost(m?.costUsd)} />)}
        {row("Tokens", tokens(m?.totalTokens))}
        <div className="sessions-metric-split">
          {row("Input", tokens(m?.inputTokens))}
          {row("Output", tokens(m?.outputTokens))}
          {row("Cache read", tokens(m?.cacheReadTokens))}
          {row("Cache write", tokens(m?.cacheWriteTokens))}
        </div>
        <div className="sessions-metric sessions-metric-context">
          <dt>Context</dt>
          <dd>
            {context ?? <Value text={undefined} />}
            <span className="sessions-metric-percent">
              <ContextBar percent={m?.contextPercent} wide />
              <Value text={pct(m?.contextPercent)} />
            </span>
          </dd>
        </div>
        {row("Wall time", <Value text={formatDuration(m?.wallMs)} />)}
        {row("Active time", detail(formatDuration(m?.activeMs)))}
        {row("Turns", detail(formatCount(m?.turns, m?.activityPartial)))}
        {row("Tool calls", detail(formatCount(m?.toolCalls, m?.activityPartial)))}
        {row(
          "PRs",
          m?.prs && m.prs.length > 0 ? (
            <span className="sessions-prs">
              {m.prs.map((url) => (
                <a key={url} href={url} target="_blank" rel="noreferrer">
                  {prLabel(url)}
                </a>
              ))}
            </span>
          ) : m?.prs ? (
            "none yet"
          ) : (
            detail(undefined)
          ),
        )}
        {row(
          "Model",
          m?.model ? (
            <span className="sessions-model">
              {m.model}
              {m.configuredModel && (
                <span className="sessions-model-configured">configured {m.configuredModel}</span>
              )}
            </span>
          ) : (
            <Value text={undefined} />
          ),
        )}
      </dl>
      {m?.activityPartial && (
        <p className="sessions-note sessions-metrics-note">
          + is a lower bound: the history is longer than one read covers.
        </p>
      )}
    </section>
  );
}
