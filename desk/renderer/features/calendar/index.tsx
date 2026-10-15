import { useEffect, useMemo, useState } from "react";
import type { CalendarChange, CalendarEvent } from "@jarvis/shared";
import { useBridgeChoice } from "../../app/bridge";
import {
  addDays,
  googleCalendarUrl,
  rangeLabel,
  shift,
  startOfDay,
  visibleRange,
  ymd,
  type CalendarView,
} from "./calendarMath";
import { MonthGrid } from "./MonthGrid";
import { NewEventForm } from "./NewEventForm";
import { SidePanel } from "./SidePanel";
import { TimeGrid } from "./TimeGrid";
import { useCalendarData } from "./useCalendarData";
import "./calendar.css";

const VIEWS: { id: CalendarView; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

const GLYPHS = {
  prev: "M15 6l-6 6 6 6",
  next: "M9 6l6 6-6 6",
  plus: "M12 5v14M5 12h14",
  external: "M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
};

function Glyph({ d }: { d: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

/** Now, ticking each half minute; the preview's scenario can pin it (ui.now). */
function useNow(fixed?: string): Date {
  const [now, setNow] = useState(() => (fixed ? new Date(fixed) : new Date()));
  useEffect(() => {
    if (fixed) return;
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, [fixed]);
  return now;
}

/** The Calendar window (mockup 10): day/week/month, details, free slots, New event, change log + undo. */
export default function Calendar() {
  const { bridge, ui } = useBridgeChoice();
  const now = useNow(ui?.now);
  const [view, setView] = useState<CalendarView>("week");
  const [anchor, setAnchor] = useState(() => startOfDay(now));
  const [selected, setSelected] = useState<CalendarEvent>();
  const [composing, setComposing] = useState(false);
  const [status, setStatus] = useState<string>();
  const [undoAsked, setUndoAsked] = useState<{ id: string; at: number }>();

  const visible = useMemo(() => visibleRange(view, anchor), [view, anchor]);
  const data = useCalendarData(bridge, visible);
  const events = useMemo(() => data.range?.events ?? [], [data.range]);

  const ask = (text: string, note: string) => {
    setStatus(note);
    bridge
      .chat(text, "desk-typed")
      .catch((err: unknown) => setStatus(`Couldn't reach JARVIS: ${String(err)}`));
  };
  const openDay = (day: Date) => {
    setView("day");
    setAnchor(startOfDay(day));
  };
  const prep = (event: CalendarEvent) => {
    ask(`prep me for ${event.title}`, `Asked JARVIS to prep you for “${event.title}”`);
    bridge.openWindow("chat");
  };
  const undo = (change: CalendarChange) => {
    setUndoAsked({ id: change.id, at: data.changeCount });
    ask("undo that", "Asked JARVIS to undo the last change");
  };
  const send = (text: string) => {
    setComposing(false);
    ask(text, `Asked JARVIS: ${text}`);
  };

  // New event starts on the day in view (today in a week or month that has it), at the next hour.
  const today = startOfDay(now);
  const todayInView = today >= visible.start && today < addDays(visible.start, visible.days);
  const firstDay = view !== "day" && todayInView ? today : anchor;
  const nextHour = String(Math.min(Math.max(now.getHours() + 1, 9), 17)).padStart(2, "0");

  return (
    <div className="cal">
      <div className="cal-toolbar" role="toolbar" aria-label="Calendar">
        <div className="cal-nav">
          <button
            type="button"
            className="cal-icon"
            aria-label={`Previous ${view}`}
            onClick={() => setAnchor((a) => shift(view, a, -1))}
          >
            <Glyph d={GLYPHS.prev} />
          </button>
          <button type="button" className="cal-today" onClick={() => setAnchor(startOfDay(now))}>
            Today
          </button>
          <button
            type="button"
            className="cal-icon"
            aria-label={`Next ${view}`}
            onClick={() => setAnchor((a) => shift(view, a, 1))}
          >
            <Glyph d={GLYPHS.next} />
          </button>
        </div>
        <h2 className="cal-range" aria-live="polite">
          {rangeLabel(view, anchor)}
        </h2>
        {data.range && data.range.stale && <span className="cal-stale">Last good copy</span>}
        <div className="cal-toolbar-end">
          <button
            type="button"
            className="cal-new-button"
            aria-expanded={composing}
            onClick={() => setComposing((c) => !c)}
          >
            <Glyph d={GLYPHS.plus} />
            New event
          </button>
          <div className="cal-views" role="group" aria-label="View">
            {VIEWS.map((v) => (
              <button
                type="button"
                key={v.id}
                aria-pressed={view === v.id}
                className={view === v.id ? "is-active" : ""}
                onClick={() => setView(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>
          <a
            className="cal-icon"
            href={googleCalendarUrl(view, anchor)}
            target="_blank"
            rel="noreferrer"
            aria-label="Open in Google Calendar"
            title="Open in Google Calendar"
          >
            <Glyph d={GLYPHS.external} />
          </a>
        </div>
        {composing && (
          <NewEventForm
            day={ymd(firstDay)}
            start={`${nextHour}:00`}
            onSend={send}
            onCancel={() => setComposing(false)}
          />
        )}
      </div>

      {status && (
        <p className="cal-status" role="status">
          {status}
        </p>
      )}

      <div className="cal-main">
        <section className="cal-view" aria-label={`${view} view`} aria-busy={!data.range && !data.error}>
          {data.error && !data.range ? (
            <div className="cal-error" role="alert">
              <p>Couldn't load the calendar: {data.error}</p>
              <button type="button" className="cal-button" onClick={data.retry}>
                Try again
              </button>
            </div>
          ) : !data.range ? (
            <Skeleton view={view} />
          ) : view === "month" ? (
            <MonthGrid
              anchor={anchor}
              events={events}
              now={now}
              selectedId={selected?.id}
              onSelect={setSelected}
              onOpenDay={openDay}
            />
          ) : (
            <TimeGrid
              visible={visible}
              events={events}
              now={now}
              selectedId={selected?.id}
              onSelect={setSelected}
              onOpenDay={openDay}
            />
          )}
        </section>
        <SidePanel
          selected={selected}
          free={data.free}
          changes={data.changes}
          now={now}
          undoAsked={undoAsked && undoAsked.at === data.changeCount ? undoAsked.id : undefined}
          onPrep={prep}
          onUndo={undo}
        />
      </div>
    </div>
  );
}

/** While the worker fetches the range: the grid's shape with shimmering blocks. */
function Skeleton({ view }: { view: CalendarView }) {
  const columns = view === "day" ? 1 : 7;
  return (
    <div
      className="cal-skeleton"
      data-testid="calendar-skeleton"
      style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
    >
      {Array.from({ length: columns }, (_, i) => (
        <div key={i} className="cal-skeleton-col">
          <span style={{ marginTop: 24 + ((i * 37) % 90), height: 44 }} />
          <span style={{ marginTop: 30 + ((i * 53) % 70), height: 70 }} />
          {i % 2 === 0 && <span style={{ marginTop: 40, height: 36 }} />}
        </div>
      ))}
      <p className="cal-skeleton-note">Fetching your calendar…</p>
    </div>
  );
}
