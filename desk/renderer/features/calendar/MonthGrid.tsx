import type { CalendarEvent } from "@jarvis/shared";
import { monthWeeks, sameDay, shortDay } from "./calendarMath";
import { EventChip } from "./TimeGrid";

/** Chips a month cell shows before "+n more". */
export const MONTH_CHIPS = 3;
const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

interface MonthGridProps {
  anchor: Date;
  events: CalendarEvent[];
  now: Date;
  selectedId?: string;
  onSelect(event: CalendarEvent): void;
  onOpenDay(day: Date): void;
}

/** The month view: whole weeks, events as chips, "+n more" opens that day. */
export function MonthGrid({ anchor, events, now, selectedId, onSelect, onOpenDay }: MonthGridProps) {
  const weeks = monthWeeks(anchor, events);
  return (
    <div className="cal-month" style={{ gridTemplateRows: `auto repeat(${weeks.length}, 1fr)` }}>
      <div className="cal-month-head">
        {WEEKDAYS.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      {weeks.map((week) => (
        <div key={week[0]!.date.getTime()} className="cal-month-week">
          {week.map(({ date, inMonth, events: dayEvents }) => {
            const more = dayEvents.length - MONTH_CHIPS;
            return (
              <div
                key={date.getTime()}
                className={`cal-month-cell${inMonth ? "" : " is-outside"}${sameDay(date, now) ? " is-today" : ""}`}
              >
                <button
                  type="button"
                  className="cal-month-num"
                  aria-label={`Open ${shortDay(date)} in day view`}
                  onClick={() => onOpenDay(date)}
                >
                  {date.getDate()}
                </button>
                {dayEvents.slice(0, MONTH_CHIPS).map((e) => (
                  <EventChip key={e.id} event={e} selected={e.id === selectedId} onSelect={onSelect} />
                ))}
                {more > 0 && (
                  <button
                    type="button"
                    className="cal-month-more"
                    aria-label={`${more} more on ${shortDay(date)}`}
                    onClick={() => onOpenDay(date)}
                  >
                    +{more} more
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
