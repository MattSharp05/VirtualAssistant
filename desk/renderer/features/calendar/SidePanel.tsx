import type { CalendarChange, CalendarEvent, FreeSlot } from "@jarvis/shared";
import {
  changeTime,
  describeChange,
  latestUndoable,
  notionLink,
  parseTime,
  shortDay,
  slotLabel,
  timeSpan,
} from "./calendarMath";

/** Free slots listed before the rest are left out. */
const FREE_SHOWN = 5;
const CHANGES_SHOWN = 3;

interface SidePanelProps {
  selected?: CalendarEvent;
  free?: FreeSlot[];
  changes?: CalendarChange[];
  now: Date;
  /** The change Undo was pressed for, until the next calendar.changed. */
  undoAsked?: string;
  onPrep(event: CalendarEvent): void;
  onUndo(change: CalendarChange): void;
}

/** The right-hand panel: the selected event, FREE THIS WEEK and CHANGED BY JARVIS (with Undo). */
export function SidePanel({ selected, free, changes, now, undoAsked, onPrep, onUndo }: SidePanelProps) {
  const undoable = changes && latestUndoable(changes);
  return (
    <aside className="cal-side" aria-label="Details">
      <section className="cal-side-section" aria-label="Selected event">
        <h2 className="cal-label">SELECTED</h2>
        {selected ? (
          <EventDetails event={selected} onPrep={onPrep} />
        ) : (
          <p className="cal-muted">Pick an event to see its details.</p>
        )}
      </section>

      <section className="cal-side-section" aria-label="Free this week">
        <h2 className="cal-label">FREE THIS WEEK</h2>
        {!free ? (
          <div className="cal-skeleton-lines" aria-busy="true">
            <span />
            <span />
          </div>
        ) : free.length === 0 ? (
          <p className="cal-muted">No free slots of 30 min or more.</p>
        ) : (
          <ul className="cal-free">
            {free.slice(0, FREE_SHOWN).map((s) => (
              <li key={s.start}>{slotLabel(s)}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="cal-side-section cal-changes" aria-label="Changed by JARVIS">
        <h2 className="cal-label">CHANGED BY JARVIS</h2>
        {changes && changes.length === 0 && <p className="cal-muted">No changes yet.</p>}
        {changes?.slice(0, CHANGES_SHOWN).map((c) => {
          const latest = c.id === undoable?.id;
          return (
            <div
              key={c.id}
              className={`cal-change${latest ? " is-latest" : ""}${c.undoneAt ? " is-undone" : ""}`}
              data-change-id={c.id}
            >
              <span className="cal-change-at">
                {changeTime(c, now)}
                {c.undoneAt ? " · undone" : ""}
              </span>
              <span className="cal-change-text">{describeChange(c)}</span>
              {latest && (
                <button
                  type="button"
                  className="cal-undo"
                  aria-label={`Undo: ${describeChange(c)}`}
                  disabled={undoAsked === c.id}
                  onClick={() => onUndo(c)}
                >
                  {undoAsked === c.id ? "Undoing…" : "Undo"}
                </button>
              )}
            </div>
          );
        })}
      </section>
    </aside>
  );
}

function EventDetails({ event, onPrep }: { event: CalendarEvent; onPrep(event: CalendarEvent): void }) {
  const notion = notionLink(event.description);
  // The Notion link is the button below, so the text leaves it out.
  const description = (notion ? event.description!.replace(notion, "") : event.description)?.trim();
  const people = event.attendees?.filter((a) => a.response !== "declined").map((a) => a.name || a.email);
  return (
    <div className="cal-details">
      <p className="cal-details-title">{event.title}</p>
      <p className="cal-details-meta">
        <span>
          {shortDay(parseTime(event.start))} · {timeSpan(event)}
        </span>
        {event.location && <span>{event.location}</span>}
        {people && people.length > 0 && <span>With {people.join(", ")}</span>}
        {event.link && (
          <a href={event.link} target="_blank" rel="noreferrer">
            {/meet\.google|zoom\.us|teams\.microsoft/.test(event.link) ? "Join the call" : "Open the event"}
          </a>
        )}
      </p>
      {description && <p className="cal-details-desc">{description}</p>}
      <button type="button" className="cal-button cal-button-accent" onClick={() => onPrep(event)}>
        Prep me for this
      </button>
      {notion && (
        <a className="cal-button" href={notion} target="_blank" rel="noreferrer">
          Open in Notion
        </a>
      )}
    </div>
  );
}
