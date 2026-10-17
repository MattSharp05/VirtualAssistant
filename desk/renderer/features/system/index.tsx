import type { ReactNode } from "react";
import type { BrainUsageToday, SystemResponse } from "@jarvis/shared";
import { useBridge } from "../../app/bridge";
import { Icon } from "../../app/icons";
import History from "./History";
import Latency from "./Latency";
import {
  agoFrom,
  bytes,
  duration,
  inFrom,
  meterLevel,
  percentOf,
  sparkline,
  tokens,
  workerShare,
} from "./model";
import Projects from "./Projects";
import { chartSeries } from "./usage";
import { useSystem } from "./useSystem";
import "./system.css";
import "./usage.css";

const SPARK_W = 300;
const SPARK_H = 44;

function Panel({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <section className={`system-section system-${id}`} aria-labelledby={`system-${id}`}>
      <h2 id={`system-${id}`} className="system-label">
        {label}
      </h2>
      {children}
    </section>
  );
}

interface MeterProps {
  label: string;
  /** 0..100; null shows an empty track and "—". */
  percent: number | null;
  value: string;
  detail?: string;
}

/** A labelled bar: accent below 75%, amber from 75%, red from 90%. */
function Meter({ label, percent, value, detail }: MeterProps) {
  const level = percent === null ? "none" : meterLevel(percent);
  return (
    <div className="system-meter" data-level={level}>
      <div className="system-meter-head">
        <span className="system-meter-label">{label}</span>
        <span className="system-meter-value">{value}</span>
      </div>
      <div
        className="system-track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.round(percent)}
        aria-valuetext={percent === null ? "unknown" : `${Math.round(percent)}%`}
      >
        <div className="system-fill" style={{ width: `${percent ?? 0}%` }} />
      </div>
      {detail && <div className="system-meter-detail">{detail}</div>}
    </div>
  );
}

function Plan({ r }: { r: SystemResponse }) {
  const { plan, checkedAt } = r;
  const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n)}%`);
  const resets = (at?: string) => {
    const when = inFrom(at, checkedAt);
    return when ? `resets ${when}` : undefined;
  };
  return (
    <Panel id="plan" label="CLAUDE PLAN">
      <Meter
        label="5-hour window"
        percent={plan.fiveHour}
        value={pct(plan.fiveHour)}
        detail={resets(plan.resetsAt)}
      />
      <Meter
        label="Weekly"
        percent={plan.weekly}
        value={pct(plan.weekly)}
        detail={resets(plan.weeklyResetsAt)}
      />
      {!plan.available && (
        <p className="system-note">{plan.reason ?? "This login doesn't report plan limits."}</p>
      )}
    </Panel>
  );
}

function Fires({ r }: { r: SystemResponse }) {
  const { fires, checkedAt } = r;
  const next = inFrom(fires.nextFreeAt, checkedAt);
  const detail = !fires.configured
    ? "No routine set up (ROUTINE_ID)"
    : fires.used >= fires.limit && next
      ? `full · next slot frees ${next}`
      : next
        ? `this hour · oldest frees ${next}`
        : "this hour";
  return (
    <Panel id="fires" label="ROUTINE FIRES">
      <Meter
        label="New cloud jobs"
        percent={percentOf(fires.used, fires.limit)}
        value={`${fires.used} / ${fires.limit}`}
        detail={detail}
      />
    </Panel>
  );
}

function Container({ r }: { r: SystemResponse }) {
  const c = r.container;
  const memPct = percentOf(c.memUsed, c.memLimit);
  const spark = sparkline(
    c.memHistory.map((h) => h.memUsed),
    SPARK_W,
    SPARK_H,
  );
  return (
    <Panel id="container" label="CONTAINER">
      <Meter
        label="Memory"
        percent={memPct}
        value={c.memLimit ? `${bytes(c.memUsed)} of ${bytes(c.memLimit)}` : bytes(c.memUsed)}
        detail={`${c.memLimit ? "" : "no limit set · "}peak ${bytes(c.memPeak)}`}
      />
      <figure className="system-spark">
        {spark ? (
          <svg
            viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Memory over the last hour: ${bytes(spark.min)} to ${bytes(spark.max)}`}
          >
            <polyline className="system-spark-line" points={spark.points} vectorEffect="non-scaling-stroke" />
          </svg>
        ) : (
          <div className="system-spark-empty">History builds up while JARVIS runs.</div>
        )}
        <figcaption>
          <span>1 h ago</span>
          {spark && (
            <span>
              {bytes(spark.min)} – {bytes(spark.max)}
            </span>
          )}
          <span>now</span>
        </figcaption>
      </figure>
      <dl className="system-stats">
        <div>
          <dt>CPU</dt>
          <dd>{c.cpu === null ? "—" : `${c.cpu}%`}</dd>
        </div>
        <div>
          <dt>Claude processes</dt>
          <dd>{c.claudeProcs}</dd>
        </div>
        <div>
          <dt>Up</dt>
          <dd>{duration(c.uptimeSeconds * 1000)}</dd>
        </div>
      </dl>
    </Panel>
  );
}

function UsageRow({ who, u, share }: { who: string; u: BrainUsageToday; share: number }) {
  return (
    <tr>
      <th scope="row">{who}</th>
      <td>{tokens(u.tokens)}</td>
      <td>{u.replies}</td>
      <td>{u.turns}</td>
      <td>{duration(u.ms)}</td>
      <td>{Math.round(share)}%</td>
    </tr>
  );
}

function Brain({ r }: { r: SystemResponse }) {
  const { chatToday, workerToday } = r.brain;
  const worker = workerShare(chatToday, workerToday);
  const idle = !chatToday.tokens && !workerToday.tokens;
  return (
    <Panel id="brain" label="BRAIN TODAY · WORKER VS CHAT">
      <div
        className="system-split"
        role="img"
        aria-label={
          idle
            ? "No brain use yet today"
            : `Worker ${Math.round(worker)}% of today's tokens, chat ${Math.round(100 - worker)}%`
        }
        data-idle={idle || undefined}
      >
        <div className="system-split-chat" style={{ flexGrow: idle ? 1 : 100 - worker }} />
        <div className="system-split-worker" style={{ flexGrow: idle ? 0 : worker }} />
      </div>
      <table className="system-table">
        <thead>
          <tr>
            <th scope="col">
              <span className="system-sr-only">Brain</span>
            </th>
            <th scope="col">Tokens</th>
            <th scope="col">Replies</th>
            <th scope="col">Turns</th>
            <th scope="col">Time</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          <UsageRow who="Chat" u={chatToday} share={idle ? 0 : 100 - worker} />
          <UsageRow who="Worker" u={workerToday} share={worker} />
        </tbody>
      </table>
    </Panel>
  );
}

function Devices({ r }: { r: SystemResponse }) {
  return (
    <Panel id="devices" label="PAIRED MACS">
      {r.devices.length ? (
        <ul className="system-device-list">
          {r.devices.map((d) => (
            <li key={d.id}>
              <span className="system-device-name">{d.name}</span>
              <span className="system-device-seen">seen {agoFrom(d.lastSeen, r.checkedAt)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="system-note">No Macs paired.</p>
      )}
    </Panel>
  );
}

const clock = (at: string) =>
  new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Cloud sessions per project and per day (JD-55); nothing on a server older than that. */
function Usage({ r }: { r: SystemResponse }) {
  if (!r.projects || !r.history) return null;
  const series = chartSeries(r.projects, r.history);
  return (
    <>
      <History history={r.history} series={series} />
      <Projects projects={r.projects} series={series} />
    </>
  );
}

/**
 * The System window (JD-30): plan usage, routine fires, container health, voice latency (JD-48),
 * the brains' use today, and cloud sessions per project with 30 days of history (JD-55).
 */
export default function System() {
  const { response, error, loading, reload } = useSystem(useBridge());
  return (
    <div className="system" aria-busy={loading}>
      <div className="system-toolbar">
        <p className="system-when" role="status">
          {response
            ? `Checked ${clock(response.checkedAt)} · refreshes every 15 s`
            : loading
              ? "Loading…"
              : ""}
        </p>
        <button
          type="button"
          className="system-refresh"
          aria-label="Refresh now"
          onClick={reload}
          disabled={loading}
        >
          <Icon name="refresh" size={15} />
        </button>
      </div>
      {error && (
        <p className="system-error" role="alert">
          {response ? "Couldn't refresh; showing the last numbers. " : "Couldn't reach JARVIS. "}
          <span className="system-error-detail">{error}</span>
        </p>
      )}
      {response && (
        <div className="system-grid">
          <Plan r={response} />
          <Fires r={response} />
          <Container r={response} />
          <Latency summary={response.voiceLatency} />
          <Brain r={response} />
          <Usage r={response} />
          <Devices r={response} />
        </div>
      )}
    </div>
  );
}
