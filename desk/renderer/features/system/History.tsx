import { useEffect, useRef, useState } from "react";
import type { UsageDay } from "@jarvis/shared";
import { tokens } from "./model";
import {
  moneyAxis,
  dayLabel,
  dayLong,
  money,
  niceScale,
  stackDays,
  type BarDay,
  type Metric,
  type Series,
} from "./usage";

const HEIGHT = 190;
const PAD = { top: 10, right: 4, bottom: 22, left: 48 };
/** Until the figure is measured (and in tests, where nothing has a size). */
const FALLBACK_WIDTH = 720;
/** Gap between stacked segments, in the surface colour. */
const GAP = 2;

const format = (metric: Metric, n: number) => (metric === "cost" ? money(n) : tokens(Math.round(n)));
const axis = (metric: Metric, n: number) => (metric === "cost" ? moneyAxis(n) : tokens(Math.round(n)));

/** The figure's width, following the window as it resizes. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);
  return { ref, width };
}

/** A bar's top segment: rounded top corners only, so the stack sits flat on the baseline. */
function topPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

const describe = (d: BarDay, metric: Metric) =>
  `${dayLong(d.day)}: ${format(metric, d.total)}` +
  (d.segments.length ? ` (${d.segments.map((s) => `${s.key} ${format(metric, s.value)}`).join(", ")})` : "");

interface Props {
  history: UsageDay[];
  series: Series[];
}

/**
 * The last 30 days of cloud session use (JD-55): one stacked bar per day, a colour per project, cost
 * or tokens. Hovering or focusing a day shows its numbers.
 */
export default function History({ history, series }: Props) {
  const [metric, setMetric] = useState<Metric>("cost");
  const [active, setActive] = useState<number>();
  const { ref, width } = useWidth();
  const days = stackDays(history, series, metric);
  const max = Math.max(0, ...days.map((d) => d.total));
  const { top, ticks } = niceScale(max);
  const sum = days.reduce((n, d) => n + d.total, 0);
  const slot = new Map(series.map((s) => [s.key, s.slot]));

  const plotW = Math.max(60, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = plotW / Math.max(1, days.length);
  const barW = Math.max(2, band - Math.min(6, band * 0.3));
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const shown = active === undefined ? undefined : days[active];
  const tipLeft =
    active === undefined ? 0 : Math.min(Math.max(PAD.left + band * (active + 0.5), 90), width - 90);

  return (
    <section className="system-section system-history" aria-labelledby="system-history">
      <div className="usage-head">
        <h2 id="system-history" className="system-label">
          LAST 30 DAYS · {metric === "cost" ? "COST" : "TOKENS"} PER DAY
        </h2>
        <span className="usage-sum">{format(metric, sum)} in 30 days</span>
        <div className="usage-toggle" role="group" aria-label="Chart shows">
          {(["cost", "tokens"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={metric === m} onClick={() => setMetric(m)}>
              {m === "cost" ? "Cost" : "Tokens"}
            </button>
          ))}
        </div>
      </div>
      {series.length > 0 && (
        <ul className="usage-legend" aria-label="Projects">
          {series.map((s) => (
            <li key={s.key} data-slot={s.slot}>
              <span className="usage-dot" aria-hidden="true" />
              {s.key}
            </li>
          ))}
        </ul>
      )}
      <div className="usage-figure" ref={ref} onMouseLeave={() => setActive(undefined)}>
        {max === 0 && (
          <p className="usage-empty">
            No cloud session use recorded yet. JARVIS snapshots every session once an hour.
          </p>
        )}
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="group"
          aria-label={`${metric === "cost" ? "Cost" : "Tokens"} per day over the last 30 days, by project`}
        >
          {/* No scale to show before anything's been used: just the baseline under the note. */}
          {(max > 0 ? ticks : []).map((t) => (
            <g key={t} className="usage-grid">
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
              <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                {axis(metric, t)}
              </text>
            </g>
          ))}
          {days.map((d, i) => {
            const x = PAD.left + band * i + (band - barW) / 2;
            let base = 0;
            return (
              <g
                key={d.day}
                className="usage-bar"
                data-dim={active !== undefined && active !== i ? "" : undefined}
              >
                {d.segments.map((s, j) => {
                  const y0 = y(base);
                  base += s.value;
                  const y1 = y(base);
                  // Each segment above the first leaves a gap below it.
                  const h = Math.max(0, y0 - y1 - (j > 0 ? GAP : 0));
                  const last = j === d.segments.length - 1;
                  return last ? (
                    <path key={s.key} d={topPath(x, y1, barW, h)} data-slot={slot.get(s.key)} />
                  ) : (
                    <rect key={s.key} x={x} y={y1} width={barW} height={h} data-slot={slot.get(s.key)} />
                  );
                })}
              </g>
            );
          })}
          <line className="usage-baseline" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />
          {days.map((d, i) =>
            (days.length - 1 - i) % 7 === 0 ? (
              <text
                key={d.day}
                className="usage-x"
                x={PAD.left + band * (i + 0.5)}
                y={HEIGHT - 6}
                textAnchor="middle"
              >
                {dayLabel(d.day)}
              </text>
            ) : null,
          )}
          {days.map((d, i) => (
            <rect
              key={d.day}
              className="usage-hit"
              x={PAD.left + band * i}
              y={PAD.top}
              width={band}
              height={plotH}
              tabIndex={0}
              role="img"
              aria-label={describe(d, metric)}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(undefined)}
            />
          ))}
        </svg>
        {shown && (
          <div className="usage-tip" style={{ left: tipLeft }} role="status">
            <div className="usage-tip-head">
              <span>{dayLong(shown.day)}</span>
              <strong>{format(metric, shown.total)}</strong>
            </div>
            {shown.segments.length ? (
              <ul>
                {[...shown.segments].reverse().map((s) => (
                  <li key={s.key} data-slot={slot.get(s.key)}>
                    <span className="usage-dot" aria-hidden="true" />
                    <span className="usage-tip-name">{s.key}</span>
                    <span className="usage-tip-value">{format(metric, s.value)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Nothing used.</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
