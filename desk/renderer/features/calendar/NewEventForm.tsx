import { useEffect, useRef, useState, type FormEvent } from "react";
import { newEventText, type NewEventDraft } from "./calendarMath";

const DURATIONS = [15, 30, 45, 60, 90, 120];

interface NewEventFormProps {
  /** YYYY-MM-DD and HH:MM the form starts on. */
  day: string;
  start: string;
  onSend(text: string): void;
  onCancel(): void;
}

/** New event: a small form whose answer is a sentence for JARVIS, who creates the event. */
export function NewEventForm({ day, start, onSend, onCancel }: NewEventFormProps) {
  const [draft, setDraft] = useState<NewEventDraft>({ title: "", day, start, minutes: 30, guests: "" });
  const title = useRef<HTMLInputElement>(null);
  useEffect(() => title.current?.focus(), []);
  const set = <K extends keyof NewEventDraft>(key: K, value: NewEventDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const ready = draft.title.trim() !== "" && draft.day !== "" && draft.start !== "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) onSend(newEventText(draft));
  };

  return (
    <form
      className="cal-new"
      role="dialog"
      aria-label="New event"
      onSubmit={submit}
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
    >
      <label className="cal-field cal-field-wide">
        <span>Title</span>
        <input
          ref={title}
          value={draft.title}
          onChange={(e) => set("title", e.target.value)}
          placeholder="Booking call"
          required
        />
      </label>
      <label className="cal-field">
        <span>Day</span>
        <input type="date" value={draft.day} onChange={(e) => set("day", e.target.value)} required />
      </label>
      <label className="cal-field">
        <span>Start</span>
        <input type="time" value={draft.start} onChange={(e) => set("start", e.target.value)} required />
      </label>
      <label className="cal-field">
        <span>Duration</span>
        <select value={draft.minutes} onChange={(e) => set("minutes", Number(e.target.value))}>
          {DURATIONS.map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} min` : `${m / 60} h`}
            </option>
          ))}
        </select>
      </label>
      <label className="cal-field cal-field-wide">
        <span>Guests</span>
        <input value={draft.guests} onChange={(e) => set("guests", e.target.value)} placeholder="Sam, Jo" />
      </label>
      <p className="cal-new-preview" aria-live="polite">
        {ready ? newEventText(draft) : "JARVIS creates it in Google Calendar."}
      </p>
      <div className="cal-new-actions">
        <button type="button" className="cal-button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="cal-button cal-button-solid" disabled={!ready}>
          Ask JARVIS
        </button>
      </div>
    </form>
  );
}
