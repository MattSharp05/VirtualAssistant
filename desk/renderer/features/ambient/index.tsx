import { useEffect } from "react";
import type { UsageResponse } from "@jarvis/shared";
import { useBridgeChoice } from "../../app/bridge";
import { Icon } from "../../app/icons";
import { Orb } from "../../app/orb/Orb";
import { useOrb } from "../../app/orb/useOrb";
import {
  ago,
  clockText,
  dateText,
  lastReport,
  meterTone,
  nextEvent,
  openCount,
  ORB_CAPTION,
  sessionCounts,
} from "./model";
import { useAmbientData, useClock } from "./useAmbient";
import "./ambient.css";

/**
 * The ambient face (JD-25, mockup 9): full screen on a second monitor. The orb in the middle follows
 * the same states and mood as the corner one; around it the clock, the next event, to-dos, sessions,
 * plan meters and the last report. Esc (or the close button) closes it.
 */
export default function Ambient() {
  const { bridge, scenario, ui } = useBridgeChoice();
  const orb = useOrb(bridge);
  const data = useAmbientData(bridge);
  const { now, real } = useClock(ui?.now);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("ambient-window");
    document.title = "Ambient · JARVIS";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && bridge.frame?.close();
    window.addEventListener("keydown", onKey);
    return () => {
      root.classList.remove("ambient-window");
      window.removeEventListener("keydown", onKey);
    };
  }, [bridge]);

  const digest = data.today?.digest;
  const next = digest && nextEvent(digest.events, now);
  const tasks = data.tasks ?? digest?.tasksDue;
  const counts = data.sessions && sessionCounts(data.sessions);
  const report = data.sessions && lastReport(data.sessions);

  return (
    <main className={`ambient${scenario ? " ambient-preview" : ""}`} aria-label="JARVIS ambient face">
      <section className="ambient-left">
        <div>
          <time className="ambient-time" data-testid="ambient-clock" dateTime={new Date(now).toISOString()}>
            {clockText(now)}
          </time>
          <p className="ambient-date">{dateText(now)}</p>
        </div>
        <div className="ambient-block" data-testid="ambient-next">
          <h2 className="ambient-label">Next up</h2>
          {next ? (
            <>
              <p className="ambient-value">{next.title}</p>
              <p className="ambient-muted">
                {next.when}
                {next.location ? ` · ${next.location}` : ""}
              </p>
            </>
          ) : (
            <p className="ambient-value ambient-muted">{digest ? "Nothing else today" : "—"}</p>
          )}
        </div>
        <div className="ambient-block" data-testid="ambient-todo">
          <h2 className="ambient-label">To-do today</h2>
          <p className="ambient-value">{tasks ? `${openCount(tasks)} open` : "—"}</p>
        </div>
      </section>

      <section className="ambient-stage" aria-label="JARVIS">
        <div className="ambient-orb" data-orb-state={orb.state} data-orb-mood={orb.mood}>
          <span className="ambient-halo ambient-halo-1" aria-hidden="true" />
          <span className="ambient-halo ambient-halo-2" aria-hidden="true" />
          <span className="ambient-halo ambient-halo-3" aria-hidden="true" />
          <Orb {...orb} expanded onClick={() => bridge.openWindow("chat")} />
        </div>
        <p className="ambient-name">JARVIS</p>
        <p className="ambient-state" data-testid="ambient-state">
          {ORB_CAPTION[orb.state]}
        </p>
      </section>

      <aside className="ambient-right">
        <div className="ambient-block" data-testid="ambient-sessions">
          <h2 className="ambient-label">Sessions</h2>
          <dl className="ambient-counts">
            <Count label="Working" tone="green" value={counts?.working} />
            <Count label="Waiting on you" tone="amber" value={counts?.waiting} />
            <Count label="Blocked" tone="red" value={counts?.blocked} />
          </dl>
        </div>
        <div className="ambient-block" data-testid="ambient-plan">
          <h2 className="ambient-label">Plan</h2>
          <PlanMeters usage={data.usage} />
        </div>
      </aside>

      <footer className="ambient-footer">
        <p className="ambient-report" data-testid="ambient-report">
          {report
            ? `Last report · ${report.who} · ${ago(report.at, real)} · ${report.text}`
            : "No reports yet"}
        </p>
        <p className="ambient-hint">⌥⌥ talk · ⌘⇧Space command · Esc close</p>
      </footer>

      <button
        type="button"
        className="ambient-close"
        aria-label="Close ambient face"
        onClick={() => bridge.frame?.close()}
      >
        <Icon name="close" size={16} />
      </button>
    </main>
  );
}

function Count({ label, tone, value }: { label: string; tone: string; value?: number }) {
  return (
    <div className="ambient-count">
      <dt>{label}</dt>
      <dd data-tone={value ? tone : "none"}>{value ?? "—"}</dd>
    </div>
  );
}

function PlanMeters({ usage }: { usage?: UsageResponse }) {
  if (!usage) return <p className="ambient-muted">—</p>;
  if (!usage.available)
    return <p className="ambient-muted">Plan usage unavailable{usage.reason ? ` · ${usage.reason}` : ""}</p>;
  return (
    <>
      <Meter label="5-hour" percent={usage.fiveHour} />
      <Meter label="Weekly" percent={usage.weekly} />
    </>
  );
}

function Meter({ label, percent }: { label: string; percent?: number }) {
  const value = Math.max(0, Math.min(100, percent ?? 0));
  const text = percent === undefined ? `${label} · —` : `${label} · ${Math.round(value)}%`;
  return (
    <div className="ambient-meter">
      <p className="ambient-meter-label">{text}</p>
      <div
        className="ambient-meter-track"
        role="meter"
        aria-label={`${label} plan usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        data-tone={meterTone(value)}
      >
        <span className="ambient-meter-fill" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}
