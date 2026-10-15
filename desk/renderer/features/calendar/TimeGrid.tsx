import { useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import type { CalendarEvent } from "@jarvis/shared";
import {
  addDays,
  allDayOn,
  boxOf,
  gridHours,
  HOUR_PX,
  layoutDay,
  nowOffset,
  sameDay,
  segmentsOn,
  shortDay,
  timeSpan,
  weekdayName,
  type VisibleRange,
} from "./calendarMath";

interface TimeGridProps {
  visible: VisibleRange;
  events: CalendarEvent[];
  now: Date;
  selectedId?: string;
  onSelect(event: CalendarEvent): void;
  onOpenDay(day: Date): void;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The day and week views: day headers, an all-day row, and the scrolling hour grid (opens at 08:00). */
export function TimeGrid({ visible, events, now, selectedId, onSelect, onOpenDay }: TimeGridProps) {
  const days = useMemo(
    () => Array.from({ length: visible.days }, (_, i) => addDays(visible.start, i)),
    [visible],
  );
  const columns = useMemo(
    () =>
      days.map((day) => ({ day, allDay: allDayOn(events, day), placed: layoutDay(segmentsOn(events, day)) })),
    [days, events],
  );
  const hours = gridHours(columns.flatMap((c) => c.placed));
  const scroller = useRef<HTMLDivElement>(null);
  const range = `${visible.start.getTime()}:${visible.days}`;

  // Open on the working day; earlier and later events are a scroll away.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = hours.scrollTop;
  }, [range, hours.scrollTop]);

  const hasAllDay = columns.some((c) => c.allDay.length > 0);
  const style = { "--days": visible.days, "--hour": `${HOUR_PX}px` } as CSSProperties;
  return (
    <div className="cal-time" style={style} data-view-days={visible.days}>
      <div className="cal-time-head">
        <span />
        {days.map((day) => {
          const today = sameDay(day, now);
          return (
            <button
              type="button"
              key={day.getTime()}
              className={`cal-day-head${today ? " is-today" : ""}`}
              aria-label={`Open ${shortDay(day)} in day view`}
              onClick={() => onOpenDay(day)}
            >
              <span className="cal-day-name">{weekdayName(day).toUpperCase()}</span>
              <span className="cal-day-num">{day.getDate()}</span>
            </button>
          );
        })}
      </div>
      {hasAllDay && (
        <div className="cal-allday">
          <span className="cal-allday-label">ALL DAY</span>
          {columns.map(({ day, allDay }) => (
            <div key={day.getTime()} className="cal-allday-cell">
              {allDay.map((e) => (
                <EventChip key={e.id} event={e} selected={e.id === selectedId} onSelect={onSelect} />
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="cal-scroll" ref={scroller} data-testid="calendar-scroll">
        <div className="cal-grid" style={{ height: (hours.to - hours.from) * HOUR_PX }}>
          <div className="cal-hours" aria-hidden="true">
            {Array.from({ length: hours.to - hours.from }, (_, i) => (
              <span key={i} style={{ top: i * HOUR_PX }}>
                {pad(hours.from + i)}:00
              </span>
            ))}
          </div>
          {columns.map(({ day, placed }) => {
            const today = sameDay(day, now);
            return (
              <div key={day.getTime()} className={`cal-col${today ? " is-today" : ""}`}>
                {placed.map((p) => {
                  const box = boxOf(p, hours.from);
                  return (
                    <button
                      type="button"
                      key={`${p.event.id}-${p.startMin}`}
                      className={`cal-event kind-${p.event.kind}${p.event.id === selectedId ? " is-selected" : ""}${box.height < 34 ? " is-short" : ""}`}
                      style={{
                        top: box.top,
                        height: box.height,
                        left: `calc(${box.left}% + 3px)`,
                        width: `calc(${box.width}% - 6px)`,
                      }}
                      aria-label={`${p.event.title}, ${shortDay(day)} ${timeSpan(p.event)}`}
                      aria-pressed={p.event.id === selectedId}
                      data-event-id={p.event.id}
                      onClick={() => onSelect(p.event)}
                    >
                      <span className="cal-event-title">{p.event.title}</span>
                      <span className="cal-event-time">{timeSpan(p.event)}</span>
                    </button>
                  );
                })}
                {today && (
                  <div
                    className="cal-now"
                    data-testid="now-line"
                    style={{ top: nowOffset(now, hours.from) }}
                    aria-hidden="true"
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** An event as a one-line chip (all-day row, month view). */
export function EventChip({
  event,
  selected,
  onSelect,
}: {
  event: CalendarEvent;
  selected: boolean;
  onSelect(event: CalendarEvent): void;
}) {
  const time = event.allDay ? "" : timeSpan(event).split(" – ")[0];
  return (
    <button
      type="button"
      className={`cal-chip kind-${event.kind}${selected ? " is-selected" : ""}`}
      aria-label={`${event.title}, ${timeSpan(event)}`}
      aria-pressed={selected}
      data-event-id={event.id}
      onClick={() => onSelect(event)}
    >
      {time && <span className="cal-chip-time">{time}</span>}
      <span className="cal-chip-title">{event.title}</span>
    </button>
  );
}
