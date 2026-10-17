// What the cards beside the orb show (JD-27, mockups 1–2): cards JARVIS put up (card.show), notices
// (session alerts, batch done, reminders) and timer countdowns. Plain state + a reducer, so the rules
// (newest on top, max 3, Do Not Disturb queue) are tested without React.
import type { DeskEvent, NoticeAction, NoticeLevel, ScreenCard } from "@jarvis/shared";

/** At most this many cards are on screen; the rest wait their turn. */
export const MAX_VISIBLE = 3;
/** Cards leave by themselves after a minute, unless the pointer is on them (running timers stay). */
export const AUTO_DISMISS_MS = 60_000;
/** The scheduler sends a "⏰ Timer done" notice right after timer.done; the timer's card already says it. */
const TIMER_NOTICE_WINDOW_MS = 5_000;

export type OverlayCard =
  | { key: string; type: "screen"; card: ScreenCard }
  | {
      key: string;
      type: "notice";
      level: NoticeLevel;
      title: string;
      body?: string;
      actions: NoticeAction[];
    }
  | { key: string; type: "timer"; id: string; endsAt: string; label?: string; done: boolean };

export interface CardsState {
  /** Newest first. */
  cards: OverlayCard[];
  /** Notices held back while Do Not Disturb is on (the orb's badge counts them), oldest first. */
  queued: OverlayCard[];
  /** When the last timer.done arrived (ms), to drop the scheduler's duplicate notice. */
  timerDoneAt?: number;
  seq: number;
}

export const initialCards: CardsState = { cards: [], queued: [], seq: 0 };

export type CardsAction =
  | { type: "event"; event: DeskEvent; dnd: boolean; now: number }
  | { type: "dismiss"; key: string }
  /** Show everything Do Not Disturb held back (badge clicked, or DND turned off). */
  | { type: "release" };

/** Which window a card's Pop out opens; kinds without one have no Pop out. */
export function popOutWindow(card: ScreenCard): string | undefined {
  return card.kind === "agenda" ? "today" : card.kind === "session" ? "sessions" : undefined;
}

/**
 * A notice's buttons: the event's own, else Open for its link; anything to act on gets a Later. A
 * button may call the Desk API instead (`request`: a browser task's Approve / Stop, JD-60).
 */
export function noticeActions(actions: NoticeAction[] | undefined, link: string | undefined): NoticeAction[] {
  const list = actions?.length ? actions : link ? [{ label: "Open", url: link }] : [];
  const hasLater = list.some((a) => !a.window && !a.url);
  return list.length && !hasLater ? [...list, { label: "Later" }] : list;
}

/** Reads a Do Not Disturb value: a boolean, or { on, until? } like the server's DndState. */
export function dndOn(value: unknown, now = Date.now()): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object" || !("on" in value)) return undefined;
  const { on, until } = value as { on: unknown; until?: unknown };
  if (on !== true) return false;
  return typeof until === "string" && Date.parse(until) <= now ? false : true;
}

export function visibleCards(state: CardsState): { shown: OverlayCard[]; more: number } {
  return { shown: state.cards.slice(0, MAX_VISIBLE), more: Math.max(0, state.cards.length - MAX_VISIBLE) };
}

export function cardsReducer(state: CardsState, action: CardsAction): CardsState {
  if (action.type === "dismiss") {
    return {
      ...state,
      cards: state.cards.filter((c) => c.key !== action.key),
      queued: state.queued.filter((c) => c.key !== action.key),
    };
  }
  if (action.type === "release") {
    if (!state.queued.length) return state;
    return { ...state, cards: [...[...state.queued].reverse(), ...state.cards], queued: [] };
  }
  const { event, dnd, now } = action;
  // The reducer runs while React renders: an event without what its card needs is skipped, never
  // allowed to throw and take the overlay down with it (JD-63).
  if (!isShowable(event)) return state;
  const seq = state.seq + 1;

  switch (event.type) {
    case "card.show": {
      // The same card again replaces the old one (and comes back to the top).
      const cards = state.cards.filter((c) => !(c.type === "screen" && c.card.id === event.card.id));
      return {
        ...state,
        seq,
        cards: [{ key: `card-${event.card.id}`, type: "screen", card: event.card }, ...cards],
      };
    }
    case "card.dismiss": {
      // A card JARVIS put up, or a notice that carried this id (JD-60's questions).
      const gone = cardsReducer(state, { type: "dismiss", key: `card-${event.id}` });
      return cardsReducer(gone, { type: "dismiss", key: `notice-${event.id}` });
    }
    case "notice": {
      if (
        event.title.startsWith("⏰") &&
        state.timerDoneAt &&
        now - state.timerDoneAt < TIMER_NOTICE_WINDOW_MS
      )
        return state;
      const card: OverlayCard = {
        key: `notice-${event.id ?? seq}`,
        type: "notice",
        level: event.level,
        title: event.title,
        ...(event.body ? { body: event.body } : {}),
        actions: noticeActions(event.actions, event.link),
      };
      // The same id again (a browser task's next question) replaces the old card.
      const rest = event.id ? cardsReducer(state, { type: "dismiss", key: card.key }) : state;
      // Do Not Disturb holds notices back silently; cards Matthew asked for still show.
      return dnd
        ? { ...rest, seq, queued: [...rest.queued, card] }
        : { ...rest, seq, cards: [card, ...rest.cards] };
    }
    case "timer.started": {
      const cards = state.cards.filter((c) => !(c.type === "timer" && c.id === event.id));
      const card: OverlayCard = {
        key: `timer-${event.id}`,
        type: "timer",
        id: event.id,
        endsAt: event.endsAt,
        ...(event.label ? { label: event.label } : {}),
        done: false,
      };
      return { ...state, seq, cards: [card, ...cards] };
    }
    case "timer.done": {
      const existing = state.cards.find((c) => c.type === "timer" && c.id === event.id);
      const rest = state.cards.filter((c) => c !== existing);
      const card: OverlayCard = {
        key: `timer-${event.id}`,
        type: "timer",
        id: event.id,
        endsAt: existing?.type === "timer" ? existing.endsAt : new Date(now).toISOString(),
        ...(event.label ? { label: event.label } : {}),
        done: true,
      };
      // A finished timer comes back to the top so it's seen.
      return { ...state, seq, timerDoneAt: now, cards: [card, ...rest] };
    }
    default:
      return state;
  }
}

const isText = (v: unknown): v is string => typeof v === "string";

/** Whether an event has what its card needs (the server and main are trusted, but not to be perfect). */
export function isShowable(event: DeskEvent): boolean {
  const e = event as Record<string, unknown>;
  switch (event.type) {
    case "card.show": {
      const card = e.card as Record<string, unknown> | undefined;
      return Boolean(card) && isText(card!.id) && isText(card!.title);
    }
    case "card.dismiss":
    case "timer.done":
      return isText(e.id);
    case "notice":
      return isText(e.title);
    case "timer.started":
      return isText(e.id) && isText(e.endsAt);
    default:
      return true;
  }
}

/** "4:12" (or "1:02:03" past an hour) until endsAt; 0:00 once it's passed. */
export function countdown(endsAt: string, now: number): string {
  const total = Math.max(0, Math.ceil((Date.parse(endsAt) - now) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
