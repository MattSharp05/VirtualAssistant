import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { DeskBridge, NoticeAction, ScreenCard } from "@jarvis/shared";
import { HAND_FLICK } from "../../../app/handTargets";
import type { HitRegions } from "../hitRegions";
import { Markdown } from "./markdown";
import { AUTO_DISMISS_MS, countdown, popOutWindow, visibleCards, type OverlayCard } from "./model";
import { useCards } from "./useCards";
import { useVoiceReply } from "./useVoiceReply";
import "./cards.css";

const GLYPHS = {
  popout: "M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  close: "M6 6l12 12M18 6 6 18",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
};

function Glyph({ name }: { name: keyof typeof GLYPHS }) {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={GLYPHS[name]} />
    </svg>
  );
}

interface LayerProps {
  bridge: DeskBridge;
  hits: HitRegions;
  /** Shown first in the stack, outside its rules (the dropped file's card, JD-40). */
  pinned?: ReactNode;
}

/**
 * Everything beside the orb (JD-27, mockups 1–2): the card stack under it (newest on top, max 3),
 * the Do Not Disturb badge on it, and the "You said" bubble + spoken caption for voice replies.
 * Only cards and the badge take clicks; the rest of the overlay stays click-through.
 */
export function CardsLayer({ bridge, hits, pinned }: LayerProps) {
  const cards = useCards(bridge);
  const voice = useVoiceReply(bridge);
  const { shown, more } = visibleCards(cards);
  const held = cards.queued.length;

  return (
    <>
      {held > 0 && (
        <Hit hits={hits} id="dnd-badge">
          <button
            type="button"
            className="dnd-badge"
            aria-label={`${held} notification${held === 1 ? "" : "s"} held by Do Not Disturb: show`}
            title="Do Not Disturb is on: show what's waiting"
            onClick={cards.release}
          >
            {held}
          </button>
        </Hit>
      )}
      {voice.heard && (
        <aside className="voice-heard glass-card" aria-label="You said">
          <div className="card-eyebrow">You said</div>
          <div className="voice-heard-text">“{voice.heard}”</div>
        </aside>
      )}
      <section className="card-stack" aria-label="Cards from JARVIS">
        {pinned}
        {shown.map((card) => (
          <Hit key={card.key} hits={hits} id={`card:${card.key}`}>
            <Card card={card} bridge={bridge} dismiss={cards.dismiss} />
          </Hit>
        ))}
        {more > 0 && <div className="card-more">+{more} more</div>}
      </section>
      {voice.spoken && (
        <aside className="voice-spoken glass-card" aria-label="JARVIS (spoken)" aria-live="polite">
          <div className="card-eyebrow">JARVIS (spoken)</div>
          <div className="voice-spoken-text">“{voice.spoken.trim()}”</div>
        </aside>
      )}
    </>
  );
}

/** A clickable region: click-through is off while the pointer is inside (and it leaves on unmount). */
export function Hit({ hits, id, children }: { hits: HitRegions; id: string; children: ReactNode }) {
  useEffect(() => () => hits.leave(id), [hits, id]);
  return (
    <div className="card-hit" onMouseEnter={() => hits.enter(id)} onMouseLeave={() => hits.leave(id)}>
      {children}
    </div>
  );
}

interface CardProps {
  card: OverlayCard;
  bridge: DeskBridge;
  dismiss(key: string): void;
}

/**
 * One card. It leaves after a minute unless the pointer (or focus) is on it; running timers stay.
 * Camera hands (JD-47) can pick it up and move it, and a flick throws it away.
 */
function Card({ card, bridge, dismiss }: CardProps) {
  const [held, setHeld] = useState(false);
  const onDismiss = useCallback(() => dismiss(card.key), [dismiss, card.key]);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.addEventListener(HAND_FLICK, onDismiss);
    return () => el?.removeEventListener(HAND_FLICK, onDismiss);
  }, [onDismiss]);
  const running = card.type === "timer" && !card.done;
  useEffect(() => {
    if (held || running) return;
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [held, running, onDismiss]);

  const level = card.type === "notice" ? card.level : card.type === "timer" && card.done ? "done" : undefined;
  return (
    <article
      ref={ref}
      data-hand-grab=""
      className={`glass-card card card-${card.type}`}
      data-card-kind={card.type === "screen" ? card.card.kind : card.type}
      {...(level ? { "data-level": level } : {})}
      aria-label={label(card)}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      {card.type === "screen" && <ShownCard card={card.card} bridge={bridge} onDismiss={onDismiss} />}
      {card.type === "notice" && <NoticeCard card={card} bridge={bridge} onDismiss={onDismiss} />}
      {card.type === "timer" && <TimerCard card={card} onDismiss={onDismiss} />}
    </article>
  );
}

function label(card: OverlayCard): string {
  if (card.type === "screen") return card.card.title;
  if (card.type === "notice") return card.title;
  return `Timer${card.label ? `: ${card.label}` : ""}`;
}

function Dismiss({ onDismiss, what }: { onDismiss(): void; what: string }) {
  return (
    <button type="button" className="card-icon-button" aria-label={`Dismiss ${what}`} onClick={onDismiss}>
      <Glyph name="close" />
    </button>
  );
}

/** A card JARVIS put up (show_on_screen): title, markdown body, rows, a link; Pop out when a window fits. */
function ShownCard({ card, bridge, onDismiss }: { card: ScreenCard; bridge: DeskBridge; onDismiss(): void }) {
  const target = popOutWindow(card);
  return (
    <>
      <header className="card-head">
        <h2 className="card-title">{card.title}</h2>
        <div className="card-tools">
          {target && (
            <button
              type="button"
              className="card-icon-button"
              aria-label={`Pop out ${card.title}`}
              title="Open as window"
              onClick={() => {
                bridge.openWindow(target);
                onDismiss();
              }}
            >
              <Glyph name="popout" />
            </button>
          )}
          <Dismiss onDismiss={onDismiss} what={card.title} />
        </div>
      </header>
      {Array.isArray(card.items) && card.items.length ? (
        <ul className={`card-rows card-rows-${card.kind}`}>
          {card.items.map((item, i) => (
            <li key={i} className="card-row">
              {card.kind === "agenda" ? (
                <>
                  <span className="card-row-time">{item.detail ?? ""}</span>
                  <span className="card-row-label">{item.label}</span>
                </>
              ) : (
                <>
                  <span className="card-row-label">{item.label}</span>
                  {item.detail && <span className="card-row-detail">{item.detail}</span>}
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {card.body?.trim() && (
        <>
          {card.items?.length ? <hr className="card-rule" /> : null}
          <Markdown text={card.body} />
        </>
      )}
      {card.link && (
        <a className="card-link" href={card.link.url} target="_blank" rel="noreferrer">
          {card.link.label} →
        </a>
      )}
    </>
  );
}

function NoticeCard({
  card,
  bridge,
  onDismiss,
}: {
  card: Extract<OverlayCard, { type: "notice" }>;
  bridge: DeskBridge;
  onDismiss(): void;
}) {
  const act = (a: NoticeAction) => {
    if (a.request) void bridge.request(a.request.path, a.request.body ?? {}).catch(() => {});
    else if (a.window) bridge.openWindow(a.window, a.params);
    else if (a.url) window.open(a.url, "_blank", "noreferrer");
    onDismiss();
  };
  return (
    <div className="notice">
      <span className="notice-dot" aria-hidden="true" />
      <div className="notice-text">
        <div className="notice-title">{card.title}</div>
        {card.body && <div className="notice-body">{card.body}</div>}
      </div>
      {card.actions.length ? (
        <div className="notice-actions">
          {card.actions.map((a, i) => (
            <button
              key={a.label}
              type="button"
              className={`notice-action${i === 0 && (a.window || a.url || a.request) ? " notice-action-primary" : ""}`}
              onClick={() => act(a)}
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : (
        <Dismiss onDismiss={onDismiss} what={card.title} />
      )}
    </div>
  );
}

/** A live countdown (timer.started), then "Time's up" (timer.done). */
function TimerCard({
  card,
  onDismiss,
}: {
  card: Extract<OverlayCard, { type: "timer" }>;
  onDismiss(): void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (card.done) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [card.done]);
  const what = card.label ? `timer ${card.label}` : "timer";
  return (
    <div className="timer">
      <Glyph name="bell" />
      <div className="timer-text">
        <div className="card-eyebrow">{card.done ? "Time's up" : "Timer"}</div>
        <div className="timer-label">{card.label ?? "Timer"}</div>
      </div>
      <div className="timer-count" role="timer" aria-label={`${what} remaining`}>
        {card.done ? "0:00" : countdown(card.endsAt, now)}
      </div>
      <Dismiss onDismiss={onDismiss} what={what} />
    </div>
  );
}
