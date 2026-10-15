import type { VoiceLatencySummary, VoiceLatencyTurn } from "@jarvis/shared";
import { biggest, LATENCY_TARGET, seconds, waterfall } from "./model";
import "./latency.css";

const TRIGGER: Record<VoiceLatencyTurn["trigger"], string> = { ptt: "push-to-talk", wake: "wake word" };

/** "claude-haiku-5-5" → "haiku". */
const shortModel = (model: string) => model.replace(/^claude-/, "").replace(/-\d.*$/, "");

function Stat({ label, ms, target }: { label: string; ms: number | null; target: number }) {
  const verdict = ms === null ? "none" : ms <= target ? "met" : "missed";
  return (
    <div className="latency-stat" data-verdict={verdict}>
      <span className="latency-stat-label">{label}</span>
      <span className="latency-stat-value">{seconds(ms)}</span>
      <span className="latency-stat-target">
        target ≤ {seconds(target)}
        {verdict === "met" ? " · met" : verdict === "missed" ? " · missed" : ""}
      </span>
    </div>
  );
}

function lastLine(last: VoiceLatencyTurn): string {
  const first = last.stages.audioStart;
  return [
    first === undefined ? "no first word" : seconds(first),
    TRIGGER[last.trigger],
    ...(last.model ? [shortModel(last.model)] : []),
  ].join(" · ");
}

/**
 * Voice latency (JD-48): p50/p90 of the first spoken word after Matthew stops talking, over the last
 * 20 voice turns, against the PRD's 2.5 s / 3.5 s, and where the time goes (each stage's median).
 */
export default function Latency({ summary }: { summary?: VoiceLatencySummary }) {
  const segments = summary ? waterfall(summary.stages) : [];
  const total = segments.reduce((n, s) => n + s.ms, 0);
  const top = biggest(segments);
  return (
    <section className="system-section system-latency" aria-labelledby="system-latency">
      <div className="latency-head">
        <h2 id="system-latency" className="system-label">
          VOICE · FIRST WORD
        </h2>
        {summary && summary.turns > 0 && (
          <span className="latency-count">
            last {summary.turns} {summary.turns === 1 ? "turn" : "turns"}
          </span>
        )}
      </div>
      {!summary ? (
        <p className="system-note">This server doesn't report voice latency yet.</p>
      ) : summary.turns === 0 ? (
        <p className="system-note">
          No voice turns timed yet. Ask JARVIS something out loud and the timings show up here.
        </p>
      ) : (
        <>
          <div className="latency-stats">
            <Stat label="Median (p50)" ms={summary.p50} target={LATENCY_TARGET.p50} />
            <Stat label="p90" ms={summary.p90} target={LATENCY_TARGET.p90} />
          </div>
          {total > 0 && (
            <figure className="latency-figure">
              <div
                className="latency-bar"
                role="img"
                aria-label={`Where the time goes: ${segments.map((s) => `${s.label} ${seconds(s.ms)}`).join(", ")}`}
              >
                {segments.map((s) => (
                  <div
                    key={s.id}
                    className="latency-segment"
                    data-segment={s.id}
                    style={{ flexGrow: s.ms }}
                    title={`${s.label}: ${seconds(s.ms)}`}
                  />
                ))}
              </div>
              <ul className="latency-legend">
                {segments.map((s) => (
                  <li key={s.id} data-segment={s.id} data-top={s === top || undefined}>
                    <span className="latency-dot" aria-hidden="true" />
                    <span className="latency-legend-label">{s.label}</span>
                    <span className="latency-legend-ms">{seconds(s.ms)}</span>
                  </li>
                ))}
              </ul>
            </figure>
          )}
          <p className="system-note latency-foot">
            {top && top.ms > 0 && (
              <>
                Biggest: <strong>{top.label}</strong> ({seconds(top.ms)}).{" "}
              </>
            )}
            {summary.last && <>Last turn: {lastLine(summary.last)}.</>}
          </p>
        </>
      )}
    </section>
  );
}
